/**
 * GavdosOcean — Mediterranean ocean surface for the real-DEM Gavdos world.
 *
 * Two components:
 *   1. Near clipmap (6 levels, same grid as WaterSurface) at y = 0, covering
 *      the whole 10240 m window.  Each vertex drops under terrain where h > 0
 *      via the depth-test (positionNode is set to y = 0 regardless; fragments
 *      above sea floor show fine because the terrain is in front).
 *
 *   2. Far sea disc — a flat full CircleGeometry (inner radius 0) of radius
 *      max(FAR_RADIUS, worldHalf*1.5), replacing the procedural far-shell hills.
 *      One flat mesh, one cheap material.  The radius scales with the active
 *      world so the sea fills out to the horizon on both gavdos (~14 km) and
 *      crete (~210 km).
 *
 * No hf.flow required (gavdos has no hydrology pass).
 *
 * Depth-aware colour: uses hf.sampleHeight(xz) < 0 to derive the water column
 * thickness.  Shallow (<12 m) → turquoise, deep → navy, using Beer-Lambert
 * identical to WaterMaterial but with Mediterranean coefficients.
 *
 * Shore foam: derived from |h| < 1.5 m at runtime — simpler and more accurate
 * than loading shore.png at this size.  (shore.png is the full-bbox 2048×1664
 * raster covering 0.3°×0.2°; resampling it to the 10240 m window in the shader
 * would require a separate UV transform and an extra texture fetch.  Runtime
 * depth band is zero cost.)
 *
 * Waves: two-layer fbm advected with a gentle constant Mediterranean breeze
 * (no flow field); amplitude keeps normals < 5° tilt → subtle wind-chop,
 * never lake-still, never stormy.
 *
 * Caustics: off — CausticsBake requires hf.flow (hydrology output, null in
 * gavdos). Flagged as expected deviation.
 *
 * SSR/reflections: reused from WaterMaterial (sky-view LUT + 18-step march).
 *
 * [T3 DEVIATIONS]
 *   - Caustics disabled (hf.flow null).
 *   - Shore foam derived from runtime depth (h < 1.5 m), not shore.png.
 *   - Far shell replaced with a flat sea disc; no analytic macro terrain beyond
 *     the world edge for gavdos (the real island ends well inside the window).
 */

