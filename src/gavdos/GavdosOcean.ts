/**
 * GavdosOcean — Mediterranean ocean surface for the real-DEM Gavdos world.
 *
 * Two components:
 *   1. Near clipmap (6 levels, same grid as WaterSurface) at y = 0, covering
 *      the whole 10240 m window.  Each vertex drops under terrain where h > 0
 *      via the depth-test (positionNode is set to y = 0 regardless; fragments
 *      above sea floor show fine because the terrain is in front).
 *
 *   2. Far sea disc — a flat RingGeometry from worldHalf to FAR_RADIUS,
 *      replacing the procedural far-shell hills.  One flat mesh, one cheap
 *      material.
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

import { BufferAttribute, BufferGeometry, Group, Mesh, RingGeometry, Vector2, Vector4 } from 'three';
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
import { FAR_RADIUS, worldHalf } from '../world/WorldConst';
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
): MeshStandardNodeMaterial {
  const noiseA = hf.noiseA;
  if (!noiseA) throw new Error('GavdosOcean: hf.noiseA not baked yet');

  const mat = new MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false; // ocean at y=0 is occluded by terrain naturally
  mat.metalness = 0;

  // ---- vertex: clipmap grid → world y=0 surface ----------------------------
  const wxz = opts.origin.add(positionLocal.xz.mul(opts.cell));
  mat.positionNode = vec3(wxz.x, float(0), wxz.y);

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

  // ---- Mediterranean wave normals: two-layer fbm advected by constant breeze
  // Constant Mediterranean breeze direction (WNW → ESE), speed ~0.12 m/s.
  // No flow field needed — constant vel produces coherent drift without rivers.
  const BREEZE = vec2(0.09, 0.035); // world-space drift per second
  const CYC = 0.32; // flowmap cycles/s (slower than streams — open sea)
  const ph1 = fract(time.mul(CYC));
  const ph2 = fract(time.mul(CYC).add(0.5));
  const w2 = abs(ph1.sub(0.5)).mul(2);
  const offA = BREEZE.mul(ph1.div(CYC));
  const offB = BREEZE.mul(ph2.div(CYC)).add(vec2(3.71, 1.13));
  const gradAt = (s: number, off: NV2): NV2 =>
    (texture(noiseA, positionWorld.xz.sub(off).div(s * PERIOD_FBM)) as unknown as NV4).zw.div(s);
  const layer = (off: NV2): NV2 =>
    gradAt(1.2, off).add(gradAt(4.5, off.mul(0.55)).mul(0.45));
  const grad = mix(layer(offA), layer(offB), w2);
  // Mediterranean: subtle chop, not stormy. Amplitude keeps normal tilt < 5°.
  const rippleAmp = float(0.004);
  const slope = grad.mul(rippleAmp);
  const n = vec3(slope.x.negate(), float(1), slope.y.negate()).normalize();
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

  // ---- Shore foam band ---------------------------------------------------------
  // Runtime depth band: |h| < FOAM_DEEP → bright white foam at the waterline.
  // This is where the DEM h transitions from negative to positive (sea→land).
  const foamDepth = smoothstep(float(FOAM_DEEP), float(FOAM_SHALLOW), waterDepth);
  // Add wave-advected foam pattern so the band isn't a hard ring
  const foamUv = (off: NV2, s: number): NV2 => positionWorld.xz.sub(off).div(s * PERIOD_FBM);
  const fA = (texture(noiseA, foamUv(offA, 0.55)) as unknown as NV4).y;
  const fB = (texture(noiseA, foamUv(offB.mul(1.13), 0.55)) as unknown as NV4).y;
  const varNorm = w2.mul(w2).add(w2.oneMinus().mul(w2.oneMinus())).sqrt();
  const fblend = mix(fA, fB, w2).sub(0.5).div(varNorm).add(0.5);
  const foamPat = smoothstep(float(0.4), float(0.75), fblend);
  const foam = foamDepth.mul(foamPat).clamp(float(0), float(0.75)) as NF;

  // ---- Compose ----------------------------------------------------------------
  mat.colorNode = vec3(0.78, 0.80, 0.80).mul(foam);
  mat.emissiveNode = mix(refrTinted, skyRefl, fres).mul(foam.oneMinus());
  mat.roughnessNode = mix(float(0.06), float(0.55), foam);

  // Opacity: fade at shore (vDepth), always visible in open sea
  // vDepth → 0 at shore → fades out gracefully over dry land (where terrain
  // depth-tests the water plane and opacityNode is never reached anyway, but
  // the fade prevents a hard cut when the clipmap extends slightly onto land).
  const shoreAlpha = smoothstep(float(0.002), float(0.04), vDepth);
  // Always show in open sea (waterDepth > 0.5 m → full alpha regardless of ray)
  const seaAlpha = smoothstep(float(0.0), float(0.5), waterDepth);
  mat.opacityNode = shoreAlpha.max(seaAlpha).mul(float(0.98));

  return mat;
}

// ---- Far sea disc material (cheap flat, atmosphere-matched) -----------------

function buildFarSeaMaterial(atm: Atmosphere): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.metalness = 0;
  mat.roughness = 0.07;

  // Flat sea at y=0 — position from geometry
  // Colour: deep navy with slight reflection of the sky horizon
  const toCam = cameraPosition.sub(positionWorld);
  const dist = toCam.length();
  const viewDir = toCam.div(dist.max(float(1)));
  const rdir = vec3(viewDir.x.negate(), viewDir.y.abs().max(float(0.04)), viewDir.z.negate()).normalize();
  const skyCol = atm.skyColor(rdir) as unknown as NV3;
  // Horizon fresnel: at long distance the sea goes nearly mirror-flat
  const cosT = clamp(viewDir.y.abs(), float(0), float(1));
  const fres = float(0.02).add(float(0.98).mul(cosT.oneMinus().pow(5)));
  const deepCol = vec3(0.02, 0.06, 0.22);
  mat.emissiveNode = mix(deepCol, skyCol, fres);
  mat.colorNode = vec3(0);
  // Fade in from world edge, fully opaque beyond
  const edgeDist = positionWorld.xz.length().sub(float(worldHalf() * 0.95));
  mat.opacityNode = smoothstep(float(0), float(worldHalf() * 0.05), edgeDist).mul(float(0.96));

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
      });
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

    // Far sea disc: replaces the procedural far-shell hills beyond the window
    const ring = new RingGeometry(worldHalf() * 0.96, FAR_RADIUS, 120, 4);
    ring.rotateX(-Math.PI / 2);
    const farMat = buildFarSeaMaterial(atm);
    const farDisc = new Mesh(ring, farMat);
    farDisc.position.y = 0;
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
