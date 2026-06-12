/**
 * GavdosVeg — Mediterranean vegetation for the Gavdos world (T4).
 *
 * Provides:
 *   • buildGavdosVegLibrary()  — VegLib with 3 tree species (juniper, pine,
 *     olive) + phrygana shrub.  No boreal species, no deadfall/logs.
 *   • runGavdosScatter()       — CPU-sampled placement driven by species.bin
 *     × weights.bin; writes into the same ScatterResult buffers so the
 *     existing Forests / GroundRing pipeline is reused unchanged.
 *   • placeGavdosRocks()       — instantiate rocks.json detected stones
 *     through the existing stone/rock pipeline.
 *   • GAVDOS_DRY_BIAS          — export constant used by GroundRing to
 *     override grass color toward golden-dry Mediterranean palette.
 *
 * Placement rules (arid island — far below engine caps):
 *   • Trees:      ~10k–60k total  (juniper + pine + olive)
 *   • Understory: ~100k–400k     (phrygana dominates)
 *   • Rocks:      rocks.json count (detected boulders, placed exactly)
 *   • Sea/below 1.5 m: excluded except juniper-on-sand (species==1 on mask==3)
 *   • No snow, no deadfall logs, no boreal species anywhere.
 */

import type { Renderer } from 'three/webgpu';
import type { DataTexture } from 'three';
import type { WorldSeed } from '../core/Seed';
import {
  bakeBarkTextures,
  type BarkTextures,
} from '../gpu/passes/BarkSynth';
import { TREE_VARIANTS } from '../gpu/passes/Scatter';
import {
  barkTexturedMaterial,
  foliageCardMaterial,
  foliageMaterial,
  rockMaterial,
} from '../render/VegMaterials';
import { captureFoliageAtlas } from '../vegetation/FoliageCards';
import { captureImpostor, type ImpostorAtlas } from '../vegetation/Impostors';
import { buildRock } from '../vegetation/RockBuilder';
import { buildTree, type HeroDiet } from '../vegetation/TreeBuilder';
import { buildShrub } from '../vegetation/Understory';
import type { GrowthInstance, SpeciesParams } from '../vegetation/VegTypes';
import type { VegLib, PoolPart, VegPool } from '../vegetation/VegLibrary';
import {
  GAVDOS_JUNIPER,
  CALABRIAN_PINE,
  OLIVE,
  PHRYGANA,
  GAVDOS_TREE_SPECIES,
  GAVDOS_UNDERSTORY_SPECIES,
} from '../vegetation/Species';
import type { GavdosDataResult } from './GavdosData';
import {
  lonLatToWorld,
  GAVDOS_WORLD_SIZE,
} from './GavdosConst';

// ---------------------------------------------------------------------------
// Re-export the dry-bias constant so GroundRing can read it without
// importing the full GavdosVeg module.
// ---------------------------------------------------------------------------

/** Pass to GroundRing as the dryBias param: 1.0 = fully golden Mediterranean */
export const GAVDOS_DRY_BIAS = 1.0;

// ---------------------------------------------------------------------------
// Hero diet budgets for Mediterranean species
// ---------------------------------------------------------------------------

const GAVDOS_HERO_DIETS: Record<string, HeroDiet> = {
  gavdosJuniper: { meshAnchorTarget: 1200, barkK: 0.9 },
  calabrianPine:  { meshAnchorTarget: 800,  barkK: 0.8 },
  olive:          { meshAnchorTarget: 2000, barkK: 0.7 },
  // phrygana is understory-class, no hero ring
};

// ---------------------------------------------------------------------------
// Geometry bounds helper
// ---------------------------------------------------------------------------

import { BufferGeometry } from 'three';

function bounds(geos: BufferGeometry[]): { height: number; radius: number } {
  let height = 0.5;
  let radius = 0.5;
  for (const g of geos) {
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const bb = g.boundingBox;
    const bs = g.boundingSphere;
    if (bb) height = Math.max(height, bb.max.y);
    if (bs) radius = Math.max(radius, bs.center.length() + bs.radius);
  }
  return { height, radius };
}

