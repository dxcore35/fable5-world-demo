/**
 * CreteMapStream — camera-driven LIVE map-tile streaming (two-layer LOD) for the
 * crete world. There are TWO satellite drapes: a STABLE coarse whole-island base
 * (`hf.satelliteTex` + `hf.satWin`, ≈68 m/texel, built once by CreteData and
 * NEVER touched here) and a high-DETAIL window drape (`hf.satDetailTex` +
 * `hf.satDetailWin`). This controller streams the DETAIL layer only: as the
 * camera zooms/moves it fetches HIGH-zoom Hellenic Cadastre LSO_v2 tiles LIVE for
 * the visible footprint, composites them, re-fills the SAME detail texture with
 * that tighter footprint, and slides the detail window uniform onto it.
 * TerrainMaterial blends the detail over the base inside the window (soft border),
 * so the DISTANCE always shows the coarse base (no edge-clamp stretch, no
 * staleness) while the focused area sharpens down to z18 (≈0.6 m) — no overlay mesh.
 *
 * ── Why this is safe ─────────────────────────────────────────────────────────
 * - No-op unless params.world === 'crete' AND the DETAIL drape + window exist
 *   (i.e. satellite imagery loaded; CreteData creates both together). Every other
 *   world, and the coarse base layer, are untouched.
 * - The detail texture and the material UV math are unchanged in shape: the
 *   material reads `texture(detail, (wxz − win.xy) / win.zw).pow(2.2)` and masks it
 *   into the base. This controller only re-fills the detail bytes and moves its
 *   window — the GPU sampling path is identical; `drape`/`satWin` below are the
 *   detail handles.
 * - In-memory tile cache ONLY (no disk writes). All fetch/build is wrapped in
 *   try/catch; on ANY failure the previous detail drape + window are kept (and the
 *   base always covers the distance regardless), so a failed refetch can never
 *   blank the terrain.
 * - Throttled: a refetch fires only when the camera altitude changed by >1.5× OR
 *   it panned past 40% of the current window — never every frame.
 *
 * ── Alignment contract ──────────────────────────────────────────────────────
 * Drape pixel (ox,oy) maps to world XZ INSIDE the new window:
 *   worldX = winOriginX + (ox+0.5)/SAT_RES · winSizeX
 *   worldZ = winOriginZ + (oy+0.5)/SAT_RES · winSizeZ
 * → lng/lat (inverse crete geodesy) → cadastre sampler. The shader's UV
 * `(wxz − winOrigin) / winSize` is the exact inverse, so the mapping is
 * self-consistent for ANY window — the drape always lands on the right ground.
 */

