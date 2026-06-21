/**
 * Stream/lake water shading (Phase 6). One material per clipmap level of the
 * WaterSurface mesh (levels differ only in uniforms — pipeline is shared).
 *
 * Composition (all scene-linear, post stack tonemaps later):
 *   emissive = (1−foam) · mix(refraction, skyReflection, fresnel)
 *     refraction: viewportSharedTexture sampled at a ripple-refracted uv,
 *       depth-validated (samples landing on geometry IN FRONT of the water
 *       fall back to the straight uv), Beer–Lambert absorbed by the water
 *       column thickness from viewportDepthTexture, plus turbidity
 *       in-scatter tied to the sky so it tracks time-of-day.
 *     reflection: sky-view LUT along the reflected ray (streams reflect sky;
 *       lakes upgrade to a planar pass later in Phase 6).
 *   diffuse (colorNode) = foam albedo — lit by sun/CSM/GI like any surface,
 *     so foam in cliff shade goes properly dim.
 *   PBR spec from the scene sun (roughness ~0.05 + ripple normals) supplies
 *   glints with cast shadows; the emissive reflection is sky-dome only, so
 *   nothing double-counts.
 *
 * Ripples: two fbm-gradient layers advected along the hydrology flow field
 * with the classic two-phase flowmap blend (no sliding-texture artifact).
 * |flowDir| encodes speed and is ZERO in lakes — they fall back to a faint
 * breeze ripple. Normals come from NoiseBake's pre-derived d(fbm)/dxz, so a
 * ripple layer costs one texture fetch.
 */

