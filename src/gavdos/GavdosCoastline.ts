/**
 * GavdosCoastline — snap the rendered waterline to the sharp OSM coastline.
 *
 * Why: the visible shore in this engine is the terrain heightmap's 0 m crossing
 * (GavdosOcean derives foam/waterline from `waterDepth = 0 − h`). The source
 * FABDEM 30 m heightmap has its coastal band (−6..+8 m) deliberately smoothed,
 * so that 0-crossing is soft/generalized. OSM `natural=coastline` is sharp.
 *
 * Strategy — SIGN CORRECTION ONLY (no imposed slope):
 *   Within a thin band of the OSM coastline, every cell's land/sea sign is forced
 *   to agree with OSM. A cell OSM says is land but the DEM submerged → lifted just
 *   above 0 (feathered). A cell OSM says is sea but the DEM raised → sunk just
 *   below 0. Cells that already agree (and all terrain beyond the band) are left
 *   exactly as-is — so flat coastal dunes/beaches and inland hills are untouched,
 *   no false ridges. The net effect: the 0-crossing snaps to the OSM polygon edge.
 *
 * Reversible: pure runtime conditioning of the CPU height array. heightmap.bin is
 * never modified. Disable with `?coastSnap=0`.
 *
 * Data: public/gavdos/coastline.geojson (one land Polygon per closed coastline
 * way) produced by tools/gavdos/fetch-coastline.ts. Point inside ANY polygon = land.
 */
import {
  CROP_W,
  CROP_H,
  CROP_X0,
  CROP_Y0,
  SRC_WEST,
  SRC_NORTH,
  SRC_DEG_PER_PX_LON,
  SRC_DEG_PER_PX_LAT,
  M_PER_DEG_LON,
  M_PER_DEG_LAT,
} from './GavdosConst';

/** Coastal influence band (m). Only cells within this of the OSM line are touched. */
const BAND_M = 120;
/** Feather ramp distance (m): corrected cells reach EPS magnitude at this distance. */
const FEATHER_M = 35;
/** Target |height| (m) a fully-corrected cell settles to at FEATHER_M from the line. */
const EPS_LAND = 1.5;
const EPS_SEA = 1.5;

interface GeoJSON {
  features: { geometry: { type: string; coordinates: number[][][] } }[];
}

/** lon → fractional grid column (matches GavdosData height upsample mapping). */
function lonToGx(lon: number, heightRes: number): number {
  const px = (lon - SRC_WEST) / SRC_DEG_PER_PX_LON;
  return (px - CROP_X0 + 0.5) * (heightRes / CROP_W) - 0.5;
}
/** lat → fractional grid row (row 0 = north). */
function latToGy(lat: number, heightRes: number): number {
  const py = (SRC_NORTH - lat) / SRC_DEG_PER_PX_LAT;
  return (py - CROP_Y0 + 0.5) * (heightRes / CROP_H) - 0.5;
}

/**
 * Condition `heightCpu` (heightRes²) in place so its 0-crossing follows the OSM
 * coastline. Returns stats, or null if disabled / no data (caller leaves heights
 * untouched).
 */
