/**
 * bake-sds-coastline.ts — Satellite-Derived Shoreline (SDS) refinement of the
 * OSM coastline for Crete, baked offline as a schema-identical GeoJSON.
 *
 * WHY (from deep research): no free vector coastline is near 1 m — OSM, GSV (~30 m),
 * EU-Hydro (~12-25 m) are all tens of meters & tide-uncorrected. The accurate path
 * is satellite-derived shorelines: a multispectral WATER INDEX (MNDWI, not naive
 * RGB) + sub-pixel edge, run offline. On Sentinel-2 (10 m) this reaches ~3-10 m
 * RMSE; Crete is microtidal (~10-20 cm range) so the tide error that dominates SDS
 * elsewhere is near-moot here — we land at the good end of the range, free.
 *
 * METHOD — "snap OSM to the SDS waterline" (topology from OSM, precision from S2):
 *   1. Pick the lowest-cloud summer Sentinel-2 L2A scene per MGRS tile over Crete
 *      from the public Earth Search STAC (AWS open data, no auth).
 *   2. Read B03 (green, 10 m) + B11 (SWIR1, 20 m) Cloud-Optimized GeoTIFFs WINDOWED
 *      over coastal cells via HTTP range reads (geotiff.js).
 *   3. MNDWI = (green - swir1)/(green + swir1). Local Otsu threshold per window.
 *   4. Densify each OSM ring, then move every vertex along the local coast-normal to
 *      the nearest sub-pixel MNDWI land/water crossing (bilinear). No crossing in
 *      range -> keep the original vertex. Ring order/closure is preserved.
 *   5. Write public/crete/coastline-sds.geojson — same FeatureCollection-of-Polygons
 *      schema as coastline.geojson, so CreteLandMask + CreteCoastline use it as-is.
 *
 * Run:  bun tools/crete/bake-sds-coastline.ts            (whole island)
 *       bun tools/crete/bake-sds-coastline.ts --limit 4  (first N coastal cells, test)
 *       bun tools/crete/bake-sds-coastline.ts --bbox 35.24,23.45,35.32,23.60  (S,W,N,E subset)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import proj4 from 'proj4';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const IN = path.resolve(import.meta.dirname, '../../public/crete/coastline.geojson');
const OUT = path.resolve(import.meta.dirname, '../../public/crete/coastline-sds.geojson');
const STAC = ['https://earth-search', '.aws.element84.com/v1/search'].join('');
const CRETE_BBOX = [23.35, 34.70, 26.42, 35.80]; // W,S,E,N — Crete + Gavdos + islets
const SEASON = '2023-06-01T00:00:00Z/2023-09-30T00:00:00Z'; // calm, low-cloud summer
const MAX_CLOUD = 10;
const CELL_DEG = 0.08;        // ~7 km coastal work cells (one raster read each)
const BUFFER_M = 400;         // read margin around a cell (covers search radius)
const CTRL_M = 18;            // uniform control-point spacing (keeps coves/headlands; stable)
const SEARCH_M = 250;         // march +/- this along the coast-normal for the waterline
const STEP_M = 4;             // march step (sub-pixel via bilinear between steps)
const NORMAL_BASE_M = 45;     // baseline for the coast tangent/normal (>> CTRL_M = stable dir)
const MNDWI_SMOOTH_M = 10;    // box-average MNDWI over +/-this (kills glint/whitewater speckle)
const CONTRAST_MARGIN = 0.06; // a crossing must span clear land(<thr-m) AND water(>thr+m)
const SMOOTH_PASSES = 1;      // post-snap cyclic moving-average pass (light de-jitter, keep detail)

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = getArg('--limit') ? parseInt(getArg('--limit')!, 10) : Infinity;
const SUB = getArg('--bbox')?.split(',').map(Number); // S,W,N,E

// ── geodesy helpers ───────────────────────────────────────────────────────────
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
const utmDef = (epsg: number): string =>
  `+proj=utm +zone=${epsg - (epsg >= 32700 ? 32700 : 32600)}${epsg >= 32700 ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;

interface LL { lon: number; lat: number; }
type Ring = LL[];

// ── 1. SCENE SELECTION ─────────────────────────────────────────────────────────
interface Scene { tile: string; epsg: number; bbox: number[]; b03: string; b11: string; cloud: number; }

async function pickScenes(): Promise<Scene[]> {
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox: CRETE_BBOX,
    datetime: SEASON,
    query: { 'eo:cloud_cover': { lt: MAX_CLOUD } },
    limit: 400,
    sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
  };
  const r = await fetch(STAC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d: any = await r.json();
  const best = new Map<string, Scene>();
  for (const f of d.features ?? []) {
    const tile = String(f.id).split('_')[1]; // S2A_34SGE_... -> 34SGE
    const cloud = f.properties['eo:cloud_cover'];
    if (best.has(tile) && best.get(tile)!.cloud <= cloud) continue;
    best.set(tile, { tile, epsg: f.properties['proj:epsg'], bbox: f.bbox, b03: f.assets.green.href, b11: f.assets.swir16.href, cloud });
  }
  const scenes = [...best.values()].sort((a, b) => a.tile.localeCompare(b.tile));
  console.log(`[sds] scenes: ${scenes.length} MGRS tiles — ${scenes.map((s) => `${s.tile}(${s.cloud.toFixed(1)}%)`).join(' ')}`);
  return scenes;
}

/** scene whose bbox contains (lon,lat); lowest-cloud wins on overlap. */
function sceneFor(scenes: Scene[], lon: number, lat: number): Scene | null {
  let best: Scene | null = null;
  for (const s of scenes) {
    if (lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3]) {
      if (!best || s.cloud < best.cloud) best = s;
    }
  }
  return best;
}

