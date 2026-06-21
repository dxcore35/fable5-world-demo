/**
 * bake-canopy-mask.ts — Vegetation-from-imagery: a single-channel canopy mask
 * derived ALGORITHMICALLY from the Hellenic Cadastre LSO_v2 orthophoto COLORS, so
 * procedural placement (trees/shrubs/rocks) can grow wherever the imagery shows
 * REAL vegetation — olive groves, forests, scrub — not just the sparse OSM
 * wood/park polygons.
 *
 * WHY: CreteScatter currently bounds all vegetation to OSM wood/park outlines, so
 * the vast olive-grove / phrygana mosaic of Crete reads as bare cadastre ground.
 * The cadastre tiles ARE the ground truth for where plants are — green pixels mean
 * plants. This bake turns that color signal into a mask the runtime can sample.
 *
 * METHOD — same pipeline shape as bake-cadastre-coastline.ts (cadastre tileUrl,
 * sharp-decoded in-memory tile composite, lngToTileX/latToTileY mercator math,
 * cell-grid + CONCURRENCY loop, writes to public/crete/), with the water test
 * swapped for a VEGETATION test:
 *   - The cadastre is RGB orthophoto, NO near-infrared, so classic NDVI is
 *     impossible. We use the RGB Excess-Green index instead:
 *         ExG = 2*G - R - B            (per pixel, on 0..255 channels)
 *     High ExG = vegetation (chlorophyll reflects green, absorbs red/blue).
 *   - Optionally a small LOCAL GREEN-CHANNEL VARIANCE term favours textured tree
 *     canopy over smooth grass/fields (canopy is rough; a mown field is flat), but
 *     ExG alone is the core signal.
 *   - ExG is normalised + soft-thresholded to a single 0..255 vegetation value
 *     (0 = bare/urban/sea, 255 = dense canopy).
 *   - Sea is 0: cells whose tiles all 404 are skipped (no fill), and any pixel
 *     that lands on a missing/black tile reads 0.
 *
 * Output:
 *   public/crete/canopy-mask.png  — grayscale, WIDTH×HEIGHT, 0=bare 255=dense.
 *   public/crete/canopy-mask.json — { west, south, east, north, width, height }.
 * The mask covers the cadastre source bbox (SRC_WEST..SRC_EAST, SRC_SOUTH..SRC_NORTH)
 * as ONE raster, so CreteScatter samples it with a simple bilinear lon/lat lookup.
 *
 * Run:  bun tools/crete/bake-canopy-mask.ts                       (whole island — LONG)
 *       bun tools/crete/bake-canopy-mask.ts --bbox 35.05,24.80,35.22,25.00  (S,W,N,E subset, e.g. Rouvas forest)
 *
 * DO NOT expect this to finish quickly — at z13 the whole island is thousands of
 * tiles over minutes. The human runs it; this file only needs to be tsc-clean.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';

// -- source bbox (mirror src/crete/CreteConst.ts) ----------------------------
// The cadastre source grid spans this lon/lat box; the mask covers the same box
// so CreteScatter's lon/lat -> mask-uv lookup needs no extra geodesy.
const SRC_WEST = 23.35;
const SRC_SOUTH = 34.70;
const SRC_EAST = 26.40;
const SRC_NORTH = 35.78;

// -- output ------------------------------------------------------------------
const OUT_PNG = path.resolve(import.meta.dirname, '../../public/crete/canopy-mask.png');
const OUT_JSON = path.resolve(import.meta.dirname, '../../public/crete/canopy-mask.json');
// Raw single-channel bytes (width*height, row 0 = north). The runtime loads THIS
// (plain fetch -> arrayBuffer), not the PNG — createImageBitmap can return a
// degenerate 0×0 bitmap when decoded mid-boot, so we avoid image decoding entirely.
const OUT_BIN = path.resolve(import.meta.dirname, '../../public/crete/canopy-mask.bin');

// -- raster resolution -------------------------------------------------------
// ~4096 wide; height matches the bbox aspect (lon-span / lat-span, no cos term —
// the mask is sampled in lon/lat directly, not on the ground plane).
const OUT_W = 4096;
const OUT_H = Math.round(OUT_W * ((SRC_NORTH - SRC_SOUTH) / (SRC_EAST - SRC_WEST))); // ~1450

/** Hellenic Cadastre LSO_v2 orthophoto tile URL — z/y/x order, EPSG:3857, 256 px,
 *  404 over open sea. Same endpoint as bake-cadastre-coastline.ts / CreteMapStream.ts. */
