/**
 * GavdosData — loads and GPU-uploads the real Gavdos island data.
 *
 * Produces the same typed resources that Heightfield.generate() would:
 *   - height: FloatBuffer (res²)
 *   - hardness: FloatBuffer (res²)
 *   - waterY: FloatBuffer (simRes²) — dry sentinel everywhere (no inland rivers)
 *   - waterYFar: FloatBuffer (simRes/8)²
 *   - fieldsTex: StorageTexture rgba16f (moisture, flowStrength, riverDepth, W)
 *   - biomeTex: StorageTexture rgba8 (biomeId/8, snow=0, density, rockExposure)
 *   - heightTex: StorageTexture r32f
 *   - normalTex: StorageTexture rgba16f
 *   - noiseA, noiseB: re-used from the bake step
 *   - cpuHeights: Float32Array (res²)
 *   - cpuWaterY: Float32Array (simRes²)
 *
 * Pipeline:
 *   1. Fetch heightmap.bin + mask.bin from /gavdos/
 *   2. Window-crop (CROP_X0..CROP_X1, CROP_Y0..CROP_Y1) from the 2048×1664 grid
 *   3. Decode roadmask.png via ImageBitmap → canvas readback
 *   4. Bicubic upsample height crop → target heightRes²
 *   5. Nearest-neighbor upsample mask crop → heightRes²
 *   6. Road smoothing: where road > 0, blend height toward 9×9 local mean (α=0.7)
 *   7. Upload CPU arrays into DataTextures, copy via compute into StorageBuffers
 *   8. Derive normals, build fieldsTex and biomeTex (biome from mask)
 */

