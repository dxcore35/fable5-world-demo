/**
 * fetch-buildings.ts — real OSM building footprints for the main Crete towns,
 * for the crete world's close-up houses. All-Crete in one query times out, so we
 * fetch a handful of town bboxes and merge.
 *
 * Output: public/crete/buildings.json — [{ r: [[lng,lat],...], h: meters }]
 * Run: bunx tsx tools/crete/fetch-buildings.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../../public/crete/buildings.json');

// town bboxes (south,west,north,east) — kept tight so Overpass returns fast
const TOWNS: { name: string; bbox: [number, number, number, number] }[] = [
  { name: 'Chania',         bbox: [35.503, 23.995, 35.525, 24.030] },
  { name: 'Rethymno',       bbox: [35.358, 24.460, 35.380, 24.495] },
  { name: 'Heraklion',      bbox: [35.320, 25.115, 35.345, 25.155] },
  { name: 'Agios Nikolaos', bbox: [35.180, 25.705, 35.200, 25.730] },
  { name: 'Ierapetra',      bbox: [35.005, 25.730, 35.022, 25.755] },
  { name: 'Sitia',          bbox: [35.198, 26.095, 35.215, 26.118] },
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

interface OvpWay { type: string; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>; }

async function fetchTown(name: string, bbox: [number, number, number, number]): Promise<OvpWay[]> {
  const q = `[out:json][timeout:60];(way["building"](${bbox.join(',')}););out geom;`;
  for (const ep of ENDPOINTS) {
    try {
      const resp = await fetch(ep, {
        method: 'POST', body: new URLSearchParams({ data: q }),
        headers: { 'User-Agent': 'crete-buildings/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(90_000),
      });
      if (!resp.ok) { process.stdout.write(`  ${name}: HTTP ${resp.status} @ ${ep}\n`); continue; }
      const j = await resp.json() as { elements: OvpWay[] };
      const ways = j.elements.filter((e) => e.type === 'way' && (e.geometry?.length ?? 0) >= 4);
      process.stdout.write(`  ${name}: ${ways.length} buildings\n`);
      return ways;
    } catch (e) { process.stdout.write(`  ${name}: ${(e as Error).message} @ ${ep}\n`); }
  }
  return [];
}

const out: { r: number[][]; h: number }[] = [];
for (const t of TOWNS) {
  const ways = await fetchTown(t.name, t.bbox);
  for (const w of ways) {
    const g = w.geometry!;
    const ring = g.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
    // height: building:height, or levels*3, else 6 m (1–2 storey Cretan house)
    const tg = w.tags ?? {};
    let h = 6;
    if (tg['height']) h = Math.max(3, parseFloat(tg['height']) || 6);
    else if (tg['building:levels']) h = Math.max(3, (parseFloat(tg['building:levels']) || 2) * 3.1);
    out.push({ r: ring, h });
  }
}

fs.writeFileSync(OUT, JSON.stringify(out));
process.stdout.write(`\n✓ ${OUT}\n  ${out.length} buildings across ${TOWNS.length} towns\n`);