const tileUrl = (z: number, x: number, y: number): string =>
  `https://tiles-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services/LSO_v2/MapServer/tile/${z}/${y}/${x}`;

const TILE_PX = 256;
const TILE_Z = 13;            // cadastre zoom: good vegetation detail, manageable tile count
const CELL_DEG = 0.10;        // ~9 km work cells (one tile-composite read each)
const CONCURRENCY = 6;        // parallel cell processing (server handles this fine)

// -- ExG -> vegetation tuning ------------------------------------------------
// ExG range is roughly [-255, 510]; over real cadastre vegetation the useful band
// sits around 5..70. Below EXG_LO reads bare (0); at EXG_HI reads full canopy (255);
// in between it ramps linearly. Keep map-safe: bare karst / towns / dry fields fall
// below EXG_LO and stay 0 so nothing is placed there.
const EXG_LO = 8;             // ExG below this = no vegetation
const EXG_HI = 60;            // ExG at/above this = dense canopy
// Local green-channel std-dev (over a small window) gently favours textured tree
// canopy over smooth grass; a small weight keeps ExG dominant. Set 0 to disable.
const VAR_WEIGHT = 0.35;      // contribution of normalised green-variance to the score
const VAR_NORM = 18;          // green std-dev that counts as "fully textured" canopy
const VAR_WIN = 1;            // half-window (px) for the variance estimate (3x3 at 1)

// -- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SUB = getArg('--bbox')?.split(',').map(Number); // S,W,N,E subset for quick testing

// -- web-mercator tile math (mirrors bake-cadastre-coastline.ts) -------------
/** Longitude -> fractional tile X at zoom z. */
function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}
/** Latitude -> fractional tile Y at zoom z (asinh form, ±85.0511 clamp). */
function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const rad = (clampedLat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

// -- cadastre tile reader (sharp-decoded, in-memory cache) -------------------
/** A decoded tile's raw RGBA bytes, or null for a 404 (open sea). */
interface Tile { data: Buffer; w: number; h: number; }
const tileCache = new Map<string, Promise<Tile | null>>();
let tilesFetched = 0;
let tilesSea = 0;

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
      if (!r.ok) { tilesSea++; return null; } // 404 over sea
      const buf = Buffer.from(await r.arrayBuffer());
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      tilesFetched++;
      return { data, w: info.width, h: info.height };
    } catch {
      tilesSea++;
      return null; // network failure -> treat as sea, never throw
    }
  })();
  tileCache.set(key, job);
  return job;
}

/** A geographic-window orthophoto composite: every covering tile blitted into one
 *  RGBA buffer, indexed by composite pixel. Missing tiles (sea) stay black (= ExG 0
 *  = no vegetation). Mirrors buildWindowSampler in the coastline bake, but keeps the
 *  raw composite so we can read 3x3 neighbourhoods for the local-variance term.
 *  Returns null if the window is entirely sea. */
interface Window {
  rgba: Uint8Array;
  W: number;
  H: number;
  xMin: number;
  yMin: number;
}

async function buildWindow(
  z: number, west: number, east: number, south: number, north: number,
): Promise<Window | null> {
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
  const rgba = new Uint8Array(W * H * 4); // black = sea by default

  let placed = 0;
  const jobs: { rx: number; ry: number }[] = [];
  for (let ry = 0; ry < tilesY; ry++) for (let rx = 0; rx < tilesX; rx++) jobs.push({ rx, ry });
  await Promise.all(jobs.map(async ({ rx, ry }) => {
    const t = await loadTile(z, xMin + rx, yMin + ry);
    if (!t) return; // sea -> leave black
    const dx = rx * TILE_PX, dy = ry * TILE_PX;
    for (let py = 0; py < TILE_PX && py < t.h; py++) {
      const srcRow = py * t.w * 4;
      const dstRow = ((dy + py) * W + dx) * 4;
      rgba.set(t.data.subarray(srcRow, srcRow + Math.min(TILE_PX, t.w) * 4), dstRow);
    }
    placed++;
  }));
  if (placed === 0) return null; // entirely sea/failed -> caller skips this cell
  return { rgba, W, H, xMin, yMin };
}