import {
  DataTexture,
  FloatType,
  HalfFloatType,
  NearestFilter,
  RedFormat,
  RGBAFormat,
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
import { bakeNoiseTextures } from '../gpu/passes/NoiseBake';
import type { FloatBuffer } from '../gpu/passes/HeightSynthesis';
import { Biome, worldSize } from '../world/WorldConst';
import {
  CROP_H,
  CROP_W,
  CROP_X0,
  CROP_Y0,
  SRC_WIDTH,
} from './GavdosConst';

// -------------------------------------------------------------------------
// Mask→biome mapping (v1)
// mask: 0=sea, 1=scrub, 2=trees, 3=sand, 4=rock
// -------------------------------------------------------------------------
function maskToBiome(m: number): number {
  switch (m) {
    case 1: return Biome.Meadow;   // scrub → meadow
    case 2: return Biome.Conifer;  // trees → conifer
    case 3: return Biome.Meadow;   // sand → meadow
    case 4: return Biome.Alpine;   // rock → alpine
    default: return Biome.Meadow;  // sea/unknown → meadow (underwater, no impact)
  }
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
// Nearest-neighbor uint8 resampler
// -------------------------------------------------------------------------
function sampleNearest(src: Uint8Array, srcW: number, srcH: number, fx: number, fy: number): number {
  const sx = Math.min(Math.max(Math.round(fx), 0), srcW - 1);
  const sy = Math.min(Math.max(Math.round(fy), 0), srcH - 1);
  return src[sy * srcW + sx] ?? 0;
}

// -------------------------------------------------------------------------
// Road mask decode: load roadmask.png (4096² grayscale, maps 1:1 to world
// window) → Float32Array at heightRes. Uses OffscreenCanvas for pixel access.
// -------------------------------------------------------------------------
async function loadRoadMask(targetRes: number): Promise<Float32Array> {
  const mask = new Float32Array(targetRes * targetRes);
  try {
    const resp = await fetch('/gavdos/roadmask.png');
    if (!resp.ok) return mask;
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(targetRes, targetRes);
    const ctx = canvas.getContext('2d');
    if (!ctx) return mask;
    ctx.drawImage(bmp, 0, 0, targetRes, targetRes);
    const data = ctx.getImageData(0, 0, targetRes, targetRes).data;
    for (let i = 0; i < targetRes * targetRes; i++) {
      mask[i] = (data[i * 4] ?? 0) >= 128 ? 1 : 0;
    }
    bmp.close();
  } catch {
    // road smoothing is non-critical — proceed without it
  }
  return mask;
}

// -------------------------------------------------------------------------
// 9×9 local mean for road height smoothing
// -------------------------------------------------------------------------
function localMean9x9(src: Float32Array, res: number, idx: number): number {
  const x = idx % res;
  const y = Math.floor(idx / res);
  let sum = 0;
  let n = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const sx = Math.min(Math.max(x + dx, 0), res - 1);
      const sy = Math.min(Math.max(y + dy, 0), res - 1);
      sum += src[sy * res + sx] ?? 0;
      n++;
    }
  }
  return sum / n;
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

// -------------------------------------------------------------------------
// Main loader result
// -------------------------------------------------------------------------
export interface GavdosDataResult {
  height: FloatBuffer;
  hardness: FloatBuffer;
  waterY: FloatBuffer;
  waterYFar: FloatBuffer;
  waterFarRes: number;
  simRes: number;
  fieldsTex: StorageTexture;
  biomeTex: StorageTexture;
  heightTex: StorageTexture;
  normalTex: StorageTexture;
  noiseA: StorageTexture;
  noiseB: StorageTexture;
  cpuHeights: Float32Array;
  cpuWaterY: Float32Array;
}

export async function loadGavdosData(
  renderer: Renderer,
  heightRes: number,
  simRes: number,
  onProgress: (p: number, msg: string) => void,
): Promise<GavdosDataResult> {
  // --- 1. Fetch raw buffers ---------------------------------------------------
  onProgress(0.01, 'gavdos: fetching heightmap');
  const [hmResp, maskResp] = await Promise.all([
    fetch('/gavdos/heightmap.bin'),
    fetch('/gavdos/mask.bin'),
  ]);
  const [hmBuf, maskBuf] = await Promise.all([hmResp.arrayBuffer(), maskResp.arrayBuffer()]);
  const srcHeight = new Float32Array(hmBuf);      // 2048×1664 float32
  const srcMask = new Uint8Array(maskBuf);        // 2048×1664 uint8

  // --- 2. Window crop --------------------------------------------------------
  onProgress(0.06, 'gavdos: cropping to world window');
  const cropH = new Float32Array(CROP_W * CROP_H);
  const cropM = new Uint8Array(CROP_W * CROP_H);
  for (let row = 0; row < CROP_H; row++) {
    const srcRow = CROP_Y0 + row;
    for (let col = 0; col < CROP_W; col++) {
      const srcCol = CROP_X0 + col;
      cropH[row * CROP_W + col] = srcHeight[srcRow * SRC_WIDTH + srcCol] ?? 0;
      cropM[row * CROP_W + col] = srcMask[srcRow * SRC_WIDTH + srcCol] ?? 0;
    }
  }

  // --- 3. Bicubic upsample height to heightRes --------------------------------
  onProgress(0.10, `gavdos: upsampling height to ${heightRes}²`);
  const heightCpu = new Float32Array(heightRes * heightRes);
  for (let oy = 0; oy < heightRes; oy++) {
    const fy = (oy + 0.5) / heightRes * CROP_H - 0.5;
    for (let ox = 0; ox < heightRes; ox++) {
      const fx = (ox + 0.5) / heightRes * CROP_W - 0.5;
      heightCpu[oy * heightRes + ox] = sampleBicubic(cropH, CROP_W, CROP_H, fx, fy);
    }
  }

  // --- 4. Nearest upsample mask to heightRes ----------------------------------
  onProgress(0.30, 'gavdos: upsampling mask');
  const maskCpu = new Uint8Array(heightRes * heightRes);
  for (let oy = 0; oy < heightRes; oy++) {
    const fy = (oy + 0.5) / heightRes * CROP_H - 0.5;
    for (let ox = 0; ox < heightRes; ox++) {
      const fx = (ox + 0.5) / heightRes * CROP_W - 0.5;
      maskCpu[oy * heightRes + ox] = sampleNearest(cropM, CROP_W, CROP_H, fx, fy);
    }
  }

  // --- 5. Load road mask & apply smoothing ------------------------------------
  onProgress(0.38, 'gavdos: loading road mask');
  const roadMask = await loadRoadMask(heightRes);
  onProgress(0.42, 'gavdos: road smoothing');
  const ROAD_ALPHA = 0.7;
  for (let i = 0; i < heightRes * heightRes; i++) {
    if ((roadMask[i] ?? 0) > 0.5) {
      const mean = localMean9x9(heightCpu, heightRes, i);
      heightCpu[i] = (heightCpu[i] ?? 0) * (1 - ROAD_ALPHA) + mean * ROAD_ALPHA;
    }
  }

  // --- 6. Upload height + hardness to GPU ------------------------------------
  onProgress(0.48, 'gavdos: uploading height to GPU');
  const heightBuf = await uploadFloatBuffer(renderer, heightCpu, heightRes);

  // Hardness: constant 0.5 across the island
  const hardnessCpu = new Float32Array(heightRes * heightRes).fill(0.5);
  const hardnessBuf = await uploadFloatBuffer(renderer, hardnessCpu, heightRes);

  // --- 7. Build waterY (dry sentinel everywhere — no inland rivers) -----------
  onProgress(0.55, 'gavdos: building water buffers');
  // Dry sentinel: -2 m (below sea floor everywhere in the crop).
  // WaterSurface.update() handles the clipmap; the bilinear waterY field
  // being -2 means all waterY samples sit below terrain → no water rendered.
  const DRY_SENTINEL = -2.0;
  const waterYBuf: FloatBuffer = instancedArray(simRes * simRes, 'float');
  const waterFarRes = Math.floor(simRes / 8);
  const waterYFarBuf: FloatBuffer = instancedArray(waterFarRes * waterFarRes, 'float');

  const initWater = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(simRes * simRes), () => { Return(); });
    waterYBuf.element(i).assign(float(DRY_SENTINEL));
  })().compute(simRes * simRes);
  initWater.setName('gavdosWaterInit');

  const initWaterFar = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(waterFarRes * waterFarRes), () => { Return(); });
    waterYFarBuf.element(i).assign(float(DRY_SENTINEL));
  })().compute(waterFarRes * waterFarRes);
  initWaterFar.setName('gavdosWaterFarInit');

  await renderer.computeAsync([initWater, initWaterFar]);

  // --- 8. fieldsTex: moisture neutral, no rivers, no flow --------------------
  onProgress(0.60, 'gavdos: building fields texture');
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
  fieldsKernel.setName('gavdosFieldsTex');
  await renderer.computeAsync(fieldsKernel);

  // --- 9. biomeTex from mask --------------------------------------------------
  onProgress(0.65, 'gavdos: building biome texture');
  // Pack biome data into an rgba32f CPU array, upload via DataTexture staging
  const biomeRgba = new Float32Array(heightRes * heightRes * 4);
  for (let i = 0; i < heightRes * heightRes; i++) {
    const m = maskCpu[i] ?? 0;
    const biomeId = maskToBiome(m);
    // snow = 0: island max 368m << SNOWLINE_BASE 1050m, snow cannot appear
    const snow = 0.0;
    let dens = 0;
    switch (m) {
      case 1: dens = 0.4; break;  // scrub
      case 2: dens = 0.8; break;  // trees
      case 3: dens = 0.1; break;  // sand
      case 4: dens = 0.2; break;  // rock
    }
    const rockExp = m === 4 ? 0.7 : m === 3 ? 0.3 : 0.05;
    biomeRgba[i * 4 + 0] = biomeId / 8;
    biomeRgba[i * 4 + 1] = snow;
    biomeRgba[i * 4 + 2] = dens;
    biomeRgba[i * 4 + 3] = rockExp;
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
  biomeKernel.setName('gavdosBiomeTex');
  await renderer.computeAsync(biomeKernel);

  // --- 10. heightTex + normalTex from height buffer --------------------------
  onProgress(0.78, 'gavdos: building height + normal textures');
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
  derivedKernel.setName('gavdosDerivedMaps');
  await renderer.computeAsync(derivedKernel);

  // --- 11. Noise textures (same bake as procedural) ---------------------------
  onProgress(0.87, 'gavdos: baking noise textures');
  const noise = await bakeNoiseTextures(renderer);

  // --- 12. CPU waterY (dry sentinel array for camera clamping) ---------------
  const cpuWaterY = new Float32Array(simRes * simRes).fill(DRY_SENTINEL);

  onProgress(0.98, 'gavdos: data ready');
  return {
    height: heightBuf,
    hardness: hardnessBuf,
    waterY: waterYBuf,
    waterYFar: waterYFarBuf,
    waterFarRes,
    simRes,
    fieldsTex,
    biomeTex,
    heightTex,
    normalTex,
    noiseA: noise.texA,
    noiseB: noise.texB,
    cpuHeights: heightCpu,
    cpuWaterY,
  };
}