function variantInstance(seed: WorldSeed, id: string, v: number): Partial<GrowthInstance> {
  const vr = seed.rng(`gavdosveg/${id}/${v}`);
  return {
    leanX: (vr.float() - 0.5) * 0.18,
    leanZ: (vr.float() - 0.5) * 0.18,
    biasX: (vr.float() - 0.5) * 1.8,
    biasZ: (vr.float() - 0.5) * 1.8,
    age: 0.65 + vr.float() * 0.35,
  };
}

// ---------------------------------------------------------------------------
// buildGavdosVegLibrary
// ---------------------------------------------------------------------------

/**
 * Build a VegLib for the Gavdos world: 3 tree species (cls 0=juniper,
 * cls 1=pine, cls 2=olive) + phrygana shrub at cls 8 (BushHazel slot).
 * No boreal species, no impostors for them, no deadfall/logs.
 */
export async function buildGavdosVegLibrary(
  renderer: Renderer,
  seed: WorldSeed,
  progress: (p: number, msg: string) => void = () => {},
): Promise<VegLib> {
  progress(0, 'gavdos veg: capturing foliage atlases');

  // ---- foliage atlases -------------------------------------------------------
  const atlases = new Map<string, DataTexture>();
  const allSpecies: SpeciesParams[] = [
    ...GAVDOS_TREE_SPECIES,
    ...GAVDOS_UNDERSTORY_SPECIES,
  ];
  for (const sp of allSpecies) {
    if (!sp.foliage || atlases.has(sp.id)) continue;
    atlases.set(sp.id, await captureFoliageAtlas(renderer, sp, seed.rng(`gavdoscards/${sp.id}`)));
  }

  progress(0.18, 'gavdos veg: baking bark textures');

  // ---- bark textures (layers used by med species) ----------------------------
  const barks = new Map<number, BarkTextures>();
  const barkLayersNeeded = new Set<number>([
    GAVDOS_JUNIPER.barkLayer,  // 4
    CALABRIAN_PINE.barkLayer,  // 1
    OLIVE.barkLayer,           // 2
    PHRYGANA.barkLayer,        // 4 (same as juniper)
    5, // snag bark for dead branches (not used in gavdos, but VegLib barks map expected)
  ]);
  for (const layer of barkLayersNeeded) {
    barks.set(layer, await bakeBarkTextures(renderer, layer, seed.sub(`gavdosbark/${layer}`) % 977));
  }

  const barkOf = (layer: number): BarkTextures => {
    const b = barks.get(layer);
    if (!b) throw new Error(`gavdos: bark layer ${layer} not baked`);
    return b;
  };

  const pools: VegPool[] = [];
  const clsHeight = new Array<number>(24).fill(1);
  const clsRadius = new Array<number>(24).fill(1);
  const clsMaxDist = new Array<number>(24).fill(150);

  const trackCls = (cls: number, h: number, r: number): void => {
    clsHeight[cls] = Math.max(clsHeight[cls] ?? 1, h);
    clsRadius[cls] = Math.max(clsRadius[cls] ?? 1, r);
  };

  // ---- tree species: 3 × 4 variants -----------------------------------------
  progress(0.3, 'gavdos veg: growing tree variant pools');

  const treeParts = (sp: SpeciesParams, t: ReturnType<typeof buildTree>): PoolPart[] => {
    const parts: PoolPart[] = [
      {
        geo: t.bark,
        tris: t.bark.index ? t.bark.index.count / 3 : 0,
        make: () => barkTexturedMaterial(barkOf(sp.barkLayer)),
        castShadow: true,
      },
    ];
    const atlas = atlases.get(sp.id);
    if (t.foliage && atlas) {
      parts.push({
        geo: t.foliage,
        tris: t.foliage.index ? t.foliage.index.count / 3 : 0,
        make: () => foliageCardMaterial(atlas, { color: sp.foliageColor }),
        castShadow: true,
      });
    }
    return parts;
  };

  for (let ci = 0; ci < GAVDOS_TREE_SPECIES.length; ci++) {
    const sp = GAVDOS_TREE_SPECIES[ci] as SpeciesParams;
    for (let v = 0; v < TREE_VARIANTS; v++) {
      const label = `gavdosveg/${sp.id}/${v}`;
      const inst = variantInstance(seed, sp.id, v);
      const t0 = buildTree(sp, seed.rng(label), {
        lod: 0,
        inst,
        foliageMode: 'hybrid',
        hero: GAVDOS_HERO_DIETS[sp.id] ?? { cardTarget: 1200, meshAnchorTarget: 1000 },
      });
      const t1 = buildTree(sp, seed.rng(label), { lod: 1, inst });
      const t2 = buildTree(sp, seed.rng(label), { lod: 2, inst });
      const r0 = treeParts(sp, t0);
      if (t0.foliageMesh) {
        r0.push({
          geo: t0.foliageMesh,
          tris: t0.foliageMesh.index ? t0.foliageMesh.index.count / 3 : 0,
          make: () => foliageMaterial({ color: sp.foliageColor }),
          castShadow: false,
        });
      }
      const r1 = treeParts(sp, t1);
      const r2 = treeParts(sp, t2);
      const b = bounds(r1.map((p) => p.geo));
      trackCls(ci, b.height, b.radius);
      pools.push({ cls: ci, variant: v, r0, r1, r2, trisR1: t1.stats.tris, trisR2: t2.stats.tris, height: b.height, radius: b.radius });
    }
    clsMaxDist[ci] = 1e8;
    progress(0.3 + 0.3 * ((ci + 1) / GAVDOS_TREE_SPECIES.length), `gavdos veg: ${sp.id} pool`);
  }

  // ---- tree impostors (variant 0 R1) -----------------------------------------
  progress(0.62, 'gavdos veg: capturing impostors');
  const impostors = new Map<number, ImpostorAtlas>();
  for (let ci = 0; ci < GAVDOS_TREE_SPECIES.length; ci++) {
    const sp = GAVDOS_TREE_SPECIES[ci] as SpeciesParams;
    const t = buildTree(sp, seed.rng(`gavdosveg/${sp.id}/0`), {
      lod: 1,
      inst: variantInstance(seed, sp.id, 0),
    });
    const parts: import('../vegetation/Impostors').ImpostorPart[] = [
      { geometry: t.bark, kind: 'bark', barkTex: barkOf(sp.barkLayer) },
    ];
    const atlas = atlases.get(sp.id);
    if (t.foliage && atlas) parts.push({ geometry: t.foliage, kind: 'cards', atlas });
    const radius = Math.max(t.stats.height * 0.55, t.skeleton.crownRadius * 1.4, 2);
    impostors.set(ci, await captureImpostor(renderer, parts, { centerY: t.stats.height * 0.5, radius }));
    progress(0.62 + 0.12 * ((ci + 1) / GAVDOS_TREE_SPECIES.length), `gavdos veg: impostor ${sp.id}`);
  }

  // ---- phrygana shrub (cls 8 = BushHazel slot) --------------------------------
  progress(0.76, 'gavdos veg: phrygana shrub pools');
  const PHRYGANA_CLS = 8; // VegClass.BushHazel — reuse the slot
  for (let v = 0; v < 4; v++) {
    const rng = seed.rng(`gavdosveg/${PHRYGANA.id}/${v}`);
    const shrub = buildShrub(PHRYGANA, rng);
    const atlas = atlases.get(PHRYGANA.id);
    const parts: PoolPart[] = [
      {
        geo: shrub.bark,
        tris: shrub.bark.index ? shrub.bark.index.count / 3 : 0,
        make: () => barkTexturedMaterial(barkOf(PHRYGANA.barkLayer)),
        castShadow: false, // tiny shrubs: shadow casters budget saved
      },
    ];
    if (shrub.foliage && atlas) {
      parts.push({
        geo: shrub.foliage,
        tris: shrub.foliage.index ? shrub.foliage.index.count / 3 : 0,
        make: () => foliageCardMaterial(atlas, { color: PHRYGANA.foliageColor }),
        castShadow: false,
      });
    }
    const b = bounds(parts.map((p) => p.geo));
    trackCls(PHRYGANA_CLS, b.height, b.radius);
    pools.push({ cls: PHRYGANA_CLS, variant: v, r1: parts, r2: null, trisR1: shrub.tris, trisR2: 0, height: b.height, radius: b.radius });
  }
  clsMaxDist[PHRYGANA_CLS] = 180;

  // ---- Mediterranean rocks: pale limestone + warm sandstone tones ------------
  progress(0.88, 'gavdos veg: rock pools');
  const paleRock = { r: 0.38, g: 0.36, b: 0.30 };  // warm limestone
  const BoulderCls = 18;
  const SlabCls = 19;
  for (const { cls, preset, moss } of [
    { cls: BoulderCls, preset: 'boulder' as const, moss: 0.06 },
    { cls: SlabCls,    preset: 'slab' as const,    moss: 0.03 },
  ]) {
    for (let v = 0; v < 4; v++) {
      const hi = buildRock(preset, seed.rng(`gavdosrock/${preset}/${v}`), 4);
      const lo = buildRock(preset, seed.rng(`gavdosrock/${preset}/${v}`), 3);
      const b = bounds([hi.geometry]);
      trackCls(cls, b.height, b.radius);
      pools.push({
        cls, variant: v,
        r1: [{ geo: hi.geometry, tris: hi.stats.tris, make: () => rockMaterial({ moss, tone: paleRock }), castShadow: true }],
        r2: [{ geo: lo.geometry, tris: lo.stats.tris, make: () => rockMaterial({ moss, tone: paleRock }), castShadow: true }],
        trisR1: hi.stats.tris, trisR2: lo.stats.tris, height: b.height, radius: b.radius,
      });
    }
    clsMaxDist[cls] = 700;
  }

  // small stones (StoneL/StoneM/StoneS classes 20/21/22) — warm pale
  const stoneClasses: { cls: number; preset: 'boulder' | 'cobble'; d1: number; d2: number | null; maxDist: number }[] = [
    { cls: 20, preset: 'boulder', d1: 3, d2: 2, maxDist: 900 },
    { cls: 21, preset: 'cobble',  d1: 2, d2: 1, maxDist: 280 },
    { cls: 22, preset: 'cobble',  d1: 1, d2: null, maxDist: 90 },
  ];
  for (const sc of stoneClasses) {
    for (let v = 0; v < 4; v++) {
      const hi = buildRock(sc.preset, seed.rng(`gavdosstoneL${sc.cls}/${v}`), sc.d1);
      const lo = sc.d2 !== null ? buildRock(sc.preset, seed.rng(`gavdosstoneL${sc.cls}/${v}`), sc.d2) : null;
      const b = bounds([hi.geometry]);
      trackCls(sc.cls, b.height, b.radius);
      pools.push({
        cls: sc.cls, variant: v,
        r1: [{ geo: hi.geometry, tris: hi.stats.tris, make: () => rockMaterial({ moss: 0.04, tone: paleRock }), castShadow: sc.cls !== 22 }],
        r2: lo ? [{ geo: lo.geometry, tris: lo.stats.tris, make: () => rockMaterial({ moss: 0.04, tone: paleRock }), castShadow: sc.cls === 20 }] : null,
        trisR1: hi.stats.tris, trisR2: lo ? lo.stats.tris : 0, height: b.height, radius: b.radius,
      });
    }
    clsMaxDist[sc.cls] = sc.maxDist;
  }

  progress(1, 'gavdos veg: pools ready');
  return { pools, impostors, clsHeight, clsRadius, clsMaxDist, atlases, barks };
}