/** Read an RGB triple (0..255) at a composite pixel; out-of-range -> [0,0,0] (sea). */
function rgbAt(win: Window, px: number, py: number): [number, number, number] {
  if (px < 0 || py < 0 || px >= win.W || py >= win.H) return [0, 0, 0];
  const idx = (py * win.W + px) * 4;
  return [win.rgba[idx] ?? 0, win.rgba[idx + 1] ?? 0, win.rgba[idx + 2] ?? 0];
}

/** Excess-Green index ExG = 2G - R - B on 0..255 channels (can be negative). */
function exg(r: number, g: number, b: number): number {
  return 2 * g - r - b;
}

/** Local green-channel std-dev over a (2*VAR_WIN+1)² window at (px,py). Cheap
 *  texture proxy: tree canopy is rough (high std), mown field / bare ground is
 *  smooth (low std). Black/sea pixels contribute 0 and pull the score down, which
 *  is correct (no vegetation at the shore). */
function greenStd(win: Window, px: number, py: number): number {
  let sum = 0, sum2 = 0, cnt = 0;
  for (let j = -VAR_WIN; j <= VAR_WIN; j++)
    for (let i = -VAR_WIN; i <= VAR_WIN; i++) {
      const g = rgbAt(win, px + i, py + j)[1];
      sum += g; sum2 += g * g; cnt++;
    }
  if (cnt === 0) return 0;
  const mean = sum / cnt;
  return Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
}

/** Map a lon/lat to this window's composite pixel (nearest). */
function lonLatToWinPx(win: Window, lng: number, lat: number, z: number): [number, number] {
  const fx = (lngToTileX(lng, z) - win.xMin) * TILE_PX;
  const fy = (latToTileY(lat, z) - win.yMin) * TILE_PX;
  return [Math.round(fx), Math.round(fy)];
}

/** Combine ExG + green-variance into a 0..255 vegetation byte.
 *  ExG is soft-thresholded EXG_LO..EXG_HI -> 0..1, then the variance term lifts
 *  textured canopy. The blend stays 0 for bare ground (ExG below EXG_LO), so the
 *  mask is map-safe. */
function vegByte(exgVal: number, gStd: number): number {
  const exgN = Math.min(1, Math.max(0, (exgVal - EXG_LO) / (EXG_HI - EXG_LO)));
  if (exgN <= 0) return 0; // hard floor: no green -> no vegetation
  const varN = Math.min(1, gStd / VAR_NORM);
  // Blend: base ExG score, boosted by texture. Weighted so ExG always dominates.
  const score = exgN * (1 - VAR_WEIGHT) + exgN * varN * VAR_WEIGHT;
  return Math.round(Math.min(1, Math.max(0, score)) * 255);
}

interface Cell { gx: number; gy: number; west: number; east: number; south: number; north: number; }