// ── 2. COG windowed reader (cached) ───────────────────────────────────────────
interface Cog { img: GeoTIFFImage; ox: number; oy: number; rx: number; ry: number; }
const cogCache = new Map<string, Promise<Cog>>();
function openCog(href: string): Promise<Cog> {
  if (!cogCache.has(href)) {
    cogCache.set(href, (async () => {
      const tiff = await fromUrl(href);
      const img = await tiff.getImage();
      const [ox, oy] = img.getOrigin();
      const [rx, ry] = img.getResolution();
      return { img, ox, oy, rx, ry };
    })());
  }
  return cogCache.get(href)!;
}

/** Read a UTM-extent window; returns the raster + a bilinear UTM sampler. */
async function readField(href: string, Emin: number, Emax: number, Nmin: number, Nmax: number) {
  const c = await openCog(href);
  const x0 = Math.floor((Emin - c.ox) / c.rx), x1 = Math.ceil((Emax - c.ox) / c.rx);
  const py0 = Math.floor((Nmax - c.oy) / c.ry), py1 = Math.ceil((Nmin - c.oy) / c.ry); // ry<0
  const left = Math.max(0, Math.min(x0, x1)), right = Math.min(c.img.getWidth(), Math.max(x0, x1));
  const top = Math.max(0, Math.min(py0, py1)), bot = Math.min(c.img.getHeight(), Math.max(py0, py1));
  if (right - left < 2 || bot - top < 2) return null;
  const rasters = await c.img.readRasters({ window: [left, top, right, bot] });
  const data = rasters[0] as unknown as { [i: number]: number; length: number };
  const W = right - left, H = bot - top;
  // bilinear sample at UTM (E,N)
  const sample = (E: number, N: number): number => {
    const fx = (E - c.ox) / c.rx - left - 0.5;
    const fy = (N - c.oy) / c.ry - top - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) return NaN;
    const tx = fx - ix, ty = fy - iy;
    const a = data[iy * W + ix], b = data[iy * W + ix + 1];
    const cc = data[(iy + 1) * W + ix], dd = data[(iy + 1) * W + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty;
  };
  return { sample, W, H };
}

// ── 3. Otsu threshold over sampled MNDWI ──────────────────────────────────────
function otsu(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 32) return 0; // fallback: 0 separates water(+)/land(-)
  const BINS = 256, lo = -1, hi = 1, scale = (BINS - 1) / (hi - lo);
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

// ── 4. ring resample (uniform) + cyclic smooth ────────────────────────────────
const mPerDeg = (lat: number): [number, number] => [111320 * Math.cos((lat * Math.PI) / 180), 110540];