import { MeshStandardNodeMaterial } from 'three/webgpu';
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
  smoothstep,
  texture,
  time,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
  sin,
  cos,
} from 'three/tsl';
import type { StorageTexture } from 'three/webgpu';
import { PERIOD_FBM } from '../gpu/passes/NoiseBake';
import { bilerpVec2Buffer } from '../gpu/BufferSample';
import { canopyAt } from '../gpu/passes/Scatter';
import type { ProbeGI } from '../gpu/passes/ProbeGI';
import type { NF, NI, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import type { Atmosphere } from '../sky/Atmosphere';
import type { Heightfield } from '../world/Heightfield';
import { worldHalf } from '../world/WorldConst';

/** clear alpine water: absorption per meter (r dies first → teal depths) */
const SIGMA = { r: 0.42, g: 0.135, b: 0.095 };

/** flowmap cycles/s — shared by ripples, foam and the caustic advection */
export const FLOW_CYC = 0.45;

export interface WaterLevelHandles {
  /** snapped world origin of this clipmap level (uniform, updated per frame) */
  origin: NV2;
  /** world rect (minX, minZ, maxX, maxZ) of the next-finer level — discarded here */
  innerRect: NV4;
  /** cell size in meters (compile-time constant per level) */
  cell: number;
  /** coarse level → sample the min-reduced far field (narrow channels
   *  vanish at distance instead of stretching across whole cells) */
  far: boolean;
}

export function waterMaterial(
  hf: Heightfield,
  atm: Atmosphere,
  canopyTex: StorageTexture | null,
  gi: ProbeGI | null,
  lvl: WaterLevelHandles,
): MeshStandardNodeMaterial {
  const flow = hf.flow;
  const noiseA = hf.noiseA;
  if (!flow || !noiseA) throw new Error('waterMaterial needs hydrology + baked noise');

  const mat = new MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = true;
  mat.metalness = 0;

  // ---- vertex: clipmap grid (cell units) → world water surface + Gerstner ocean swell physics ----
  const sampleY = (q: NV2): NF => (lvl.far ? hf.sampleWaterYFar(q) : hf.sampleWaterY(q));
  const wxz = lvl.origin.add(positionLocal.xz.mul(lvl.cell));
  // Add cheap Gerstner vertical displacement for physical ocean waves (only near + mid, faded far for perf)
  const tv = time.mul(0.8);
  const wxv = wxz.x.mul(0.006).add(tv.mul(0.6));
  const wzv = wxz.y.mul(0.007).add(tv.mul(-0.45));
  const g1v = sin(wxv).mul(cos(wzv)).mul(0.65);
  const g2v = sin(wxv.mul(1.7).add(1.3)).mul(cos(wzv.mul(1.9))).mul(0.35);
  const gHv = g1v.add(g2v).mul(0.45);
  // Vertex-side distance proxy for fade (cheap length)
  const vDist = cameraPosition.sub(vec3(wxz.x, sampleY(wxz), wxz.y)).length();
  const macroFadeV = smoothstep(1200.0, 420.0, vDist);
  const y = sampleY(wxz).add(gHv.mul(macroFadeV));
  mat.positionNode = vec3(wxz.x, y, wxz.y);

  // ---- inner-level cutout + hard world bounds ----------------------------------
  // Outside ±worldHalf() the field samples clamp to the border texel — a wet
  // border cell would extend an infinite water band into the far shell.
  const p = positionWorld.xz;
  const r = lvl.innerRect;
  const insideInner = p.x
    .greaterThan(r.x)
    .and(p.y.greaterThan(r.y))
    .and(p.x.lessThan(r.z))
    .and(p.y.lessThan(r.w));
  const inWorld = p.x.abs().lessThan(worldHalf() - 4).and(p.y.abs().lessThan(worldHalf() - 4));
  mat.maskNode = insideInner.not().and(inWorld);

  // ---- flow field --------------------------------------------------------------
  const simRes = hf.simRes;
  const g = clamp(positionWorld.xz.div(4096).add(0.5), 0, 1).mul(simRes).sub(0.5);
  const flowV = bilerpVec2Buffer(flow.flowDir, simRes, g);
  const spd = flowV.length();
  const fdir = flowV.div(spd.max(1e-4));

  // ---- ripple normal: two-phase + LOD Gerstner macro (dispersion feel via freq scale)
  // Minimize taps: 4 fetches total (reuse y/zw), use mix/select. LOD by cell (far clip).
  const CYC = 0.45;
  const ph1 = fract(time.mul(CYC));
  const ph2 = fract(time.mul(CYC).add(0.5));
  const w2 = abs(ph1.sub(0.5)).mul(2);
  const vel = fdir.mul(spd.mul(1.9)).add(vec2(0.045, 0.03));
  const offA = vel.mul(ph1.div(CYC));
  const offB = vel.mul(ph2.div(CYC)).add(vec2(3.71, 1.13));
  // 4 fetches, reuse channels
  const uvA1 = positionWorld.xz.sub(offA).div(0.9 * PERIOD_FBM);
  const uvA2 = positionWorld.xz.sub(offA.mul(0.62)).div(3.4 * PERIOD_FBM);
  const uvB1 = positionWorld.xz.sub(offB).div(0.9 * PERIOD_FBM);
  const uvB2 = positionWorld.xz.sub(offB.mul(0.62)).div(3.4 * PERIOD_FBM);
  const sA1 = texture(noiseA, uvA1) as unknown as NV4;
  const sA2 = texture(noiseA, uvA2) as unknown as NV4;
  const sB1 = texture(noiseA, uvB1) as unknown as NV4;
  const sB2 = texture(noiseA, uvB2) as unknown as NV4;
  const gA = sA1.zw.div(0.9).add(sA2.zw.div(3.4).mul(0.5));
  const gB = sB1.zw.div(0.9).add(sB2.zw.div(3.4).mul(0.5));
  const grad = mix(gA, gB, w2);
  const rippleAmp = float(0.007).add(spd.mul(0.028));
  const slope = grad.mul(rippleAmp);

  // Simple fast Gerstner macro (2 waves, dispersion-scaled freq). LOD by level cell + dist.
  const cellF = float(lvl.cell);
  const lodCell = mix(1.0, 0.3, smoothstep(6, 48, cellF)); // clip LOD
  const tf = time.mul(0.8);
  const wx = positionWorld.x.mul(0.006).add(tf.mul(0.6));
  const wz = positionWorld.z.mul(0.007).add(tf.mul(-0.45));
  const g1 = sin(wx).mul(cos(wz)).mul(0.65);
  const g2 = sin(wx.mul(1.7).add(1.3)).mul(cos(wz.mul(1.9))).mul(0.35);
  const gNx = cos(wx).mul(cos(wz)).mul(0.6);
  const gNz = -sin(wx.mul(1.7)).mul(sin(wz.mul(1.9))).mul(0.4);
  const nBase = vec3(slope.x.negate().add(gNx), 1, slope.y.negate().add(gNz)).normalize();
  // hoist dist early for fade (fixes forward-ref)
  const toCam0 = cameraPosition.sub(positionWorld);
  const dist0 = toCam0.length();
  const macroFade = smoothstep(1200.0, 420.0, dist0).mul(lodCell);
  const nFlat = vec3(slope.x.negate(), 1, slope.y.negate()).normalize();
  const n = mix(nFlat, nBase, macroFade);
  mat.normalNode = transformNormalToView(n);

  // ---- view / depth (dist hoisted pre-Gerstner) ------------
  const dist = dist0;
  const viewDir = toCam0.div(dist.max(1e-4));
  const fragZ = positionView.z; // negative

  // refraction uv: ripple-driven, shrinking with distance, depth-validated
  const refrK = clamp(float(9).div(dist.max(1)), 0.04, 1).mul(0.055);
  const ruv = screenUV.add(n.xz.mul(refrK));
  const zR = perspectiveDepthToViewZ(
    (viewportDepthTexture(ruv) as unknown as NV4).x,
    cameraNear,
    cameraFar,
  );
  const leaked = zR.greaterThan(fragZ.add(0.02)); // refr sample in FRONT of water
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
  const thick = fragZ.sub(zScene).max(0); // meters of water along the ray
  // vertical water column under this fragment (foam/shore feather)
  const vDepth = thick.mul(viewDir.y.abs().max(0.06));

  // ---- transmitted light --------------------------------------------------------
  const sceneCol = (viewportSharedTexture(uvF) as unknown as NV4).rgb;
  const absorb = thick.mul(1.25);
  const T = vec3(
    exp(absorb.mul(-SIGMA.r)),
    exp(absorb.mul(-SIGMA.g)),
    exp(absorb.mul(-SIGMA.b)),
  );
  // turbidity in-scatter follows the zenith sky → tracks time-of-day
  const inscat = atm.skyColor(vec3(0, 1, 0)).mul(vec3(0.013, 0.036, 0.032));
  const refr = sceneCol.mul(T).add(inscat.mul(vec3(1, 1, 1).sub(T)));

  // ---- reflection: screen-space march with sky fallback ---------------------------
  // Streams at grazing angles must reflect the far bank / trees (dark), not
  // bright horizon haze — sky-only reflection read as a white sheet. March
  // the opaque depth buffer along the reflected ray; misses fall back to
  // the sky-view LUT.
  const rdir = reflect(viewDir.negate(), vec3(n.x.mul(0.55), n.y, n.z.mul(0.55)).normalize());
  const reflection = Fn((): NV3 => {
    const dirV = cameraViewMatrix.mul(vec4(rdir, 0)).xyz;
    // far cap 28 m: a grazing lake reflects its far tree line — with a
    // 12 m cap the march died ~200 m short and the whole far band fell to
    // the FLAT probe fallback (read as a dark slab hovering on the lake)
    const stepLen = clamp(dist.mul(0.09), 0.25, 28);
    const jitter = interleavedGradientNoise(screenCoordinate.xy);
    const hit = float(0).toVar();
    const hitUv = vec2(0, 0).toVar();
    // Extreme speed + quality: 14 iters max (far views break early on horizon). Near beach detail stays crisp.
    Loop(14, ({ i }: { readonly i: NI }) => {
      const t = float(i).add(jitter).mul(stepLen);
      const pV = positionView.add(dirV.mul(t));
      const uvS = getScreenPosition(pV, cameraProjectionMatrix) as unknown as NV2;
      If(
        uvS.x.lessThan(0).or(uvS.x.greaterThan(1)).or(uvS.y.lessThan(0)).or(uvS.y.greaterThan(1)),
        () => {
          Break();
        },
      );
      const zS = perspectiveDepthToViewZ(
        (viewportDepthTexture(uvS) as unknown as NV4).x,
        cameraNear,
        cameraFar,
      );
      // hit: scene surface just in front of the ray point (viewZ is negative)
      If(
        zS.greaterThan(pV.z.add(0.06)).and(zS.lessThan(pV.z.add(stepLen.mul(2.6).add(0.7)))),
        () => {
          hit.assign(1);
          hitUv.assign(uvS);
          Break();
        },
      );
    });
    // sky fallback (horizon-clamped so the LUT never samples below ground)
    const rdirUp = vec3(rdir.x, rdir.y.max(0.035), rdir.z).normalize();
    const sky = atm.skyColor(rdirUp);
    // CROWNED-HORIZON occlusion: when the SSR march misses, "sky" is only
    // correct if the reflected ray clears terrain AND tree crowns. March
    // the height field at log-spaced ranges with the canopy map raising
    // the tested horizon by crown height — one test covers both regimes:
    // steep gorge-stream rays get caught by overhead crowns (dark wall/
    // canopy mirror, scene1), grazing lake rays clear the far tree line
    // into open sky (a blanket canopy multiply here used to crush the
    // far-lake band to black). Occluded rays fall back to the probe field
    // toward the ray — it already encodes wall/canopy brightness.
    const horizonVis = float(1).toVar();
    for (const dRay of [9, 24, 65, 180]) {
      const q = positionWorld.xz.add(rdir.xz.mul(dRay));
      const rayY = positionWorld.y.add(rdir.y.mul(dRay));
      let hQ = hf.sampleHeightNearest(q) as NF;
      if (canopyTex) {
        hQ = hQ.add(canopyAt(canopyTex, q).mul(16)) as NF;
      }
      // wide knee — a hard threshold printed razor-edged reflection bands
      horizonVis.mulAssign(smoothstep(-16, 7, rayY.sub(hQ)));
    }
    const wallAmb = gi
      ? (gi.irradiance(positionWorld, rdir).mul(0.65) as unknown as NV3)
      : (sky.mul(0.18) as unknown as NV3);
    // ripple-jittered blend breaks the residual banding at the transition
    const vJit = n.x.add(n.z).mul(0.18);
    const fallback = mix(wallAmb, sky as unknown as NV3, horizonVis.add(vJit).clamp(0, 1));
    // fade SSR toward the screen border so hits don't pop at the edge
    const e = hitUv.sub(0.5).abs().mul(2);
    const edgeFade = smoothstep(1.0, 0.82, e.x.max(e.y));
    const scene = (viewportSharedTexture(hitUv) as unknown as NV4).rgb;
    return mix(fallback, scene, hit.mul(edgeFade));
  })();
  const skyRefl = reflection as unknown as NV3;
  // fresnel on a FLATTENED normal (standard water practice): per-pixel
  // ripple tilt makes (1−cosθ)^5 explode at any view angle — reflectance
  // weight should follow the mean surface, the ripples only shape WHAT is
  // reflected (rdir above keeps the full normal)
  const nFres = vec3(n.x.mul(0.3), n.y, n.z.mul(0.3)).normalize();
  const cosT = clamp(viewDir.dot(nFres), 0.0, 1.0);
  const fres = float(0.02).add(float(0.98).mul(cosT.oneMinus().pow(5)));

  // ---- foam ----------------------------------------------------------------------
  // Two-phase advection like the ripple normals — a linearly time-advected
  // pattern slides coherently and its thresholded fbm level sets read as
  // sharp white stripes (user-reported). Two decorrelated scales multiply
  // into clumpy patches instead of bands.
  const foamUv = (off: NV2, s: number): NV2 => positionWorld.xz.sub(off).div(s * PERIOD_FBM);
  // EVERY octave must live inside the two-phase blend: phase A's offset
  // snaps to zero at its cycle wrap, and the blend only hides that for
  // terms weighted by w2 — a detail octave pinned to offA alone snapped
  // visibly once per cycle (user-reported "sharp stop in the loop").
  const fA = (texture(noiseA, foamUv(offA, 0.55)) as unknown as NV4).y;
  const fB = (texture(noiseA, foamUv(offB.mul(1.13), 0.55)) as unknown as NV4).y;
  const dA = (texture(noiseA, foamUv(offA.mul(0.6), 0.21)) as unknown as NV4).y;
  const dB = (texture(noiseA, foamUv(offB.mul(0.71), 0.21)) as unknown as NV4).y;
  // renormalize the crossfade variance — averaging two uncorrelated fields
  // flattens the pattern at blend midpoints and thresholded coverage pulses
  const varNorm = w2.mul(w2).add(w2.oneMinus().mul(w2.oneMinus())).sqrt();
  const fblend = mix(fA, fB, w2).sub(0.5).div(varNorm).add(0.5);
  const fDetail = mix(dA, dB, w2).sub(0.5).div(varNorm).add(0.5);
  const foamPat = smoothstep(0.42, 0.85, fblend.mul(0.62).add(fDetail.mul(0.38)));
  // Shore foam boosted near beaches: wave energy (crest height + slope) makes realistic breaking + surge.
  // Uses Gerstner g* for phase/physics match to ocean swell (fast: no extra tex).
  const shoreBase = smoothstep(0.18, 0.02, vDepth).mul(0.55);
  // Use local Gerstner terms available in scope (g1/g2 from swell calc + gNx/gNz)
  const gHapprox = g1.add(g2).mul(0.5);
  const waveEnergy = abs(gHapprox).add(abs(gNx).mul(0.6)).add(abs(gNz).mul(0.6)).mul(0.8);
  const shoreFoam = shoreBase.mul(smoothstep(0.3, 1.1, waveEnergy).add(0.6)).clamp(0, 1.0);
  // rapids key on the DROP of the water surface along flow (a large calm
  // river has high strength but no whitewater — slope is what froths).
  // Window starts at ~3% grade: a 1.5% start blanketed every gorge reach
  // in white (real streams run clear on smooth grades and froth at STEPS,
  // which survive in the smoothed field as locally steeper sub-reaches).
  const drop = sampleY(positionWorld.xz)
    .sub(sampleY(positionWorld.xz.add(fdir.mul(3))))
    .div(3);
  const rapidFoam = smoothstep(0.09, 0.24, drop).mul(smoothstep(0.18, 0.55, spd)).mul(0.8);
  // Ocean crest foam (physics) — high Gerstner slope + macro wave peaks read as breaking caps on open sea near beaches
  const crest = smoothstep(0.38, 0.82, abs(gNx).add(abs(gNz)).mul(0.9)).mul(0.55);
  // Extra shore break foam when close to beach (vDepth low + horizontal speed or wave phase)
  const gHcrest = g1.add(g2).mul(0.45);
  const breakFoam = smoothstep(0.22, 0.01, vDepth).mul(smoothstep(0.25, 0.7, abs(gHcrest).add(0.3))).mul(0.6);
  const foam = clamp(shoreFoam.add(rapidFoam).add(crest).add(breakFoam), 0, 1).mul(foamPat).clamp(0, 0.72) as NF;

  // ---- compose --------------------------------------------------------------------
  mat.colorNode = vec3(0.74, 0.76, 0.74).mul(foam);
  mat.emissiveNode = mix(refr, skyRefl, fres).mul(foam.oneMinus());
  mat.roughnessNode = mix(float(0.05), float(0.55), foam);
  // shoreline feather: mm-deep water fades out over the bed. ALSO fade
  // steep surface RAMPS: the field dives ~2 m to the dry sentinel past
  // every shoreline — across a FLAT far beach seen edge-on that dive
  // renders as a thick dark band hugging the shore (twin-lake artifact).
  // Hydrology gates real water to gentle slopes (rdGate), so any render
  // slope ≥ ~30° is a dive, never water.
  const eS = 2.0;
  const gWx = sampleY(positionWorld.xz.add(vec2(eS, 0)))
    .sub(sampleY(positionWorld.xz.sub(vec2(eS, 0))))
    .div(2 * eS);
  const gWz = sampleY(positionWorld.xz.add(vec2(0, eS)))
    .sub(sampleY(positionWorld.xz.sub(vec2(0, eS))))
    .div(2 * eS);
  // near levels only: far levels carry the min-reduction's shore dip by
  // design (see Heightfield.reduceWaterY) — fading it would expose the
  // dark silt bed as a rim band instead
  const rampK = lvl.far
    ? float(1)
    : smoothstep(0.55, 0.3, vec2(gWx, gWz).length());
  mat.opacityNode = smoothstep(0.004, 0.05, vDepth).mul(rampK).mul(0.985);

  // ?waterdbg=N — component probe ladder (1 foam, 2 fresnel, 3 refraction,
  // 4 reflection, 5 column thickness, 6 SSR hit/horizon mix)
  const dbg = Number(new URLSearchParams(window.location.search).get('waterdbg') ?? '0');
  if (dbg > 0) {
    const paint =
      dbg === 1
        ? vec3(foam)
        : dbg === 2
          ? vec3(fres)
          : dbg === 3
            ? refr
            : dbg === 4
              ? skyRefl
              : dbg === 5
                ? vec3(thick.mul(0.25), vDepth.mul(0.25), 0)
                : (skyRefl as NV3);
    mat.colorNode = vec3(0);
    mat.emissiveNode = paint;
    mat.opacityNode = float(1);
  }

  return mat;
}
