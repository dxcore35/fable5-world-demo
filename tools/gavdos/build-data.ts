#!/usr/bin/env bun
/**
 * Gavdos data pack builder.
 * Usage: bunx tsx tools/gavdos/build-data.ts --stage=copy|vectors|roadmask|all
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../..");
const SOURCE_GAVDOS = path.resolve(
  REPO_ROOT,
  "../../3D-newra-terrain/public/gavdos"
);
const SOURCE_LABELS = path.resolve(
  REPO_ROOT,
  "../../3D-newra-terrain/public/labels.json"
);
const DEST = path.resolve(REPO_ROOT, "public/gavdos");
const CACHE_DIR = path.resolve(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "overpass.json");

// World window for roadmask
// Window comes from the single geodesy source of truth (node-importable, dependency-free)
import {
  GAVDOS_WIN_WEST,
  GAVDOS_WIN_EAST,
  GAVDOS_WIN_SOUTH,
  GAVDOS_WIN_NORTH,
} from "../../src/gavdos/GavdosConst";
const ROAD_LON_MIN = GAVDOS_WIN_WEST;
const ROAD_LON_MAX = GAVDOS_WIN_EAST;
const ROAD_LAT_MIN = GAVDOS_WIN_SOUTH;
const ROAD_LAT_MAX = GAVDOS_WIN_NORTH;
const RASTER_SIZE = 4096;

// Overpass bbox: south,west,north,east
const OVP_SOUTH = 34.78;
const OVP_NORTH = 34.90;
const OVP_WEST = 24.00;
const OVP_EAST = 24.17;

const COPY_FILES: string[] = [
  "heightmap.bin",
  "meta.json",
  "mask.bin",
  "mask-meta.json",
  "species.bin",
  "species-meta.json",
  "weights.bin",
  "shore.png",
  "ao.png",
  "rocks.json",
  "ortho_hero.jpg",
  "hero-meta.json",
];

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

function fail(msg: string): never {
  process.stderr.write("ERROR: " + msg + "\n");
  process.exit(1);
}

// ── stage: copy ───────────────────────────────────────────────────────────────

async function stageCopy(): Promise<void> {
  log("=== stage: copy ===");

  // Check all source files exist first
  const missing: string[] = [];
  for (const f of COPY_FILES) {
    const src = path.join(SOURCE_GAVDOS, f);
    if (!fs.existsSync(src)) missing.push(src);
  }
  if (!fs.existsSync(SOURCE_LABELS)) missing.push(SOURCE_LABELS);
  if (missing.length > 0) {
    fail("Missing source files:\n" + missing.join("\n"));
  }

  // Copy gavdos files
  for (const f of COPY_FILES) {
    const src = path.join(SOURCE_GAVDOS, f);
    const dst = path.join(DEST, f);
    fs.copyFileSync(src, dst);
    const size = fs.statSync(dst).size;
    log(`  copied ${f} (${size} bytes)`);
  }

  // Copy labels.json
  const labelsDst = path.join(DEST, "labels.json");
  fs.copyFileSync(SOURCE_LABELS, labelsDst);
  const labelsSize = fs.statSync(labelsDst).size;
  log(`  copied labels.json (${labelsSize} bytes)`);

  log("copy stage done.");
}

// ── stage: vectors ────────────────────────────────────────────────────────────

const OVERPASS_QUERY = `[out:json][timeout:90];
(
  way["building"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  relation["building"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  way["highway"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  way["barrier"~"wall|fence"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  way["landuse"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  node["amenity"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  node["place"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  node["tourism"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  node["natural"="beach"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
  node["man_made"="lighthouse"](${OVP_SOUTH},${OVP_WEST},${OVP_NORTH},${OVP_EAST});
);
out geom;`;

async function fetchOverpass(): Promise<unknown> {
  if (fs.existsSync(CACHE_FILE)) {
    log("  using cached overpass response");
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as unknown;
  }

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`  fetching from ${endpoint} (attempt ${attempt})...`);
      try {
        const body = new URLSearchParams({ data: OVERPASS_QUERY });
        const resp = await fetch(endpoint, {
          method: "POST",
          body,
          headers: {
            "User-Agent": "gavdos-data-builder/1.0 (Gavdos island data pack)",
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!resp.ok) {
          log(`  HTTP ${resp.status} from ${endpoint}`);
          continue;
        }
        const text = await resp.text();
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, text, "utf8");
        log(`  cached to ${CACHE_FILE} (${text.length} bytes)`);
        return JSON.parse(text) as unknown;
      } catch (err) {
        log(`  error: ${(err as Error).message}`);
      }
    }
  }
  fail("All Overpass endpoints failed after retries.");
}

interface OvpNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OvpWayGeom {
  lat: number;
  lon: number;
}

interface OvpWay {
  type: "way";
  id: number;
  geometry?: OvpWayGeom[];
  tags?: Record<string, string>;
}

interface OvpMember {
  type: string;
  role: string;
  geometry?: OvpWayGeom[];
  ref?: number;
}

interface OvpRelation {
  type: "relation";
  id: number;
  members?: OvpMember[];
  tags?: Record<string, string>;
}

type OvpElement = OvpNode | OvpWay | OvpRelation;

interface OvpResponse {
  elements: OvpElement[];
}

type LonLat = [number, number];

interface Building {
  id: number;
  outline: LonLat[];
  tags: Record<string, string>;
}

interface Road {
  id: number;
  path: LonLat[];
  highway: string;
  tags: Record<string, string>;
}

interface Wall {
  id: number;
  path: LonLat[];
  tags: Record<string, string>;
}

interface LandUse {
  id: number;
  outline: LonLat[];
  kind: string;
  tags: Record<string, string>;
}

interface Poi {
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

function geomToLonLat(geom: OvpWayGeom[]): LonLat[] {
  return geom.map((g) => [g.lon, g.lat] as LonLat);
}

function closeOutline(pts: LonLat[]): LonLat[] {
  if (pts.length < 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...pts, [first[0], first[1]]];
  }
  return pts;
}

async function stageVectors(): Promise<void> {
  log("=== stage: vectors ===");

  const raw = (await fetchOverpass()) as OvpResponse;
  const elements = raw.elements;
  log(`  total elements: ${elements.length}`);

  const buildings: Building[] = [];
  const roads: Road[] = [];
  const walls: Wall[] = [];
  const landuse: LandUse[] = [];
  const pois: Poi[] = [];

  for (const el of elements) {
    if (el.type === "node") {
      const t = el.tags ?? {};
      if (t.amenity || t.place || t.tourism || t.natural === "beach" || t.man_made === "lighthouse") {
        pois.push({ id: el.id, lon: el.lon, lat: el.lat, tags: t });
      }
    } else if (el.type === "way") {
      const geom = el.geometry ?? [];
      const pts = geomToLonLat(geom);
      const tags = el.tags ?? {};

      if (tags.building) {
        if (pts.length >= 3) {
          buildings.push({ id: el.id, outline: closeOutline(pts), tags });
        }
      } else if (tags.highway) {
        roads.push({ id: el.id, path: pts, highway: tags.highway, tags });
      } else if (tags.barrier === "wall" || tags.barrier === "fence") {
        walls.push({ id: el.id, path: pts, tags });
      } else if (tags.landuse) {
        if (pts.length >= 3) {
          landuse.push({
            id: el.id,
            outline: closeOutline(pts),
            kind: tags.landuse,
            tags,
          });
        }
      }
    } else if (el.type === "relation") {
      const tags = el.tags ?? {};
      if (tags.building) {
        // Use outer way geometry
        const members = el.members ?? [];
        const outer = members.find(
          (m) => m.role === "outer" && m.geometry && m.geometry.length > 0
        );
        if (outer?.geometry) {
          const pts = geomToLonLat(outer.geometry);
          if (pts.length >= 3) {
            buildings.push({ id: el.id, outline: closeOutline(pts), tags });
          }
        }
      }
    }
  }

  const output = {
    generated: new Date().toISOString(),
    bbox: {
      west: OVP_WEST,
      south: OVP_SOUTH,
      east: OVP_EAST,
      north: OVP_NORTH,
    },
    buildings,
    roads,
    walls,
    landuse,
    pois,
  };

  const outPath = path.join(DEST, "vectors.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  log(
    `  wrote vectors.json: buildings=${buildings.length} roads=${roads.length} walls=${walls.length} landuse=${landuse.length} pois=${pois.length}`
  );
  log("vectors stage done.");
}

// ── stage: roadmask ───────────────────────────────────────────────────────────

function lonToX(lon: number): number {
  return ((lon - ROAD_LON_MIN) / (ROAD_LON_MAX - ROAD_LON_MIN)) * RASTER_SIZE;
}

function latToY(lat: number): number {
  return ((ROAD_LAT_MAX - lat) / (ROAD_LAT_MAX - ROAD_LAT_MIN)) * RASTER_SIZE;
}

function highwayWidth(hw: string): number {
  if (["track", "unclassified", "residential", "service"].includes(hw))
    return 5;
  if (["path", "footway"].includes(hw)) return 2;
  return 3;
}

async function stageRoadmask(): Promise<void> {
  log("=== stage: roadmask ===");

  const vecPath = path.join(DEST, "vectors.json");
  if (!fs.existsSync(vecPath)) {
    fail("vectors.json not found — run --stage=vectors first");
  }

  const vectors = JSON.parse(fs.readFileSync(vecPath, "utf8")) as {
    roads: Road[];
  };
  const roads = vectors.roads;
  log(`  rasterizing ${roads.length} roads to ${RASTER_SIZE}×${RASTER_SIZE}`);

  // Build SVG with polylines
  const polylines: string[] = [];
  for (const road of roads) {
    if (road.path.length < 2) continue;
    const pts = road.path
      .map(([lon, lat]) => `${lonToX(lon).toFixed(2)},${latToY(lat).toFixed(2)}`)
      .join(" ");
    const w = highwayWidth(road.highway);
    polylines.push(
      `<polyline points="${pts}" stroke="white" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_SIZE}" height="${RASTER_SIZE}" viewBox="0 0 ${RASTER_SIZE} ${RASTER_SIZE}">
<rect width="${RASTER_SIZE}" height="${RASTER_SIZE}" fill="black"/>
${polylines.join("\n")}
</svg>`;

  const outPath = path.join(DEST, "roadmask.png");
  await sharp(Buffer.from(svg))
    .png()
    .toFile(outPath);

  const size = fs.statSync(outPath).size;
  log(`  wrote roadmask.png (${size} bytes)`);
  log("roadmask stage done.");
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stageArg = args.find((a) => a.startsWith("--stage="));
  const stage = stageArg ? stageArg.replace("--stage=", "") : "all";

  if (!["copy", "vectors", "roadmask", "all"].includes(stage)) {
    fail(`Unknown stage: ${stage}. Use copy|vectors|roadmask|all`);
  }

  fs.mkdirSync(DEST, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (stage === "copy" || stage === "all") await stageCopy();
  if (stage === "vectors" || stage === "all") await stageVectors();
  if (stage === "roadmask" || stage === "all") await stageRoadmask();

  log("\nAll requested stages complete.");
}

main().catch((err) => {
  process.stderr.write("Fatal: " + String(err) + "\n");
  process.exit(1);
});
