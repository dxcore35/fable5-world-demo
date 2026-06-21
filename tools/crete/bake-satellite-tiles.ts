/**
 * bake-satellite-tiles.ts — download the ESRI World Imagery tiles the Crete
 * satellite drape needs into public/crete/sat-tiles/, so first load doesn't hit
 * the network (faster + no rate-limiting). The runtime tries the local copy
 * first and falls back to ESRI if a tile is missing. Alignment/resample are
 * unchanged — same tiles, just served locally.
 *
 * Run: bunx tsx tools/crete/bake-satellite-tiles.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SRC_WEST, SRC_NORTH, SRC_EAST, SRC_SOUTH } from '../../src/crete/CreteConst';

const Z = 12; // must match SAT_ZOOM in CreteSatellite.ts (z12 ≈ 30 m/px)
const OUT = path.resolve(import.meta.dirname, '../../public/crete/sat-tiles', String(Z));
const tileUrl = (x: number, y: number): string =>
  `https://tiles-eu1.arcgis.com/40tFGWzosjaLJpmn/arcgis/rest/services/LSO_v2/MapServer/tile/${Z}/${y}/${x}`;

const lngToTileX = (lng: number): number => ((lng + 180) / 360) * 2 ** Z;
const latToTileY = (lat: number): number => {
  const c = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  return ((1 - Math.asinh(Math.tan((c * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
};

const xMin = Math.floor(lngToTileX(SRC_WEST));
const xMax = Math.floor(lngToTileX(SRC_EAST));
const yMin = Math.floor(latToTileY(SRC_NORTH)); // north → smaller y
const yMax = Math.floor(latToTileY(SRC_SOUTH));

fs.mkdirSync(OUT, { recursive: true });
let ok = 0, fail = 0, bytes = 0, done = 0;

// All (x,y) tiles in the bbox range.
const tiles: Array<[number, number]> = [];
for (let y = yMin; y <= yMax; y++) for (let x = xMin; x <= xMax; x++) tiles.push([x, y]);
const total = tiles.length;
process.stdout.write(`baking ${total} tiles (x ${xMin}..${xMax}, y ${yMin}..${yMax}) at z${Z}…\n`);

async function fetchTile([x, y]: [number, number]): Promise<void> {
  const dest = path.join(OUT, String(x), `${y}.jpg`);
  if (fs.existsSync(dest)) { ok++; return; } // resume: skip already-baked
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(tileUrl(x, y), { headers: { 'User-Agent': 'crete-sat-bake/1.0' }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { if (attempt === 3) fail++; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.join(OUT, String(x)), { recursive: true });
      fs.writeFileSync(dest, buf);
      ok++; bytes += buf.length; return;
    } catch { if (attempt === 3) fail++; }
  }
}

// Concurrency-capped pool (ESRI rate-limits large parallel bursts).
const CONCURRENCY = 12;
for (let i = 0; i < tiles.length; i += CONCURRENCY) {
  await Promise.all(tiles.slice(i, i + CONCURRENCY).map(fetchTile));
  done += Math.min(CONCURRENCY, tiles.length - i);
  if (done % 120 === 0 || done >= total) process.stdout.write(`  ${Math.min(done, total)}/${total} (${ok} ok, ${fail} fail)\n`);
}
process.stdout.write(`✓ sat tiles z${Z}: ${ok} saved, ${fail} failed, ${(bytes / 1e6).toFixed(1)} MB → ${OUT}\n`);
process.stdout.write(`  tile range x ${xMin}..${xMax}, y ${yMin}..${yMax}\n`);