import {
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
} from 'three';
import {
  Fn,
  If,
  Return,
  float,
  instanceIndex,
  texture,
  textureStore,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl';
import type { Engine } from '../core/Engine';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { worldSize } from '../world/WorldConst';
import { SAT_RES } from './CreteData';
import {
  CRETE_CENTER_LAT,
  CRETE_CENTER_LON,
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  NORTH_SIGN,
} from './CreteConst';

/** Hellenic Cadastre LSO_v2 orthophoto tile URL — z/y/x order, EPSG:3857,
 *  256 px, zooms 0–18, 404 over open sea. Same endpoint as CreteSatellite. */
const tileUrl = (z: number, x: number, y: number): string =>
  `https://tiles-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services/LSO_v2/MapServer/tile/${z}/${y}/${x}`;

const TILE_PX = 256;
/** clamp the streamed cadastre zoom to the source's published range ceiling and
 *  a sensible floor (below this the static whole-island drape is already finer). */
const Z_MIN = 11;
const Z_MAX = 18; // LSO_v2 max published zoom
/** footprint ≈ camera AGL × this. Balanced: wide enough (with the forward bias
 *  below) to cover the looked-at scene, small enough to keep the per-window tile
 *  count — and the CPU refill — fast. The FORWARD_BIAS aims this modest window at
 *  the view, so it needn't be huge. (Bigger = more coverage but slower loads.) */
const FOOTPRINT_PER_AGL = 2.5;
/** footprint clamp: never tighter than this, never wider than the whole world.
 *  2.5 km @ 4096 px ≈ 0.6 m/texel — crisp, and ~3× fewer tiles than a 4 km box. */
const FOOTPRINT_MIN_M = 2500;
/** Bias the window centre toward where the camera LOOKS (fraction of the window
 *  size), so the sharp area lands on the view, not directly under the camera. */
const FORWARD_BIAS = 0.35;
/** Reusable scratch for the camera look direction (forward bias). */
const _fwd = new Vector3();
/** refetch when altitude changes by more than this ratio (either direction). */
const ALT_CHANGE_RATIO = 1.5;
/** refetch when the camera pans past this fraction of the current window. */
const PAN_FRACTION = 0.4;

/** A streamer's last committed window + the altitude it was built for. */
interface StreamState {
  centerX: number;
  centerZ: number;
  /** square window edge length in meters (= satWin sizeX = sizeZ). */
  sizeM: number;
  /** camera altitude-above-ground the window was sized for. */
  agl: number;
}

// --- Web-Mercator tile math (mirrors CreteSatellite.ts) ---------------------

/** Longitude → fractional tile X at zoom z. */
function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

/** Latitude → fractional tile Y at zoom z (asinh form, ±85.0511° clamp). */
function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const rad = (clampedLat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Inverse crete geodesy: engine world (x,z) → geographic (lng,lat). Exact
 *  inverse of CreteConst.lonLatToWorld (same convention worldToSourcePx uses). */
function worldToLngLat(x: number, z: number): { lng: number; lat: number } {
  const lng = CRETE_CENTER_LON + x / M_PER_DEG_LON;
  const lat = CRETE_CENTER_LAT + (z * NORTH_SIGN) / M_PER_DEG_LAT;
  return { lng, lat };
}

// ── Land/sea pre-filter ──────────────────────────────────────────────────────
// The cadastre has NO imagery over open sea, so those tile fetches 404 (console
// noise + wasted bandwidth). Rasterise the coastline into a coarse CPU land grid
// ONCE (dilated ~1 km so coastal tiles are always kept), then skip any tile whose
// whole footprint is open sea before fetching it. No grid → skip nothing.
const LAND_GRID_RES = 1024;
let landGrid: Uint8Array | null = null;
let landGridReady: Promise<void> | null = null;
function ensureLandGrid(): Promise<void> {
  if (!landGridReady) {
    landGridReady = (async () => {
      try {
        type GJ = { features?: { geometry?: { type: string; coordinates: number[][][] } }[] };
        let geo: GJ | null = null;
        for (const u of [
          '/crete/coastline-cadastre.geojson',
          '/crete/coastline-sds.geojson',
          '/crete/coastline.geojson',
        ]) {
          const r = await fetch(u);
          if (r.ok) { geo = (await r.json()) as GJ; break; }
        }
        const polys = (geo?.features ?? [])
          .filter((f) => f.geometry?.type === 'Polygon')
          .map((f) => f.geometry!.coordinates[0]);
        if (polys.length === 0 || typeof OffscreenCanvas === 'undefined') return;
        const W = worldSize();
        const cv = new OffscreenCanvas(LAND_GRID_RES, LAND_GRID_RES);
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, LAND_GRID_RES, LAND_GRID_RES);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 8; // ~1 km dilation (273 m/px) so coastal tiles are kept
        for (const ring of polys) {
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const px = (((ring[i]![0]! - CRETE_CENTER_LON) * M_PER_DEG_LON) / W + 0.5) * LAND_GRID_RES;
            const py = ((NORTH_SIGN * (ring[i]![1]! - CRETE_CENTER_LAT) * M_PER_DEG_LAT) / W + 0.5) * LAND_GRID_RES;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        const d = ctx.getImageData(0, 0, LAND_GRID_RES, LAND_GRID_RES).data;
        const g = new Uint8Array(LAND_GRID_RES * LAND_GRID_RES);
        for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] ?? 0) > 127 ? 1 : 0;
        landGrid = g;
      } catch {
        landGrid = null; // any failure → don't skip anything
      }
    })();
  }
  return landGridReady;
}

