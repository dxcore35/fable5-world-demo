/**
 * CreteConst — single source of truth for whole-Crete geodesy.
 *
 * Mirrors GavdosConst exactly (same formulas, same north convention) with the
 * Crete base-layer constants substituted. Engine north-axis convention is
 * unchanged: yaw=0 = looking −z (north) → north is −Z → NORTH_SIGN = -1
 * (a point north of origin has a more-negative world Z).
 *
 * World size: 280000 m (280 km square centered on the island).
 * Source grid: 3072×1088 baked heightmap (public/crete/heightmap.bin), bounds
 *   W23.35 S34.70 E26.40 N35.78. The source spans the full E-W island extent
 *   (~309 km) but only ~120 km N-S, so a 280 km square window overruns the
 *   source on the N/S (and slightly on E/W); the CreteData crop loop guards
 *   every sample with `?? 0`, so off-grid cells read as 0 m (open sea) — the
 *   correct base-layer behavior for an island surrounded by ocean.
 * setActiveWorldSize(CRETE_WORLD_SIZE) is called in TerrainScene.ts before any
 * world system is constructed.
 */

/** Full-island world size in meters (280000 = CENTER ± 140000 m). */
export const CRETE_WORLD_SIZE = 280_000;

/** World center in geographic coordinates */
export const CRETE_CENTER_LON = 24.875;
export const CRETE_CENTER_LAT = 35.24;

/** Meters per degree at this latitude */
export const M_PER_DEG_LAT = 111_132;
/** 111320 × cos(35.24°) ≈ 90903 */
export const M_PER_DEG_LON = 90_903;

/**
 * World window half-extent in meters (CRETE_WORLD_SIZE / 2 = 140000 m).
 * Full island + sea margin: CENTER ± 140000 m.
 */
export const CRETE_CROP_HALF = CRETE_WORLD_SIZE / 2; // 140000 meters

/**
 * North sign in Three.js world coordinates.
 * Evidence: TerrainScene.ts "yaw=0 = looking −z (north)"
 * → more-north = more-negative Z → NORTH_SIGN = -1
 */
export const NORTH_SIGN = -1 as const;

// --- Source grid constants (meta.json) ---
export const SRC_WIDTH = 3072;
export const SRC_HEIGHT = 1088;
export const SRC_WEST = 23.35;
export const SRC_NORTH = 35.78;
export const SRC_EAST = 26.40;
export const SRC_SOUTH = 34.70;

/** Degrees per pixel in the source grid */
export const SRC_DEG_PER_PX_LON = (SRC_EAST - SRC_WEST) / SRC_WIDTH; // 3.05/3072
export const SRC_DEG_PER_PX_LAT = (SRC_NORTH - SRC_SOUTH) / SRC_HEIGHT; // 1.08/1088

/**
 * World window in lon/lat:
 *   CENTER ± CRETE_CROP_HALF / M_PER_DEG_*
 */
export const CRETE_WIN_WEST = CRETE_CENTER_LON - CRETE_CROP_HALF / M_PER_DEG_LON;
export const CRETE_WIN_EAST = CRETE_CENTER_LON + CRETE_CROP_HALF / M_PER_DEG_LON;
export const CRETE_WIN_SOUTH = CRETE_CENTER_LAT - CRETE_CROP_HALF / M_PER_DEG_LAT;
export const CRETE_WIN_NORTH = CRETE_CENTER_LAT + CRETE_CROP_HALF / M_PER_DEG_LAT;

/**
 * Source pixel crop bounds (real-valued, use Math.round for slicing).
 * px: column 0 = west edge (SRC_WEST). py: row 0 = north edge (SRC_NORTH).
 */
export const CROP_PX_WEST = (CRETE_WIN_WEST - SRC_WEST) / SRC_DEG_PER_PX_LON;
export const CROP_PX_EAST = (CRETE_WIN_EAST - SRC_WEST) / SRC_DEG_PER_PX_LON;
export const CROP_PY_NORTH = (SRC_NORTH - CRETE_WIN_NORTH) / SRC_DEG_PER_PX_LAT;
export const CROP_PY_SOUTH = (SRC_NORTH - CRETE_WIN_SOUTH) / SRC_DEG_PER_PX_LAT;

/** Integer crop region [inclusive] */
export const CROP_X0 = Math.round(CROP_PX_WEST);
export const CROP_X1 = Math.round(CROP_PX_EAST);
export const CROP_Y0 = Math.round(CROP_PY_NORTH);
export const CROP_Y1 = Math.round(CROP_PY_SOUTH);
export const CROP_W = CROP_X1 - CROP_X0;
export const CROP_H = CROP_Y1 - CROP_Y0;

/**
 * Convert geographic coordinates to engine world (x, z) in meters.
 * Origin = CRETE_CENTER. North = −Z (NORTH_SIGN = −1).
 * x increases eastward, z decreases northward.
 */
export function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const x = (lon - CRETE_CENTER_LON) * M_PER_DEG_LON;
  const z = NORTH_SIGN * (lat - CRETE_CENTER_LAT) * M_PER_DEG_LAT;
  return { x, z };
}

/**
 * Convert engine world (x, z) to source grid pixel (px column, py row).
 * px: column in 3072-wide source grid. py: row in 1088-tall source grid (row 0 = north).
 */
export function worldToSourcePx(x: number, z: number): { px: number; py: number } {
  const lon = CRETE_CENTER_LON + x / M_PER_DEG_LON;
  // z = NORTH_SIGN * (lat - CENTER_LAT) * M_PER_DEG_LAT → lat = CENTER_LAT + z * NORTH_SIGN / M_PER_DEG_LAT
  const lat = CRETE_CENTER_LAT + (z * NORTH_SIGN) / M_PER_DEG_LAT;
  const px = (lon - SRC_WEST) / SRC_DEG_PER_PX_LON;
  const py = (SRC_NORTH - lat) / SRC_DEG_PER_PX_LAT;
  return { px, py };
}

// ---- Wave run-up (swash) shared tunables for Crete beach wet/dry + ocean foam
// Keep these in sync with GavdosOcean.ts (RUNUP_AMP_M / RUNUP_SPEED / FOAM_*) so
// the moving waterline on the 3D sand surface feels married to the ocean surface.
export const BEACH_RUNUP_AMP_M = 1.1;
export const BEACH_RUNUP_SPEED = 0.55;
export const BEACH_FOAM_DEEP = 1.5;
export const BEACH_FOAM_GAIN = 1.6;
// Beach band for PBR sand / pebbles (m above 0). Wider than pure waterline to
// capture the full intertidal + berm.
export const BEACH_MAX_H = 9.0;