// ---------------------------------------------------------------------------
// runGavdosScatter — CPU placement driven by species.bin × weights.bin
// ---------------------------------------------------------------------------

/** Same shape as ScatterResult from Scatter.ts */
export interface GavdosScatterResult {
  trees: { bufA: unknown; bufB: unknown; cap: number; count: number };
  understory: { bufA: unknown; bufB: unknown; cap: number; count: number };
  extras: { bufA: unknown; bufB: unknown; cap: number; count: number };
  stones: { bufA: unknown; bufB: unknown; cap: number; count: number };
}

const TREE_CAP_G   = 80_000;
const UNDER_CAP_G  = 450_000;
const EXTRA_CAP_G  = 40_000;
const STONE_CAP_G  = 600_000;

// VegClass values (matching Scatter.ts)
const VC_BOULDER = 18;
const VC_SLAB    = 19;
const VC_STONEL  = 20;
const VC_STONEM  = 21;
const VC_STONES  = 22;

/**
 * Deterministic float hash from two integers (Cantor + xorshift).
 * Returns [0,1).
 */
function hashF(a: number, b: number): number {
  let h = ((a * 1664525 + b * 1013904223) ^ (a * 22695477 + b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return (h & 0xffffff) / 16777216;
}

function hashF2(a: number, b: number, salt: number): number {
  return hashF(a ^ salt, b ^ (salt >> 16));
}

/**
 * Poisson-scatter trees + understory + rocks over Gavdos using the
 * species.bin and weights.bin maps sampled at each candidate cell.
 *
 * The result has the same structure as ScatterResult so the existing
 * Forests / GroundRing pipeline works without changes.
 */
export async function runGavdosScatter(
  _renderer: Renderer,
  data: GavdosDataResult,
): Promise<GavdosScatterResult> {
  const { cpuHeights, cpuSpecies, cpuWeights, vegRes } = data;
  const halfW = GAVDOS_WORLD_SIZE / 2;

  // Allocate CPU scratch: (x,y,z,scale) and (yaw,leanX,leanZ,idF)
  const tArrA = new Float32Array(TREE_CAP_G * 4);
  const tArrB = new Float32Array(TREE_CAP_G * 4);
  const uArrA = new Float32Array(UNDER_CAP_G * 4);
  const uArrB = new Float32Array(UNDER_CAP_G * 4);
  const eArrA = new Float32Array(EXTRA_CAP_G * 4);
  const eArrB = new Float32Array(EXTRA_CAP_G * 4);
  const sArrA = new Float32Array(STONE_CAP_G * 4);
  const sArrB = new Float32Array(STONE_CAP_G * 4);

  let tCount = 0;
  let uCount = 0;
  let eCount = 0;
  let sCount = 0;

  // Helpers ----------------------------------------------------------------
  const sampleAt = (x: number, z: number): { h: number; sp: number; wt: number; mask: number } => {
    // world → [0,1] UV → pixel in vegRes² grid
    const ux = (x + halfW) / GAVDOS_WORLD_SIZE;
    const uz = (z + halfW) / GAVDOS_WORLD_SIZE;
    const px = Math.floor(ux * (vegRes - 1) + 0.5);
    const py = Math.floor(uz * (vegRes - 1) + 0.5);
    const cx = Math.min(Math.max(px, 0), vegRes - 1);
    const cy = Math.min(Math.max(py, 0), vegRes - 1);
    const i = cy * vegRes + cx;
    return {
      h: cpuHeights[i] ?? 0,
      sp: cpuSpecies[i] ?? 0,
      wt: cpuWeights[i] ?? 0,
      mask: 0, // mask embedded in sp==0
    };
  };

  const pushTree = (x: number, h: number, z: number, scale: number, yaw: number, leanX: number, leanZ: number, cls: number, variant: number): void => {
    if (tCount >= TREE_CAP_G) return;
    const idF = cls * 8 + variant;
    const i = tCount * 4;
    tArrA[i] = x; tArrA[i + 1] = h - scale * 0.12; tArrA[i + 2] = z; tArrA[i + 3] = scale;
    tArrB[i] = yaw; tArrB[i + 1] = leanX; tArrB[i + 2] = leanZ; tArrB[i + 3] = idF;
    tCount++;
  };

  const pushUnder = (x: number, h: number, z: number, scale: number, yaw: number, leanX: number, leanZ: number, cls: number, variant: number): void => {
    if (uCount >= UNDER_CAP_G) return;
    const idF = cls * 8 + variant;
    const i = uCount * 4;
    uArrA[i] = x; uArrA[i + 1] = h; uArrA[i + 2] = z; uArrA[i + 3] = scale;
    uArrB[i] = yaw; uArrB[i + 1] = leanX; uArrB[i + 2] = leanZ; uArrB[i + 3] = idF;
    uCount++;
  };

  const pushExtra = (x: number, h: number, z: number, scale: number, yaw: number, cls: number, variant: number): void => {
    if (eCount >= EXTRA_CAP_G) return;
    const idF = cls * 8 + variant;
    const i = eCount * 4;
    eArrA[i] = x; eArrA[i + 1] = h; eArrA[i + 2] = z; eArrA[i + 3] = scale;
    eArrB[i] = yaw; eArrB[i + 1] = 0; eArrB[i + 2] = 0; eArrB[i + 3] = idF;
    eCount++;
  };

  const pushStone = (x: number, h: number, z: number, scale: number, yaw: number, cls: number, variant: number): void => {
    if (sCount >= STONE_CAP_G) return;
    const idF = cls * 8 + variant;
    const i = sCount * 4;
    sArrA[i] = x; sArrA[i + 1] = h; sArrA[i + 2] = z; sArrA[i + 3] = scale;
    sArrB[i] = yaw; sArrB[i + 1] = 0; sArrB[i + 2] = 0; sArrB[i + 3] = idF;
    sCount++;
  };

  // ---- Tree pass (cell 5 m) ------------------------------------------------
  const TCELL = 5.0;
  const TGRID = Math.ceil(GAVDOS_WORLD_SIZE / TCELL);
  const TSALT = 0x4a7c3d;

  for (let gy = 0; gy < TGRID; gy++) {
    for (let gx = 0; gx < TGRID; gx++) {
      const jx = hashF(gx, gy ^ TSALT);
      const jz = hashF2(gx, gy, TSALT ^ 0x9e37);
      const wx = (gx + jx) * TCELL - halfW;
      const wz = (gy + jz) * TCELL - halfW;
      if (wx < -halfW || wx > halfW || wz < -halfW || wz > halfW) continue;

      const site = sampleAt(wx, wz);
      const h = site.h;
      const sp = site.sp;    // 0=none,1=juniper,2=pine,3=olive,4=phrygana
      const wt = site.wt;

      // Juniper exception: allowed on sand/dunes (h may be 0–5 m)
      const isJuniperOnSand = sp === 1 && h >= 0.0;
      if (!isJuniperOnSand && h < 1.5) continue;  // sea / beach exclusion

      // Map species → cls
      let cls = -1;
      if (sp === 1) cls = 0;       // gavdosJuniper
      else if (sp === 2) cls = 1;  // calabrianPine
      else if (sp === 3) cls = 2;  // olive
      // sp==4 phrygana → understory, not tree pass
      // sp==0 → no placement

      if (cls < 0) continue;

      // Density gate: base probability from weight map + per-species arid factor
      const baseProb = sp === 1 ? 0.18 : sp === 2 ? 0.12 : 0.15;
      const prob = baseProb * Math.max(wt, 0.1);
      if (hashF(gx ^ 0x1234, gy) > prob) continue;

      const scale = 0.65 + hashF(gx ^ 0x5678, gy) * 0.7;
      const yaw = hashF(gx ^ 0xabc, gy) * 6.2832;
      const lx = (hashF(gx ^ 0xdef, gy) - 0.5) * 0.12;
      const lz = (hashF(gx ^ 0x111, gy) - 0.5) * 0.12;
      const variant = Math.floor(hashF(gx ^ 0x222, gy) * TREE_VARIANTS) % TREE_VARIANTS;
      pushTree(wx, h, wz, scale, yaw, lx, lz, cls, variant);
    }
  }

  // ---- Understory pass (cell 2.8 m) — phrygana dominant -------------------
  const UCELL = 2.8;
  const UGRID = Math.ceil(GAVDOS_WORLD_SIZE / UCELL);
  const USALT = 0x7b1e4f;
  const PHRYGANA_CLS = 8;  // VegClass.BushHazel slot

  for (let gy = 0; gy < UGRID; gy++) {
    for (let gx = 0; gx < UGRID; gx++) {
      const jx = hashF(gx, gy ^ USALT);
      const jz = hashF2(gx, gy, USALT ^ 0x5c3a);
      const wx = (gx + jx) * UCELL - halfW;
      const wz = (gy + jz) * UCELL - halfW;
      if (wx < -halfW || wx > halfW || wz < -halfW || wz > halfW) continue;

      const site = sampleAt(wx, wz);
      const h = site.h;
      const sp = site.sp;
      const wt = site.wt;

      // Only on land with h > 0.5 (beach scrub edge), no sea
      if (h < 0.5) continue;
      // Phrygana on all species except water; densest where sp==4
      const phryProb = sp === 4 ? 0.45 : sp === 1 ? 0.22 : sp === 2 ? 0.14 : sp === 3 ? 0.20 : 0.05;
      const prob = phryProb * Math.max(wt * 0.8 + 0.2, 0.1);
      if (hashF(gx ^ 0x3333, gy) > prob) continue;

      const scale = 0.4 + hashF(gx ^ 0x4444, gy) * 0.8;
      const yaw = hashF(gx ^ 0x5555, gy) * 6.2832;
      const lx = (hashF(gx ^ 0x6666, gy) - 0.5) * 0.08;
      const lz = (hashF(gx ^ 0x7777, gy) - 0.5) * 0.08;
      const variant = Math.floor(hashF(gx ^ 0x8888, gy) * 4) % 4;
      pushUnder(wx, h, wz, scale, yaw, lx, lz, PHRYGANA_CLS, variant);
    }
  }

  // ---- Extras pass: boulders / slabs on rocky/slope areas -----------------
  const ECELL = 8.0;
  const EGRID = Math.ceil(GAVDOS_WORLD_SIZE / ECELL);
  const ESALT = 0x2c9f1a;

  for (let gy = 0; gy < EGRID; gy++) {
    for (let gx = 0; gx < EGRID; gx++) {
      const jx = hashF(gx, gy ^ ESALT);
      const jz = hashF2(gx, gy, ESALT ^ 0xd3b1);
      const wx = (gx + jx) * ECELL - halfW;
      const wz = (gy + jz) * ECELL - halfW;
      if (wx < -halfW || wx > halfW || wz < -halfW || wz > halfW) continue;

      const site = sampleAt(wx, wz);
      if (site.h < 0.5) continue;

      const r = hashF(gx ^ 0xeeee, gy);
      const yaw = hashF(gx ^ 0xffff, gy) * 6.2832;
      const scale = 0.6 + hashF(gx ^ 0xaaaa, gy) * 1.4;
      const variant = Math.floor(hashF(gx ^ 0xbbbb, gy) * 4) % 4;

      // Rocky areas get more boulders; 25% probability on rocky mask (sp==0, high h)
      const prob = site.h > 100 ? 0.2 : site.h > 30 ? 0.1 : 0.05;
      if (r > prob) continue;

      const cls = r < prob * 0.55 ? VC_BOULDER : VC_SLAB;
      pushExtra(wx, site.h, wz, scale, yaw, cls, variant);
    }
  }

  // ---- Stone pass: small ground coverage -----------------------------------
  const SCELL = 3.2;
  const SGRID = Math.ceil(GAVDOS_WORLD_SIZE / SCELL);
  const SSALT = 0x6e2b8d;

  for (let gy = 0; gy < SGRID; gy++) {
    for (let gx = 0; gx < SGRID; gx++) {
      const jx = hashF(gx, gy ^ SSALT);
      const jz = hashF2(gx, gy, SSALT ^ 0x4f2c);
      const wx = (gx + jx) * SCELL - halfW;
      const wz = (gy + jz) * SCELL - halfW;
      if (wx < -halfW || wx > halfW || wz < -halfW || wz > halfW) continue;

      const site = sampleAt(wx, wz);
      if (site.h < 0.3) continue;

      const r = hashF(gx ^ 0x1111, gy);
      if (r > 0.28) continue;  // sparse — arid island

      const yaw = hashF(gx ^ 0x2222, gy) * 6.2832;
      const scale = 0.4 + hashF(gx ^ 0x3333, gy) * 0.8;
      const variant = Math.floor(hashF(gx ^ 0x4444, gy) * 4) % 4;
      const rr = hashF(gx ^ 0x5555, gy);
      const cls = rr < 0.3 ? VC_STONEL : rr < 0.65 ? VC_STONEM : VC_STONES;
      pushStone(wx, site.h, wz, scale, yaw, cls, variant);
    }
  }

  // ---- Upload to GPU via StorageBufferAttribute ----------------------------
  // We use the same instance-layout as the GPU scatter (vec4 A + vec4 B)
  // and upload as StorageBufferAttribute so Forests/GroundRing can read them.
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { storage } = await import('three/tsl');

  const makeLayer = async (
    arrA: Float32Array,
    arrB: Float32Array,
    count: number,
    cap: number,
  ): Promise<{ bufA: unknown; bufB: unknown; cap: number; count: number }> => {
    const realCount = Math.min(count, cap);
    // Trim to actual count (padded to cap for the attribute)
    const a = new Float32Array(cap * 4);
    const b = new Float32Array(cap * 4);
    a.set(arrA.subarray(0, realCount * 4));
    b.set(arrB.subarray(0, realCount * 4));
    const attrA = new StorageBufferAttribute(a, 4);
    const attrB = new StorageBufferAttribute(b, 4);
    const bufA = storage(attrA, 'vec4', cap);
    const bufB = storage(attrB, 'vec4', cap);
    return { bufA, bufB, cap, count: realCount };
  };

  const trees      = await makeLayer(tArrA, tArrB, tCount, TREE_CAP_G);
  const understory = await makeLayer(uArrA, uArrB, uCount, UNDER_CAP_G);
  const extras     = await makeLayer(eArrA, eArrB, eCount, EXTRA_CAP_G);
  const stones     = await makeLayer(sArrA, sArrB, sCount, STONE_CAP_G);

  return { trees, understory, extras, stones } as GavdosScatterResult;
}

// ---------------------------------------------------------------------------
// placeGavdosRocks — instantiate rocks.json detected boulders
// ---------------------------------------------------------------------------

interface RocksEntry {
  lng: number;
  lat: number;
  r: number;
  c: [number, number, number];
}

/**
 * Load rocks.json and push each boulder into the extras scatter layer
 * at the correct world position. Called after runGavdosScatter if the
 * caller wants precise cadastral-grade rock placement.
 *
 * Returns a count of rocks placed.
 */
export async function placeGavdosRocks(
  scatter: GavdosScatterResult,
  data: GavdosDataResult,
): Promise<number> {
  let raw: RocksEntry[];
  try {
    const resp = await fetch('/gavdos/rocks.json');
    raw = (await resp.json()) as RocksEntry[];
  } catch {
    return 0; // non-critical: proceed without it
  }

  const extras = scatter.extras as { bufA: unknown; bufB: unknown; cap: number; count: number };
  // Access the underlying float array via the StorageBufferAttribute
  // The attribute is at (bufA as {value:{array:Float32Array}}).value.array
  const getArr = (buf: unknown): Float32Array | null => {
    try {
      const a = (buf as { value: { array: Float32Array } }).value.array;
      return a instanceof Float32Array ? a : null;
    } catch {
      return null;
    }
  };
  const arrA = getArr(extras.bufA);
  const arrB = getArr(extras.bufB);
  if (!arrA || !arrB) return 0;

  let placed = 0;
  const halfW = GAVDOS_WORLD_SIZE / 2;
  const { cpuHeights, vegRes } = data;

  for (const rock of raw) {
    if (extras.count >= extras.cap) break;
    const { x, z } = lonLatToWorld(rock.lng, rock.lat);
    if (Math.abs(x) > halfW || Math.abs(z) > halfW) continue;

    // Sample height at this position
    const ux = (x + halfW) / GAVDOS_WORLD_SIZE;
    const uz = (z + halfW) / GAVDOS_WORLD_SIZE;
    const px = Math.min(Math.max(Math.round(ux * (vegRes - 1)), 0), vegRes - 1);
    const py = Math.min(Math.max(Math.round(uz * (vegRes - 1)), 0), vegRes - 1);
    const h = cpuHeights[py * vegRes + px] ?? 0;
    if (h < -5) continue;  // deep underwater

    // Scale from radius (rocks.json r is in meters)
    const scale = Math.max(rock.r / 8, 0.5);
    const cls = rock.r > 8 ? VC_BOULDER : VC_STONEL;
    const variant = Math.floor(Math.abs(Math.sin(rock.lng * 1000)) * 4) % 4;
    const yaw = Math.abs(Math.sin(rock.lat * 1000)) * 6.2832;
    const idF = cls * 8 + variant;
    const i = extras.count * 4;
    arrA[i] = x; arrA[i + 1] = h; arrA[i + 2] = z; arrA[i + 3] = scale;
    arrB[i] = yaw; arrB[i + 1] = 0; arrB[i + 2] = 0; arrB[i + 3] = idF;
    extras.count++;
    placed++;
  }
  return placed;
}
