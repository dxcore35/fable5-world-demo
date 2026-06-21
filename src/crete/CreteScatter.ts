/**
 * CreteScatter — real, OSM-placed Mediterranean vegetation + rocks for the Crete
 * world, packed into the SAME ScatterResult buffer layout the laas/gavdos Forests
 * pipeline consumes. This gives Crete the exact high-quality rendering of the
 * default localhost:5173 scene (3D LOD trees, foliage cards, octahedral impostors
 * at distance, sun shadows, wind sway) instead of the old flat cones.
 *
 * Placement is BOUNDED BY the OSM wood/park polygons (random-rejection sampling,
 * reused verbatim from CreteGreenery) — NOT a full-world grid like gavdos. Crete
 * is a ~280 km world; a 5 m gavdos-style grid would be billions of cells. Trees,
 * shrubs and rocks are emitted ONLY inside real forest/park outlines, so the
 * cadastre orthophoto stays fully visible over cities, roads, fields, bare ground.
 *
 * Species come from the gavdos Mediterranean library (buildGavdosVegLibrary):
 *   trees  → cls 0 juniper / 1 pine / 2 olive   (variant 0..TREE_VARIANTS-1)
 *   shrubs → cls 8 phrygana                       (variant 0..3)
 *   rocks  → cls 18 boulder / 19 slab (extras), 20/21/22 stones (variant 0..3)
 * idF = cls*8 + variant, matching the gavdos instance packing.
 */
import type { Heightfield } from '../world/Heightfield';
import { TREE_VARIANTS } from '../gpu/passes/Scatter';
import type { GavdosScatterResult } from '../gavdos/GavdosVeg';
import {
  makeRng,
  ringToWorld,
  ringAreaM2,
  samplePointsInRing,
  type GreeneryRecord,
  type WorldRing,
  type TreePoint,
} from './CreteGreenery';
import {
  CRETE_CENTER_LON,
  CRETE_CENTER_LAT,
  M_PER_DEG_LON,
  M_PER_DEG_LAT,
  CRETE_CROP_HALF,
} from './CreteConst';

// --- density tuning ----------------------------------------------------------
// Tight per-polygon spacing so a forest looks forested when you descend into it;
// the global caps then thin everything proportionally to stay within the fps
// budget. (From altitude the forests already read as green in the cadastre
// imagery itself — the 3D trees fill in as you fly down.)
const WOOD_TREE_SPACING_M2 = 220;
const PARK_TREE_SPACING_M2 = 650;
const WOOD_SHRUB_SPACING_M2 = 180;
const PARK_SHRUB_SPACING_M2 = 550;
/** boulders/slabs (extras layer): sparse, occasional. */
const ROCK_SPACING_M2 = 2500;
/** small ground stones (stones layer). */
const STONE_SPACING_M2 = 1200;

// Higher caps → less proportional thinning → the OSM woods read DENSE like the
// default demo's forests (the Forests GPU cull + impostor LOD carry the count;
// the CPU scatter build cost is minor). Tune up/down for density vs perf.
const TREE_CAP = 320_000;
const SHRUB_CAP = 420_000;
const ROCK_CAP = 30_000;
const STONE_CAP = 70_000;

// Reserve a share of the tree/shrub budget for the canopy-from-imagery pass so it
// can BROADEN placement across the island's real vegetation. Without this the OSM
// wood/park pass (~1.4M natural trees) thins to fill the WHOLE cap first, leaving
// the canopy pass nothing. OSM gets OSM_VEG_FRAC of the cap (dense forests); the
// canopy pass fills the remainder (groves/scrub the imagery shows beyond OSM).
const OSM_VEG_FRAC = 0.4;
const OSM_TREE_CAP = Math.floor(TREE_CAP * OSM_VEG_FRAC);
const OSM_SHRUB_CAP = Math.floor(SHRUB_CAP * OSM_VEG_FRAC);

/** phrygana shrub class — matches buildGavdosVegLibrary's PHRYGANA_CLS. */
const PHRYGANA_CLS = 8;
// Mediterranean rock classes (match buildGavdosVegLibrary / Scatter VegClass).
const VC_BOULDER = 18;
const VC_SLAB = 19;
const VC_STONEL = 20;
const VC_STONEM = 21;
const VC_STONES = 22;