/** True only if the tile's WHOLE footprint (4 corners + centre) is open sea, so
 *  we can skip the fetch. Conservative: any sample on land keeps the tile. */
function tileIsOpenSea(z: number, tx: number, ty: number): boolean {
  const grid = landGrid;
  if (!grid) return false;
  const nn = 2 ** z;
  const W = worldSize();
  const lngOf = (t: number): number => (t / nn) * 360 - 180;
  const latOf = (t: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * (t / nn)))) * 180) / Math.PI;
  const isLand = (lng: number, lat: number): boolean => {
    const wx = (lng - CRETE_CENTER_LON) * M_PER_DEG_LON;
    const wz = NORTH_SIGN * (lat - CRETE_CENTER_LAT) * M_PER_DEG_LAT;
    const px = Math.min(Math.max(Math.round((wx / W + 0.5) * LAND_GRID_RES), 0), LAND_GRID_RES - 1);
    const py = Math.min(Math.max(Math.round((wz / W + 0.5) * LAND_GRID_RES), 0), LAND_GRID_RES - 1);
    return grid[py * LAND_GRID_RES + px] === 1;
  };
  return !(
    isLand(lngOf(tx), latOf(ty)) ||
    isLand(lngOf(tx + 1), latOf(ty)) ||
    isLand(lngOf(tx), latOf(ty + 1)) ||
    isLand(lngOf(tx + 1), latOf(ty + 1)) ||
    isLand(lngOf(tx + 0.5), latOf(ty + 0.5))
  );
}

// ── Two-tier tile cache ──────────────────────────────────────────────────────
// TIER 1: in-memory LRU of decoded ImageBitmaps (sub-ms re-use within a session).
// TIER 2: the Cache API (persistent) — re-visited areas load instantly across
// page reloads instead of re-downloading. Plus a concurrency cap so a fast camera
// flick can't fire hundreds of fetches at once.

/** In-memory LRU. null = a tile that 404'd (open sea) — memoised so we never
 *  re-fetch a known-empty slot. Bounded; LRU bitmaps are closed + evicted. */
const MEM_TILE_MAX = 1600;
const memTiles = new Map<string, ImageBitmap | null>();

function memGet(key: string): ImageBitmap | null | undefined {
  const v = memTiles.get(key);
  if (v !== undefined) {
    memTiles.delete(key); // LRU touch → move to most-recent end
    memTiles.set(key, v);
  }
  return v;
}
function memSet(key: string, val: ImageBitmap | null): void {
  memTiles.set(key, val);
  if (memTiles.size > MEM_TILE_MAX) {
    const oldest = memTiles.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      memTiles.get(oldest)?.close(); // free the LRU bitmap
      memTiles.delete(oldest);
    }
  }
}

/** Persistent tile cache (Cache API). Opened lazily; null if unavailable. */
const TILE_CACHE_NAME = 'crete-cadastre-tiles-v1';
let persistentCache: Cache | null = null;
let persistentCacheReady: Promise<void> | null = null;
function ensurePersistentCache(): Promise<void> {
  if (!persistentCacheReady) {
    persistentCacheReady = (
      typeof caches !== 'undefined'
        ? caches.open(TILE_CACHE_NAME).then((c) => { persistentCache = c; })
        : Promise.resolve()
    ).catch(() => { persistentCache = null; });
  }
  return persistentCacheReady;
}

/** Cap concurrent NETWORK fetches (cache hits are free and bypass this). */
const MAX_CONCURRENT_FETCH = 16;
let inFlight = 0;
const fetchWaiters: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_FETCH) { inFlight += 1; return Promise.resolve(); }
  return new Promise<void>((r) => fetchWaiters.push(r)).then(() => { inFlight += 1; });
}
function releaseSlot(): void {
  inFlight -= 1;
  fetchWaiters.shift()?.();
}