/** Resample a ring to ~uniform `step`-metre spacing by arc length. Both densifies
 *  long generalized OSM segments AND decimates over-dense ones → stable, low-jitter
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
  console.log(`[sds] OSM rings: ${inRings.length}, ${inRings.reduce((s, r) => s + r.length, 0)} pts`);

  // uniform resample → stable, low-jitter control points
  const rings = inRings.map((r) => resample(r, CTRL_M));
  console.log(`[sds] resampled to ${rings.reduce((s, r) => s + r.length, 0)} control pts (~${CTRL_M}m)`);
  const ringSnaps = new Int32Array(rings.length); // snapped-vertex count per ring

  const scenes = await pickScenes();
  if (scenes.length === 0) { console.error('[sds] no scenes; aborting'); process.exit(1); }

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
  console.log(`[sds] ${cellList.length} coastal cells to process${Number.isFinite(LIMIT) ? ' (limited)' : ''}`);

  // pre-snap copy: normals + march origins use ORIGINAL positions so the result is
  // order-independent (safe to process cells concurrently).
  const orig = rings.map((r) => r.map((p) => ({ ...p })));

  let snapped = 0, kept = 0, cellsDone = 0, cellsSkipped = 0;
  const moves: number[] = []; // |bestT| per snapped vertex, for a displacement histogram

  async function processCell(cell: Cell): Promise<void> {
    const s = sceneFor(scenes, cell.lon0 + CELL_DEG / 2, cell.lat0 + CELL_DEG / 2);
    if (!s) { cellsSkipped++; return; }
    const toUtm = (lon: number, lat: number): [number, number] => proj4('EPSG:4326', utmDef(s.epsg), [lon, lat]) as [number, number];
    const toLL = (E: number, N: number): [number, number] => proj4(utmDef(s.epsg), 'EPSG:4326', [E, N]) as [number, number];
    // cell UTM extent (+buffer)
    const corners = [[cell.lon0, cell.lat0], [cell.lon0 + CELL_DEG, cell.lat0], [cell.lon0, cell.lat0 + CELL_DEG], [cell.lon0 + CELL_DEG, cell.lat0 + CELL_DEG]].map(([lo, la]) => toUtm(lo, la));
    const Emin = Math.min(...corners.map((c) => c[0])) - BUFFER_M, Emax = Math.max(...corners.map((c) => c[0])) + BUFFER_M;
    const Nmin = Math.min(...corners.map((c) => c[1])) - BUFFER_M, Nmax = Math.max(...corners.map((c) => c[1])) + BUFFER_M;
    let green, swir;
    try {
      [green, swir] = await Promise.all([
        readField(s.b03, Emin, Emax, Nmin, Nmax),
        readField(s.b11, Emin, Emax, Nmin, Nmax),
      ]);
    } catch { cellsSkipped++; return; }
    if (!green || !swir) { cellsSkipped++; return; }
    const mndwi = (E: number, N: number): number => {
      const g = green!.sample(E, N), w = swir!.sample(E, N);
      if (!Number.isFinite(g) || !Number.isFinite(w) || g + w < 1e-3) return NaN;
      return (g - w) / (g + w);
    };
    // box-averaged MNDWI (3x3 at +/-MNDWI_SMOOTH_M): suppresses sun-glint / whitewater /
    // wet-sand speckle that otherwise creates spurious crossings → jitter.
    const mndwiS = (E: number, N: number): number => {
      let sum = 0, cnt = 0;
      for (let de = -MNDWI_SMOOTH_M; de <= MNDWI_SMOOTH_M; de += MNDWI_SMOOTH_M)
        for (let dn = -MNDWI_SMOOTH_M; dn <= MNDWI_SMOOTH_M; dn += MNDWI_SMOOTH_M) {
          const v = mndwi(E + de, N + dn); if (Number.isFinite(v)) { sum += v; cnt++; }
        }
      return cnt ? sum / cnt : NaN;
    };
    // local Otsu: sample MNDWI on a coarse grid over the cell
    const probe: number[] = [];
    for (let e = Emin; e <= Emax; e += 20) for (let n = Nmin; n <= Nmax; n += 20) probe.push(mndwi(e, n));
    const thr = otsu(probe);

    const off = Math.max(1, Math.round(NORMAL_BASE_M / CTRL_M)); // wide-baseline normal offset
    // snap each control point along its (stable) coast-normal to the real waterline
    for (const { ri, vi } of cell.members) {
      const oring = orig[ri];
      const L = oring.length;
      const prev = oring[(vi - off + L) % L];
      const next = oring[(vi + off) % L];
      const [Ev, Nv] = toUtm(oring[vi].lon, oring[vi].lat);
      const [Ep, Np] = toUtm(prev.lon, prev.lat);
      const [En, Nn] = toUtm(next.lon, next.lat);
      let tx = En - Ep, ty = Nn - Np; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = -ty, ny = tx; // unit normal
      // sample the smoothed MNDWI along the normal.
      const ts: number[] = [], ms: number[] = [];
      for (let t = -SEARCH_M; t <= SEARCH_M + 1e-6; t += STEP_M) { ts.push(t); ms.push(mndwiS(Ev + t * nx, Nv + t * ny)); }
      // gate: only snap where the normal actually spans clear land AND clear water
      // (rejects open-water / inland-only normals & sun-glint speckle). Then take the
      // crossing nearest the original vertex.
      let lo = Infinity, hi = -Infinity;
      for (const v of ms) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      let bestT = NaN, bestAbs = Infinity;
      if (hi >= thr + CONTRAST_MARGIN && lo <= thr - CONTRAST_MARGIN) {
        for (let i = 1; i < ts.length; i++) {
          const a = ms[i - 1], b = ms[i];
          if (!Number.isFinite(a) || !Number.isFinite(b) || (a - thr) * (b - thr) >= 0) continue;
          const tc = ts[i - 1] + ((thr - a) / (b - a)) * STEP_M;
          if (Math.abs(tc) < bestAbs) { bestAbs = Math.abs(tc); bestT = tc; }
        }
      }
      if (Number.isFinite(bestT)) {
        const [lon, lat] = toLL(Ev + bestT * nx, Nv + bestT * ny);
        rings[ri][vi] = { lon, lat };
        snapped++; ringSnaps[ri]++; moves.push(Math.abs(bestT));
      } else kept++;
    }
    cellsDone++;
    if (cellsDone % 20 === 0) console.log(`[sds]   ${cellsDone}/${cellList.length} cells, ${snapped} snapped, ${kept} kept`);
  }

  // concurrency pool (public S3 COGs handle this fine)
  const CONCURRENCY = 8;
  for (let i = 0; i < cellList.length; i += CONCURRENCY) {
    await Promise.all(cellList.slice(i, i + CONCURRENCY).map(processCell));
  }

  // post-snap smoothing: remove residual per-control-point jitter on refined rings
  let smoothedRings = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    if (ringSnaps[ri] >= 3) { smoothRing(rings[ri], SMOOTH_PASSES); smoothedRings++; }
  }
  console.log(`[sds] smoothed ${smoothedRings} refined rings (${SMOOTH_PASSES} passes)`);

  // ── 5. write schema-identical output ───────────────────────────────────────
  const features = inRings.map((_orig, i) => {
    const coords = rings[i].map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
    const a = coords[0], z = coords[coords.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) coords.push([a[0], a[1]]);
    return { type: 'Feature' as const, properties: { i, points: coords.length }, geometry: { type: 'Polygon' as const, coordinates: [coords] } };
  });
  const out = {
    type: 'FeatureCollection' as const,
    properties: {
      source: 'SDS: OSM natural=coastline snapped to Sentinel-2 MNDWI sub-pixel waterline',
      method: `MNDWI(B03/B11) box-smoothed + local Otsu + contrast-gated normal-march sub-pixel; ctrl ${CTRL_M}m, normal ${NORMAL_BASE_M}m, search ${SEARCH_M}m, smooth ${SMOOTH_PASSES}x`,
      season: SEASON, scenes: scenes.map((s) => `${s.tile}@${s.cloud.toFixed(1)}%`),
    },
    features,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n[sds] ✓ ${OUT}`);
  console.log(`[sds] ${features.length} rings, ${features.reduce((s, f) => s + f.geometry.coordinates[0].length, 0)} pts`);
  console.log(`[sds] snapped ${snapped} / kept ${kept} (${((snapped / (snapped + kept || 1)) * 100).toFixed(0)}% of coastal vertices refined to satellite waterline)`);
  console.log(`[sds] cells ${cellsDone} done / ${cellsSkipped} skipped, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (moves.length) {
    moves.sort((a, b) => a - b);
    const q = (p: number): number => moves[Math.min(moves.length - 1, Math.floor(p * moves.length))];
    const atLimit = moves.filter((m) => m >= SEARCH_M - STEP_M).length;
    console.log(`[sds] move dist (m): median ${q(0.5).toFixed(0)}, p90 ${q(0.9).toFixed(0)}, max ${moves[moves.length - 1].toFixed(0)}; ` +
      `${((atLimit / moves.length) * 100).toFixed(1)}% pinned at search limit (suspicious if high)`);
  }
}

await main();
