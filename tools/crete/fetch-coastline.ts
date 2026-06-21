/**
 * fetch-coastline.ts — sharp OSM `natural=coastline` for Crete + its islands.
 *
 * The admin-relation polygon (282436) is generalized (~7k pts for all of Crete).
 * OSM `natural=coastline` ways are the real, sharp shoreline. They come as many
 * open ways that chain end-to-end into closed rings (one per landmass). We fetch
 * them and stitch by shared endpoints into land polygons.
 *
 * Output: public/crete/coastline.geojson — FeatureCollection of land Polygons
 * (point inside ANY polygon = land), consumed by CreteCoastline + the ocean mask.
 *
 * Run: bunx tsx tools/crete/fetch-coastline.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../../public/crete/coastline.geojson');
const BBOX = '34.70,23.35,35.78,26.40'; // S,W,N,E — Crete + Gavdos + islets
const QUERY = `[out:json][timeout:180];( way["natural"="coastline"](${BBOX}); ); out geom;`;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

interface Pt { lat: number; lon: number; }
interface Way { type: string; id: number; geometry?: Pt[]; }

async function fetchOverpass(): Promise<Way[]> {
  for (const ep of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      process.stdout.write(`  fetching ${ep} (attempt ${attempt})...\n`);
      try {
        const resp = await fetch(ep, {
          method: 'POST',
          body: new URLSearchParams({ data: QUERY }),
          headers: { 'User-Agent': 'crete-coastline/1.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(200_000),
        });
        if (!resp.ok) { process.stdout.write(`  HTTP ${resp.status}\n`); continue; }
        const j = (await resp.json()) as { elements: Way[] };
        return j.elements.filter((e) => e.type === 'way' && (e.geometry?.length ?? 0) >= 2);
      } catch (err) { process.stdout.write(`  error: ${(err as Error).message}\n`); }
    }
  }
  throw new Error('All Overpass endpoints failed.');
}

const key = (p: Pt): string => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

const ways = await fetchOverpass();
process.stdout.write(`  ${ways.length} coastline ways, ${ways.reduce((s, w) => s + (w.geometry?.length ?? 0), 0)} pts\n`);

// --- stitch ways into closed rings by matching endpoints --------------------
type Seg = { pts: Pt[]; used: boolean };
const segs: Seg[] = ways.map((w) => ({ pts: w.geometry!, used: false }));
// index: endpoint-key → list of segment indices touching it
const ends = new Map<string, number[]>();
for (let i = 0; i < segs.length; i++) {
  for (const p of [segs[i].pts[0], segs[i].pts[segs[i].pts.length - 1]]) {
    const k = key(p);
    (ends.get(k) ?? ends.set(k, []).get(k)!).push(i);
  }
}

const rings: Pt[][] = [];
for (let i = 0; i < segs.length; i++) {
  if (segs[i].used) continue;
  let ring: Pt[] = [...segs[i].pts];
  segs[i].used = true;
  // extend forward until the ring closes or dead-ends
  let guard = 0;
  while (guard++ < segs.length + 5) {
    const tail = ring[ring.length - 1];
    if (key(tail) === key(ring[0]) && ring.length > 3) break; // closed
    const cands = (ends.get(key(tail)) ?? []).filter((j) => !segs[j].used);
    if (cands.length === 0) break;
    const j = cands[0];
    const s = segs[j];
    s.used = true;
    // orient the next segment so its start matches the tail
    const fwd = key(s.pts[0]) === key(tail);
    const add = fwd ? s.pts.slice(1) : [...s.pts].reverse().slice(1);
    ring = ring.concat(add);
  }
  if (ring.length >= 4) rings.push(ring);
}

// keep rings as land polygons; sort largest-first (Crete main island first)
rings.sort((a, b) => b.length - a.length);
const features = rings.map((r, i) => {
  const coords = r.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
  // force-close the ring
  const a = coords[0], z = coords[coords.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) coords.push([a[0], a[1]]);
  return { type: 'Feature' as const, properties: { i, points: coords.length },
    geometry: { type: 'Polygon' as const, coordinates: [coords] } };
});

const fc = {
  type: 'FeatureCollection' as const,
  properties: { source: 'OSM natural=coastline (sharp)', bbox: BBOX,
    note: 'land polygons stitched from coastline ways; point in any = land' },
  features,
};
fs.writeFileSync(OUT, JSON.stringify(fc));
const totalPts = features.reduce((s, f) => s + f.geometry.coordinates[0].length, 0);
process.stdout.write(`\n✓ ${OUT}\n  ${features.length} land rings, ${totalPts} pts (sharp)\n` +
  `  largest ring: ${features[0]?.geometry.coordinates[0].length} pts (Crete main island)\n`);
