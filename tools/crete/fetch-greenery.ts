/**
 * fetch-greenery.ts — real OSM greenery + water polygons for the Crete world, so
 * trees/parks/lakes are placed where they ACTUALLY are (Monaco-pipeline style:
 * no procedural scatter, no hand-placing). Consumed by CreteGreenery.ts.
 *
 * Tags: natural=wood + landuse=forest → tree cover; leisure=park → parks;
 * natural=water + landuse=reservoir → lakes/reservoirs.
 *
 * Output: public/crete/greenery.json — [{ t: 'wood'|'park'|'water', r: [[lng,lat],...] }]
 * Run: bun tools/crete/fetch-greenery.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../../public/crete/greenery.json');
const BBOX = '34.70,23.35,35.78,26.40'; // S,W,N,E — Crete + Gavdos + islets

// One Overpass query per class so a heavy class can't sink the others; each maps
// to a coarse `t` the placer understands.
const CLASSES: { t: string; sel: string }[] = [
  { t: 'wood', sel: 'way["natural"="wood"];way["landuse"="forest"]' },
  { t: 'park', sel: 'way["leisure"="park"];way["leisure"="garden"]' },
  { t: 'water', sel: 'way["natural"="water"];way["landuse"="reservoir"]' },
];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

interface OvpWay { type: string; geometry?: { lat: number; lon: number }[]; }

async function fetchClass(t: string, sel: string): Promise<OvpWay[]> {
  // bbox applied per selector via the (S,W,N,E) suffix
  const body = sel.split(';').filter(Boolean).map((s) => `${s}(${BBOX});`).join('');
  const q = `[out:json][timeout:180];(${body});out geom;`;
  for (const ep of ENDPOINTS) {
    try {
      process.stdout.write(`  ${t}: ${ep} …\n`);
      const resp = await fetch(ep, {
        method: 'POST', body: new URLSearchParams({ data: q }),
        headers: { 'User-Agent': 'crete-greenery/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(200_000),
      });
      if (!resp.ok) { process.stdout.write(`    HTTP ${resp.status}\n`); continue; }
      const j = await resp.json() as { elements: OvpWay[] };
      const ways = j.elements.filter((e) => e.type === 'way' && (e.geometry?.length ?? 0) >= 4);
      process.stdout.write(`    ${ways.length} ${t} polygons\n`);
      return ways;
    } catch (e) { process.stdout.write(`    ${(e as Error).message}\n`); }
  }
  return [];
}

const out: { t: string; r: number[][] }[] = [];
for (const c of CLASSES) {
  const ways = await fetchClass(c.t, c.sel);
  for (const w of ways) {
    const ring = w.geometry!.map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]);
    out.push({ t: c.t, r: ring });
  }
}

fs.writeFileSync(OUT, JSON.stringify(out));
const byType = (t: string): number => out.filter((o) => o.t === t).length;
process.stdout.write(`\n✓ ${OUT}\n  ${out.length} polygons — wood ${byType('wood')}, park ${byType('park')}, water ${byType('water')}\n`);
