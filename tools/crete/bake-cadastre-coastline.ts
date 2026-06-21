/**
 * bake-cadastre-coastline.ts — Cadastre-Derived Shoreline: the OSM coastline
 * topology snapped to the waterline VISIBLE IN THE Hellenic Cadastre LSO_v2
 * orthophoto, baked offline as a schema-identical GeoJSON.
 *
 * WHY: the crete world (?scene=crete) surfaces the LIVE Hellenic Cadastre LSO_v2
 * orthophoto. coastline-sds.geojson (OSM snapped to Sentinel-2 MNDWI) was tuned
 * against a DIFFERENT image, so its waterline no longer lines up with the cadastre
 * surface the user actually sees. This bake derives the coastline FROM the same
 * cadastre imagery, so the trim + overlay line match the ground exactly.
 *
 * METHOD — identical pipeline to bake-sds-coastline.ts ("snap OSM to the visible
 * waterline"), with TWO swaps only:
 *   1. IMAGERY: instead of Sentinel-2 COGs over S3, fetch Hellenic Cadastre LSO_v2
 *      XYZ tiles (z15, 256 px, EPSG:3857, 404 over sea) and composite them per
 *      coastal work-cell into one RGB buffer with a (lng,lat)->[r,g,b] sampler.
 *      Tiles are DECODED WITH `sharp` (bun has no Image/OffscreenCanvas).
 *   2. WATER TEST: instead of MNDWI(B03/B11), use a `waterness(r,g,b)` heuristic on
 *      the cadastre RGB — open sea is dark + blue-dominant, land is brighter / not
 *      blue-dominant. Everything else (OSM ring load, uniform resample, per-cell
 *      coastal windowing, the wide-baseline coast-normal march that snaps each ring
 *      vertex to the nearest sub-pixel water->land crossing, the contrast gate, local
 *      Otsu threshold, post-snap cyclic smoothing, the metrics logging, and the
 *      schema-identical FeatureCollection-of-Polygons output) is carried over.
 *
 * Output: public/crete/coastline-cadastre.geojson — same schema as coastline.geojson
 * & coastline-sds.geojson, so CreteLandMask + CreteCoastlineOverlay use it as-is.
 *
 * Run:  bun tools/crete/bake-cadastre-coastline.ts            (whole island — LONG)
 *       bun tools/crete/bake-cadastre-coastline.ts --limit 4  (first N coastal cells, test)
 *       bun tools/crete/bake-cadastre-coastline.ts --bbox 35.24,23.45,35.32,23.60  (S,W,N,E subset)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import proj4 from 'proj4';
import sharp from 'sharp';

// -- CONFIG ------------------------------------------------------------------
const IN = path.resolve(import.meta.dirname, '../../public/crete/coastline.geojson');
const OUT = path.resolve(import.meta.dirname, '../../public/crete/coastline-cadastre.geojson');

/** Hellenic Cadastre LSO_v2 orthophoto tile URL — z/y/x order, EPSG:3857, 256 px,
 *  404 over open sea. Same endpoint as src/crete/CreteMapStream.ts. */
const tileUrl = (z: number, x: number, y: number): string =>
  `https://tiles-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services/LSO_v2/MapServer/tile/${z}/${y}/${x}`;

const TILE_PX = 256;
const TILE_Z = 15;            // cadastre zoom for the bake (~4.8 m/px at this latitude)
const CELL_DEG = 0.08;        // ~7 km coastal work cells (one tile-composite read each)
const BUFFER_M = 400;         // read margin around a cell (covers search radius)
const CTRL_M = 18;            // uniform control-point spacing (keeps coves/headlands; stable)
const SEARCH_M = 250;         // march +/- this along the coast-normal for the waterline
const STEP_M = 4;             // march step (sub-pixel via bilinear between steps)
const NORMAL_BASE_M = 45;     // baseline for the coast tangent/normal (>> CTRL_M = stable dir)
const WATER_SMOOTH_M = 10;    // box-average waterness over +/-this (kills glint/whitewater speckle)
const CONTRAST_MARGIN = 0.06; // a crossing must span clear land(<thr-m) AND clear water(>thr+m)
const SMOOTH_PASSES = 1;      // post-snap cyclic moving-average pass (light de-jitter, keep detail)

// -- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = getArg('--limit') ? parseInt(getArg('--limit')!, 10) : Infinity;
const SUB = getArg('--bbox')?.split(',').map(Number); // S,W,N,E

