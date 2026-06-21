/**
 * CreteData — loads and GPU-uploads the whole-Crete BASE-layer data.
 *
 * Strips the gavdos-only inputs (mask.bin / species.bin / weights.bin /
 * roadmask.png) and the road-smoothing stage. Vegetation/structures are
 * deferred, so biome is a single neutral biome (Meadow) everywhere and the veg
 * arrays are returned empty. Everything else (window crop, bicubic height
 * upsample, dry-sentinel water buffers, height/normal texture derivation, noise
 * bake) is identical to GavdosData so the result slots into Heightfield.fromGavdos.
 *
 * Produces the same typed resources that Heightfield.generate() would
 * (GavdosDataResult shape):
 *   - height: FloatBuffer (res²)
 *   - hardness: FloatBuffer (res²)
 *   - waterY: FloatBuffer (simRes²) — dry sentinel everywhere
 *   - waterYFar: FloatBuffer (simRes/8)²
 *   - fieldsTex: StorageTexture rgba16f (moisture, flowStrength, riverDepth, W)
 *   - biomeTex: StorageTexture rgba8 (biomeId/8, snow=0, density, rockExposure)
 *   - heightTex: StorageTexture r32f
 *   - normalTex: StorageTexture rgba16f
 *   - noiseA, noiseB: re-used from the bake step
 *   - cpuHeights: Float32Array (res²)
 *   - cpuWaterY: Float32Array (simRes²)
 *   - cpuSpecies / cpuWeights: empty (veg deferred)
 *
 * Pipeline:
 *   1. Fetch heightmap.bin from /crete/
 *   2. Window-crop (CROP_X0..CROP_X1, CROP_Y0..CROP_Y1) from the 3072×1088 grid
 *   3. Bicubic upsample height crop → target heightRes²
 *   4. Snap waterline to OSM coastline (no-op until coastline.geojson exists)
 *   5. Upload CPU arrays into DataTextures, copy via compute into StorageBuffers
 *   6. Derive normals, build neutral fieldsTex and a single-biome biomeTex
 */

