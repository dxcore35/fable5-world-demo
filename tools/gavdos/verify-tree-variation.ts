/**
 * verify-tree-variation.ts — headless proof that per-variant procedural
 * perturbation yields genuinely different tree shapes. Grows every variant of
 * each Gavdos species (LOD2, no GPU) and reports the spread in height / branch
 * count / triangles. Mirrors GavdosVeg's perturbSpecies + variantInstance.
 *
 * Run: bunx tsx tools/gavdos/verify-tree-variation.ts
 */
import { buildTree } from '../../src/vegetation/TreeBuilder';
import { GAVDOS_JUNIPER, CALABRIAN_PINE, OLIVE } from '../../src/vegetation/Species';
import { WorldSeed } from '../../src/core/Seed';
import type { SpeciesParams } from '../../src/vegetation/VegTypes';
import { perturbSpecies, variantInstance } from '../../src/gavdos/GavdosTreeVariation';

const TREE_VARIANTS = 6;
const seed = new WorldSeed(0xC0FFEE);

const cv = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return m ? (sd / m) * 100 : 0;
};

for (const sp of [GAVDOS_JUNIPER, CALABRIAN_PINE, OLIVE] as SpeciesParams[]) {
  const rows: { v: number; height: number; branches: number; tris: number; broken: string }[] = [];
  for (let v = 0; v < TREE_VARIANTS; v++) {
    const psp = perturbSpecies(sp, seed.rng(`gavdosveg/${sp.id}/${v}/shape`));
    const t = buildTree(psp, seed.rng(`gavdosveg/${sp.id}/${v}`), { lod: 2, inst: variantInstance(seed, sp.id, v) });
    rows.push({ v, height: +t.stats.height.toFixed(2), branches: t.stats.branches, tris: t.stats.tris,
      broken: psp.brokenTop ? `snag@${psp.brokenTop.toFixed(2)}` : '—' });
  }
  console.log(`\n=== ${sp.id} (${TREE_VARIANTS} variants) ===`);
  console.table(rows);
  console.log(`spread  height CV ${cv(rows.map(r => r.height)).toFixed(1)}%  ` +
    `branches CV ${cv(rows.map(r => r.branches)).toFixed(1)}%  tris CV ${cv(rows.map(r => r.tris)).toFixed(1)}%`);
}