// -- geodesy helpers ----------------------------------------------------------
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');

interface LL { lon: number; lat: number; }
type Ring = LL[];

// -- web-mercator tile math (mirrors src/crete/CreteMapStream.ts) -------------
/** Longitude -> fractional tile X at zoom z. */
function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}
/** Latitude -> fractional tile Y at zoom z (asinh form, +/-85.0511 clamp). */
function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const rad = (clampedLat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

// -- 1. cadastre tile reader (sharp-decoded, in-memory cache) -----------------
/** A decoded tile's raw RGBA bytes, or null for a 404 (open sea). */
interface Tile { data: Buffer; w: number; h: number; }
const tileCache = new Map<string, Promise<Tile | null>>();

/** Fetch + sharp-decode one cadastre tile to raw RGBA. 404/error -> null (sea).
 *  bun has NO Image/createImageBitmap/OffscreenCanvas — sharp is the only decode
 *  path. Memoised by `z/x/y` so a tile shared by neighbouring cells is fetched once. */
function loadTile(z: number, x: number, y: number): Promise<Tile | null> {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const job = (async (): Promise<Tile | null> => {
    try {
      const r = await fetch(tileUrl(z, x, y));
      if (!r.ok) return null; // 404 over sea
      const buf = Buffer.from(await r.arrayBuffer());
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    } catch {
      return null; // network failure -> treat as sea, never throw
    }
  })();
  tileCache.set(key, job);
  return job;
}

/** A geographic-window orthophoto sampler: (lng,lat) -> sRGB [0,1] triple.
 *  Mirrors buildWindowSampler in CreteMapStream: composite every covering tile,
 *  index pixels by fractional tile coordinate. Missing tiles (sea) read black. */
type WindowSampler = (lng: number, lat: number) => [number, number, number];

async function buildWindowSampler(
  z: number, west: number, east: number, south: number, north: number,
): Promise<{ sample: WindowSampler; placed: number } | null> {
  const n = 2 ** z;
  const clampTile = (v: number): number => Math.min(Math.max(v, 0), n - 1);
  const xMin = clampTile(Math.floor(lngToTileX(west, z)));
  const xMax = clampTile(Math.floor(lngToTileX(east, z)));
  // Tile Y increases SOUTHWARD: north edge -> smallest Y.
  const yMin = clampTile(Math.floor(latToTileY(north, z)));
  const yMax = clampTile(Math.floor(latToTileY(south, z)));
  const tilesX = xMax - xMin + 1;
  const tilesY = yMax - yMin + 1;
  if (tilesX <= 0 || tilesY <= 0) return null;

  const W = tilesX * TILE_PX;
  const H = tilesY * TILE_PX;
  const rgba = new Uint8Array(W * H * 4); // black/transparent = sea by default

  // Fetch every covering tile and blit it into the composite buffer.
  let placed = 0;
  const jobs: { rx: number; ry: number }[] = [];
  for (let ry = 0; ry < tilesY; ry++) for (let rx = 0; rx < tilesX; rx++) jobs.push({ rx, ry });
  await Promise.all(jobs.map(async ({ rx, ry }) => {
    const t = await loadTile(z, xMin + rx, yMin + ry);
    if (!t) return; // sea -> leave black
    const dx = rx * TILE_PX, dy = ry * TILE_PX;
    // sharp gives RGBA already; copy row by row into the composite.
    for (let py = 0; py < TILE_PX && py < t.h; py++) {
      const srcRow = py * t.w * 4;
      const dstRow = ((dy + py) * W + dx) * 4;
      rgba.set(t.data.subarray(srcRow, srcRow + Math.min(TILE_PX, t.w) * 4), dstRow);
    }
    placed++;
  }));
  if (placed === 0) return null; // entirely sea/failed -> caller keeps the OSM vertex

  // (lng,lat) -> composite pixel -> [r,g,b] in 0..1 (mirror buildCreteSatellite).
  const sample: WindowSampler = (lng, lat) => {
    const fx = (lngToTileX(lng, z) - xMin) * TILE_PX;
    const fy = (latToTileY(lat, z) - yMin) * TILE_PX;
    const px = Math.min(Math.max(Math.round(fx), 0), W - 1);
    const py = Math.min(Math.max(Math.round(fy), 0), H - 1);
    const idx = (py * W + px) * 4;
    return [(rgba[idx] ?? 0) / 255, (rgba[idx + 1] ?? 0) / 255, (rgba[idx + 2] ?? 0) / 255];
  };
  return { sample, placed };
}

// -- 2. water test (replaces MNDWI) ------------------------------------------
/** Cadastre waterness: HIGH over open sea (dark + blue-dominant), LOW over land
 *  (brighter / not blue-dominant). luma = Rec.601. The blue-dominance term lifts
 *  sea above bright sand/rock; the (1-luma) term lifts dark deep water; together
 *  they separate cleanly under a per-cell Otsu threshold. Black (sea/404) -> high. */
function waterness(r: number, g: number, b: number): number {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return (b - Math.max(r, g)) + (1 - luma) * 0.5;
}

// -- 3. Otsu threshold over sampled waterness --------------------------------
function otsu(values: number[], lo: number, hi: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 32) return (lo + hi) / 2; // fallback: midpoint
  const BINS = 256, scale = (BINS - 1) / (hi - lo);
  const hist = new Float64Array(BINS);
  for (const v of finite) hist[Math.max(0, Math.min(BINS - 1, Math.round((Math.max(lo, Math.min(hi, v)) - lo) * scale)))]++;
  const total = finite.length;
  let sum = 0; for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = -1, thrBin = BINS / 2;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thrBin = i; }
  }
  return lo + thrBin / scale;
}