/** Cumulative cache stats — logged with each restream + exposed for inspection so
 *  you can SEE the cache working (mem/disk hits climb, network loads plateau). */
const tileStats = { mem: 0, disk: 0, net: 0 };
if (typeof window !== 'undefined') {
  (window as unknown as { __creteTiles?: typeof tileStats }).__creteTiles = tileStats;
}

/** Load one cadastre tile: in-memory LRU → persistent Cache API → network (CORS).
 *  Network results are written to BOTH tiers. Decodes to an ImageBitmap (drawable
 *  into the OffscreenCanvas). Returns null on 404/error (memoised). */
async function loadTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const key = `${z}/${x}/${y}`;
  const mem = memGet(key);
  if (mem !== undefined) { tileStats.mem += 1; return mem; } // tier-1 hit (incl. cached 404 nulls)

  const url = tileUrl(z, x, y);
  await ensurePersistentCache();
  await acquireSlot();
  try {
    let resp: Response | undefined;
    if (persistentCache) {
      try { resp = await persistentCache.match(url); } catch { /* ignore */ }
    }
    if (resp) {
      tileStats.disk += 1; // tier-2 hit (persisted across reloads)
    } else {
      tileStats.net += 1;
      resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (resp.ok && persistentCache) {
        // store raw bytes for cross-session re-use (quota errors are non-fatal)
        persistentCache.put(url, resp.clone()).catch(() => { /* quota — ignore */ });
      }
    }
    if (!resp || !resp.ok) { memSet(key, null); return null; }
    const bmp = await createImageBitmap(await resp.blob());
    memSet(key, bmp);
    return bmp;
  } catch {
    memSet(key, null);
    return null;
  } finally {
    releaseSlot();
  }
}

/** Async tile prefetch for next camera position (pre-warms mem+disk cache, no composite).
 *  Called opportunistically to kill hitching/pops when real Crete DEM + sat streams. */
function prefetchTilesForWindow(z: number, west: number, east: number, south: number, north: number): void {
  const n = 2 ** z;
  const clampTile = (v: number): number => Math.min(Math.max(v, 0), n - 1);
  const xMin = clampTile(Math.floor(lngToTileX(west, z)));
  const xMax = clampTile(Math.floor(lngToTileX(east, z)));
  const yMin = clampTile(Math.floor(latToTileY(north, z)));
  const yMax = clampTile(Math.floor(latToTileY(south, z)));
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      if (!tileIsOpenSea(z, tx, ty)) {
        // fire and forget — cache side effect only
        void loadTile(z, tx, ty).catch(() => {});
      }
    }
  }
}

/** A geographic-window orthophoto sampler: (lng,lat) → sRGB [0,1] triple. */
type WindowSampler = (lng: number, lat: number) => [number, number, number];

/**
 * Fetch every cadastre tile covering the lng/lat bbox at zoom z, composite into
 * one OffscreenCanvas, and return a (lng,lat) sampler over it (mirrors
 * buildCreteSatellite). Returns null when nothing usable could be built (no 2D
 * context, no tile decoded, or a tainted canvas) so the caller keeps the old drape.
 */