import { BufferAttribute, BufferGeometry, CircleGeometry, Group, Mesh, Vector2, Vector4 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { PerspectiveCamera } from 'three';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  exp,
  float,
  fract,
  getScreenPosition,
  interleavedGradientNoise,
  mix,
  perspectiveDepthToViewZ,
  positionLocal,
  positionView,
  positionWorld,
  reflect,
  screenCoordinate,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
} from 'three/tsl';
import type { ProbeGI } from '../gpu/passes/ProbeGI';
import type { NF, NI, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import type { Atmosphere } from '../sky/Atmosphere';
import type { Heightfield } from '../world/Heightfield';
import { FAR_RADIUS, worldHalf, worldSize } from '../world/WorldConst';
import type { StorageTexture } from 'three/webgpu';
import { PERIOD_FBM } from '../gpu/passes/NoiseBake';
import { runiform } from '../gpu/RenderUniform';

// ---- Mediterranean absorption coefficients (water column, per metre) --------
// Shorter wavelengths absorbed last → deep water reads navy/indigo.
// r dies in ~2.4 m, g in ~7.5 m, b in ~10.5 m.
const SIGMA = { r: 0.42, g: 0.135, b: 0.095 };

// ---- Shore foam depth band ---------------------------------------------------
/** Water depths (m below sea level) where the foam band is non-zero */
const FOAM_DEEP = 1.5; // below this, full-opacity foam band
const FOAM_SHALLOW = 0.0; // above this (above sea level), no foam

// ---- Animated shore swash (wave run-up / retreat) ---------------------------
// The waterline advances up the beach and recedes like real swash. We shift the
// effective water depth by a small time-driven RUN-UP distance (metres), summed
// from a few overlapping wave sets with different frequencies and spatial phase
// so the wavefront isn't a single pulsing ring. Cost: a handful of sin/texture
// lookups per fragment, only meaningful inside the near-shore band.
/** Peak run-up amplitude in METRES of waterline travel (per wave set). Small —
 *  real swash on a gentle beach travels ~0.5–2 m up the slope. */
const RUNUP_AMP_M = 1.1;
/** Base angular speed (rad/s) of the slowest wave set; faster sets scale up. */
const RUNUP_SPEED = 0.55;
/** Brightness multiplier for the crisp foam line at the leading edge of run-up. */
const FOAM_GAIN = 1.6;

// ---- Clipmap geometry (matches WaterSurface) --------------------------------
const CELLS = 128;
const LEVEL_CELL = [1.5, 3, 6, 12, 24, 48] as const;

function gridGeometry(): BufferGeometry {
  const n = CELLS + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = (z * n + x) * 3;
      pos[i] = x - CELLS / 2;
      pos[i + 1] = 0;
      pos[i + 2] = z - CELLS / 2;
      nrm[i + 1] = 1;
    }
  }
  const idx = new Uint32Array(CELLS * CELLS * 6);
  let k = 0;
  for (let z = 0; z < CELLS; z++) {
    for (let x = 0; x < CELLS; x++) {
      const a = z * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

// ---- Shared ocean material factory ------------------------------------------

interface OceanLevelOpts {
  origin: NV2;
  innerRect: NV4;
  cell: number;
}

function buildOceanMaterial(
  hf: Heightfield,
  atm: Atmosphere,
  gi: ProbeGI | null,
  opts: OceanLevelOpts,
  landMask?: StorageTexture | null,
): MeshStandardNodeMaterial {
  const noiseA = hf.noiseA;
  if (!noiseA) throw new Error('GavdosOcean: hf.noiseA not baked yet');

  const mat = new MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false; // ocean at y=0 is occluded by terrain naturally
  mat.metalness = 0;

  // ---- vertex: clipmap grid → world y=0 surface + fast directional Gerstner (dispersion) ----
  const wxz = opts.origin.add(positionLocal.xz.mul(opts.cell));
  // LOD wave detail by clip level distance (outer levels = coarser macro only, fewer high-k)
  const cellF = float(opts.cell);
  const lodK = mix(float(1), float(0.35), smoothstep(6, 48, cellF)); // near full, far reduced
  const gLod = mix(float(1), float(0.25), smoothstep(12, 48, cellF));

  // Fast Gerstner waves: directional, dispersion ω=√(g·k), chop for crests.
  // 4 waves: main swell + 3 shorter for chop + detail. Physical phase speed.
  // Q controls choppiness (higher = steeper crests without breaking loop).
  const G = float(9.81);
  // wave defs: [dirX, dirZ, lambda(m), amp(m), Q, phaseOff]
  const GERSTNER = [
    [0.82, 0.57, 38.0, 0.55, 0.38, 0.0],
    [0.75, -0.66, 19.0, 0.32, 0.42, 1.7],
    [-0.61, 0.79, 9.5, 0.18, 0.55, 3.1],
    [0.94, 0.34, 5.2, 0.09, 0.65, 4.9],
  ] as const;

  const px = wxz.x.toVar();
  const py = float(0).toVar();
  const pz = wxz.y.toVar();
  const nx = float(0).toVar();
  const ny = float(1).toVar();
  const nz = float(0).toVar();
  for (const w of GERSTNER) {
    const k = float(6.2831853 / w[2]); // 2π/λ
    const omega = G.mul(k).sqrt().mul(0.82); // deep-water dispersion, slight slow for visible
    const dirX = float(w[0]);
    const dirZ = float(w[1]);
    const A = float(w[3]).mul(lodK);
    const Q = float(w[4]);
    const ph0 = float(w[5]);
    const phase = px.mul(k).mul(dirX).add(pz.mul(k).mul(dirZ)).sub(time.mul(omega)).add(ph0);
    const s = phase.sin();
    const c = phase.cos();
    // horizontal displacement (Gerstner chop) + vertical
    px.addAssign(dirX.mul(Q).mul(A).mul(s));
    pz.addAssign(dirZ.mul(Q).mul(A).mul(s));
    py.addAssign(A.mul(c));
    // accumulate normal perturbation (∂/∂ derivs)
    const akc = A.mul(k).mul(c);
    nx.addAssign(dirX.mul(akc).negate());
    nz.addAssign(dirZ.mul(akc).negate());
    ny.subAssign(A.mul(k).mul(Q).mul(s)); // curvature term
  }
  // normalize perturbed + bias
  const gN = vec3(nx, ny.add(1.0).max(0.2), nz).normalize().mul(gLod).add(vec3(0, 1, 0).mul(gLod.oneMinus())).normalize();

  mat.positionNode = vec3(px, py, pz);

  // ---- inner-level cutout + hard world bounds ------------------------------
  const p = positionWorld.xz;
  const r = opts.innerRect;
  const wh = worldHalf();
  const insideInner = p.x
    .greaterThan(r.x)
    .and(p.y.greaterThan(r.y))
    .and(p.x.lessThan(r.z))
    .and(p.y.lessThan(r.w));
  const inWorld = p.x.abs().lessThan(float(wh - 4)).and(p.y.abs().lessThan(float(wh - 4)));
  mat.maskNode = insideInner.not().and(inWorld);

  // ---- ripple micro (fbm advected) + Gerstner macro normals; LOD by level cell
  // Reuse 4 noise taps for grad + foam value (reduce texture bandwidth).
  const BREEZE = vec2(0.09, 0.035);
  const CYC = 0.32;
  const ph1 = fract(time.mul(CYC));
  const ph2 = fract(time.mul(CYC).add(0.5));
  const w2 = abs(ph1.sub(0.5)).mul(2);
  const offA = BREEZE.mul(ph1.div(CYC));
  const offB = BREEZE.mul(ph2.div(CYC)).add(vec2(3.71, 1.13));
  const uvA1 = positionWorld.xz.sub(offA).div(1.2 * PERIOD_FBM);
  const uvA2 = positionWorld.xz.sub(offA.mul(0.55)).div(4.5 * PERIOD_FBM);
  const uvB1 = positionWorld.xz.sub(offB).div(1.2 * PERIOD_FBM);
  const uvB2 = positionWorld.xz.sub(offB.mul(0.55)).div(4.5 * PERIOD_FBM);
  const sA1 = (texture(noiseA, uvA1) as unknown as NV4);
  const sA2 = (texture(noiseA, uvA2) as unknown as NV4);
  const sB1 = (texture(noiseA, uvB1) as unknown as NV4);
  const sB2 = (texture(noiseA, uvB2) as unknown as NV4);
  // grad from zw (reuse .y below for foam)
  const gA = sA1.zw.div(1.2).add(sA2.zw.div(4.5).mul(0.45));
  const gB = sB1.zw.div(1.2).add(sB2.zw.div(4.5).mul(0.45));
  const grad = mix(gA, gB, w2);
  const rippleAmp = float(0.0038).mul(lodK);
  const slope = grad.mul(rippleAmp);
  // combine Gerstner base normal + micro ripple (fewer taps, physical directional)
  const nRipple = vec3(slope.x.negate(), float(1), slope.y.negate()).normalize();
  const n = mix(nRipple, gN, gLod).normalize(); // gN from Gerstner vertex
  mat.normalNode = transformNormalToView(n);

  // ---- view / depth -----------------------------------------------------------
  const toCam = cameraPosition.sub(positionWorld);
  const dist = toCam.length();
  const viewDir = toCam.div(dist.max(1e-4));
  const fragZ = positionView.z;

  // ---- refraction (depth-validated, Beer–Lambert) ----------------------------
  const refrK = clamp(float(9).div(dist.max(1)), 0.04, 1).mul(0.055);
  const ruv = screenUV.add(n.xz.mul(refrK));
  const zR = perspectiveDepthToViewZ(
    (viewportDepthTexture(ruv) as unknown as NV4).x,
    cameraNear,
    cameraFar,
  );
  const leaked = zR.greaterThan(fragZ.add(0.02));
  const uvF = mix(ruv, screenUV, leaked.select(float(1), float(0)));
  const zScene = mix(
    zR,
    perspectiveDepthToViewZ(
      (viewportDepthTexture(screenUV) as unknown as NV4).x,
      cameraNear,
      cameraFar,
    ),
    leaked.select(float(1), float(0)),
  );
  const thick = fragZ.sub(zScene).max(float(0));
  const vDepth = thick.mul(viewDir.y.abs().max(float(0.06)));

  // Sample the actual seabed height to drive colour and foam.
  // hf.sampleHeight returns the raw DEM value (negative below sea level).
  const bedH = hf.sampleHeight(positionWorld.xz);
  // waterDepth: positive = below sea level; 0 at the shoreline; negative = above
  const waterDepth = bedH.negate().max(float(0)); // metres below sea level

  // Beer–Lambert absorption using real water depth rather than ray thickness
  // (ray thickness → 0 at grazing view but the water is still deep there)
  const absorb = waterDepth.add(thick.mul(0.6)).mul(float(1.1));
  const sceneCol = (viewportSharedTexture(uvF) as unknown as NV4).rgb;
  const T = vec3(
    exp(absorb.mul(-SIGMA.r)),
    exp(absorb.mul(-SIGMA.g)),
    exp(absorb.mul(-SIGMA.b)),
  );
  const inscat = atm.skyColor(vec3(0, 1, 0)).mul(vec3(0.009, 0.025, 0.022));
  const refr = sceneCol.mul(T).add(inscat.mul(vec3(1, 1, 1).sub(T)));

  // ---- Depth-aware base tint --------------------------------------------------
  // Shallow turquoise → deep navy blended over the Beer-Lambert result.
  // Turquoise: shallow water viewed from above reads bright aqua.
  // Navy: deep open sea.
  const shallowCol = vec3(0.18, 0.52, 0.52); // turquoise
  const deepCol    = vec3(0.02, 0.06, 0.22); // navy
  const depthT = clamp(waterDepth.div(float(12)), float(0), float(1));
  const seaTint = mix(shallowCol, deepCol, depthT.mul(depthT));
  // Blend tint into the refraction at depth — shallow shows the sandy bed,
  // deep is dominated by the tint
  const refrTinted = mix(refr, seaTint, depthT.mul(float(0.65)));

  // ---- Reflection (sky-view LUT + 18-step SSR) --------------------------------
  const rdir = reflect(viewDir.negate(), vec3(n.x.mul(0.55), n.y, n.z.mul(0.55)).normalize());
  const reflection = Fn((): NV3 => {
    const dirV = cameraViewMatrix.mul(vec4(rdir, 0)).xyz;
    const stepLen = clamp(dist.mul(0.09), 0.25, float(28));
    const jitter = interleavedGradientNoise(screenCoordinate.xy);
    const hit = float(0).toVar();
    const hitUv = vec2(0, 0).toVar();
    Loop(18, ({ i }: { readonly i: NI }) => {
      const t = float(i).add(jitter).mul(stepLen);
      const pV = positionView.add(dirV.mul(t));
      const uvS = getScreenPosition(pV, cameraProjectionMatrix) as unknown as NV2;
      If(
        uvS.x.lessThan(0).or(uvS.x.greaterThan(1)).or(uvS.y.lessThan(0)).or(uvS.y.greaterThan(1)),
        () => { Break(); },
      );
      const zS = perspectiveDepthToViewZ(
        (viewportDepthTexture(uvS) as unknown as NV4).x,
        cameraNear,
        cameraFar,
      );
      If(
        zS.greaterThan(pV.z.add(0.06)).and(zS.lessThan(pV.z.add(stepLen.mul(2.6).add(0.7)))),
        () => { hit.assign(1); hitUv.assign(uvS); Break(); },
      );
    });
    const rdirUp = vec3(rdir.x, rdir.y.max(float(0.035)), rdir.z).normalize();
    const sky = atm.skyColor(rdirUp);
    const fallback = gi
      ? (mix(
          gi.irradiance(positionWorld, rdir).mul(0.65) as unknown as NV3,
          sky as unknown as NV3,
          float(0.85),
        ) as unknown as NV3)
      : (sky as unknown as NV3);
    const e = hitUv.sub(0.5).abs().mul(2);
    const edgeFade = smoothstep(float(1.0), float(0.82), e.x.max(e.y));
    const scene = (viewportSharedTexture(hitUv) as unknown as NV4).rgb;
    return mix(fallback, scene, hit.mul(edgeFade));
  })();
  const skyRefl = reflection as unknown as NV3;

  // Fresnel on flattened normal
  const nFres = vec3(n.x.mul(0.3), n.y, n.z.mul(0.3)).normalize();
  const cosT = clamp(viewDir.dot(nFres), float(0), float(1));
  const fres = float(0.02).add(float(0.98).mul(cosT.oneMinus().pow(5)));

  // ---- Animated shore swash: run-up / retreat ---------------------------------
  // Spatial phase: a COHERENT directional swell — one uniform wind direction so the
  // wavefront travels the SAME way everywhere (symmetric, "like wind"), not random
  // per-stretch surges. phase = (worldXZ · windDir) · 2π/wavelength. ~160 m sets.
  const WIND_DIR = vec2(0.7071, 0.7071); // NE-ish steady wind
  const spatialPhase = positionWorld.xz.dot(WIND_DIR).mul(float(6.2832 / 160));
  // Three overlapping wave sets (different ω, amplitude, spatial-phase scale) so
  // the wavefront reads as real swash. sin → [-1,1]; multiplied by amplitude in
  // METRES gives signed waterline travel (positive = run-up advancing up-beach,
  // negative = retreating). Net travel stays ≈0.5–2 m (gentle beach).
  const wave1 = sin(time.mul(float(RUNUP_SPEED)).add(spatialPhase));
  const wave2 = sin(time.mul(float(RUNUP_SPEED * 1.7)).add(spatialPhase.mul(float(1.6))).add(float(2.1)));
  const wave3 = sin(time.mul(float(RUNUP_SPEED * 2.6)).add(spatialPhase.mul(float(0.7))).add(float(4.3)));
  const runUp = wave1.mul(float(RUNUP_AMP_M))
    .add(wave2.mul(float(RUNUP_AMP_M * 0.55)))
    .add(wave3.mul(float(RUNUP_AMP_M * 0.35)));
  // Effective depth tracks the moving waterline. Subtracting a positive run-up
  // pushes the foam band toward deeper water → the waterline advances up-beach.
  // Clamped at 0 so the band never wraps past the shoreline into dry land.
  const effDepth = waterDepth.sub(runUp).max(float(0));

  // ---- Shore foam band ---------------------------------------------------------
  // Runtime depth band: |h| < FOAM_DEEP → bright white foam at the (now moving)
  // waterline. This is where the DEM h transitions from negative to positive.
  const foamDepth = smoothstep(float(FOAM_DEEP), float(FOAM_SHALLOW), effDepth);
  // Foam from REUSED noise samples (.y channel) — 0 extra texture taps.
  // + physical whitecaps from total slope magnitude (age/steepness) + breaking.
  const varNorm = w2.mul(w2).add(w2.oneMinus().mul(w2.oneMinus())).sqrt();
  const fA = sA1.y; const fB = sB1.y; // reuse fetched (coarse)
  const fblend = mix(fA, fB, w2).sub(0.5).div(varNorm).add(0.5);
  const foamPat = smoothstep(float(0.4), float(0.75), fblend);
  const foamBase = foamDepth.mul(foamPat);
  // Whitecaps: slope-based (Gerstner+ripple) → crest foam independent of depth.
  // dispersion + chop produce realistic breaking age.
  const totalSlope = slope.length().add( gN.xz.length().mul(0.6) );
  const whiteCap = smoothstep(0.18, 0.38, totalSlope).mul(0.7);
  // Leading-edge crest + shoreline breaking accumulation (phase responsive).
  const advancing = smoothstep(float(0.2), float(0.95), wave1);
  const crestLine = smoothstep(float(0.5), float(0.0), effDepth).mul(advancing);
  const breakFoam = smoothstep(0.08, 0.01, effDepth).mul( smoothstep(0.6, 1.2, totalSlope).add(whiteCap) ).mul(0.55);
  const foam = foamBase.add(crestLine.mul(foamPat).mul(float(FOAM_GAIN)))
    .add(whiteCap).add(breakFoam)
    .clamp(float(0), float(1)) as NF;

  // ---- Compose ----------------------------------------------------------------
  // foam now carries slope-age whitecaps + directional breaking
  mat.colorNode = vec3(0.78, 0.80, 0.80).mul(foam);
  mat.emissiveNode = mix(refrTinted, skyRefl, fres).mul(foam.oneMinus());
  mat.roughnessNode = mix(float(0.06), float(0.62), foam);

  // Opacity: fade at shore (vDepth), always visible in open sea
  // vDepth → 0 at shore → fades out gracefully over dry land (where terrain
  // depth-tests the water plane and opacityNode is never reached anyway, but
  // the fade prevents a hard cut when the clipmap extends slightly onto land).
  const shoreAlpha = smoothstep(float(0.002), float(0.04), vDepth);
  // Always show in open sea (waterDepth > 0.5 m → full alpha regardless of ray)
  const seaAlpha = smoothstep(float(0.0), float(0.5), waterDepth);
  const oceanOpacity = shoreAlpha.max(seaAlpha).mul(float(0.98));
  // Sharp coastline cut (crete): kill water opacity wherever the OSM land mask
  // says land — trims the sea crisply at the true shoreline, independent of the
  // coarse terrain grid. When landMask is null (gavdos/laas) the graph is unchanged.
  if (landMask) {
    const landV = (texture(landMask, positionWorld.xz.div(worldSize()).add(0.5)) as unknown as NV4).r;
    // ANIMATED WATERLINE: the cut threshold oscillates with the swash waves so the
    // water runs UP onto the soft shore band and RETREATS — real beach swash.
    // swashN ∈ ~[-1.1,1.1] (reuses the wave set above); raising the threshold lets
    // water cover more of the land edge (run-up), lowering it bares the sand.
    // landV ramps 0→1 over ~1 mask texel (~63 m), so 1 unit of thr ≈ 63 m of
    // waterline travel. CAP run-up at ~3 m (2 m typical): multiplier 0.04 →
    // ±0.044 → ±~2.8 m. "Just up and down" — small, not metres of flooding.
    const swashN = wave1.mul(float(0.6)).add(wave2.mul(float(0.3))).add(wave3.mul(float(0.2)));
    const thr = float(0.5).add(swashN.mul(float(0.04)));
    // Tight soft band (±0.07 ≈ ±4 m) → crisp shoreline, not a wide blurry bleed.
    const waterMask = smoothstep(thr.add(float(0.07)), thr.sub(float(0.07)), landV);
    // The detected (SDS) waterline is AUTHORITATIVE at every zoom: keep the sea fully
    // opaque right up to the mask edge instead of fading with depth. The old depth
    // fade (oceanOpacity) made the ocean see-through in the shallow shore band, which
    // revealed the satellite-imagery's OWN coastline on the terrain underneath — so
    // far/zoomed-out views showed the "original map" coast and close views showed the
    // SDS coast (the jump you saw). Mask+swash now define the edge consistently.
    mat.opacityNode = waterMask.mul(float(0.98));
  } else {
    mat.opacityNode = oceanOpacity;
  }

  return mat;
}

// ---- Far sea disc material (cheap flat, atmosphere-matched) -----------------
// The disc covers 0→max(FAR_RADIUS, worldHalf*1.5) (full disc, inner radius 0)
// and sits at y=-0.05 so the clipmap levels (y=0) always draw on top without
// z-fighting.  Color matches the clipmap's deep-water branch (same deepCol +
// fresnel sky reflection) so the seam is invisible.

function buildFarSeaMaterial(atm: Atmosphere, landMask?: StorageTexture | null): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.metalness = 0;
  mat.roughness = 0.07;

  // Flat sea at y=-0.05 — position from geometry (slight bias so clipmap wins)
  // Colour: deep navy matching clipmap deepCol, with sky fresnel reflection
  const toCam = cameraPosition.sub(positionWorld);
  const dist = toCam.length();
  const viewDir = toCam.div(dist.max(float(1)));
  const rdir = vec3(viewDir.x.negate(), viewDir.y.abs().max(float(0.04)), viewDir.z.negate()).normalize();
  const skyCol = atm.skyColor(rdir) as unknown as NV3;
  // Fresnel: identical to clipmap deep-water branch
  const cosT = clamp(viewDir.y.abs(), float(0), float(1));
  const fres = float(0.02).add(float(0.98).mul(cosT.oneMinus().pow(5)));
  // Same deepCol constant as clipmap (0.02, 0.06, 0.22) — no mismatch
  const deepCol = vec3(0.02, 0.06, 0.22);
  mat.emissiveNode = mix(deepCol, skyCol, fres);
  mat.colorNode = vec3(0);
  // Always fully opaque — clipmap draws over us inside the window, atmosphere
  // hazes beyond FAR_RADIUS.  No ring-fade needed: the disc is invisible under
  // the clipmap (y=-0.05 loses depth test) and visible only where clipmap
  // doesn't reach.
  mat.opacityNode = landMask
    ? float(0.96).mul((texture(landMask, positionWorld.xz.div(worldSize()).add(0.5)) as unknown as NV4).r.oneMinus())
    : float(0.96);

  return mat;
}

// ---- GavdosOcean class -------------------------------------------------------

interface LevelHandle {
  origin: { value: Vector2 };
  innerRect: { value: Vector4 };
  cell: number;
}

export class GavdosOcean {
  readonly group = new Group();
  private readonly lvls: LevelHandle[] = [];

  constructor(
    hf: Heightfield,
    atm: Atmosphere,
    gi: ProbeGI | null,
    landMask: StorageTexture | null = null,
  ) {
    const geo = gridGeometry();

    // Near clipmap levels (same as WaterSurface)
    for (const cell of LEVEL_CELL) {
      const origin = runiform(new Vector2());
      const innerRect = runiform(new Vector4(1e9, 1e9, -1e9, -1e9));
      const mat = buildOceanMaterial(hf, atm, gi, {
        origin: origin as unknown as NV2,
        innerRect: innerRect as unknown as NV4,
        cell,
      }, landMask);
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.lvls.push({
        origin: origin as unknown as LevelHandle['origin'],
        innerRect: innerRect as unknown as LevelHandle['innerRect'],
        cell,
      });
    }

    // Far sea disc: full circle (inner radius 0) covering 0→FAR_DISC_RADIUS.
    // Sits at y=-0.05 so the clipmap (y=0) always wins the depth test and draws
    // on top — no visible boundary between clipmap and disc.
    // This eliminates the coverage gap that existed when using RingGeometry with
    // inner radius = worldHalf*0.96: from an offshore camera the ring's inner
    // hole exposed bare seabed in the far side of the window that the clipmap
    // didn't reach.
    //
    // Radius must scale with the active world, not be pinned to FAR_RADIUS.
    // FAR_RADIUS (14 km) covers gavdos (worldHalf=5120 → max(14000,7680)=14000,
    // identical to before) but is far too small for crete (worldHalf=140000):
    // a 14 km disc would leave the whole island ringed by bare seabed. Reading
    // worldHalf() here is safe because setActiveWorldSize() runs before the
    // ocean is constructed (per-world boot order).
    const farDiscRadius = Math.max(FAR_RADIUS, worldHalf() * 1.5);
    const disc = new CircleGeometry(farDiscRadius, 120);
    disc.rotateX(-Math.PI / 2);
    const farMat = buildFarSeaMaterial(atm, landMask);
    const farDisc = new Mesh(disc, farMat);
    farDisc.position.y = -0.05;
    farDisc.frustumCulled = false;
    farDisc.castShadow = false;
    farDisc.receiveShadow = false;
    this.group.add(farDisc);
  }

  update(cam: PerspectiveCamera): void {
    let prev: Vector4 | null = null;
    for (const lvl of this.lvls) {
      const snap = lvl.cell * 2;
      const ox = Math.floor(cam.position.x / snap) * snap;
      const oz = Math.floor(cam.position.z / snap) * snap;
      lvl.origin.value.set(ox, oz);
      if (prev) lvl.innerRect.value.copy(prev);
      else lvl.innerRect.value.set(1e9, 1e9, -1e9, -1e9);
      const h = (CELLS / 2) * lvl.cell;
      prev = new Vector4(ox - h, oz - h, ox + h, oz + h);
    }
  }
}