import {
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector4,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  texture,
  textureStore,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { runiform } from '../gpu/RenderUniform';
import type { NV4 } from '../gpu/TSLTypes';
import { bakeNoiseTextures } from '../gpu/passes/NoiseBake';
import type { FloatBuffer } from '../gpu/passes/HeightSynthesis';
import { Biome, worldSize } from '../world/WorldConst';
import type { GavdosDataResult } from '../gavdos/GavdosData';
import {
  CROP_H,
  CROP_W,
  CROP_X0,
  CROP_Y0,
  SRC_DEG_PER_PX_LAT,
  SRC_DEG_PER_PX_LON,
  SRC_NORTH,
  SRC_WEST,
  SRC_WIDTH,
} from './CreteConst';
import { conditionHeightsToCoastline } from './CreteCoastline';
import { loadCreteSatellite } from './CreteSatellite';

/**
 * Satellite drape resolution (px per side). Reliable coarse base (≈68 m/texel
 * over the 280 km world); the SHARP zoom detail comes from the live-streamed LOD
 * window (CreteMapStream re-fills this same texture for a tighter footprint), not
 * from a giant static texture. Exported so the streamer re-bakes at the identical
 * resolution. Keep at 4096 — larger blows up first-load time and VRAM.
 */
export const SAT_RES = 4096;

// -------------------------------------------------------------------------
// Base-terrain biome tunables (elevation + slope → biome variety)
// -------------------------------------------------------------------------
// The whole-Crete base layer has no vegetation/species mask, so the natural
// colour variety is painted entirely through the biomeTex CONTINUOUS channels
// that TerrainMaterial reads (see TerrainShadingInputs.biomeTex):
//   g = snow         → snowField → white snowCol
//   b = vegDensity   → grass/forest weight (greener as it rises)
//   a = rockExposure → grey rockCol (forced even on flat ground)
// The r channel (biomeId/8) is only a hint for scatter passes, so it is set to
// the nearest REAL Biome enum member per band (Meadow / Conifer / Alpine) —
// the enum has NO Sand/Scrub/Rock/Snow members, so those intents are expressed
// through the snow/veg/rock channels instead, which is what actually colours
// the terrain.
//
// All thresholds are in metres of elevation (h) or in slope (rise/run, ~tan).
const BIOME_BANDS = {
  /** ≤ this is open sea (ocean covers it) → fully neutral, no veg/rock/snow. */
  seaLevelM: 0,
  /** coastal flat band top: 0 < h < this reads as sandy/bare shore. */
  coastTopM: 40,
  /** lowland/hills band top: green Meadow with healthy veg density. */
  lowlandTopM: 600,
  /** mid-slope scrub band top: drier, thinner veg, rock rising with slope. */
  midTopM: 1300,
  /** above this elevation the surface is predominantly bare rock/highland. */
  highlandM: 1900,
  /** snow ramps in across this elevation window (Crete summits ~2456 m). */
  snowStartM: 1900,
  snowFullM: 2300,
  /** slope (rise/run) window that biases ANY elevation toward bare rock (cliffs). */
  slopeRockStart: 0.55,
  slopeRockFull: 1.1,
  /** extra rock exposure contributed by steepness once past slopeRockStart. */
  slopeRockGain: 0.9,
  /** vegetation-density anchors per band (b channel). */
  vegCoast: 0.22,
  vegLowland: 0.55,
  vegMid: 0.25,
  vegHigh: 0.05,
  /** baseline rock exposure per band before the slope bias is added (a channel). */
  rockCoast: 0.04,
  rockLowland: 0.05,
  rockMid: 0.3,
  rockHigh: 0.85,
} as const;

/** Scalar smoothstep (matches GLSL/TSL smoothstep): 0 below e0, 1 above e1. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

// -------------------------------------------------------------------------
// Bicubic kernel (Catmull-Rom)
// -------------------------------------------------------------------------
function cubic(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

function sampleBicubic(src: Float32Array, srcW: number, srcH: number, fx: number, fy: number): number {
  let sum = 0;
  let wsum = 0;
  const x0 = Math.floor(fx) - 1;
  const y0 = Math.floor(fy) - 1;
  for (let dy = 0; dy < 4; dy++) {
    const sy = Math.min(Math.max(y0 + dy, 0), srcH - 1);
    const wy = cubic(fy - (y0 + dy));
    for (let dx = 0; dx < 4; dx++) {
      const sx = Math.min(Math.max(x0 + dx, 0), srcW - 1);
      const wx = cubic(fx - (x0 + dx));
      const w = wx * wy;
      sum += (src[sy * srcW + sx] ?? 0) * w;
      wsum += w;
    }
  }
  return wsum !== 0 ? sum / wsum : 0;
}

// -------------------------------------------------------------------------
// Upload a Float32Array into a StorageBuffer via DataTexture → compute copy
// -------------------------------------------------------------------------
async function uploadFloatBuffer(
  renderer: Renderer,
  data: Float32Array,
  res: number,
): Promise<FloatBuffer> {
  const buf: FloatBuffer = instancedArray(res * res, 'float');

  // Pack data into an r32f DataTexture, then copy texel-by-texel via compute
  const stagingTex = new DataTexture(data, res, res, RedFormat, FloatType);
  stagingTex.needsUpdate = true;

  const copyKernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(res * res), () => { Return(); });
    const x = i.mod(res);
    const y = i.div(res);
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
    const val = texture(stagingTex, uv).r;
    buf.element(i).assign(val);
  })().compute(res * res);
  copyKernel.setName(`uploadFloat_${res}`);
  await renderer.computeAsync(copyKernel);
  return buf;
}

export async function loadCreteData(
  renderer: Renderer,
  heightRes: number,
  simRes: number,
  onProgressRaw: (p: number, msg: string) => void,
): Promise<GavdosDataResult> {
  // --- timing: record ms spent on each stage (the work between progress calls) ---
  const _marks: { stage: string; ms: number }[] = [];
  const _t0 = performance.now();
  let _tPrev = _t0;
  let _prevMsg = 'init';
  const onProgress = (p: number, msg: string): void => {
    const now = performance.now();
    _marks.push({ stage: _prevMsg, ms: Math.round(now - _tPrev) });
    _tPrev = now;
    _prevMsg = msg;
    onProgressRaw(p, msg);
  };

  // --- 1. Fetch raw buffer (height only — no mask/species/weights) ------------
  onProgress(0.01, 'crete: fetching heightmap');
  const hmResp = await fetch('/crete/heightmap.bin');
  const hmBuf = await hmResp.arrayBuffer();
  const srcHeight = new Float32Array(hmBuf); // 3072×1088 float32

  // --- 2. Window crop --------------------------------------------------------
  // The 280 km window can overrun the source N/S/E/W; `srcHeight[si] ?? 0`
  // fills off-grid cells with 0 m (open sea), the correct base-layer behavior.
  onProgress(0.06, 'crete: cropping to world window');
  const cropH = new Float32Array(CROP_W * CROP_H);
  for (let row = 0; row < CROP_H; row++) {
    const srcRow = CROP_Y0 + row;
    for (let col = 0; col < CROP_W; col++) {
      const srcCol = CROP_X0 + col;
      const si = srcRow * SRC_WIDTH + srcCol;
      cropH[row * CROP_W + col] = srcHeight[si] ?? 0;
    }
  }

  // --- 3. Bicubic upsample height to heightRes --------------------------------
  onProgress(0.10, `crete: upsampling height to ${heightRes}²`);
  const heightCpu = new Float32Array(heightRes * heightRes);
  for (let oy = 0; oy < heightRes; oy++) {
    const fy = (oy + 0.5) / heightRes * CROP_H - 0.5;
    for (let ox = 0; ox < heightRes; ox++) {
      const fx = (ox + 0.5) / heightRes * CROP_W - 0.5;
      heightCpu[oy * heightRes + ox] = sampleBicubic(cropH, CROP_W, CROP_H, fx, fy);
    }
  }

  // --- 3b. Snap waterline to sharp OSM coastline (sign-correction only) -------
  // No-op until public/crete/coastline.geojson exists (fetch fails → null).
  onProgress(0.46, 'crete: snapping coastline to OSM');
  const coastStats = await conditionHeightsToCoastline(heightCpu, heightRes);
  if (coastStats) {
    console.log(
      `[crete] coastline snap: ${coastStats.bandCells} band cells, ` +
      `${coastStats.lifted} lifted, ${coastStats.sunk} sunk`,
    );
  }

  // --- 4. Upload height + hardness to GPU ------------------------------------
  onProgress(0.48, 'crete: uploading height to GPU');
  const heightBuf = await uploadFloatBuffer(renderer, heightCpu, heightRes);

  // Hardness: constant 0.5 across the island
  const hardnessCpu = new Float32Array(heightRes * heightRes).fill(0.5);
  const hardnessBuf = await uploadFloatBuffer(renderer, hardnessCpu, heightRes);

  // --- 5. Build waterY (dry sentinel everywhere — no inland rivers) -----------
  onProgress(0.55, 'crete: building water buffers');
  // Dry sentinel: -2 m (below sea floor everywhere in the crop).
  // The bilinear waterY field being -2 means all waterY samples sit below
  // terrain → no inland water planes rendered; the ocean is GavdosOcean.
  const DRY_SENTINEL = -2.0;
  const waterYBuf: FloatBuffer = instancedArray(simRes * simRes, 'float');
  const waterFarRes = Math.floor(simRes / 8);
  const waterYFarBuf: FloatBuffer = instancedArray(waterFarRes * waterFarRes, 'float');

  const initWater = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(simRes * simRes), () => { Return(); });
    waterYBuf.element(i).assign(float(DRY_SENTINEL));
  })().compute(simRes * simRes);
  initWater.setName('creteWaterInit');

  const initWaterFar = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(waterFarRes * waterFarRes), () => { Return(); });
    waterYFarBuf.element(i).assign(float(DRY_SENTINEL));
  })().compute(waterFarRes * waterFarRes);
  initWaterFar.setName('creteWaterFarInit');

  await renderer.computeAsync([initWater, initWaterFar]);

  // --- 6. fieldsTex: moisture neutral, no rivers, no flow --------------------
  onProgress(0.60, 'crete: building fields texture');
  const fieldsTex = new StorageTexture(simRes, simRes);
  fieldsTex.type = HalfFloatType;
  fieldsTex.generateMipmaps = false;
  const fieldsKernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(simRes * simRes), () => { Return(); });
    const x = i.mod(simRes);
    const y = i.div(simRes);
    // moisture=0.3 (neutral), flowStrength=0, riverDepth=0, W=0
    textureStore(fieldsTex, uvec2(x.toUint(), y.toUint()), vec4(0.3, 0, 0, 0)).toWriteOnly();
  })().compute(simRes * simRes);
  fieldsKernel.setName('creteFieldsTex');
  await renderer.computeAsync(fieldsKernel);

  // --- 7. biomeTex: elevation + slope derived biome variety -------------------
  onProgress(0.65, 'crete: building biome texture');
  // Pack biome data into an rgba32f CPU array, upload via DataTexture staging.
  // No species mask → per-cell colour comes from the CONTINUOUS channels the
  // terrain shader reads: g=snow, b=vegDensity, a=rockExposure. Each is ramped
  // smoothly (smoothstep) across elevation/slope bands so colours transition
  // with no hard banding. The r channel (biomeId/8) is a scatter hint set to
  // the nearest real Biome enum member per band. Pure CPU arithmetic — one
  // extra read of `heightCpu` neighbours per cell, no extra GPU pass.
  const biomeRgba = new Float32Array(heightRes * heightRes * 4);
  // metres per texel of the upsampled height grid — used to turn the
  // neighbouring-cell height difference into a slope (rise / run).
  const metresPerTexel = worldSize() / heightRes;
  const B = BIOME_BANDS;
  const idMeadow = Biome.Meadow / 8; // green lowland scatter hint
  const idConifer = Biome.Conifer / 8; // mid-slope drier scatter hint
  const idAlpine = Biome.Alpine / 8; // highland rock/scree scatter hint
  for (let i = 0; i < heightRes * heightRes; i++) {
    const x = i % heightRes;
    const y = (i - x) / heightRes;
    const h = heightCpu[i] ?? 0;

    // --- local slope from central differences on the upsampled height grid ---
    const xm = x > 0 ? x - 1 : x;
    const xp = x < heightRes - 1 ? x + 1 : x;
    const ym = y > 0 ? y - 1 : y;
    const yp = y < heightRes - 1 ? y + 1 : y;
    const hl = heightCpu[y * heightRes + xm] ?? h;
    const hr = heightCpu[y * heightRes + xp] ?? h;
    const hd = heightCpu[ym * heightRes + x] ?? h;
    const hu = heightCpu[yp * heightRes + x] ?? h;
    // run is 2 texels horizontally for each axis; combine both axes (rise/run).
    const run = 2 * metresPerTexel;
    const dzdx = (hr - hl) / run;
    const dzdy = (hu - hd) / run;
    const slope = Math.hypot(dzdx, dzdy);

    if (h <= B.seaLevelM) {
      // --- Sea: neutral, fully covered by the ocean plane → no land paint. ---
      biomeRgba[i * 4 + 0] = idMeadow;
      biomeRgba[i * 4 + 1] = 0; // snow
      biomeRgba[i * 4 + 2] = 0; // vegDensity
      biomeRgba[i * 4 + 3] = 0; // rockExposure
      continue;
    }

    // --- elevation band weights (smoothstep ramps — no hard cutoffs) ---------
    // coast: full just above shoreline, fades out as the lowland band ramps in.
    const tCoast = 1 - smoothstep(B.coastTopM, B.coastTopM * 3, h);
    // lowland green: ramps in past the coast band, fades into the mid band.
    const tLowland = smoothstep(B.coastTopM, B.coastTopM * 3, h)
      * (1 - smoothstep(B.lowlandTopM, B.midTopM, h));
    // mid scrub: ramps in over the lowland→mid transition, out toward highland.
    const tMid = smoothstep(B.lowlandTopM, B.midTopM, h)
      * (1 - smoothstep(B.midTopM, B.highlandM, h));
    // highland rock: ramps in past mid, full above highlandM.
    const tHigh = smoothstep(B.midTopM, B.highlandM, h);

    // --- vegetation density: blend each band's anchor by its weight ----------
    // Normalise the elevation weights so the densest band wins smoothly.
    const wSum = tCoast + tLowland + tMid + tHigh || 1;
    let veg =
      (tCoast * B.vegCoast +
        tLowland * B.vegLowland +
        tMid * B.vegMid +
        tHigh * B.vegHigh) /
      wSum;

    // --- rock exposure: band baseline blended, then slope bias added ---------
    let rock =
      (tCoast * B.rockCoast +
        tLowland * B.rockLowland +
        tMid * B.rockMid +
        tHigh * B.rockHigh) /
      wSum;
    // Steep slope ALWAYS biases toward rock regardless of elevation (cliffs).
    const slopeRock = smoothstep(B.slopeRockStart, B.slopeRockFull, slope) * B.slopeRockGain;
    rock = Math.min(1, rock + slopeRock);
    // Where rock dominates, suppress vegetation so cliffs read bare.
    veg = Math.min(veg, Math.max(0, veg * (1 - slopeRock) - slopeRock * 0.25));
    veg = Math.max(0, Math.min(1, veg));

    // --- snow: ramps in only on high peaks (Crete tops get winter snow) ------
    const snow = smoothstep(B.snowStartM, B.snowFullM, h);

    // --- scatter-hint biome id: nearest real enum member for this band -------
    const biomeId = h > B.midTopM ? idAlpine : h > B.lowlandTopM ? idConifer : idMeadow;

    biomeRgba[i * 4 + 0] = biomeId; // biomeId/8 (scatter hint only)
    biomeRgba[i * 4 + 1] = snow; // snow → white on peaks
    biomeRgba[i * 4 + 2] = veg; // vegDensity → green lowlands
    biomeRgba[i * 4 + 3] = rock; // rockExposure → grey highlands/cliffs
  }

  const biomeTex = new StorageTexture(heightRes, heightRes);
  biomeTex.magFilter = NearestFilter;
  biomeTex.minFilter = NearestFilter;
  biomeTex.generateMipmaps = false;

  // Upload via rgba32f DataTexture staging → compute copy into StorageTexture
  const biomeStagingTex = new DataTexture(biomeRgba, heightRes, heightRes, RGBAFormat, FloatType);
  biomeStagingTex.needsUpdate = true;

  const biomeKernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(heightRes * heightRes), () => { Return(); });
    const x = i.mod(heightRes);
    const y = i.div(heightRes);
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(heightRes);
    const b = texture(biomeStagingTex, uv);
    textureStore(biomeTex, uvec2(x.toUint(), y.toUint()), vec4(b.r, b.g, b.b, b.a)).toWriteOnly();
  })().compute(heightRes * heightRes);
  biomeKernel.setName('creteBiomeTex');
  await renderer.computeAsync(biomeKernel);

  // --- 7b. Satellite albedo drape (crete-only, optional) ---------------------
  // Sample REAL ESRI Crete imagery at each terrain CELL using the SAME
  // crop→source-pixel→lng/lat mapping the height crop uses (below), so the
  // satellite texture aligns texel-for-texel with height/biome/normal. Gated by
  // `?sat=0`; any load failure leaves satelliteTex null → biome fallback.
  onProgress(0.74, 'crete: draping satellite imagery');
  const satDisabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('sat') === '0';
  let satelliteTex: StorageTexture | null = null;
  // Dynamic drape window uniform (world coords: originX, originZ, sizeX, sizeZ).
  // Initialised below to the WHOLE-ISLAND window so the initial drape (the coarse
  // base built here) maps with whole-world UV — byte-identical to the pre-stream
  // behaviour. CreteMapStream later mutates `.value` to a tighter footprint after
  // re-filling satelliteTex. Created ONLY alongside a real drape so the window and
  // its texture always travel together; null otherwise (no streaming, no UV shift).
  let satWin: NV4 | null = null;
  // Two-layer LOD detail drape: a SEPARATE high-detail StorageTexture the live
  // streamer (CreteMapStream) re-fills for the focused window, blended over the
  // coarse base above. Created empty here with a DEGENERATE off-world window so
  // the in-window mask is 0 everywhere and only the base shows until the streamer
  // fills it. Travels with the base (created in the same `if (!satDisabled)`
  // block) so the detail texture + window are always either both present or both
  // null. Null in gavdos/laas => TerrainMaterial sees no detail layer => base-only.
  let satDetailTex: StorageTexture | null = null;
  let satDetailWin: NV4 | null = null;
  if (!satDisabled) {
    const sampler = await loadCreteSatellite();
    if (sampler) {
      // rgba8 (sRGB) CPU buffer at heightRes. For each output cell (ox, oy) we
      // mirror the height crop's fractional source-pixel mapping exactly:
      //   fx = (ox+0.5)/heightRes * CROP_W - 0.5   (column within the crop)
      //   fy = (oy+0.5)/heightRes * CROP_H - 0.5   (row within the crop)
      // then the ABSOLUTE source pixel is (CROP_X0 + fx, CROP_Y0 + fy), which
      // maps to geographic lng/lat via the source-grid origin + deg/px. This is
      // the identical correspondence used to build cropH/heightCpu, so cell
      // (ox,oy) of the satellite texture is the same ground point as cell
      // (ox,oy) of the height texture.
      // Drape resolution is DECOUPLED from heightRes: the terrain grid is coarse
      // (2048 ≈ 137 m) but the imagery is draped at SAT_RES (8192 ≈ 34 m for the
      // 280 km world) so the z12 (~30 m/px) ESRI detail actually shows instead of
      // being downsampled to the terrain grid. The crop→lng/lat mapping is
      // fractional, so any grid resolution aligns to the same ground points.
      // SAT_RES is the module-level export (4096); the live-stream re-bake uses
      // the same value so its drape fills this exact texture.
      const satRgba = new Uint8Array(SAT_RES * SAT_RES * 4);
      for (let oy = 0; oy < SAT_RES; oy++) {
        const fy = ((oy + 0.5) / SAT_RES) * CROP_H - 0.5;
        const srcRow = CROP_Y0 + fy;
        const lat = SRC_NORTH - srcRow * SRC_DEG_PER_PX_LAT;
        for (let ox = 0; ox < SAT_RES; ox++) {
          const fx = ((ox + 0.5) / SAT_RES) * CROP_W - 0.5;
          const srcCol = CROP_X0 + fx;
          const lng = SRC_WEST + srcCol * SRC_DEG_PER_PX_LON;
          const [r, g, b] = sampler(lng, lat);
          const o = (oy * SAT_RES + ox) * 4;
          satRgba[o] = Math.round(r * 255);
          satRgba[o + 1] = Math.round(g * 255);
          satRgba[o + 2] = Math.round(b * 255);
          satRgba[o + 3] = 255;
        }
      }

      // Upload the sRGB imagery via an rgba8 DataTexture → compute copy into a
      // StorageTexture (the StorageTexture is what the material samples). The
      // DataTexture is flagged sRGB so the GPU fetch in TerrainMaterial returns
      // LINEAR values — the shader does NOT re-linearise (see the satellite
      // branch there). LinearFilter for smooth interpolation across cells.
      // NOTE: the StorageTexture MUST be linear (RGBA8Unorm). WebGPU forbids
      // storage-write to an sRGB texture format. The sRGB→linear decode happens
      // when the kernel samples the sRGB-flagged staging texture below, so the
      // linear values we store here are already correct (material samples raw).
      const satTex = new StorageTexture(SAT_RES, SAT_RES);
      satTex.magFilter = LinearFilter;
      satTex.minFilter = LinearFilter;
      satTex.generateMipmaps = false;

      const satStagingTex = new DataTexture(
        satRgba,
        SAT_RES,
        SAT_RES,
        RGBAFormat,
        UnsignedByteType,
      );
      // Keep BOTH textures LINEAR (no sRGB): WebGPU forbids storage-write to an
      // sRGB format, and three.js propagates the sampled texture's colorspace to
      // the storage-write target. So we store the raw sRGB bytes as-is and do the
      // sRGB→linear decode in TerrainMaterial (pow 2.2).
      satStagingTex.needsUpdate = true;

      const satKernel = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(SAT_RES * SAT_RES), () => { Return(); });
        const x = i.mod(SAT_RES);
        const y = i.div(SAT_RES);
        const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(SAT_RES);
        const s = texture(satStagingTex, uv);
        textureStore(satTex, uvec2(x.toUint(), y.toUint()), vec4(s.r, s.g, s.b, float(1))).toWriteOnly();
      })().compute(SAT_RES * SAT_RES);
      satKernel.setName('creteSatelliteTex');
      await renderer.computeAsync(satKernel);
      satelliteTex = satTex;
      // --- detail drape layer (two-layer LOD) — kills the 4-way distance stretch.
      // The base above stays whole-island (never shrinks), so the DISTANCE always
      // shows the coarse base with no edge-clamp smear; the streamer fills THIS
      // detail texture with a sharp high-zoom window blended over the base. Init it
      // with the base mosaic via the proven kernel so it's never sampled gray; the
      // degenerate window keeps the blend mask 0 until the streamer commits tiles.
      const detTex = new StorageTexture(SAT_RES, SAT_RES);
      detTex.magFilter = LinearFilter;
      detTex.minFilter = LinearFilter;
      detTex.generateMipmaps = false;
      const detKernel = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(SAT_RES * SAT_RES), () => { Return(); });
        const x = i.mod(SAT_RES);
        const y = i.div(SAT_RES);
        const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(SAT_RES);
        const s = texture(satStagingTex, uv);
        textureStore(detTex, uvec2(x.toUint(), y.toUint()), vec4(s.r, s.g, s.b, float(1))).toWriteOnly();
      })().compute(SAT_RES * SAT_RES);
      detKernel.setName('creteSatelliteDetailInit');
      await renderer.computeAsync(detKernel);
      satDetailTex = detTex;
      satStagingTex.dispose();
      satDetailWin = runiform(new Vector4(1e9, 1e9, 1, 1)) as unknown as NV4;
      // Whole-island window for the STABLE base: UV `(wxz − origin) / size` == world UV.
      const ws = worldSize();
      satWin = runiform(new Vector4(-ws / 2, -ws / 2, ws, ws)) as unknown as NV4;
      console.log('[crete] satellite drape: built base+detail at', SAT_RES, '(z12 imagery)');
    } else {
      console.log('[crete] satellite drape: unavailable → biome fallback');
    }
  }

  // --- 8. heightTex + normalTex from height buffer ---------------------------
  onProgress(0.78, 'crete: building height + normal textures');
  const heightTex = new StorageTexture(heightRes, heightRes);
  heightTex.type = FloatType;
  heightTex.format = RedFormat;
  heightTex.magFilter = NearestFilter;
  heightTex.minFilter = NearestFilter;
  heightTex.generateMipmaps = false;

  const normalTex = new StorageTexture(heightRes, heightRes);
  normalTex.type = HalfFloatType;
  normalTex.generateMipmaps = false;

  const texelSize = worldSize() / heightRes;
  const derivedKernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(heightRes * heightRes), () => { Return(); });
    const x = i.mod(heightRes).toInt();
    const y = i.div(heightRes).toInt();
    const xm = clamp(float(x).sub(1), 0, heightRes - 1).toInt();
    const xp = clamp(float(x).add(1), 0, heightRes - 1).toInt();
    const ym = clamp(float(y).sub(1), 0, heightRes - 1).toInt();
    const yp = clamp(float(y).add(1), 0, heightRes - 1).toInt();
    const h  = heightBuf.element(i).toVar();
    const hl = heightBuf.element(y.mul(heightRes).add(xm)).toVar();
    const hr = heightBuf.element(y.mul(heightRes).add(xp)).toVar();
    const hd = heightBuf.element(ym.mul(heightRes).add(x)).toVar();
    const hu = heightBuf.element(yp.mul(heightRes).add(x)).toVar();
    const n = vec3(hl.sub(hr), float(texelSize * 2), hd.sub(hu)).normalize();
    const slopeTsl = vec3(hl.sub(hr), float(0), hd.sub(hu)).length().div(texelSize * 2);
    textureStore(heightTex, uvec2(x.toUint(), y.toUint()), vec4(h, 0, 0, 1)).toWriteOnly();
    textureStore(normalTex, uvec2(x.toUint(), y.toUint()), vec4(n, slopeTsl)).toWriteOnly();
  })().compute(heightRes * heightRes);
  derivedKernel.setName('creteDerivedMaps');
  await renderer.computeAsync(derivedKernel);

  // --- 9. Noise textures (same bake as procedural) ----------------------------
  onProgress(0.87, 'crete: baking noise textures');
  const noise = await bakeNoiseTextures(renderer);

  // --- 10. CPU waterY (dry sentinel array for camera clamping) ---------------
  const cpuWaterY = new Float32Array(simRes * simRes).fill(DRY_SENTINEL);

  onProgress(0.98, 'crete: data ready');
  _marks.push({ stage: 'TOTAL', ms: Math.round(performance.now() - _t0) });
  console.log(`[crete] data load: ${_marks[_marks.length - 1].ms} ms @ heightRes=${heightRes}, simRes=${simRes}`);
  console.table(_marks);
  return {
    height: heightBuf,
    hardness: hardnessBuf,
    waterY: waterYBuf,
    waterYFar: waterYFarBuf,
    waterFarRes,
    simRes,
    fieldsTex,
    biomeTex,
    satelliteTex,
    satWin,
    satDetailTex,
    satDetailWin,
    heightTex,
    normalTex,
    noiseA: noise.texA,
    noiseB: noise.texB,
    cpuHeights: heightCpu,
    cpuWaterY,
    // veg deferred — empty stubs (Heightfield.fromGavdos tolerates these)
    cpuSpecies: new Uint8Array(0),
    cpuWeights: new Float32Array(0),
    vegRes: heightRes,
  };
}