async function buildWindowSampler(
  z: number,
  west: number,
  east: number,
  south: number,
  north: number,
): Promise<{ sampler: WindowSampler; tiles: number; skipped: number } | null> {
  const n = 2 ** z;
  const clampTile = (v: number): number => Math.min(Math.max(v, 0), n - 1);
  const xMin = clampTile(Math.floor(lngToTileX(west, z)));
  const xMax = clampTile(Math.floor(lngToTileX(east, z)));
  // Tile Y increases SOUTHWARD: north edge → smallest Y.
  const yMin = clampTile(Math.floor(latToTileY(north, z)));
  const yMax = clampTile(Math.floor(latToTileY(south, z)));

  const tilesX = xMax - xMin + 1;
  const tilesY = yMax - yMin + 1;
  if (tilesX <= 0 || tilesY <= 0) return null;

  const canvasW = tilesX * TILE_PX;
  const canvasH = tilesY * TILE_PX;
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // Skip open-sea tiles (no cadastre imagery → would 404). No-op until ready.
  await ensureLandGrid();

  // Fetch every covering tile in parallel; null slots stay black (open sea).
  const jobs: Promise<void>[] = [];
  let placed = 0;
  let skippedSea = 0;
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      if (tileIsOpenSea(z, tx, ty)) { skippedSea += 1; continue; } // no fetch over open sea
      const dx = (tx - xMin) * TILE_PX;
      const dy = (ty - yMin) * TILE_PX;
      jobs.push(
        loadTile(z, tx, ty).then((img) => {
          if (img) {
            ctx.drawImage(img, dx, dy, TILE_PX, TILE_PX);
            placed++;
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (placed === 0) return null; // entirely sea/failed → keep old drape

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, canvasW, canvasH).data;
  } catch {
    // Tainted canvas (CORS) → can't read back; keep the old drape.
    return null;
  }

  const sampler: WindowSampler = (lng, lat) => {
    const fx = (lngToTileX(lng, z) - xMin) * TILE_PX;
    const fy = (latToTileY(lat, z) - yMin) * TILE_PX;
    const px = Math.min(Math.max(Math.round(fx), 0), canvasW - 1);
    const py = Math.min(Math.max(Math.round(fy), 0), canvasH - 1);
    const idx = (py * canvasW + px) * 4;
    return [
      (pixels[idx] ?? 0) / 255,
      (pixels[idx + 1] ?? 0) / 255,
      (pixels[idx + 2] ?? 0) / 255,
    ];
  };
  return { sampler, tiles: placed, skipped: skippedSea };
}

/**
 * Pick the cadastre zoom so that ~SAT_RES px span the footprint: we want enough
 * 256 px tiles across `footprintM` to fill the drape. metresPerTile(z) at this
 * latitude = (360 / 2^z) deg/tile × M_PER_DEG_LON. Choose the smallest z whose
 * tile is fine enough that footprintM / metresPerTile ≥ SAT_RES/TILE_PX tiles.
 * Clamped to [Z_MIN, Z_MAX].
 */
function pickZoom(footprintM: number): number {
  const tilesAcrossNeeded = SAT_RES / TILE_PX; // 4096/256 = 16 tiles
  for (let z = Z_MIN; z <= Z_MAX; z++) {
    const degPerTile = 360 / 2 ** z;
    const metresPerTile = degPerTile * M_PER_DEG_LON;
    if (footprintM / metresPerTile >= tilesAcrossNeeded) return z;
  }
  return Z_MAX;
}

/**
 * Install the live map-tile streamer. No-op unless this is the crete world and a
 * real satellite drape + window exist on the heightfield (i.e. imagery loaded
 * and `?sat=0` was not set). `?mapstream=0` force-disables it for A/B.
 */
export function installCreteMapStream(
  engine: Engine,
  hf: Heightfield,
  params: LaasParams,
): void {
  if (params.world !== 'crete') return;
  // TWO-LAYER LOD: stream the DETAIL drape only; the whole-island base (hf.satelliteTex
  // + hf.satWin) is built once and NEVER touched here, so the distance always shows the
  // coarse base with NO 4-way edge-clamp smear. This fills hf.satDetailTex with a sharp
  // high-zoom window and slides hf.satDetailWin onto it; TerrainMaterial blends detail
  // over base inside the window (soft border).
  const drape = hf.satDetailTex;
  const satWin = hf.satDetailWin;
  if (!drape || !satWin) return; // no detail layer → nothing to stream onto
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mapstream') === '0'
  ) {
    console.log('[crete] map stream: disabled (?mapstream=0)');
    return;
  }

  const ws = worldSize();
  const half = ws / 2;
  // The window uniform exposes a Vector4 .value (created via uniform(new Vector4));
  // the TSL node type hides it, so reach it through the same cast family used for
  // swizzles elsewhere. This is the ONLY mutable handle on the drape window.
  const winValue = (satWin as unknown as { value: Vector4 }).value;

  // Reusable CPU buffer for the drape re-fill (SAT_RES² rgba8). Allocated once.
  // Tiles are cached two-tier (in-memory LRU + persistent Cache API) at module level.
  const satRgba = new Uint8Array(SAT_RES * SAT_RES * 4);

  // Last committed window state; null until the first successful rebuild.
  let state: StreamState | null = null;
  // Guard so a slow refetch can't overlap itself (per-frame onUpdate fires fast).
  let busy = false;

  /** Re-fill the drape StorageTexture from a fresh window sampler via a compute
   *  copy (mirrors CreteData's satKernel: raw sRGB bytes in, material does pow2.2). */
  async function refillDrape(
    sampler: WindowSampler,
    originX: number,
    originZ: number,
    sizeM: number,
  ): Promise<void> {
    // Drape pixel (ox,oy) → world XZ inside the new window → lng/lat → sampler.
    // This is a 16.7M-pixel CPU fill; run it in row-chunks that YIELD to the event
    // loop so it never freezes the page (it was a multi-second rAF block / jank on
    // every stream). Slightly longer wall-time, but the UI stays responsive.
    for (let oy = 0; oy < SAT_RES; oy++) {
      const wz = originZ + ((oy + 0.5) / SAT_RES) * sizeM;
      for (let ox = 0; ox < SAT_RES; ox++) {
        const wx = originX + ((ox + 0.5) / SAT_RES) * sizeM;
        const { lng, lat } = worldToLngLat(wx, wz);
        const [r, g, b] = sampler(lng, lat);
        const o = (oy * SAT_RES + ox) * 4;
        satRgba[o] = Math.round(r * 255);
        satRgba[o + 1] = Math.round(g * 255);
        satRgba[o + 2] = Math.round(b * 255);
        satRgba[o + 3] = 255;
      }
      if ((oy & 255) === 255) await new Promise<void>((r) => setTimeout(r, 0)); // fewer yields = faster no-hitch Crete drape fill
    }

    // Stage the raw sRGB bytes (no colorspace flag — identical to CreteData) and
    // compute-copy into the EXISTING drape StorageTexture. The material samples
    // `drape` and applies pow(2.2), so storing raw sRGB here is correct.
    const staging = new DataTexture(satRgba, SAT_RES, SAT_RES, RGBAFormat, UnsignedByteType);
    staging.needsUpdate = true;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(SAT_RES * SAT_RES), () => {
        Return();
      });
      const x = i.mod(SAT_RES);
      const y = i.div(SAT_RES);
      const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(SAT_RES);
      const s = texture(staging, uv);
      textureStore(
        drape as NonNullable<typeof drape>,
        uvec2(x.toUint(), y.toUint()),
        vec4(s.r, s.g, s.b, float(1)),
      ).toWriteOnly();
    })().compute(SAT_RES * SAT_RES);
    kernel.setName('creteMapStreamRefill');
    await engine.renderer.computeAsync(kernel);
    staging.dispose();
  }

  /** Compute the target window for the current camera and, if it differs enough
   *  from the committed window, refetch tiles + re-fill the drape. */
  async function maybeRestream(): Promise<void> {
    if (busy) return;
    const cam = engine.camera;
    const groundY = hf.heightAtCpu(cam.position.x, cam.position.z);
    const agl = Math.max(10, cam.position.y - groundY);

    // Footprint: AGL-scaled, clamped. Centre = camera ground point, biased toward
    // where the camera LOOKS (so an oblique view's sharp area lands on the scene
    // ahead, not the patch under the camera), then clamped inside the island bbox.
    const sizeM = Math.min(Math.max(agl * FOOTPRINT_PER_AGL, FOOTPRINT_MIN_M), ws);
    const halfWin = sizeM / 2;
    cam.getWorldDirection(_fwd);
    const fwdLen = Math.hypot(_fwd.x, _fwd.z);
    const biasX = fwdLen > 0.05 ? (_fwd.x / fwdLen) * sizeM * FORWARD_BIAS : 0;
    const biasZ = fwdLen > 0.05 ? (_fwd.z / fwdLen) * sizeM * FORWARD_BIAS : 0;
    const centerX = Math.min(Math.max(cam.position.x + biasX, -half + halfWin), half - halfWin);
    const centerZ = Math.min(Math.max(cam.position.z + biasZ, -half + halfWin), half - halfWin);

    // Throttle: rebuild only on a big altitude change OR a large pan. The very
    // first call (state === null) always builds.
    if (state) {
      const altRatio = agl / state.agl;
      const altChanged = altRatio > ALT_CHANGE_RATIO || altRatio < 1 / ALT_CHANGE_RATIO;
      const panDist = Math.hypot(centerX - state.centerX, centerZ - state.centerZ);
      const panned = panDist > state.sizeM * PAN_FRACTION;
      if (!altChanged && !panned) return;
    }

    busy = true;
    try {
      const originX = centerX - halfWin;
      const originZ = centerZ - halfWin;
      // Window corners → lng/lat bbox. Z grows SOUTHWARD (NORTH_SIGN=-1), so the
      // min-Z corner is NORTH and the max-Z corner is SOUTH; normalise explicitly.
      const cTL = worldToLngLat(originX, originZ);
      const cBR = worldToLngLat(originX + sizeM, originZ + sizeM);
      const west = Math.min(cTL.lng, cBR.lng);
      const east = Math.max(cTL.lng, cBR.lng);
      const south = Math.min(cTL.lat, cBR.lat);
      const north = Math.max(cTL.lat, cBR.lat);

      const z = pickZoom(sizeM);
      const built = await buildWindowSampler(z, west, east, south, north);
      if (!built) {
        // No usable imagery for this window — keep the previous drape + window.
        return;
      }

      await refillDrape(built.sampler, originX, originZ, sizeM);
      // Commit: slide the drape window onto the new footprint AFTER the bytes are
      // in place, so the material never samples new window UVs against old bytes.
      winValue.set(originX, originZ, sizeM, sizeM);
      state = { centerX, centerZ, sizeM, agl };
      console.log(
        `[crete] map stream: z${z} window ${(sizeM / 1000).toFixed(1)}km, ${built.tiles} tiles` +
          ` (${built.skipped} sea-skipped) | cache ${tileStats.mem}mem/${tileStats.disk}disk/${tileStats.net}net`,
      );

      // async prefetch for predicted forward window (frustum-biased) — no pop/hitch on CreteMapStream
      const fwdSize = Math.min(sizeM * 1.15, ws);
      const fwdHalf = fwdSize / 2;
      const fwdCenterX = centerX + biasX * 0.6;
      const fwdCenterZ = centerZ + biasZ * 0.6;
      const fO = fwdCenterX - fwdHalf, fZ = fwdCenterZ - fwdHalf;
      const cTLf = worldToLngLat(fO, fZ);
      const cBRf = worldToLngLat(fO + fwdSize, fZ + fwdSize);
      const zf = pickZoom(fwdSize);
      prefetchTilesForWindow(zf,
        Math.min(cTLf.lng, cBRf.lng), Math.max(cTLf.lng, cBRf.lng),
        Math.min(cTLf.lat, cBRf.lat), Math.max(cTLf.lat, cBRf.lat)
      );
    } catch (err) {
      // Any failure (fetch/build/compute) → previous drape stays; log once.
      console.warn('[crete] map stream: rebuild failed, keeping previous drape', err);
    } finally {
      busy = false;
    }
  }

  engine.onUpdate(() => {
    void maybeRestream();
  });
}
