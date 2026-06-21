/**
 * fetch-coastline.ts — pull OSM `natural=coastline` for Gavdos and save it as a
 * sharp land-polygon GeoJSON for the runtime coastline-conditioner.
 *
 * Rationale: EuroGeographics / 1:250k coastlines are generalized; the FABDEM 30 m
 * heightmap's 0 m contour (the rendered waterline) is smoothed in the coastal band.
 * OSM natural=coastline ways are sharp closed loops — main island way 6117217
 * (~1375 pts) + offshore islets. Each closed way becomes one land Polygon; a point
 * inside ANY polygon is land.
 *
 * Usage: bunx tsx tools/gavdos/fetch-coastline.ts
 * Output: public/gavdos/coastline.geojson  (FeatureCollection of lon/lat Polygons)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.resolve(REPO_ROOT, "public/gavdos/coastline.geojson");

// Overpass bbox: south,west,north,east (Gavdos + islets)
const BBOX = "34.78,24.00,34.90,24.17";
const QUERY = `[out:json][timeout:60];
( way["natural"="coastline"](${BBOX}); );
out geom;`;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

interface Pt { lat: number; lon: number; }
interface Way { type: string; id: number; geometry?: Pt[]; tags?: Record<string, string>; }

async function fetchOverpass(): Promise<Way[]> {
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      process.stdout.write(`  fetching ${endpoint} (attempt ${attempt})...\n`);
      try {
        const resp = await fetch(endpoint, {
          method: "POST",
          body: new URLSearchParams({ data: QUERY }),
          headers: {
            "User-Agent": "gavdos-coastline/1.0 (Gavdos coastline)",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!resp.ok) { process.stdout.write(`  HTTP ${resp.status}\n`); continue; }
        const j = (await resp.json()) as { elements: Way[] };
        return j.elements.filter((e) => e.type === "way" && (e.geometry?.length ?? 0) >= 4);
      } catch (err) {
        process.stdout.write(`  error: ${(err as Error).message}\n`);
      }
    }
  }
  throw new Error("All Overpass endpoints failed.");
}

function ringClosed(g: Pt[]): number[][] {
  const ring = g.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]); // force-close
  return ring;
}

const ways = await fetchOverpass();
ways.sort((a, b) => (b.geometry?.length ?? 0) - (a.geometry?.length ?? 0));

const features = ways.map((w) => {
  const ring = ringClosed(w.geometry!);
  return {
    type: "Feature" as const,
    properties: { osm_way: w.id, points: ring.length },
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
});

const fc = {
  type: "FeatureCollection" as const,
  properties: {
    source: "OSM natural=coastline",
    bbox: BBOX,
    note: "Land polygons (one per closed coastline way). Point in ANY polygon = land.",
    main_island_way: ways[0]?.id ?? null,
    generated_from: "tools/gavdos/fetch-coastline.ts",
  },
  features,
};

fs.writeFileSync(OUT, JSON.stringify(fc), "utf8");
const totalPts = features.reduce((s, f) => s + f.geometry.coordinates[0].length, 0);
process.stdout.write(
  `\n✓ wrote ${OUT}\n  ${features.length} land polygons, ${totalPts} pts total\n` +
  `  main island way ${ways[0]?.id} (${features[0]?.geometry.coordinates[0].length} pts)\n`,
);