export async function conditionHeightsToCoastline(
  heightCpu: Float32Array,
  heightRes: number,
): Promise<{ bandCells: number; lifted: number; sunk: number } | null> {
  // Toggle: ?coastSnap=0 disables.
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search).get('coastSnap');
    if (p === '0' || p === 'false') return null;
  }

  let geo: GeoJSON;
  try {
    const resp = await fetch('/gavdos/coastline.geojson');
    if (!resp.ok) return null;
    geo = (await resp.json()) as GeoJSON;
  } catch {
    return null;
  }
  const polys = geo.features
    .filter((f) => f.geometry?.type === 'Polygon')
    .map((f) => f.geometry.coordinates[0].map(([lon, lat]) => ({
      gx: lonToGx(lon, heightRes),
      gy: latToGy(lat, heightRes),
    })));
  if (polys.length === 0) return null;

  const N = heightRes * heightRes;
  // --- 1. Land mask via scanline polygon fill (even-odd per polygon, OR union) --
  const land = new Uint8Array(N);
  for (const ring of polys) {
    // bounding rows to limit work
    let minY = Infinity, maxY = -Infinity;
    for (const p of ring) { if (p.gy < minY) minY = p.gy; if (p.gy > maxY) maxY = p.gy; }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(heightRes - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; // sample at cell center
      xs.length = 0;
      for (let k = 0; k < ring.length - 1; k++) {
        const a = ring[k], b = ring[k + 1];
        const ay = a.gy, by = b.gy;
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          const t = (yc - ay) / (by - ay);
          xs.push(a.gx + t * (b.gx - a.gx));
        }
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const xa = Math.max(0, Math.ceil(xs[s] - 0.5));
        const xb = Math.min(heightRes - 1, Math.floor(xs[s + 1] - 0.5));
        const row = y * heightRes;
        for (let x = xa; x <= xb; x++) land[row + x] = 1; // OR: never un-land
      }
    }
  }

  // --- 2. Signed distance (in cells) to the land/sea boundary, BFS-bounded ------
  const cellMetersX = M_PER_DEG_LON * SRC_DEG_PER_PX_LON * (CROP_W / heightRes);
  const cellMetersY = M_PER_DEG_LAT * SRC_DEG_PER_PX_LAT * (CROP_H / heightRes);
  const cellMeters = (cellMetersX + cellMetersY) / 2;
  const bandCells = Math.ceil(BAND_M / cellMeters);

  // dist in cells from boundary; sign carried by `land`. Multi-source BFS that
  // only ever visits the coastal band, and collects those cells so the
  // correction pass below stays O(band) — not O(heightRes²).
  const dist = new Int16Array(N).fill(-1); // -1 = unvisited / beyond band
  const band: number[] = [];
  let queue: number[] = [];
  // boundary = a cell whose 4-neighbor has the opposite land value
  for (let y = 0; y < heightRes; y++) {
    for (let x = 0; x < heightRes; x++) {
      const i = y * heightRes + x;
      const l = land[i];
      const up = y > 0 ? land[i - heightRes] : l;
      const dn = y < heightRes - 1 ? land[i + heightRes] : l;
      const lf = x > 0 ? land[i - 1] : l;
      const rt = x < heightRes - 1 ? land[i + 1] : l;
      if (up !== l || dn !== l || lf !== l || rt !== l) { dist[i] = 0; queue.push(i); band.push(i); }
    }
  }
  // BFS outward up to bandCells (8-connected, ring-count distance)
  let ring = 0;
  while (queue.length && ring < bandCells) {
    const next: number[] = [];
    ring++;
    for (const i of queue) {
      const x = i % heightRes, y = (i / heightRes) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= heightRes || ny >= heightRes) continue;
          const ni = ny * heightRes + nx;
          if (dist[ni] === -1) { dist[ni] = ring; next.push(ni); band.push(ni); }
        }
      }
    }
    queue = next;
  }

  // --- 3. Sign-correction within the band (band cells only) -------------------
  let lifted = 0, sunk = 0;
  for (const i of band) {
    const dM = dist[i] * cellMeters;
    const feather = Math.min(dM / FEATHER_M, 1); // 0 at line → 1 at FEATHER_M
    const h = heightCpu[i];
    if (land[i]) {
      // OSM land: must be ≥ 0. Lift only if DEM submerged it.
      const target = feather * EPS_LAND;
      if (h < target) { heightCpu[i] = target; lifted++; }
    } else {
      // OSM sea: must be ≤ 0. Sink only if DEM raised it.
      const target = -feather * EPS_SEA;
      if (h > target) { heightCpu[i] = target; sunk++; }
    }
  }

  return { bandCells: band.length, lifted, sunk };
}
