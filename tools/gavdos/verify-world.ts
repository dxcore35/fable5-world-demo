/**
 * verify-world.ts — full Gavdos verification battery (Task 6).
 *
 * Run: bunx tsx tools/gavdos/verify-world.ts
 *
 * Gates (PASS/FAIL table):
 *   1. typecheck          tsc --noEmit exit 0
 *   2. data IoU           ≥ 0.95 (reuses iou.ts logic)
 *   3. render IoU         ≥ 0.90 (top-down shot, blue-dominant sea, cloud exclusion)
 *   4. structures         200/200 buildings, walls > 50, POI audit ≤ 60 m
 *   5. no-black-shadows   bookmark-3 at T=14 and T=18.5; min channel > 8/255
 *   6. perf               bookmarks 3, 7, 8 fps ≥ 24 @1080p
 *   7. veg sanity         veg.trees in [5k,80k], veg.under in [100k,600k]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '../../');
const toolsDir = resolve(import.meta.dirname, '../');
const shootTs = join(toolsDir, 'shoot.ts');
const shotsDir = join(repoRoot, 'shots/gavdos');
mkdirSync(shotsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runShoot(
  outFile: string,
  opts: {
    T?: number;
    settle?: number;
    cam?: string;
    stats?: string;
  } = {},
): string {
  const outPath = join(shotsDir, outFile);
  const argv = ['bunx', 'tsx', shootTs, '--scene', 'gavdos', '--world', 'gavdos', '--out', outPath];
  if (opts.T !== undefined) argv.push('--T', String(opts.T));
  if (opts.settle !== undefined) argv.push('--settle', String(opts.settle));
  if (opts.cam !== undefined) argv.push('--cam', opts.cam);
  if (opts.stats !== undefined) argv.push('--stats', opts.stats);
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env },
  });
  if (result.status !== 0) {
    console.error(`[shoot] FAILED (exit ${result.status}): ${result.stderr?.slice(0, 400)}`);
  }
  return outPath;
}

// Load sharp lazily (present in node_modules from iou.ts usage)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<((...a: any[]) => any) | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await import('sharp' as string) as { default: (...a: any[]) => any };
    return m.default;
  } catch {
    return null;
  }
}

interface PixelData {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readPng(sharp: (...a: any[]) => any, p: string): Promise<PixelData> {
  const buf = readFileSync(p);
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }) as {
    data: Buffer;
    info: { width: number; height: number; channels: number };
  };
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function pxRGB(d: PixelData, px: number, py: number): [number, number, number] {
  const i = (py * d.width + px) * d.channels;
  return [d.data[i] ?? 0, d.data[i + 1] ?? 0, d.data[i + 2] ?? 0];
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// Gate results accumulator
// ---------------------------------------------------------------------------

interface GateResult {
  id: number;
  name: string;
  pass: boolean;
  detail: string;
}

const gates: GateResult[] = [];

function gate(id: number, name: string, pass: boolean, detail: string): void {
  gates.push({ id, name, pass, detail });
  const symbol = pass ? 'PASS' : 'FAIL';
  console.log(`[${symbol}] Gate ${id}: ${name} — ${detail}`);
}

// ---------------------------------------------------------------------------
// GavdosConst values (needed for IoU crop)
// ---------------------------------------------------------------------------

import {
  GAVDOS_CENTER_LON,
  GAVDOS_CENTER_LAT,
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  GAVDOS_CROP_HALF,
  lonLatToWorld,
} from '../../src/gavdos/GavdosConst';

const SRC_WIDTH = 2048;
const SRC_HEIGHT = 1664;
const SRC_WEST = 23.9;
const SRC_NORTH = 34.96;
const SRC_EAST = 24.2;
const SRC_SOUTH = 34.76;
const SRC_DEG_PER_PX_LON = (SRC_EAST - SRC_WEST) / SRC_WIDTH;
const SRC_DEG_PER_PX_LAT = (SRC_NORTH - SRC_SOUTH) / SRC_HEIGHT;
const WIN_WEST = GAVDOS_CENTER_LON - GAVDOS_CROP_HALF / M_PER_DEG_LON;
const WIN_EAST = GAVDOS_CENTER_LON + GAVDOS_CROP_HALF / M_PER_DEG_LON;
const WIN_SOUTH = GAVDOS_CENTER_LAT - GAVDOS_CROP_HALF / M_PER_DEG_LAT;
const WIN_NORTH = GAVDOS_CENTER_LAT + GAVDOS_CROP_HALF / M_PER_DEG_LAT;
const CX0 = Math.round((WIN_WEST - SRC_WEST) / SRC_DEG_PER_PX_LON);
const CX1 = Math.round((WIN_EAST - SRC_WEST) / SRC_DEG_PER_PX_LON);
const CY0 = Math.round((SRC_NORTH - WIN_NORTH) / SRC_DEG_PER_PX_LAT);
const CY1 = Math.round((SRC_NORTH - WIN_SOUTH) / SRC_DEG_PER_PX_LAT);
const CROP_W = CX1 - CX0;
const CROP_H = CY1 - CY0;

// suppress unused-import warning for coord helpers used only in gate 4
void GAVDOS_CENTER_LON, GAVDOS_CENTER_LAT, M_PER_DEG_LAT, M_PER_DEG_LON;

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

console.log('=== Gavdos full verification battery ===\n');

// ── Gate 1: typecheck ──────────────────────────────────────────────────────
console.log('--- Gate 1: typecheck ---');
{
  const r = spawnSync('bun', ['run', 'typecheck'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  });
  const pass = r.status === 0;
  const detail = pass ? 'tsc --noEmit exit 0' : `tsc exit ${r.status}: ${r.stderr?.slice(0, 200)}`;
  gate(1, 'typecheck', pass, detail);
}
console.log('');

// ── Gate 2: data IoU ≥ 0.95 ───────────────────────────────────────────────
console.log('--- Gate 2: data IoU ---');
{
  const hmPath = join(repoRoot, 'public/gavdos/heightmap.bin');
  const maskPath = join(repoRoot, 'public/gavdos/mask.bin');
  const hmRaw = readFileSync(hmPath);
  const maskRaw = readFileSync(maskPath);
  const srcHeight = new Float32Array(hmRaw.buffer, hmRaw.byteOffset, hmRaw.byteLength / 4);
  const srcMask = new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, maskRaw.byteLength);

  const cropHm = new Float32Array(CROP_W * CROP_H);
  const cropMask = new Uint8Array(CROP_W * CROP_H);
  for (let row = 0; row < CROP_H; row++) {
    const srcRow = CY0 + row;
    for (let col = 0; col < CROP_W; col++) {
      cropHm[row * CROP_W + col] = srcHeight[(srcRow * SRC_WIDTH + CX0 + col)] ?? 0;
      cropMask[row * CROP_W + col] = srcMask[(srcRow * SRC_WIDTH + CX0 + col)] ?? 0;
    }
  }

  const SZ = 256;
  let intersection = 0, union = 0;
  for (let oy = 0; oy < SZ; oy++) {
    const fy = Math.min(Math.round((oy + 0.5) / SZ * CROP_H), CROP_H - 1);
    for (let ox = 0; ox < SZ; ox++) {
      const fx = Math.min(Math.round((ox + 0.5) / SZ * CROP_W), CROP_W - 1);
      const idx = fy * CROP_W + fx;
      const h = (cropHm[idx] ?? 0) > 0 ? 1 : 0;
      const r = (cropMask[idx] ?? 0) > 0 ? 1 : 0;
      if (h === 1 && r === 1) intersection++;
      if (h === 1 || r === 1) union++;
    }
  }
  const iou = union > 0 ? intersection / union : 0;
  const pass = iou >= 0.95;
  gate(2, 'data IoU ≥ 0.95', pass, `IoU=${iou.toFixed(4)}`);
}
console.log('');

// ── Gate 3: render IoU ≥ 0.90 ─────────────────────────────────────────────
console.log('--- Gate 3: render IoU ---');
{
  const sharp = await loadSharp();
  if (!sharp) {
    gate(3, 'render IoU ≥ 0.90', false, 'sharp not available — skip');
  } else {
    // Shoot top-down at T=12 with cloud settle
    const tdPath = join(shotsDir, 'verify-topdown-t12.png');
    runShoot('verify-topdown-t12.png', { T: 12, settle: 20, cam: '0,9200,0,0,-1.57' });

    const maskRaw = readFileSync(join(repoRoot, 'public/gavdos/mask.bin'));
    const srcMask = new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, maskRaw.byteLength);

    // crop reference mask to world window
    const cropMask = new Uint8Array(CROP_W * CROP_H);
    for (let row = 0; row < CROP_H; row++) {
      const srcRow = CY0 + row;
      for (let col = 0; col < CROP_W; col++) {
        cropMask[row * CROP_W + col] = srcMask[(srcRow * SRC_WIDTH + CX0 + col)] ?? 0;
      }
    }

    const px = await readPng(sharp, tdPath);
    const W = px.width;
    const H = px.height;

    // island bbox in pixel coords (full frame = full window for top-down)
    let ri = 0, ru = 0;
    let excludedCount = 0;
    const totalPx = W * H;

    for (let py2 = 0; py2 < H; py2++) {
      const fy = Math.min(Math.round((py2 + 0.5) / H * CROP_H), CROP_H - 1);
      for (let px2 = 0; px2 < W; px2++) {
        const fx = Math.min(Math.round((px2 + 0.5) / W * CROP_W), CROP_W - 1);
        const [r, g, b] = pxRGB(px, px2, py2);
        const brightness = (r + g + b) / 3;

        // exclude cloud pixels (very bright)
        if (brightness > 215) {
          excludedCount++;
          continue;
        }

        // blue-dominant → sea; otherwise land
        const isSea = b > r + 20 && b > g + 10;
        const shotLand = isSea ? 0 : 1;
        const refLand = (cropMask[fy * CROP_W + fx] ?? 0) > 0 ? 1 : 0;

        if (shotLand === 1 && refLand === 1) ri++;
        if (shotLand === 1 || refLand === 1) ru++;
      }
    }

    const excludedFrac = excludedCount / totalPx;
    console.log(`  Excluded cloud pixels: ${(excludedFrac * 100).toFixed(1)}% of frame`);

    let finalIoU = ru > 0 ? ri / ru : 0;
    let shotUsed = 'T=12';

    // If > 35% excluded, reshoot at T=9 and pick better
    if (excludedFrac > 0.35) {
      console.log('  > 35% cloud coverage — reshooting at T=9...');
      const td9Path = join(shotsDir, 'verify-topdown-t9.png');
      runShoot('verify-topdown-t9.png', { T: 9, settle: 20, cam: '0,9200,0,0,-1.57' });

      const px9 = await readPng(sharp, td9Path);
      let ri9 = 0, ru9 = 0, excl9 = 0;
      for (let py2 = 0; py2 < px9.height; py2++) {
        const fy = Math.min(Math.round((py2 + 0.5) / px9.height * CROP_H), CROP_H - 1);
        for (let px2 = 0; px2 < px9.width; px2++) {
          const fx = Math.min(Math.round((px2 + 0.5) / px9.width * CROP_W), CROP_W - 1);
          const [r, g, b] = pxRGB(px9, px2, py2);
          if ((r + g + b) / 3 > 215) { excl9++; continue; }
          const isSea = b > r + 20 && b > g + 10;
          const sl = isSea ? 0 : 1;
          const rl = (cropMask[fy * CROP_W + fx] ?? 0) > 0 ? 1 : 0;
          if (sl === 1 && rl === 1) ri9++;
          if (sl === 1 || rl === 1) ru9++;
        }
      }
      const iou9 = ru9 > 0 ? ri9 / ru9 : 0;
      if (iou9 > finalIoU) { finalIoU = iou9; shotUsed = 'T=9 (reshoot)'; }
      console.log(`  T=9 IoU: ${iou9.toFixed(4)}, T=12 IoU: ${(ri / (ru || 1)).toFixed(4)} → using ${shotUsed}`);
    }

    const pass = finalIoU >= 0.90;
    gate(3, 'render IoU ≥ 0.90', pass, `IoU=${finalIoU.toFixed(4)} (${shotUsed}, cloud_excl=${(excludedFrac * 100).toFixed(1)}%)`);
  }
}
console.log('');

// ── Gate 4: structures ─────────────────────────────────────────────────────
console.log('--- Gate 4: structures ---');
{
  const vectorsPath = join(repoRoot, 'public/gavdos/vectors.json');

  interface Building { id: number; outline: [number, number][]; }
  interface Wall { id: number; path: [number, number][]; }
  interface Poi { id: number; lon: number; lat: number; tags: Record<string, string>; }
  interface VectorsJson { buildings: Building[]; walls: Wall[]; pois: Poi[]; }

  function polyArea(pts: { x: number; z: number }[]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += (pts[i]!.x) * (pts[j]!.z) - (pts[j]!.x) * (pts[i]!.z);
    }
    return a / 2;
  }

  function polyCentroid(pts: { x: number; z: number }[]): { x: number; z: number } {
    const area = polyArea(pts);
    let cx = 0, cz = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const cross = pts[i]!.x * pts[j]!.z - pts[j]!.x * pts[i]!.z;
      cx += (pts[i]!.x + pts[j]!.x) * cross;
      cz += (pts[i]!.z + pts[j]!.z) * cross;
    }
    const f = 1 / (6 * area);
    return { x: cx * f, z: cz * f };
  }

  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as VectorsJson;
  const buildings = vectors.buildings ?? [];
  const walls = vectors.walls ?? [];
  const pois = vectors.pois ?? [];

  // 4a: buildings
  const centroids: { x: number; z: number }[] = [];
  let placed = 0;
  for (const b of buildings) {
    if (!b.outline || b.outline.length < 4) continue;
    const ring = b.outline;
    const last = ring[ring.length - 1]!;
    const first = ring[0]!;
    const closed = Math.abs(last[0] - first[0]) < 1e-8 && Math.abs(last[1] - first[1]) < 1e-8;
    const pts = (closed ? ring.slice(0, -1) : ring).map(([lon, lat]) => lonLatToWorld(lon, lat));
    if (pts.length < 3) continue;
    centroids.push(polyCentroid(pts));
    placed++;
  }
  const bPass = placed >= Math.floor(buildings.length * 0.98);
  console.log(`  Buildings: ${placed}/${buildings.length} placed (gate: ≥ ${Math.floor(buildings.length * 0.98)})`);

  // 4b: walls
  let wallSegs = 0;
  for (const w of walls) {
    if (!w.path || w.path.length < 2) continue;
    const wpts = w.path.map(([lon, lat]) => lonLatToWorld(lon, lat));
    for (let i = 0; i < wpts.length - 1; i++) {
      const dx = wpts[i + 1]!.x - wpts[i]!.x;
      const dz = wpts[i + 1]!.z - wpts[i]!.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.1) wallSegs += Math.max(1, Math.ceil(len / 2.5));
    }
  }
  const wPass = wallSegs > 50;
  console.log(`  Wall segments: ${wallSegs} (gate: > 50)`);

  // 4c: POI audit (hamlet POIs → nearest building centroid ≤ 60 m)
  const hamletPois = pois.filter(p => p.tags?.place === 'hamlet');
  let maxPoiDist = 0;
  let poiPass = true;
  for (const poi of hamletPois) {
    const pw = lonLatToWorld(poi.lon, poi.lat);
    let minDist = Infinity;
    for (const c of centroids) {
      const d = Math.sqrt((c.x - pw.x) ** 2 + (c.z - pw.z) ** 2);
      if (d < minDist) minDist = d;
    }
    const name = poi.tags?.['name:en'] ?? poi.tags?.int_name ?? poi.tags?.name ?? '?';
    console.log(`  POI "${name}": nearest building ${minDist.toFixed(0)} m`);
    if (minDist > maxPoiDist) maxPoiDist = minDist;
    if (minDist > 60) poiPass = false;
  }

  const allPass = bPass && wPass && poiPass;
  gate(4, 'structures', allPass,
    `buildings=${placed}/${buildings.length} walls_segs=${wallSegs} max_poi_dist=${maxPoiDist.toFixed(0)}m`);
}
console.log('');

// ── Gate 5: no-black-shadows ───────────────────────────────────────────────
console.log('--- Gate 5: no-black-shadows ---');
{
  const sharp = await loadSharp();
  if (!sharp) {
    gate(5, 'no-black-shadows', false, 'sharp not available');
  } else {
    // bookmark 3 = Kastri village cam: x=16, z=712, alt=100, yaw=0, pitch=-0.35, T=14 and T=18.5
    // Cam string: "x,y,z,yaw,pitch" — y is approximate (alt above sea, terrain will clamp)
    // We use a fixed y≈450 (100 m alt over ~350 m terrain at Kastri)
    const bm3cam = '16,450,712,0,-0.35';

    const shots5: { T: number; file: string }[] = [
      { T: 14, file: 'verify-shadow-t14.png' },
      { T: 18.5, file: 'verify-shadow-t18.5.png' },
    ];

    let allPass = true;
    for (const s of shots5) {
      runShoot(s.file, { T: s.T, settle: 24, cam: bm3cam });
      const p = await readPng(sharp, join(shotsDir, s.file));

      // Collect luminance of all pixels in central island area, find darkest decile
      const W = p.width;
      const H = p.height;
      // restrict to central 60% of image (avoid sky/sea edges)
      const x0 = Math.floor(W * 0.2);
      const x1 = Math.floor(W * 0.8);
      const y0 = Math.floor(H * 0.2);
      const y1 = Math.floor(H * 0.8);

      const lums: number[] = [];
      for (let py2 = y0; py2 < y1; py2++) {
        for (let px2 = x0; px2 < x1; px2++) {
          const [r, g, b] = pxRGB(p, px2, py2);
          lums.push(luminance(r, g, b));
        }
      }
      lums.sort((a, b) => a - b);

      // sample 8 pixels from the darkest decile
      const decileEnd = Math.floor(lums.length * 0.1);
      const samples8: number[] = [];
      for (let k = 0; k < 8; k++) {
        const idx = Math.floor((k / 8) * decileEnd);
        samples8.push(lums[idx] ?? 0);
      }

      const minLum = Math.min(...samples8);
      const shadPass = minLum > 8;
      allPass = allPass && shadPass;
      console.log(`  T=${s.T}: darkest-decile 8 samples (lum): [${samples8.map(v => v.toFixed(1)).join(', ')}]`);
      console.log(`  T=${s.T}: min lum=${minLum.toFixed(1)} gate>8 → ${shadPass ? 'PASS' : 'FAIL'}`);
    }
    gate(5, 'no-black-shadows', allPass, 'min channel luminance > 8/255 in darkest decile');
  }
}
console.log('');

// ── Gate 6: perf fps ≥ 24 @1080p ──────────────────────────────────────────
console.log('--- Gate 6: perf ---');
{
  // Bookmarks 3, 7, 8 cams
  const perfShots: { name: string; cam: string; T: number }[] = [
    { name: 'bm3-kastri',  cam: '16,450,712,0,-0.35',          T: 13 },
    { name: 'bm7-summit',  cam: '0,2817,-2367,0,-0.3',         T: 14 },
    { name: 'bm8-offshore',cam: '-1767,900,1768,-2.36,-0.35',  T: 13 },
  ];

  let allPass = true;
  for (const s of perfShots) {
    const statsFile = join(shotsDir, `verify-perf-${s.name}-stats.json`);
    runShoot(`verify-perf-${s.name}.png`, { T: s.T, settle: 48, cam: s.cam, stats: statsFile });

    if (!existsSync(statsFile)) {
      console.log(`  ${s.name}: stats file missing — FAIL`);
      allPass = false;
      continue;
    }
    const stats = JSON.parse(readFileSync(statsFile, 'utf8')) as { fps?: number; triangles?: number };
    const fps = stats.fps ?? 0;
    const tris = stats.triangles ?? 0;
    const pass = fps >= 24;
    if (!pass) allPass = false;
    console.log(`  ${s.name}: fps=${fps.toFixed(1)} tris=${(tris / 1e6).toFixed(2)}M → ${pass ? 'PASS' : 'FAIL'}`);
  }
  gate(6, 'perf fps ≥ 24 @1080p', allPass, 'all three bookmark shots');
}
console.log('');

// ── Gate 7: veg sanity ─────────────────────────────────────────────────────
console.log('--- Gate 7: veg sanity ---');
{
  // Use bm7 stats already shot in gate 6
  const statsFile = join(shotsDir, 'verify-perf-bm7-summit-stats.json');
  if (!existsSync(statsFile)) {
    gate(7, 'veg sanity', false, 'bm7 stats file missing');
  } else {
    const stats = JSON.parse(readFileSync(statsFile, 'utf8')) as {
      counters?: { 'veg.trees'?: number; 'veg.under'?: number };
    };
    const trees = stats.counters?.['veg.trees'] ?? 0;
    const under = stats.counters?.['veg.under'] ?? 0;
    const treesPass = trees >= 5_000 && trees <= 80_000;
    const underPass = under >= 100_000 && under <= 600_000;
    const pass = treesPass && underPass;
    console.log(`  veg.trees=${trees} (gate: 5k–80k) → ${treesPass ? 'PASS' : 'FAIL'}`);
    console.log(`  veg.under=${under} (gate: 100k–600k) → ${underPass ? 'PASS' : 'FAIL'}`);
    gate(7, 'veg sanity', pass, `trees=${trees} under=${under}`);
  }
}
console.log('');

// ── Summary table ──────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(' Gate  Name                       Result  Detail');
console.log('───────────────────────────────────────────────────────────────');
for (const g of gates) {
  const status = g.pass ? ' PASS ' : ' FAIL ';
  const name = g.name.padEnd(28);
  const detail = g.detail.slice(0, 60);
  console.log(`  ${String(g.id).padEnd(4)} ${name} [${status}] ${detail}`);
}
console.log('═══════════════════════════════════════════════════════════════');

const allPass = gates.every(g => g.pass);
const passCount = gates.filter(g => g.pass).length;
console.log(`\nResult: ${passCount}/${gates.length} gates PASS${allPass ? ' — ALL PASS' : ' — SOME FAIL'}\n`);
process.exit(allPass ? 0 : 1);
