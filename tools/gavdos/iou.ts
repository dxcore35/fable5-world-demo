/**
 * iou.ts — IoU (Intersection-over-Union) check for Gavdos data pipeline.
 *
 * Run: bunx tsx tools/gavdos/iou.ts [--img shots/gavdos/topdown.png]
 *
 * Two modes:
 *
 * 1. DATA-PIPELINE IoU (primary, always runs): classifies the upsampled
 *    heightmap crop (h > 0 = land, h ≤ 0 = sea) against the mask.bin
 *    reference (mask > 0 = land). Both are downsampled to 256×256 for speed.
 *    GATE: IoU ≥ 0.90 on data pipeline.
 *
 * 2. RENDER IoU (secondary, requires --img): compares shot pixels against
 *    the reference mask. V1 note: the gavdos render has no ocean shader
 *    (WaterSurface disabled — sea floor renders as terrain). Pixel-based
 *    sea/land is indistinguishable until T3 adds the ocean. Reports IoU
 *    but does NOT gate on it for v1.
 *
 * Gate: data-pipeline IoU ≥ 0.90.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// --- GavdosConst values (duplicated for node-runnable tool) ------------------
const GAVDOS_CENTER_LON = 24.080;
const GAVDOS_CENTER_LAT = 34.827;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 91_393;
const GAVDOS_CROP_HALF = 4096; // GAVDOS_WORLD_SIZE / 2 = 8192 / 2
const SRC_WIDTH = 2048;
const SRC_HEIGHT = 1664;
const SRC_WEST = 23.9;
const SRC_NORTH = 34.96;
const SRC_EAST = 24.2;
const SRC_SOUTH = 34.76;
const SRC_DEG_PER_PX_LON = (SRC_EAST - SRC_WEST) / SRC_WIDTH;
const SRC_DEG_PER_PX_LAT = (SRC_NORTH - SRC_SOUTH) / SRC_HEIGHT;
const GAVDOS_WIN_WEST = GAVDOS_CENTER_LON - GAVDOS_CROP_HALF / M_PER_DEG_LON;
const GAVDOS_WIN_EAST = GAVDOS_CENTER_LON + GAVDOS_CROP_HALF / M_PER_DEG_LON;
const GAVDOS_WIN_SOUTH = GAVDOS_CENTER_LAT - GAVDOS_CROP_HALF / M_PER_DEG_LAT;
const GAVDOS_WIN_NORTH = GAVDOS_CENTER_LAT + GAVDOS_CROP_HALF / M_PER_DEG_LAT;
const CROP_PX_WEST = (GAVDOS_WIN_WEST - SRC_WEST) / SRC_DEG_PER_PX_LON;
const CROP_PX_EAST = (GAVDOS_WIN_EAST - SRC_WEST) / SRC_DEG_PER_PX_LON;
const CROP_PY_NORTH = (SRC_NORTH - GAVDOS_WIN_NORTH) / SRC_DEG_PER_PX_LAT;
const CROP_PY_SOUTH = (SRC_NORTH - GAVDOS_WIN_SOUTH) / SRC_DEG_PER_PX_LAT;
const CROP_X0 = Math.round(CROP_PX_WEST);
const CROP_X1 = Math.round(CROP_PX_EAST);
const CROP_Y0 = Math.round(CROP_PY_NORTH);
const CROP_Y1 = Math.round(CROP_PY_SOUTH);
const CROP_W = CROP_X1 - CROP_X0;
const CROP_H = CROP_Y1 - CROP_Y0;
void GAVDOS_CENTER_LON, GAVDOS_CENTER_LAT, M_PER_DEG_LAT, M_PER_DEG_LON;

// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '../../');
const args = process.argv.slice(2);
const imgArg = args.indexOf('--img');
const imgPath = imgArg >= 0 ? (args[imgArg + 1] ?? '') : '';

console.log('=== Gavdos IoU verification ===');
console.log('');

// --- Load source data -------------------------------------------------------
const hmPath = join(repoRoot, 'public/gavdos/heightmap.bin');
const maskPath = join(repoRoot, 'public/gavdos/mask.bin');
const hmRaw = readFileSync(hmPath);
const maskRaw = readFileSync(maskPath);
const srcHeight = new Float32Array(hmRaw.buffer, hmRaw.byteOffset, hmRaw.byteLength / 4);
const srcMask = new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, maskRaw.byteLength);

// --- Crop both to world window -----------------------------------------------
const cropHm = new Float32Array(CROP_W * CROP_H);
const cropMask = new Uint8Array(CROP_W * CROP_H);
for (let row = 0; row < CROP_H; row++) {
  const srcRow = CROP_Y0 + row;
  for (let col = 0; col < CROP_W; col++) {
    const srcCol = CROP_X0 + col;
    cropHm[row * CROP_W + col] = srcHeight[srcRow * SRC_WIDTH + srcCol] ?? 0;
    cropMask[row * CROP_W + col] = srcMask[srcRow * SRC_WIDTH + srcCol] ?? 0;
  }
}

// --- DATA-PIPELINE IoU (primary) ----------------------------------------
// Downsample both to 256×256 for speed
const SZ = 256;
const hmLand = new Uint8Array(SZ * SZ);   // h > 0 → land
const refLand = new Uint8Array(SZ * SZ);  // mask > 0 → land

for (let oy = 0; oy < SZ; oy++) {
  const fy = Math.min(Math.round((oy + 0.5) / SZ * CROP_H), CROP_H - 1);
  for (let ox = 0; ox < SZ; ox++) {
    const fx = Math.min(Math.round((ox + 0.5) / SZ * CROP_W), CROP_W - 1);
    const idx = fy * CROP_W + fx;
    hmLand[oy * SZ + ox] = (cropHm[idx] ?? 0) > 0 ? 1 : 0;
    refLand[oy * SZ + ox] = (cropMask[idx] ?? 0) > 0 ? 1 : 0;
  }
}

let intersection = 0, union = 0, hmLandTotal = 0, refLandTotal = 0;
for (let i = 0; i < SZ * SZ; i++) {
  const h = hmLand[i] ?? 0;
  const r = refLand[i] ?? 0;
  if (h === 1) hmLandTotal++;
  if (r === 1) refLandTotal++;
  if (h === 1 && r === 1) intersection++;
  if (h === 1 || r === 1) union++;
}
const dataIoU = union > 0 ? intersection / union : 0;

console.log('--- Data-pipeline IoU (heightmap h>0 vs mask>0, 256×256) ---');
console.log(`Heightmap land pixels: ${hmLandTotal} / ${SZ * SZ} (${(hmLandTotal / (SZ * SZ) * 100).toFixed(1)}%)`);
console.log(`Reference land pixels: ${refLandTotal} / ${SZ * SZ} (${(refLandTotal / (SZ * SZ) * 100).toFixed(1)}%)`);
console.log(`Intersection: ${intersection}, Union: ${union}`);
console.log(`Data-pipeline IoU: ${dataIoU.toFixed(4)}`);
console.log('');

const GATE = 0.90;
const dataPipelinePass = dataIoU >= GATE;
if (dataPipelinePass) {
  console.log(`PASS: Data-pipeline IoU ${dataIoU.toFixed(4)} ≥ ${GATE}`);
} else {
  console.log(`FAIL: Data-pipeline IoU ${dataIoU.toFixed(4)} < ${GATE}`);
}

// --- RENDER IoU (secondary, informational only for v1) ---------------------
if (imgPath && existsSync(imgPath)) {
  console.log('');
  console.log('--- Render IoU (informational, v1 has no ocean shader) ---');
  console.log('NOTE: v1 sea floor renders as terrain material (no WaterSurface).');
  console.log('Pixel-based sea/land classification is unreliable until T3 adds ocean.');
  console.log('Render IoU is reported but NOT gated in v1.');

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: sharp } = await import('sharp' as string) as { default: (...args: any[]) => any };
    const imgBuf = readFileSync(imgPath);
    const result = await sharp(imgBuf).raw().toBuffer({ resolveWithObject: true }) as { data: Buffer; info: { width: number; height: number; channels: number } };
    const { data: pixData, info } = result;
    const W = info.width as number;
    const H = info.height as number;
    const ch = info.channels as number;
    console.log(`Loaded screenshot: ${W}×${H}`);

    // Reference at render resolution
    const renderRef = new Uint8Array(W * H);
    for (let oy = 0; oy < H; oy++) {
      const fy = Math.min(Math.round((oy + 0.5) / H * CROP_H), CROP_H - 1);
      for (let ox = 0; ox < W; ox++) {
        const fx = Math.min(Math.round((ox + 0.5) / W * CROP_W), CROP_W - 1);
        renderRef[oy * W + ox] = (cropMask[fy * CROP_W + fx] ?? 0) > 0 ? 1 : 0;
      }
    }

    // Pixel classification: blue-dominant = sea
    let ri = 0, ru = 0, rRef = 0, rShot = 0;
    for (let i = 0; i < W * H; i++) {
      const r = (pixData as Buffer)[i * ch] ?? 0;
      const g = (pixData as Buffer)[i * ch + 1] ?? 0;
      const b = (pixData as Buffer)[i * ch + 2] ?? 0;
      const isSea = (b > r + 20 && b > g + 10) || (r < 30 && g < 30 && b < 30);
      const shotL = isSea ? 0 : 1;
      const refL = renderRef[i] ?? 0;
      if (refL === 1) rRef++;
      if (shotL === 1) rShot++;
      if (shotL === 1 && refL === 1) ri++;
      if (shotL === 1 || refL === 1) ru++;
    }
    const renderIoU = ru > 0 ? ri / ru : 0;
    console.log(`Render IoU (blue-dominant sea classifier): ${renderIoU.toFixed(4)}`);
    console.log(`(Expected low in v1 — sea floor not visually distinct from terrain)`);
  } catch {
    console.log('(sharp not available for render IoU — skipped)');
  }
} else if (imgPath) {
  console.log('');
  console.log(`Shot not found at: ${imgPath}`);
}

console.log('');
console.log('=== Summary ===');
console.log(`Data-pipeline IoU: ${dataIoU.toFixed(4)}`);
if (dataPipelinePass) {
  console.log('Result: PASS');
  process.exit(0);
} else {
  console.log('Result: FAIL');
  process.exit(1);
}
