/**
 * render-tree-sheet.ts — headless contact sheet of every tree variant.
 * Grows each Gavdos species' variants, software-rasterizes a side view
 * (z-buffered, lambert-shaded bark + foliage) into a PNG so tree shape
 * variation + realism can be inspected without the WebGPU scene.
 *
 * Run: bunx tsx tools/gavdos/render-tree-sheet.ts  → /tmp/gavdos-trees.png
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { buildTree } from '../../src/vegetation/TreeBuilder';
import { GAVDOS_JUNIPER, CALABRIAN_PINE, OLIVE } from '../../src/vegetation/Species';
import { WorldSeed } from '../../src/core/Seed';
import type { SpeciesParams } from '../../src/vegetation/VegTypes';
import { perturbSpecies, variantInstance } from '../../src/gavdos/GavdosTreeVariation';

const TREE_VARIANTS = 6;
const seed = new WorldSeed(0xC0FFEE);

// ---- tiny PNG writer ----
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((b, i) => { raw[y * (w * 4 + 1) + 1 + i] = b; }); }
  const idat = deflateSync(raw);
  const crcTab = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTab[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const SW = 240, SH = 340, COLS = TREE_VARIANTS, ROWS = 3;
const W = SW * COLS, H = SH * ROWS;
const img = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 232; img[i * 4 + 1] = 238; img[i * 4 + 2] = 246; img[i * 4 + 3] = 255; } // sky
const zbuf = new Float32Array(W * H).fill(-Infinity);
const L = (() => { const v = [-0.4, 0.82, 0.42]; const m = Math.hypot(...v); return v.map(x => x / m); })();

function drawGeo(pos: Float32Array, idx: ArrayLike<number> | null, nrm: Float32Array | null, ox: number, oy: number, sc: number, cx: number, ymin: number, col: [number, number, number]) {
  const n = idx ? idx.length : pos.length / 3;
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    const px = [a, b, c].map(i => ox + (pos[i * 3] - cx) * sc + SW / 2);
    const py = [a, b, c].map(i => oy + SH - 18 - (pos[i * 3 + 1] - ymin) * sc);
    const pz = [a, b, c].map(i => pos[i * 3 + 2]);
    let lam = 0.7;
    if (nrm) { const ni = a; lam = Math.max(0.18, nrm[ni * 3] * L[0] + nrm[ni * 3 + 1] * L[1] + nrm[ni * 3 + 2] * L[2]) * 0.85 + 0.2; }
    const minX = Math.max(0, Math.floor(Math.min(...px))), maxX = Math.min(W - 1, Math.ceil(Math.max(...px)));
    const minY = Math.max(0, Math.floor(Math.min(...py))), maxY = Math.min(H - 1, Math.ceil(Math.max(...py)));
    const d = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
    if (Math.abs(d) < 1e-6) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = ((px[1] - x) * (py[2] - y) - (px[2] - x) * (py[1] - y)) / d;
      const w1 = ((px[2] - x) * (py[0] - y) - (px[0] - x) * (py[2] - y)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * pz[0] + w1 * pz[1] + w2 * pz[2];
      const o = y * W + x;
      if (z <= zbuf[o]) continue; zbuf[o] = z;
      img[o * 4] = Math.min(255, col[0] * lam * 255); img[o * 4 + 1] = Math.min(255, col[1] * lam * 255); img[o * 4 + 2] = Math.min(255, col[2] * lam * 255);
    }
  }
}

const species = [GAVDOS_JUNIPER, CALABRIAN_PINE, OLIVE] as SpeciesParams[];
for (let r = 0; r < species.length; r++) {
  const sp = species[r];
  const fc = sp.foliageColor; const fol: [number, number, number] = [Math.min(1, fc.r * 4 + 0.15), Math.min(1, fc.g * 4 + 0.25), Math.min(1, fc.b * 4 + 0.12)];
  for (let v = 0; v < TREE_VARIANTS; v++) {
    const psp = perturbSpecies(sp, seed.rng(`gavdosveg/${sp.id}/${v}/shape`));
    const t = buildTree(psp, seed.rng(`gavdosveg/${sp.id}/${v}`), { lod: 0, foliageMode: 'mesh', inst: variantInstance(seed, sp.id, v), hero: { cardTarget: 0, meshAnchorTarget: 6000 } });
    const bp = t.bark.attributes.position.array as Float32Array;
    // fit
    let cx = 0, ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < bp.length; i += 3) { xmin = Math.min(xmin, bp[i]); xmax = Math.max(xmax, bp[i]); ymin = Math.min(ymin, bp[i + 1]); ymax = Math.max(ymax, bp[i + 1]); }
    cx = (xmin + xmax) / 2;
    const sc = Math.min((SW - 30) / Math.max(xmax - xmin, 1.2), (SH - 36) / Math.max(ymax - ymin, 2));
    const ox = v * SW, oy = r * SH;
    drawGeo(bp, t.bark.index?.array ?? null, t.bark.attributes.normal?.array as Float32Array ?? null, ox, oy, sc, cx, ymin, [0.36, 0.26, 0.17]);
    const fg = t.foliageMesh ?? t.foliage;
    if (fg) drawGeo(fg.attributes.position.array as Float32Array, fg.index?.array ?? null, fg.attributes.normal?.array as Float32Array ?? null, ox, oy, sc, cx, ymin, fol);
  }
}
writeFileSync('/tmp/gavdos-trees.png', png(W, H, img));
console.log(`wrote /tmp/gavdos-trees.png  ${W}x${H}  (${ROWS} species × ${COLS} variants)`);
