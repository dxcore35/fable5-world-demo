/**
 * GavdosConst — single source of truth for Gavdos geodesy.
 *
 * Engine north-axis evidence: TerrainScene.ts line 273 comment
 *   "yaw=0 = looking −z (north)"
 * → north is −Z in world space → NORTH_SIGN = -1
 *   (a point north of origin has a more-negative world Z)
 *
 * WORLD_SIZE fallback path taken: WORLD_SIZE=4096 (engine constant)
 * with M-scaled crop CENTER ± 2048 m. Parameterizing 8192 would require
 * touching >10 subsystems (Scatter, BiomeSnow, Heightfield, TerrainTiles,
 * ProbeGI, Froxels, Particles, GroundRing, Caustics, WaterMaterial,
 * CanopyShell, ShadowProxy). V1 shows the central 4×4 km of the island.
 */

/** World center in geographic coordinates */
export const GAVDOS_CENTER_LON = 24.080;
export const GAVDOS_CENTER_LAT = 34.827;

/** Meters per degree at this latitude */
export const M_PER_DEG_LAT = 111_132;
/** 111320 × cos(34.827°) ≈ 91393 */
export const M_PER_DEG_LON = 91_393;

/**
 * World window radius in meters (engine WORLD_SIZE / 2 = 2048 m).
 * V1 shows the central 4×4 km of Gavdos (full 8×8 km needs WORLD_SIZE=8192).
 */
export const GAVDOS_CROP_HALF = 2048; // meters

/**
 * North sign in Three.js world coordinates.
 * Evidence: TerrainScene.ts "yaw=0 = looking −z (north)"
 * → more-north = more-negative Z → NORTH_SIGN = -1
 */
export const NORTH_SIGN = -1 as const;

// --- Source grid constants (meta.json) ---
export const SRC_WIDTH = 2048;
export const SRC_HEIGHT = 1664;
export const SRC_WEST = 23.9;
export const SRC_NORTH = 34.96;
export const SRC_EAST = 24.2;
export const SRC_SOUTH = 34.76;

/** Degrees per pixel in the source grid */
export const SRC_DEG_PER_PX_LON = (SRC_EAST - SRC_WEST) / SRC_WIDTH; // 0.3/2048
export const SRC_DEG_PER_PX_LAT = (SRC_NORTH - SRC_SOUTH) / SRC_HEIGHT; // 0.2/1664

/**
 * World window in lon/lat:
 *   CENTER ± GAVDOS_CROP_HALF / M_PER_DEG_*
 */
export const GAVDOS_WIN_WEST = GAVDOS_CENTER_LON - GAVDOS_CROP_HALF / M_PER_DEG_LON;
export const GAVDOS_WIN_EAST = GAVDOS_CENTER_LON + GAVDOS_CROP_HALF / M_PER_DEG_LON;
export const GAVDOS_WIN_SOUTH = GAVDOS_CENTER_LAT - GAVDOS_CROP_HALF / M_PER_DEG_LAT;
export const GAVDOS_WIN_NORTH = GAVDOS_CENTER_LAT + GAVDOS_CROP_HALF / M_PER_DEG_LAT;

/**
 * Source pixel crop bounds (real-valued, use Math.round for slicing).
 * px: column 0 = west edge (SRC_WEST). py: row 0 = north edge (SRC_NORTH).
 */
export const CROP_PX_WEST = (GAVDOS_WIN_WEST - SRC_WEST) / SRC_DEG_PER_PX_LON;
export const CROP_PX_EAST = (GAVDOS_WIN_EAST - SRC_WEST) / SRC_DEG_PER_PX_LON;
export const CROP_PY_NORTH = (SRC_NORTH - GAVDOS_WIN_NORTH) / SRC_DEG_PER_PX_LAT;
export const CROP_PY_SOUTH = (SRC_NORTH - GAVDOS_WIN_SOUTH) / SRC_DEG_PER_PX_LAT;

/** Integer crop region [inclusive] */
export const CROP_X0 = Math.round(CROP_PX_WEST);
export const CROP_X1 = Math.round(CROP_PX_EAST);
export const CROP_Y0 = Math.round(CROP_PY_NORTH);
export const CROP_Y1 = Math.round(CROP_PY_SOUTH);
export const CROP_W = CROP_X1 - CROP_X0;
export const CROP_H = CROP_Y1 - CROP_Y0;

/**
 * Convert geographic coordinates to engine world (x, z) in meters.
 * Origin = GAVDOS_CENTER. North = −Z (NORTH_SIGN = −1).
 * x increases eastward, z decreases northward.
 */
export function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const x = (lon - GAVDOS_CENTER_LON) * M_PER_DEG_LON;
  const z = NORTH_SIGN * (lat - GAVDOS_CENTER_LAT) * M_PER_DEG_LAT;
  return { x, z };
}

/**
 * Convert engine world (x, z) to source grid pixel (px column, py row).
 * px: column in 2048-wide source grid. py: row in 1664-tall source grid (row 0 = north).
 */
export function worldToSourcePx(x: number, z: number): { px: number; py: number } {
  const lon = GAVDOS_CENTER_LON + x / M_PER_DEG_LON;
  // z = NORTH_SIGN * (lat - CENTER_LAT) * M_PER_DEG_LAT → lat = CENTER_LAT + z * NORTH_SIGN / M_PER_DEG_LAT
  const lat = GAVDOS_CENTER_LAT + (z * NORTH_SIGN) / M_PER_DEG_LAT;
  const px = (lon - SRC_WEST) / SRC_DEG_PER_PX_LON;
  const py = (SRC_NORTH - lat) / SRC_DEG_PER_PX_LAT;
  return { px, py };
}