async function main(): Promise<void> {
  const t0 = Date.now();

  // Effective bbox = source bbox, optionally clipped to --bbox (S,W,N,E).
  const bSouth = SUB ? Math.max(SRC_SOUTH, SUB[0]!) : SRC_SOUTH;
  const bWest = SUB ? Math.max(SRC_WEST, SUB[1]!) : SRC_WEST;
  const bNorth = SUB ? Math.min(SRC_NORTH, SUB[2]!) : SRC_NORTH;
  const bEast = SUB ? Math.min(SRC_EAST, SUB[3]!) : SRC_EAST;

  console.log(`[canopy] bbox W${bWest} S${bSouth} E${bEast} N${bNorth} (${SUB ? 'subset' : 'full source'})`);
  console.log(`[canopy] raster ${OUT_W}x${OUT_H}, cadastre z${TILE_Z}, cells ${CELL_DEG}deg, concurrency ${CONCURRENCY}`);

  // Output mask covers the FULL source bbox always (so the .json bbox + dims are
  // stable and CreteScatter's lookup is unconditional). A --bbox subset only fills
  // its sub-rectangle; the rest stays 0 (useful for a quick visual test).
  const mask = new Uint8Array(OUT_W * OUT_H); // 0 = bare/sea by default

  // lon/lat <-> output pixel (linear over the source bbox).
  const lonOfPx = (px: number): number => SRC_WEST + ((px + 0.5) / OUT_W) * (SRC_EAST - SRC_WEST);
  const latOfPy = (py: number): number => SRC_NORTH - ((py + 0.5) / OUT_H) * (SRC_NORTH - SRC_SOUTH);
  const pxOfLon = (lon: number): number => ((lon - SRC_WEST) / (SRC_EAST - SRC_WEST)) * OUT_W;
  const pyOfLat = (lat: number): number => ((SRC_NORTH - lat) / (SRC_NORTH - SRC_SOUTH)) * OUT_H;

  // Build work cells over the effective bbox.
  const cells: Cell[] = [];
  const gx0 = Math.floor(bWest / CELL_DEG), gx1 = Math.floor((bEast - 1e-9) / CELL_DEG);
  const gy0 = Math.floor(bSouth / CELL_DEG), gy1 = Math.floor((bNorth - 1e-9) / CELL_DEG);
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++) {
      cells.push({
        gx, gy,
        west: Math.max(bWest, gx * CELL_DEG),
        east: Math.min(bEast, (gx + 1) * CELL_DEG),
        south: Math.max(bSouth, gy * CELL_DEG),
        north: Math.min(bNorth, (gy + 1) * CELL_DEG),
      });
    }
  console.log(`[canopy] ${cells.length} work cells to process`);

  let cellsDone = 0, cellsSkipped = 0, vegPixels = 0;

  async function processCell(cell: Cell): Promise<void> {
    let win: Window | null;
    try {
      win = await buildWindow(TILE_Z, cell.west, cell.east, cell.south, cell.north);
    } catch { cellsSkipped++; return; }
    if (!win) { cellsSkipped++; cellsDone++; return; } // all-sea cell: nothing to fill

    // Output pixel range covering this cell (clamped to the raster).
    const pxA = Math.max(0, Math.floor(pxOfLon(cell.west)));
    const pxB = Math.min(OUT_W - 1, Math.ceil(pxOfLon(cell.east)));
    const pyA = Math.max(0, Math.floor(pyOfLat(cell.north))); // north -> smaller py
    const pyB = Math.min(OUT_H - 1, Math.ceil(pyOfLat(cell.south)));

    for (let py = pyA; py <= pyB; py++) {
      const lat = latOfPy(py);
      if (lat < cell.south || lat > cell.north) continue;
      for (let px = pxA; px <= pxB; px++) {
        const lon = lonOfPx(px);
        if (lon < cell.west || lon > cell.east) continue;
        const [wx, wy] = lonLatToWinPx(win, lon, lat, TILE_Z);
        const [r, g, b] = rgbAt(win, wx, wy);
        if (r === 0 && g === 0 && b === 0) continue; // sea / missing tile -> stays 0
        const v = vegByte(exg(r, g, b), VAR_WEIGHT > 0 ? greenStd(win, wx, wy) : 0);
        if (v > 0) { mask[py * OUT_W + px] = v; vegPixels++; }
      }
    }
    cellsDone++;
    if (cellsDone % 10 === 0) {
      console.log(
        `[canopy]   ${cellsDone}/${cells.length} cells, ${tilesFetched} tiles fetched, ` +
        `${tilesSea} sea/404, ${vegPixels} veg pixels so far`,
      );
    }
  }

  // concurrency pool
  for (let i = 0; i < cells.length; i += CONCURRENCY) {
    await Promise.all(cells.slice(i, i + CONCURRENCY).map(processCell));
  }

  // -- write grayscale PNG + sidecar json -------------------------------------
  await sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), {
    raw: { width: OUT_W, height: OUT_H, channels: 1 },
  }).png().toFile(OUT_PNG);

  // Raw bytes for the runtime (no image decode at load time).
  fs.writeFileSync(OUT_BIN, Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength));

  const meta = { west: SRC_WEST, south: SRC_SOUTH, east: SRC_EAST, north: SRC_NORTH, width: OUT_W, height: OUT_H };
  fs.writeFileSync(OUT_JSON, JSON.stringify(meta));

  console.log(`\n[canopy] OK ${OUT_BIN} (${mask.length} bytes raw)`);
  console.log(`[canopy] OK ${OUT_PNG}`);
  console.log(`[canopy] OK ${OUT_JSON} ${JSON.stringify(meta)}`);
  console.log(
    `[canopy] ${cellsDone} cells done / ${cellsSkipped} all-sea skipped, ` +
    `${tilesFetched} tiles fetched, ${tilesSea} sea/404`,
  );
  console.log(
    `[canopy] ${vegPixels} / ${OUT_W * OUT_H} pixels vegetated ` +
    `(${((vegPixels / (OUT_W * OUT_H)) * 100).toFixed(1)}%), ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

await main();