const TAU = Math.PI * 2;

// Fast approx slope (rise/run) from cpu heightfield for slope-aware scatter.
// Used to bias realistic phrygana (moderate slope scrub) / olives (gentle near-beach)
// / rocks (steep) especially at low coastal elevations for beach realism.
function approxSlope(hf: Heightfield, x: number, z: number, step = 6): number {
  const h = hf.heightAtCpu(x, z);
  const hx = hf.heightAtCpu(x + step, z);
  const hz = hf.heightAtCpu(x, z + step);
  const s = Math.hypot(hx - h, hz - h) / step;
  return Math.min(1.4, s);
}

// --- canopy-from-imagery pass tuning -----------------------------------------
// The canopy mask (public/crete/canopy-mask.png, baked by tools/crete/bake-canopy-mask.ts)
// encodes WHERE real vegetation is from the cadastre orthophoto's colours (ExG).
// This pass scatters trees/shrubs/rocks on the open terrain wherever the mask says
// "vegetation", BROADENING placement beyond the sparse OSM wood/park polygons.
//
// We march a coarse world grid (CANOPY_STEP_M) over the island window; at each cell
// canopyAt() gives 0..1, and a cell with canopy >= CANOPY_THRESHOLD becomes candidate
// ground. Density scales with the canopy value (denser canopy -> more trees). Every
// candidate is gated by the same land/height test the OSM pass uses (sea -> skipped).
const CANOPY_STEP_M = 50;          // world grid spacing for the canopy march (~5.6k×5.6k cells over 280km; keeps the boot march cheap)
const CANOPY_THRESHOLD = 0.20;     // mask value below this = not enough vegetation -> nothing placed (lower = catches lighter grove/scrub the imagery shows)
const CANOPY_SEA_EPS = 0.5;        // ground height (m) below this = sea -> no placement (matches CreteGreenery)
// Per-canopy-cell expected counts at FULL canopy (value 1.0); scaled by the cell's
// canopy value and jittered. Sized so the canopy pass actually FILLS its reserved
// share of the cap (broad grove/scrub coverage), not just a thin sprinkle.
const CANOPY_TREE_PER_CELL = 1.1;  // ~1 tree per full-canopy cell
const CANOPY_SHRUB_PER_CELL = 0.8;
const CANOPY_ROCK_PER_CELL = 0.012;

/** Bilinear-sampled canopy coverage 0..1 from the baked mask, or null if the mask
 *  is unavailable (then the canopy pass is skipped and only OSM placement runs). */