// -- 4. ring resample (uniform) + cyclic smooth (identical to SDS bake) -------
const mPerDeg = (lat: number): [number, number] => [111320 * Math.cos((lat * Math.PI) / 180), 110540];

/** Resample a ring to ~uniform `step`-metre spacing by arc length. Both densifies
 *  long generalized OSM segments AND decimates over-dense ones -> stable, low-jitter
 *  control points whose count doesn't depend on OSM's irregular vertex density. */
function resample(ring: Ring, step: number): Ring {
  if (ring.length < 3) return ring;
  const out: Ring = [ring[0]];
  let acc = 0; // distance accumulated since the last emitted point
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const [mLon, mLat] = mPerDeg(a.lat);
    const seg = Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
    if (seg < 1e-9) continue;
    let pos = 0; // current position along this segment (metres)
    while (acc + (seg - pos) >= step) {
      pos += step - acc;          // advance to the next sample
      const t = pos / seg;
      out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
      acc = 0;
    }
    acc += seg - pos;             // leftover carries into the next segment
  }
  const first = out[0], last = out[out.length - 1];
  if (first.lon !== last.lon || first.lat !== last.lat) out.push({ ...first }); // close
  return out;
}

/** Cyclic moving-average smooth of a closed ring (preserves closure). */
function smoothRing(ring: Ring, passes: number): void {
  const m = ring.length - 1; // unique points (ring is closed: last == first)
  if (m < 6) return;
  for (let p = 0; p < passes; p++) {
    const src = ring.slice(0, m).map((q) => ({ ...q }));
    for (let i = 0; i < m; i++) {
      const a = src[(i - 1 + m) % m], b = src[i], c = src[(i + 1) % m];
      ring[i] = { lon: 0.25 * a.lon + 0.5 * b.lon + 0.25 * c.lon, lat: 0.25 * a.lat + 0.5 * b.lat + 0.25 * c.lat };
    }
    ring[m] = { ...ring[0] };
  }
}

interface Cell { key: string; lon0: number; lat0: number; members: { ri: number; vi: number }[]; }

