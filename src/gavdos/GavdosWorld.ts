/**
 * GavdosWorld — orchestrates the real-DEM Gavdos world source.
 *
 * When Params.world === 'gavdos', this replaces the procedural
 * synthesis/erosion/hydrology pipeline and feeds the SAME downstream
 * consumers (CDLOD tiles, terrain material, veg scatter, water clipmap)
 * with Gavdos DEM data.
 *
 * World-size path taken: WORLD_SIZE=4096 (engine constant). Parameterizing
 * World size 10240 m via setActiveWorldSize — full island (see GavdosConst)
 * (CENTER ± 2048 m ≈ lon [24.058, 24.102] / lat [34.808, 34.846]).
 *
 * Water level: 0 m (sea level). The procedural LAKE_LEVEL=142 is bypassed
 * because we skip the entire hydrology pass — waterY is initialized to a
 * dry sentinel everywhere, so no inland water planes are rendered.
 *
 * Hook comments for future tasks:
 *   [GAVDOS-WATER-HOOK] — shore-wave ocean integration (T3)
 *   [GAVDOS-VEG-HOOK]   — Mediterranean veg species library (T4)
 *   [GAVDOS-STRUCT-HOOK] — building/road/wall OSM mesh placement (T5)
 */

import type { Renderer } from 'three/webgpu';
import type { QualityConfig } from '../world/WorldConst';
import type { MacroParams } from '../world/MacroMap';
import { Heightfield } from '../world/Heightfield';
import { loadGavdosData } from './GavdosData';

export type GavdosProgressFn = (p: number, msg: string) => void;

/**
 * Build a Heightfield populated from real Gavdos DEM data.
 *
 * Skips: runHeightSynthesis, runErosion, runFlowRivers, runBiomeSnow.
 * Keeps: bakeNoiseTextures, TerrainTiles, WaterSurface, scatter, etc.
 *
 * @param renderer - WebGPU renderer
 * @param cfg      - Quality config (heightRes, simRes from qualityConfig())
 * @param mp       - MacroParams (neutral procedural params; used only for far
 *                   shell analytic — the far shell beyond WORLD_HALF is sea)
 * @param progress - 0..1 progress callback
 */
export async function buildGavdosHeightfield(
  renderer: Renderer,
  cfg: QualityConfig,
  mp: MacroParams,
  progress: GavdosProgressFn,
): Promise<Heightfield> {
  const data = await loadGavdosData(
    renderer,
    cfg.heightRes,
    cfg.simRes,
    progress,
  );

  // [GAVDOS-WATER-HOOK] — replace dry waterY with shore/ocean integration (T3)

  const hf = Heightfield.fromGavdos(data, cfg, mp);

  // [GAVDOS-VEG-HOOK] — pass species.bin / weights.bin to veg scatter (T4)

  // [GAVDOS-STRUCT-HOOK] — load vectors.json for building/road placement (T5)

  return hf;
}