interface CanopyMask {
  data: Uint8Array;     // width*height grayscale, row 0 = north edge
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Fetch + decode public/crete/canopy-mask.png (+ .json sidecar) into a CPU grid.
 *  Uses OffscreenCanvas with a Canvas2D/createImageBitmap fallback — mirrors the
 *  land-grid raster load in CreteMapStream. Returns null on any failure so the
 *  caller degrades gracefully to OSM-only placement (never throws). */
async function loadCanopyMask(): Promise<CanopyMask | null> {
  try {
    // Load the RAW byte grid (canopy-mask.bin), NOT the PNG: image decoding
    // (createImageBitmap) can return a degenerate 0×0 bitmap when run mid-boot while
    // the main thread is jammed by the heightfield/drape bake. A plain arrayBuffer
    // fetch is immune to that race.
    const [metaResp, binResp] = await Promise.all([
      fetch('/crete/canopy-mask.json'),
      fetch('/crete/canopy-mask.bin'),
    ]);
    if (!metaResp.ok || !binResp.ok) { console.warn('[crete] canopy mask: fetch not ok', metaResp.status, binResp.status); return null; }
    const meta = (await metaResp.json()) as {
      west: number; south: number; east: number; north: number; width: number; height: number;
    };
    if (!meta || !Number.isFinite(meta.width) || !Number.isFinite(meta.height)) { console.warn('[crete] canopy mask: bad meta', meta); return null; }

    const buf = await binResp.arrayBuffer();
    const data = new Uint8Array(buf);
    if (data.length < meta.width * meta.height) {
      console.warn('[crete] canopy mask: bin too small', data.length, 'expected', meta.width * meta.height); return null;
    }
    console.log('[crete] canopy mask: loaded BIN', meta.width, '×', meta.height, '(', data.length, 'bytes )');
    return {
      data, width: meta.width, height: meta.height,
      west: meta.west, south: meta.south, east: meta.east, north: meta.north,
    };
  } catch (e) {
    console.warn('[crete] canopy mask: load threw', e); // missing mask / decode failure -> OSM-only
    return null;
  }
}

/** Bilinear canopy coverage 0..1 at a lon/lat; 0 outside the mask or if mask is null. */
function canopyAt(mask: CanopyMask | null, lon: number, lat: number): number {
  if (!mask) return 0;
  // lon/lat -> fractional pixel (row 0 = north edge).
  const fx = ((lon - mask.west) / (mask.east - mask.west)) * mask.width - 0.5;
  const fy = ((mask.north - lat) / (mask.north - mask.south)) * mask.height - 0.5;
  if (fx < -1 || fy < -1 || fx > mask.width || fy > mask.height) return 0;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const clampX = (x: number): number => Math.min(Math.max(x, 0), mask.width - 1);
  const clampY = (y: number): number => Math.min(Math.max(y, 0), mask.height - 1);
  const at = (x: number, y: number): number => mask.data[clampY(y) * mask.width + clampX(x)] ?? 0;
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return (top + (bot - top) * ty) / 255;
}

interface VegPoly {
  ring: WorldRing;
  isWood: boolean;
  area: number;
}

/** Pack one instance into A=(x,y,z,scale) + B=(yaw,leanX,leanZ, cls*8+variant). */
function pack(
  arrA: Float32Array,
  arrB: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  leanX: number,
  leanZ: number,
  cls: number,
  variant: number,
): void {
  const o = i * 4;
  arrA[o] = x;
  arrA[o + 1] = y;
  arrA[o + 2] = z;
  arrA[o + 3] = scale;
  arrB[o] = yaw;
  arrB[o + 1] = leanX;
  arrB[o + 2] = leanZ;
  arrB[o + 3] = cls * 8 + variant;
}

/**
 * Build the Crete scatter (trees + phrygana shrubs + rocks) from
 * public/crete/greenery.json, shaped exactly like ScatterResult so
 * Forests/GroundRing render it unchanged. On any data failure it returns an
 * all-empty scatter so world boot never aborts.
 */
export async function buildCreteScatter(hf: Heightfield): Promise<GavdosScatterResult> {
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { storage } = await import('three/tsl');

  const makeLayer = (
    arrA: Float32Array,
    arrB: Float32Array,
    count: number,
    cap: number,
  ): { bufA: unknown; bufB: unknown; cap: number; count: number } => {
    const real = Math.min(count, cap);
    const a = new Float32Array(cap * 4);
    const b = new Float32Array(cap * 4);
    a.set(arrA.subarray(0, real * 4));
    b.set(arrB.subarray(0, real * 4));
    return {
      bufA: storage(new StorageBufferAttribute(a, 4), 'vec4', cap),
      bufB: storage(new StorageBufferAttribute(b, 4), 'vec4', cap),
      cap,
      count: real,
    };
  };
  const emptyLayer = () => makeLayer(new Float32Array(16 * 4), new Float32Array(16 * 4), 0, 16);
  const emptyScatter = (): GavdosScatterResult =>
    ({ trees: emptyLayer(), understory: emptyLayer(), extras: emptyLayer(), stones: emptyLayer() } as GavdosScatterResult);

  let records: GreeneryRecord[];
  try {
    const resp = await fetch('/crete/greenery.json');
    if (!resp.ok) throw new Error(`greenery.json HTTP ${resp.status}`);
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) throw new Error('greenery.json is not an array');
    records = data as GreeneryRecord[];
  } catch (e) {
    console.warn('[crete] scatter: greenery.json load failed; no procedural veg', e);
    return emptyScatter();
  }

