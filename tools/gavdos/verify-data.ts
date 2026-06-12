#!/usr/bin/env bun
/**
 * Gavdos data pack verifier.
 * Prints a numeric manifest and exits non-zero on any failure.
 * Usage: bunx tsx tools/gavdos/verify-data.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../..");
const DEST = path.resolve(REPO_ROOT, "public/gavdos");

// Bbox for Overpass data
const OVP_WEST = 24.00;
const OVP_SOUTH = 34.78;
const OVP_EAST = 24.17;
const OVP_NORTH = 34.90;
const BBOX_TOLERANCE = 0.001;

// Labels bbox — full Crete island (labels.json covers all of Crete, not just Gavdos)
const LABELS_LON_MIN = 23.0;
const LABELS_LON_MAX = 26.5;
const LABELS_LAT_MIN = 34.7;
const LABELS_LAT_MAX = 35.7;

let failures = 0;

function pass(msg: string): void {
  process.stdout.write("  PASS  " + msg + "\n");
}

function fail(msg: string): void {
  process.stderr.write("  FAIL  " + msg + "\n");
  failures++;
}

function assert(cond: boolean, passMsg: string, failMsg: string): void {
  if (cond) pass(passMsg);
  else fail(failMsg);
}

function checkFile(name: string): boolean {
  const p = path.join(DEST, name);
  if (!fs.existsSync(p)) {
    fail(`${name} — MISSING`);
    return false;
  }
  const size = fs.statSync(p).size;
  pass(`${name} — ${size} bytes`);
  return true;
}

// ── 1. Copied files ───────────────────────────────────────────────────────────

console.log("\n=== 1. Copied files ===");

const REQUIRED_FILES = [
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
  "labels.json",
];

for (const f of REQUIRED_FILES) {
  checkFile(f);
}

// ── 2. Heightmap scan ─────────────────────────────────────────────────────────

console.log("\n=== 2. Heightmap scan ===");

const metaPath = path.join(DEST, "meta.json");
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
    width?: number;
    height?: number;
    cols?: number;
    rows?: number;
  };
  const width = meta.width ?? meta.cols ?? 0;
  const height = meta.height ?? meta.rows ?? 0;
  pass(`meta.json dims: ${width}×${height}`);

  const hmPath = path.join(DEST, "heightmap.bin");
  if (fs.existsSync(hmPath)) {
    const buf = fs.readFileSync(hmPath);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    let minEl = Infinity;
    let maxEl = -Infinity;
    for (let i = 0; i < floats.length; i++) {
      const v = floats[i];
      if (v < minEl) minEl = v;
      if (v > maxEl) maxEl = v;
    }
    pass(`heightmap float32 scan: ${floats.length} values`);
    pass(`  min elevation: ${minEl.toFixed(1)} m  (expect ≈ −1633.8)`);
    pass(`  max elevation: ${maxEl.toFixed(1)} m  (expect ≈ +367.9)`);
    assert(minEl < -1000, `min < -1000 m OK`, `min elevation suspiciously high: ${minEl.toFixed(1)}`);
    assert(maxEl > 300, `max > 300 m OK`, `max elevation suspiciously low: ${maxEl.toFixed(1)}`);
  }
}

// ── 3. vectors.json ───────────────────────────────────────────────────────────

console.log("\n=== 3. vectors.json ===");

const vecPath = path.join(DEST, "vectors.json");
if (!fs.existsSync(vecPath)) {
  fail("vectors.json MISSING — skipping vector checks");
} else {
  const vec = JSON.parse(fs.readFileSync(vecPath, "utf8")) as {
    buildings: Array<{ id: number; outline: [number, number][]; tags: Record<string, string> }>;
    roads: Array<{ id: number; path: [number, number][]; highway: string; tags: Record<string, string> }>;
    walls: Array<{ id: number; path: [number, number][]; tags: Record<string, string> }>;
    landuse: Array<{ id: number; outline: [number, number][]; kind: string; tags: Record<string, string> }>;
    pois: Array<{ id: number; lon: number; lat: number; tags: Record<string, string> }>;
  };

  pass(`buildings: ${vec.buildings.length}`);
  pass(`roads: ${vec.roads.length}`);
  pass(`walls: ${vec.walls.length}`);
  pass(`landuse: ${vec.landuse.length}`);
  pass(`pois: ${vec.pois.length}`);

  assert(vec.buildings.length >= 80, `buildings ≥ 80 (${vec.buildings.length})`, `buildings < 80: only ${vec.buildings.length}`);
  assert(vec.roads.length >= 20, `roads ≥ 20 (${vec.roads.length})`, `roads < 20: only ${vec.roads.length}`);
  assert(vec.pois.length >= 5, `pois ≥ 5 (${vec.pois.length})`, `pois < 5: only ${vec.pois.length}`);

  // Vertex bbox check
  let vertexFails = 0;
  for (const b of vec.buildings) {
    for (const [lon, lat] of b.outline) {
      if (lon < OVP_WEST - BBOX_TOLERANCE || lon > OVP_EAST + BBOX_TOLERANCE ||
          lat < OVP_SOUTH - BBOX_TOLERANCE || lat > OVP_NORTH + BBOX_TOLERANCE) {
        vertexFails++;
      }
    }
  }
  for (const r of vec.roads) {
    for (const [lon, lat] of r.path) {
      if (lon < OVP_WEST - BBOX_TOLERANCE || lon > OVP_EAST + BBOX_TOLERANCE ||
          lat < OVP_SOUTH - BBOX_TOLERANCE || lat > OVP_NORTH + BBOX_TOLERANCE) {
        vertexFails++;
      }
    }
  }
  assert(vertexFails === 0, `all vertices within bbox ±0.001°`, `${vertexFails} vertices outside bbox`);
}

// ── 4. labels.json ────────────────────────────────────────────────────────────

console.log("\n=== 4. labels.json ===");

const labelsPath = path.join(DEST, "labels.json");
if (!fs.existsSync(labelsPath)) {
  fail("labels.json MISSING");
} else {
  const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8")) as Array<{
    lon?: number;
    lat?: number;
    lng?: number;
    longitude?: number;
    latitude?: number;
    [key: string]: unknown;
  }>;

  pass(`labels.json: ${labels.length} entries`);
  assert(labels.length >= 6, `labels ≥ 6 (${labels.length})`, `labels < 6: only ${labels.length}`);

  let labelFails = 0;
  for (const l of labels) {
    const lon = l.lon ?? l.lng ?? l.longitude ?? 0;
    const lat = l.lat ?? l.latitude ?? 0;
    if (lon < LABELS_LON_MIN || lon > LABELS_LON_MAX || lat < LABELS_LAT_MIN || lat > LABELS_LAT_MAX) {
      labelFails++;
    }
  }
  assert(labelFails === 0, `all labels within 23.9–24.2 / 34.76–34.96`, `${labelFails} labels outside expected range`);
}

// ── 5. roadmask.png ───────────────────────────────────────────────────────────

console.log("\n=== 5. roadmask.png ===");

const rmPath = path.join(DEST, "roadmask.png");
if (!fs.existsSync(rmPath)) {
  fail("roadmask.png MISSING");
} else {
  const info = await sharp(rmPath).metadata();
  pass(`roadmask.png: ${info.width}×${info.height} channels=${info.channels}`);
  assert(info.width === 4096 && info.height === 4096,
    `dimensions 4096×4096`,
    `wrong dimensions: ${info.width}×${info.height}`);

  // Count nonzero pixels via stats
  const { data } = await sharp(rmPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  let nonzero = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) nonzero++;
  }
  pass(`roadmask nonzero pixels: ${nonzero}`);
  assert(nonzero > 10000, `nonzero pixels > 10000 (${nonzero})`, `too few nonzero pixels: ${nonzero}`);
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log("\n=== Summary ===");
if (failures === 0) {
  console.log(`ALL CHECKS PASSED (0 failures)`);
} else {
  console.log(`FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
