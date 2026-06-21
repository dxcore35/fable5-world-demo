/**
 * fetch-roads.ts — the main OSM road network for Crete (motorway→tertiary),
 * for the crete world's draped road ribbons.
 *
 * Output: public/crete/roads.json — [{ p: number[][], c: string }]
 *   p = polyline as [lng,lat] pairs, c = highway class (sets ribbon width/colour)
 * Run: bunx tsx tools/crete/fetch-roads.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../../public/crete/roads.json');
// Crete bbox (south,west,north,east)
const BBOX = '34.70,23.35,35.78,26.40';
const CLASSES = 'motorway|trunk|primary|secondary|tertiary';
const QUERY = `[out:json][timeout:120];( way["highway"~"^(${CLASSES})$"](${BBOX}); );out geom;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

interface OvpWay { type: string; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>; }

async function run(): Promise<OvpWay[]> {
  for (const ep of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      process.stdout.write(`  ${ep} (attempt ${attempt})...\n`);
      try {
        const resp = await fetch(ep, {
          method: 'POST', body: new URLSearchParams({ data: QUERY }),
          headers: { 'User-Agent': 'crete-roads/1.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(150_000),
        });
        if (!resp.ok) { process.stdout.write(`  HTTP ${resp.status}\n`); continue; }
        const j = await resp.json() as { elements: OvpWay[] };
        return j.elements.filter((e) => e.type === 'way' && (e.geometry?.length ?? 0) >= 2);
      } catch (e) { process.stdout.write(`  ${(e as Error).message}\n`); }
    }
  }
  throw new Error('All Overpass endpoints failed for roads.');
}

const ways = await run();
const out = ways.map((w) => ({
  p: w.geometry!.map((pt) => [Number(pt.lon.toFixed(7)), Number(pt.lat.toFixed(7))]),
  c: (w.tags?.['highway'] ?? 'tertiary'),
}));
fs.writeFileSync(OUT, JSON.stringify(out));
const byCls: Record<string, number> = {};
for (const r of out) byCls[r.c] = (byCls[r.c] ?? 0) + 1;
process.stdout.write(`\n✓ ${OUT}\n  ${out.length} road segments  ${JSON.stringify(byCls)}\n`);