  // Canopy-from-imagery mask: drives a second, broader placement pass (olive groves,
  // scrub, forests the OSM polygons miss). ?canopy=0 disables it for A/B (OSM-only).
  // Missing mask -> null -> the canopy pass is skipped and behaviour is unchanged.
  const canopyDisabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('canopy') === '0';
  const canopyMask = canopyDisabled ? null : await loadCanopyMask();

  const polys: VegPoly[] = [];
  for (const rec of records) {
    try {
      if (rec.t !== 'wood' && rec.t !== 'park') continue;
      const ring = ringToWorld(rec.r);
      if (!ring) continue;
      const area = ringAreaM2(ring);
      if (area <= 0) continue;
      polys.push({ ring, isWood: rec.t === 'wood', area });
    } catch (e) {
      console.warn('[crete] scatter: bad polygon skipped', e);
    }
  }

  // Pre-sum natural counts so per-polygon spacing scales up by one shared factor
  // if a layer's total exceeds its cap (proportional thinning).
  let natTrees = 0;
  let natShrubs = 0;
  let natRocks = 0;
  let natStones = 0;
  for (const p of polys) {
    natTrees += Math.round(p.area / (p.isWood ? WOOD_TREE_SPACING_M2 : PARK_TREE_SPACING_M2));
    natShrubs += Math.round(p.area / (p.isWood ? WOOD_SHRUB_SPACING_M2 : PARK_SHRUB_SPACING_M2));
    natRocks += Math.round(p.area / ROCK_SPACING_M2);
    natStones += Math.round(p.area / STONE_SPACING_M2);
  }
  const treeScale = natTrees > OSM_TREE_CAP ? natTrees / OSM_TREE_CAP : 1;
  const shrubScale = natShrubs > OSM_SHRUB_CAP ? natShrubs / OSM_SHRUB_CAP : 1;
  const rockScale = natRocks > ROCK_CAP ? natRocks / ROCK_CAP : 1;
  const stoneScale = natStones > STONE_CAP ? natStones / STONE_CAP : 1;

  const tA = new Float32Array(TREE_CAP * 4);
  const tB = new Float32Array(TREE_CAP * 4);
  const uA = new Float32Array(SHRUB_CAP * 4);
  const uB = new Float32Array(SHRUB_CAP * 4);
  const eA = new Float32Array(ROCK_CAP * 4);
  const eB = new Float32Array(ROCK_CAP * 4);
  const sA = new Float32Array(STONE_CAP * 4);
  const sB = new Float32Array(STONE_CAP * 4);
  let tCount = 0;
  let uCount = 0;
  let eCount = 0;
  let sCount = 0;
  const rng = makeRng(0x0c2e7e9); // fixed seed → stable placement across reloads
  const pts: TreePoint[] = [];

  /** Sample `area/spacing` points inside a ring and run `place` for each. */
  const layerPass = (
    poly: VegPoly,
    spacing: number,
    scaleFactor: number,
    atCap: () => boolean,
    place: (x: number, z: number, h: number) => void,
  ): void => {
    if (atCap()) return;
    const target = Math.round(poly.area / (spacing * scaleFactor));
    if (target <= 0) return;
    pts.length = 0;
    samplePointsInRing(poly.ring, target, hf, rng, pts);
    for (const pt of pts) {
      if (atCap()) break;
      place(pt.x, pt.z, Math.max(0, hf.heightAtCpu(pt.x, pt.z)));
    }
  };

