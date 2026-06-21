/**
 * CreteWorld — orchestrates the whole-Crete BASE-layer world source.
 *
 * When Params.world === 'crete', this replaces the procedural
 * synthesis/erosion/hydrology pipeline and feeds the SAME downstream consumers
 * (CDLOD tiles, terrain material, water clipmap) with the baked Crete DEM.
 *
 * World size: 280000 m (see CreteConst). setActiveWorldSize(CRETE_WORLD_SIZE)
 * is called in TerrainScene.ts before any world system is constructed.
 *
 * Water level: 0 m (sea level). The procedural hydrology pass is skipped —
 * waterY is initialized to a dry sentinel everywhere, so no inland water planes
 * are rendered; the ocean is GavdosOcean (reused).
 *
 * Vegetation/structures are deferred (ablated at boot) and so are not wired here.
 */

import type { Renderer } from 'three/webgpu';
import type { QualityConfig } from '../world/WorldConst';
import type { MacroParams } from '../world/MacroMap';
import { Heightfield } from '../world/Heightfield';
import { loadCreteData } from './CreteData';

export type CreteProgressFn = (p: number, msg: string) => void;

/**
 * Build a Heightfield populated from the baked whole-Crete DEM.
 *
 * Skips: runHeightSynthesis, runErosion, runFlowRivers, runBiomeSnow.
 * Keeps: bakeNoiseTextures, TerrainTiles, ocean, etc.
 *
 * @param renderer - WebGPU renderer
 * @param cfg      - Quality config (heightRes, simRes from qualityConfig())
 * @param mp       - MacroParams (neutral procedural params; used only for far
 *                   shell analytic — the far shell beyond WORLD_HALF is sea)
 * @param progress - 0..1 progress callback
 */
export async function buildCreteHeightfield(
  renderer: Renderer,
  cfg: QualityConfig,
  mp: MacroParams,
  progress: CreteProgressFn,
): Promise<Heightfield> {
  const data = await loadCreteData(
    renderer,
    cfg.heightRes,
    cfg.simRes,
    progress,
  );

  // Reuse the gavdos heightfield adapter — CreteData returns the same
  // GavdosDataResult shape, so fromGavdos consumes it unchanged.
  const hf = Heightfield.fromGavdos(data, cfg, mp);

  return hf;
}
