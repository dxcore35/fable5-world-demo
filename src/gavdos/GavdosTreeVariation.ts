/**
 * GavdosTreeVariation — procedural per-variant shape & foliage diversity.
 *
 * Shared by the live veg builder (GavdosVeg) and the headless verify/render
 * tools, so what gets inspected is exactly what ships. Pure data + RNG only
 * (no three.js renderer/materials) → safe to import headless.
 *
 * Goal: every variant of a species should differ in ALL the things the tree is
 * generated from — overall proportions, trunk girth, crown asymmetry, branch
 * posture (angle/wander/droop/curl/length), gnarl, storm-breakage, AND canopy
 * (leaf density, leaf size, tint) — not just height.
 */
import type { WorldSeed } from '../core/Seed';
import type { GrowthInstance, SpeciesParams } from '../vegetation/VegTypes';

/** Per-variant placement/growth instance: coastal wind-lean + crown bias + age. */
export function variantInstance(seed: WorldSeed, id: string, v: number): Partial<GrowthInstance> {
  const vr = seed.rng(`gavdosveg/${id}/${v}`);
  // Coastal trees lean off a prevailing wind: per-variant bearing + magnitude
  // (skewed low, so a few read as strongly wind-swept).
  const windDir = vr.float() * Math.PI * 2;
  const windMag = 0.04 + vr.float() * vr.float() * 0.26; // 0.04..0.30
  return {
    leanX: Math.cos(windDir) * windMag,
    leanZ: Math.sin(windDir) * windMag,
    biasX: (vr.float() - 0.5) * 2.0,
    biasZ: (vr.float() - 0.5) * 2.0,
    age: 0.4 + vr.float() * 0.6, // young & slender → old & broad
  };
}

/**
 * Deep-clone a species and jitter every shape- and canopy-defining field so the
 * variant grows a distinct silhouette. Multiplicative jitter stays within valid
 * ranges; clamps guard the few absolute fields.
 */
export function perturbSpecies(sp: SpeciesParams, rng: { float(): number }): SpeciesParams {
  const jit = (c: number, amt: number): number => c * (1 + (rng.float() - 0.5) * 2 * amt);
  const psp: SpeciesParams = structuredClone(sp);

  // ---- overall proportions ----
  const hf = 0.82 + rng.float() * 0.36; // 0.82..1.18 height scale
  psp.height = [sp.height[0] * hf, sp.height[1] * hf];
  psp.trunkRadiusK = jit(sp.trunkRadiusK, 0.2);
  psp.asym = Math.min(0.7, Math.max(0, sp.asym + (rng.float() - 0.5) * 0.32));

  // ---- branch posture per level (skip the bare trunk's insertion-angle fields) ----
  for (let i = 0; i < psp.levels.length; i++) {
    const L = psp.levels[i];
    L.wander = jit(L.wander, 0.4);
    L.droop = jit(L.droop, 0.32);
    L.tipCurl = jit(L.tipCurl, 0.38);
    L.taper = jit(L.taper, 0.08);
    if (i > 0) {
      L.angleBase = jit(L.angleBase, 0.14);
      L.angleTip = jit(L.angleTip, 0.14);
      L.lenRatio = jit(L.lenRatio, 0.14);
      L.density = jit(L.density, 0.22); // sparser / denser crowns
    }
  }

  // ---- gnarl / storm damage ----
  psp.stubChance = Math.min(0.22, Math.max(0, sp.stubChance + rng.float() * 0.12));
  psp.brokenTop = rng.float() < 0.1 ? 0.7 + rng.float() * 0.18 : (sp.brokenTop ?? 0);

  // ---- canopy: leaf density, size, and tint vary too ----
  if (psp.foliage) {
    const f = psp.foliage;
    f.spacing = jit(f.spacing, 0.18);           // anchor spacing → canopy density
    const lf = 0.86 + rng.float() * 0.28;        // leaf/needle size scale
    f.scale = [f.scale[0] * lf, f.scale[1] * lf];
  }
  const fc = psp.foliageColor;
  if (fc) {
    psp.foliageColor = {
      r: jit(fc.r, 0.12),
      g: jit(fc.g, 0.1),
      b: jit(fc.b, 0.12),
      hueVar: fc.hueVar,
    };
  }

  return psp;
}