  for (const poly of polys) {
    // trees — pine-dominant Mediterranean mix (pine 50% / olive 30% / juniper 20%)
    layerPass(poly, poly.isWood ? WOOD_TREE_SPACING_M2 : PARK_TREE_SPACING_M2, treeScale,
      () => tCount >= OSM_TREE_CAP,
      (x, z, h) => {
        const sHash = rng();
        const sl = approxSlope(hf, x, z);
        const coastal = h < 22 ? 1 : 0; // bias olives/phrygana near real beaches
        // slope + coastal for realism: olives prefer low-slope coastal flats; pine on steeper
        let cls = sHash < 0.5 ? 1 : sHash < 0.8 ? 2 : 0;
        if (coastal && sl < 0.22 && rng() < 0.55) cls = 2; // olive bias near beaches
        const scale = 0.7 + rng() * 0.7;
        pack(tA, tB, tCount, x, h - scale * 0.12, z, scale, rng() * TAU,
          (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12, cls,
          Math.floor(rng() * TREE_VARIANTS) % TREE_VARIANTS);
        tCount++;
      });

    // shrubs — phrygana (cls 8)
    layerPass(poly, poly.isWood ? WOOD_SHRUB_SPACING_M2 : PARK_SHRUB_SPACING_M2, shrubScale,
      () => uCount >= OSM_SHRUB_CAP,
      (x, z, h) => {
        const sl = approxSlope(hf, x, z);
        const coastal = h < 18 ? 1.0 : 0.3; // phrygana loves low coastal + gentle-moderate slopes
        // higher phrygana density near beaches on realistic scrub slopes (0.1-0.6)
        const phryBias = coastal * (sl > 0.08 && sl < 0.65 ? 1.4 : 0.7);
        if (rng() > 0.6 / Math.max(0.5, phryBias)) return; // reject inland steep non-scrub
        const scale = 0.4 + rng() * 0.8;
        pack(uA, uB, uCount, x, h, z, scale, rng() * TAU,
          (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08, PHRYGANA_CLS,
          Math.floor(rng() * 4) % 4);
        uCount++;
      });

    // boulders / slabs (extras layer)
    layerPass(poly, ROCK_SPACING_M2, rockScale,
      () => eCount >= ROCK_CAP,
      (x, z, h) => {
        const sl = approxSlope(hf, x, z);
        const coastal = h < 25 ? 1 : 0;
        const cls = (coastal && sl > 0.35) || sl > 0.7 ? VC_BOULDER : VC_SLAB; // boulders on steep/coastal cliffs
        const scale = 0.6 + rng() * 1.4;
        pack(eA, eB, eCount, x, h, z, scale, rng() * TAU, 0, 0, cls, Math.floor(rng() * 4) % 4);
        eCount++;
      });

    // small ground stones (stones layer)
    layerPass(poly, STONE_SPACING_M2, stoneScale,
      () => sCount >= STONE_CAP,
      (x, z, h) => {
        const rr = rng();
        const cls = rr < 0.3 ? VC_STONEL : rr < 0.65 ? VC_STONEM : VC_STONES;
        const scale = 0.4 + rng() * 0.8;
        pack(sA, sB, sCount, x, h, z, scale, rng() * TAU, 0, 0, cls, Math.floor(rng() * 4) % 4);
        sCount++;
      });
  }

  // --- canopy-from-imagery pass ------------------------------------------------
  // March a coarse world grid over the island window; where the baked mask reports
  // real vegetation (canopyAt >= threshold) and the terrain is land, scatter trees +
  // shrubs (+ occasional rocks) on the ground. Shares the SAME arrays/caps as the OSM
  // pass, so it broadens coverage without exceeding the budget. The OSM woods already
  // placed above keep their dense look; this fills the surrounding grove/scrub mosaic.
  let canopyTrees = 0;
  let canopyShrubs = 0;
  let canopyRocks = 0;
  if (canopyMask) {
    // world XZ window: ±CRETE_CROP_HALF (same crop the terrain/ocean use). The mask
    // is sampled by lon/lat, so convert each grid cell's world XZ back to lon/lat.
    const half = CRETE_CROP_HALF;
    const cellsPerSide = Math.floor((half * 2) / CANOPY_STEP_M);
    // jitter each placement within its cell so the grid never reads as rows.
    const worldToLon = (x: number): number => CRETE_CENTER_LON + x / M_PER_DEG_LON;
    // world z = NORTH_SIGN(-1) * (lat - centre) * M_PER_DEG_LAT -> lat = centre - z / M_PER_DEG_LAT
    const worldToLat = (z: number): number => CRETE_CENTER_LAT - z / M_PER_DEG_LAT;

    for (let gy = 0; gy < cellsPerSide; gy++) {
      // Break on the MAIN veg caps (trees+shrubs); rocks are sparse decoration and
      // fill slowest — gating the break on them would march ~25M extra cells.
      if (tCount >= TREE_CAP && uCount >= SHRUB_CAP) break;
      const z0 = -half + gy * CANOPY_STEP_M;
      for (let gx = 0; gx < cellsPerSide; gx++) {
        const x0 = -half + gx * CANOPY_STEP_M;
        const x = x0 + rng() * CANOPY_STEP_M;
        const z = z0 + rng() * CANOPY_STEP_M;
        const cov = canopyAt(canopyMask, worldToLon(x), worldToLat(z));
        if (cov < CANOPY_THRESHOLD) continue; // not enough vegetation in the imagery
        const h = hf.heightAtCpu(x, z);
        if (h < CANOPY_SEA_EPS) continue;      // land only — never in the sea

        // density scales with canopy value (denser canopy -> more instances).
        const hh = Math.max(0, h);
        const slCan = approxSlope(hf, x, z);
        const coastalCan = hh < 22 ? 1 : 0;
        if (tCount < TREE_CAP && rng() < CANOPY_TREE_PER_CELL * cov) {
          const sHash = rng();
          let cls = sHash < 0.5 ? 1 : sHash < 0.8 ? 2 : 0; // pine / olive / juniper
          if (coastalCan && slCan < 0.25 && rng() < 0.5) cls = 2; // olive near-beach bias
          const scale = 0.7 + rng() * 0.7;
          pack(tA, tB, tCount, x, hh - scale * 0.12, z, scale, rng() * TAU,
            (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.12, cls,
            Math.floor(rng() * TREE_VARIANTS) % TREE_VARIANTS);
          tCount++; canopyTrees++;
        }
        if (uCount < SHRUB_CAP && rng() < CANOPY_SHRUB_PER_CELL * cov) {
          const slCan = approxSlope(hf, x, z);
          const coastalCan = hh < 18 ? 1.3 : 0.55;
          const phryBias = coastalCan * (slCan > 0.09 && slCan < 0.62 ? 1.4 : 0.8);
          if (rng() > 0.62 / Math.max(0.55, phryBias)) { /* reject non-scrub */ } else {
            const scale = 0.4 + rng() * 0.8;
            pack(uA, uB, uCount, x, hh, z, scale, rng() * TAU,
              (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08, PHRYGANA_CLS,
              Math.floor(rng() * 4) % 4);
            uCount++; canopyShrubs++;
          }
        }
        if (eCount < ROCK_CAP && rng() < CANOPY_ROCK_PER_CELL * cov) {
          const slCan = approxSlope(hf, x, z);
          const coastalCan = hh < 25 ? 1 : 0;
          const cls = (coastalCan && slCan > 0.32) || slCan > 0.65 ? VC_BOULDER : VC_SLAB;
          const scale = 0.6 + rng() * 1.4;
          pack(eA, eB, eCount, x, hh, z, scale, rng() * TAU, 0, 0, cls, Math.floor(rng() * 4) % 4);
          eCount++; canopyRocks++;
        }
      }
    }
  }

  console.log(
    `[crete] scatter: trees=${tCount} shrubs=${uCount} rocks=${eCount} stones=${sCount} in ${polys.length} woods/parks` +
      (treeScale > 1 ? ` (OSM trees thinned ${natTrees}→${OSM_TREE_CAP}, rest reserved for canopy)` : ''),
  );
  console.log(
    canopyMask
      ? `[crete] scatter: canopy pass added trees=${canopyTrees} shrubs=${canopyShrubs} rocks=${canopyRocks} ` +
          `(threshold ${CANOPY_THRESHOLD}, step ${CANOPY_STEP_M}m)`
      : `[crete] scatter: canopy pass ${canopyDisabled ? 'disabled (?canopy=0)' : 'skipped (no canopy-mask.png)'}; OSM-only placement`,
  );

  return {
    trees: makeLayer(tA, tB, tCount, TREE_CAP),
    understory: makeLayer(uA, uB, uCount, SHRUB_CAP),
    extras: makeLayer(eA, eB, eCount, ROCK_CAP),
    stones: makeLayer(sA, sB, sCount, STONE_CAP),
  } as GavdosScatterResult;
}