async function main(): Promise<void> {
  const t0 = Date.now();
  const fc = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const inRings: Ring[] = fc.features
    .filter((f: any) => f.geometry?.type === 'Polygon')
    .map((f: any) => f.geometry.coordinates[0].map((c: number[]) => ({ lon: c[0], lat: c[1] })));
  console.log(`[cadastre] OSM rings: ${inRings.length}, ${inRings.reduce((s, r) => s + r.length, 0)} pts`);

  // uniform resample -> stable, low-jitter control points
  const rings = inRings.map((r) => resample(r, CTRL_M));
  console.log(`[cadastre] resampled to ${rings.reduce((s, r) => s + r.length, 0)} control pts (~${CTRL_M}m)`);
  const ringSnaps = new Int32Array(rings.length); // snapped-vertex count per ring

  // bin vertices into coastal work cells
  const cells = new Map<string, Cell>();
  const inSub = (lat: number, lon: number): boolean =>
    !SUB || (lat >= SUB[0] && lat <= SUB[2] && lon >= SUB[1] && lon <= SUB[3]);
  for (let ri = 0; ri < rings.length; ri++) {
    for (let vi = 0; vi < rings[ri].length; vi++) {
      const p = rings[ri][vi];
      if (!inSub(p.lat, p.lon)) continue;
      const gx = Math.floor(p.lon / CELL_DEG), gy = Math.floor(p.lat / CELL_DEG);
      const key = `${gx},${gy}`;
      let cell = cells.get(key);
      if (!cell) { cell = { key, lon0: gx * CELL_DEG, lat0: gy * CELL_DEG, members: [] }; cells.set(key, cell); }
      cell.members.push({ ri, vi });
    }
  }
  let cellList = [...cells.values()].sort((a, b) => b.members.length - a.members.length);
  if (Number.isFinite(LIMIT)) cellList = cellList.slice(0, LIMIT);
  console.log(`[cadastre] ${cellList.length} coastal cells to process${Number.isFinite(LIMIT) ? ' (limited)' : ''}`);

  // pre-snap copy: normals + march origins use ORIGINAL positions so the result is
  // order-independent (safe to process cells concurrently).
  const orig = rings.map((r) => r.map((p) => ({ ...p })));

  // local metres-per-degree at Crete's latitude -> convert march distances to lng/lat
  // offsets. (No UTM round-trip needed: cadastre sampling is geographic.)
  const [M_LON, M_LAT] = mPerDeg(35.24);

  let snapped = 0, kept = 0, cellsDone = 0, cellsSkipped = 0;
  const moves: number[] = []; // |bestT| per snapped vertex, for a displacement histogram

  async function processCell(cell: Cell): Promise<void> {
    // cell lng/lat bbox (+buffer in degrees) -> composite the covering cadastre tiles.
    const dLon = BUFFER_M / M_LON, dLat = BUFFER_M / M_LAT;
    const west = cell.lon0 - dLon, east = cell.lon0 + CELL_DEG + dLon;
    const south = cell.lat0 - dLat, north = cell.lat0 + CELL_DEG + dLat;
    let win;
    try {
      win = await buildWindowSampler(TILE_Z, west, east, south, north);
    } catch { cellsSkipped++; return; }
    if (!win) { cellsSkipped++; return; }
    const photo = win.sample;

    // waterness at a geographic point.
    const wAt = (lon: number, lat: number): number => {
      const [r, g, b] = photo(lon, lat);
      return waterness(r, g, b);
    };
    // box-averaged waterness (3x3 at +/-WATER_SMOOTH_M): suppresses sun-glint /
    // whitewater / wet-sand speckle that otherwise creates spurious crossings.
    const wS = (lon: number, lat: number): number => {
      let sum = 0, cnt = 0;
      const de = WATER_SMOOTH_M / M_LON, dn = WATER_SMOOTH_M / M_LAT;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          const v = wAt(lon + i * de, lat + j * dn);
          if (Number.isFinite(v)) { sum += v; cnt++; }
        }
      return cnt ? sum / cnt : NaN;
    };
    // local Otsu: sample waterness on a coarse grid over the cell (20 m steps).
    const probe: number[] = [];
    const gstepLon = 20 / M_LON, gstepLat = 20 / M_LAT;
    for (let lon = west; lon <= east; lon += gstepLon)
      for (let lat = south; lat <= north; lat += gstepLat) probe.push(wAt(lon, lat));
    // waterness range is roughly [-1, 1.5]; give Otsu a generous bracket.
    const thr = otsu(probe, -1.5, 1.5);

    const off = Math.max(1, Math.round(NORMAL_BASE_M / CTRL_M)); // wide-baseline normal offset
    // snap each control point along its (stable) coast-normal to the visible waterline
    for (const { ri, vi } of cell.members) {
      const oring = orig[ri];
      const L = oring.length;
      const prev = oring[(vi - off + L) % L];
      const next = oring[(vi + off) % L];
      const v = oring[vi];
      // tangent in metres (local-flat lng/lat -> m), rotated 90 deg -> unit normal.
      let tx = (next.lon - prev.lon) * M_LON, ty = (next.lat - prev.lat) * M_LAT;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = -ty, ny = tx; // unit normal (metres)
      // sample the smoothed waterness along the normal (convert march metres -> deg).
      const ts: number[] = [], ws: number[] = [];
      for (let t = -SEARCH_M; t <= SEARCH_M + 1e-6; t += STEP_M) {
        ts.push(t);
        ws.push(wS(v.lon + (t * nx) / M_LON, v.lat + (t * ny) / M_LAT));
      }
      // gate: only snap where the normal actually spans clear land AND clear water.
      let lo = Infinity, hi = -Infinity;
      for (const x of ws) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      let bestT = NaN, bestAbs = Infinity;
      if (hi >= thr + CONTRAST_MARGIN && lo <= thr - CONTRAST_MARGIN) {
        for (let i = 1; i < ts.length; i++) {
          const a = ws[i - 1], b = ws[i];
          if (!Number.isFinite(a) || !Number.isFinite(b) || (a - thr) * (b - thr) >= 0) continue;
          const tc = ts[i - 1] + ((thr - a) / (b - a)) * STEP_M;
          if (Math.abs(tc) < bestAbs) { bestAbs = Math.abs(tc); bestT = tc; }
        }
      }
      if (Number.isFinite(bestT)) {
        rings[ri][vi] = { lon: v.lon + (bestT * nx) / M_LON, lat: v.lat + (bestT * ny) / M_LAT };
        snapped++; ringSnaps[ri]++; moves.push(Math.abs(bestT));
      } else kept++;
    }
    cellsDone++;
    if (cellsDone % 20 === 0) console.log(`[cadastre]   ${cellsDone}/${cellList.length} cells, ${snapped} snapped, ${kept} kept`);
  }

  // concurrency pool (the cadastre tile server handles this fine)
  const CONCURRENCY = 6;
  for (let i = 0; i < cellList.length; i += CONCURRENCY) {
    await Promise.all(cellList.slice(i, i + CONCURRENCY).map(processCell));
  }

  // post-snap smoothing: remove residual per-control-point jitter on refined rings
  let smoothedRings = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    if (ringSnaps[ri] >= 3) { smoothRing(rings[ri], SMOOTH_PASSES); smoothedRings++; }
  }
  console.log(`[cadastre] smoothed ${smoothedRings} refined rings (${SMOOTH_PASSES} passes)`);

  // -- 5. write schema-identical output ---------------------------------------
  const features = inRings.map((_orig, i) => {
    const coords = rings[i].map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
    const a = coords[0], z = coords[coords.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) coords.push([a[0], a[1]]);
    return { type: 'Feature' as const, properties: { i, points: coords.length }, geometry: { type: 'Polygon' as const, coordinates: [coords] } };
  });
  const out = {
    type: 'FeatureCollection' as const,
    properties: {
      source: 'Cadastre-derived: OSM natural=coastline snapped to Hellenic Cadastre LSO_v2 waterline',
      method: `waterness(b-max(r,g) + (1-luma)*0.5) on LSO_v2 z${TILE_Z} tiles + local Otsu + contrast-gated normal-march sub-pixel; ctrl ${CTRL_M}m, normal ${NORMAL_BASE_M}m, search ${SEARCH_M}m, smooth ${SMOOTH_PASSES}x`,
    },
    features,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n[cadastre] OK ${OUT}`);
  console.log(`[cadastre] ${features.length} rings, ${features.reduce((s, f) => s + f.geometry.coordinates[0].length, 0)} pts`);
  console.log(`[cadastre] snapped ${snapped} / kept ${kept} (${((snapped / (snapped + kept || 1)) * 100).toFixed(0)}% of coastal vertices refined to cadastre waterline)`);
  console.log(`[cadastre] cells ${cellsDone} done / ${cellsSkipped} skipped, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (moves.length) {
    moves.sort((a, b) => a - b);
    const q = (p: number): number => moves[Math.min(moves.length - 1, Math.floor(p * moves.length))];
    const atLimit = moves.filter((m) => m >= SEARCH_M - STEP_M).length;
    console.log(`[cadastre] move dist (m): median ${q(0.5).toFixed(0)}, p90 ${q(0.9).toFixed(0)}, max ${moves[moves.length - 1].toFixed(0)}; ` +
      `${((atLimit / moves.length) * 100).toFixed(1)}% pinned at search limit (suspicious if high)`);
  }
}

await main();
