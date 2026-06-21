/**
 * CreteSatellite — fetches ESRI World Imagery and returns a per-(lng,lat)
 * RGB sampler used to drape REAL Crete satellite imagery over the whole-Crete
 * base terrain.
 *
 * Crete-world ONLY. The loader is never called for gavdos/laas (CreteData gates
 * it behind the crete path + the `?sat=0` toggle), so those worlds are
 * unaffected. On ANY critical failure (no tiles fetched / no 2D context) the
 * loader returns null and the caller falls back to the existing procedural
 * biome colouring — no crash.
 *
 * ── Alignment contract ──────────────────────────────────────────────────────
 * The satellite is NOT projected directly into the terrain UV. Instead this
 * module returns a `(lng, lat) => [r, g, b]` sampler, and CreteData calls it
 * once per terrain CELL using the SAME crop→source-pixel→lng/lat mapping the
 * height crop uses. That guarantees satellite cell ↔ height cell correspondence
 * is exact: both grids index the identical geographic point per (ox, oy).
 *
 * ── Imagery source ──────────────────────────────────────────────────────────
 * ESRI World Imagery XYZ tiles at zoom z=10. At Crete's latitude one z=10 tile
 * is 256 px over ~38 km ⇒ ≈120 m/px, a good match for the 280 km terrain whose
 * upsampled texels span ≈137 m. Tiles are fetched in parallel and composited
 * into one OffscreenCanvas laid out by their tile grid; the sampler reads that
 * canvas via the Web-Mercator pixel transform.
 */

import {
  SRC_EAST,
  SRC_NORTH,
  SRC_SOUTH,
  SRC_WEST,
} from './CreteConst';

/** ESRI World Imagery zoom level. z=12 ⇒ ≈30 m/px, matched to the 8192 satellite
 *  drape (≈34 m/texel for the 280 km world). Tiles are baked locally
 *  (tools/crete/bake-satellite-tiles.ts) so the larger z12 tile set loads from disk
 *  instead of hammering ESRI. */
const SAT_ZOOM = 12;

/** Official Hellenic Cadastre LSO_v2 orthophoto (Greek authority, 50cm source,
 *  EPSG:3857, zooms 0–18, z/y/x order). 404 over open sea → black slot. */
const tileUrl = (z: number, x: number, y: number): string =>
  `https://tiles-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services/LSO_v2/MapServer/tile/${z}/${y}/${x}`;

/** Sampler: geographic (lng, lat) → linear-index-free sRGB [0,1] triple. */
export type SatelliteSampler = (lng: number, lat: number) => [number, number, number];

// --- Web-Mercator tile math -------------------------------------------------

/** Longitude → fractional tile X at zoom z. */
function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

/** Latitude → fractional tile Y at zoom z (asinh form, clamped to the ±85.0511° Mercator limit). */
function latToTileY(lat: number, z: number): number {
  const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const rad = (clampedLat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Load one tile image with anonymous CORS. Resolves to null on any load error. */
function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  // Try the locally-baked tile first (public/crete/sat-tiles/, no network) and
  // fall back to the ESRI endpoint if it's missing. Local hit = fast first load.
  return new Promise((resolve) => {
    const tryUrl = (url: string, fallback: string | null): void => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => (fallback ? tryUrl(fallback, null) : resolve(null));
      img.src = url;
    };
    tryUrl(`/crete/sat-tiles/${z}/${x}/${y}.jpg`, tileUrl(z, x, y));
  });
}

/**
 * Fetch ESRI imagery covering the CreteConst DEM bbox at z=SAT_ZOOM, composite
 * it, and return a per-(lng,lat) sampler. Returns null if nothing usable could
 * be built (caller falls back to procedural biome colour).
 *
 * `?sat=0` is honoured defensively here too: the caller already skips the call,
 * but if it is reached with the flag set we return null immediately.
 */
// Module-level cache: the satellite is identical per session, and it's consumed
// twice (the terrain drape in CreteData + the colour-refined coastline mask in
// CreteLandMask). Build the composite ONCE; the 2nd caller reuses the sampler.
let _satCache: SatelliteSampler | null | undefined;
export async function loadCreteSatellite(): Promise<SatelliteSampler | null> {
  if (_satCache !== undefined) return _satCache;
  _satCache = await buildCreteSatellite();
  return _satCache;
}

async function buildCreteSatellite(): Promise<SatelliteSampler | null> {
  // Defensive toggle: never drape if explicitly disabled.
  if (typeof window !== 'undefined') {
    const sat = new URLSearchParams(window.location.search).get('sat');
    if (sat === '0') return null;
  }

  const z = SAT_ZOOM;
  const n = 2 ** z;

  // Integer tile range covering the DEM bbox. Tile Y increases SOUTHWARD, so the
  // NORTH edge gives the smallest Y. Clamp into the valid [0, n-1] tile range.
  const clampTile = (v: number): number => Math.min(Math.max(v, 0), n - 1);
  const xMin = clampTile(Math.floor(lngToTileX(SRC_WEST, z)));
  const xMax = clampTile(Math.floor(lngToTileX(SRC_EAST, z)));
  const yMin = clampTile(Math.floor(latToTileY(SRC_NORTH, z))); // north → smaller y
  const yMax = clampTile(Math.floor(latToTileY(SRC_SOUTH, z))); // south → larger y

  const tilesX = xMax - xMin + 1;
  const tilesY = yMax - yMin + 1;
  if (tilesX <= 0 || tilesY <= 0) return null;

  const TILE_PX = 256;
  const canvasW = tilesX * TILE_PX;
  const canvasH = tilesY * TILE_PX;

  // OffscreenCanvas is the same pixel-readback path GavdosData already uses.
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // Fetch every tile in parallel; place each into its grid slot. Failed tiles
  // (null) leave their slot transparent/black — the sampler still works, those
  // cells just read dark, which is acceptable (and rare) over open sea.
  const jobs: Promise<void>[] = [];
  let placed = 0;
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
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

  // No tile decoded ⇒ nothing to sample ⇒ fall back to biome.
  if (placed === 0) return null;

  // Snapshot the composited pixels once. ImageData is RGBA8, row-major.
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, canvasW, canvasH).data;
  } catch {
    // getImageData throws if the canvas is tainted (CORS failure despite the
    // anonymous request). Fall back to biome rather than crash.
    return null;
  }

  // Canvas pixel(0,0) corresponds to tile (xMin, yMin)'s top-left, i.e. the
  // fractional tile-space origin (xMin, yMin). Convert a (lng,lat) to a
  // fractional tile coordinate, subtract the origin, scale to pixels.
  const sample: SatelliteSampler = (lng, lat) => {
    const fx = (lngToTileX(lng, z) - xMin) * TILE_PX;
    const fy = (latToTileY(lat, z) - yMin) * TILE_PX;
    // Clamp out-of-range reads to the edge (cells outside the imagery bbox).
    const px = Math.min(Math.max(Math.round(fx), 0), canvasW - 1);
    const py = Math.min(Math.max(Math.round(fy), 0), canvasH - 1);
    const idx = (py * canvasW + px) * 4;
    return [
      (pixels[idx] ?? 0) / 255,
      (pixels[idx + 1] ?? 0) / 255,
      (pixels[idx + 2] ?? 0) / 255,
    ];
  };

  return sample;
}
