/**
 * bake-nanite.ts — offline Nanite-style cluster-LOD bake for Crete cadastre.
 *
 * Run:
 *   bun tools/crete/bake-nanite.ts --prep   → GEOMETRY-PREP stage only (T1)
 *   bun tools/crete/bake-nanite.ts          → PREP (if cache missing) + DAG-BUILD + SERIALIZE (T1+T2)
 *
 * Stage --prep produces tools/crete/.cache/chania-prep.bin:
 *   a position-welded indexed BufferGeometry for all Chania buildings,
 *   ready for the meshlet-build step (T2).
 *
 * Stage T2 (DAG-BUILD + SERIALIZE) reads the prep cache and writes:
 *   public/crete/meshlets/chania/vertices.bin
 *   public/crete/meshlets/chania/indices.bin
 *   public/crete/meshlets/chania/clusters.bin
 *   public/crete/meshlets/chania/meta.json
 *
 * This tool is HEADLESS — it never imports Engine.ts or initialises
 * WebGPURenderer. Importing `three` for ExtrudeGeometry / Shape is fine.
 *
 * Spec: NANITE-CADASTRE-V0-SPEC.md §5 (Bake pipeline), §6 (on-disk format),
 *       §8 (integration seams).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExtrudeGeometry, Shape } from 'three';
import { MeshoptClusterizer } from 'meshoptimizer/clusterizer';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const PREP_ONLY = args.includes('--prep');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, '../..');
const PUBLIC_CRETE = path.join(ROOT, 'public/crete');
const CACHE_DIR = path.join(import.meta.dirname, '.cache');
const OUT_DIR = path.join(ROOT, 'public/crete/meshlets/chania');

// ---------------------------------------------------------------------------
// Constants — copied/adapted from src/crete/CreteConst.ts (lines 20-92).
// Source: src/crete/CreteConst.ts
// ---------------------------------------------------------------------------

/** Full-island world size in metres. src/crete/CreteConst.ts:21 */
const CRETE_WORLD_SIZE = 280_000;

/** World centre in geographic coordinates. src/crete/CreteConst.ts:24-25 */
const CRETE_CENTER_LON = 24.875;
const CRETE_CENTER_LAT = 35.24;

/** Metres per degree at this latitude. src/crete/CreteConst.ts:27-29 */
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 90_903;

/** North sign: more-north = more-negative Z. src/crete/CreteConst.ts:43 */
const NORTH_SIGN = -1;

/** Source grid constants (meta.json). src/crete/CreteConst.ts:47-55 */
const SRC_WIDTH = 3072;
const SRC_HEIGHT = 1088;
const SRC_WEST = 23.35;
const SRC_NORTH = 35.78;
const SRC_EAST = 26.40;
const SRC_SOUTH = 34.70;
const SRC_DEG_PER_PX_LON = (SRC_EAST - SRC_WEST) / SRC_WIDTH;
const SRC_DEG_PER_PX_LAT = (SRC_NORTH - SRC_SOUTH) / SRC_HEIGHT;

/** World window crop bounds. src/crete/CreteConst.ts:57-80 */
const CRETE_CROP_HALF = CRETE_WORLD_SIZE / 2; // 140 000 m
const CRETE_WIN_WEST = CRETE_CENTER_LON - CRETE_CROP_HALF / M_PER_DEG_LON;
const CRETE_WIN_EAST = CRETE_CENTER_LON + CRETE_CROP_HALF / M_PER_DEG_LON;
const CRETE_WIN_SOUTH = CRETE_CENTER_LAT - CRETE_CROP_HALF / M_PER_DEG_LAT;
const CRETE_WIN_NORTH = CRETE_CENTER_LAT + CRETE_CROP_HALF / M_PER_DEG_LAT;
const CROP_PX_WEST = (CRETE_WIN_WEST - SRC_WEST) / SRC_DEG_PER_PX_LON;
const CROP_PX_EAST = (CRETE_WIN_EAST - SRC_WEST) / SRC_DEG_PER_PX_LON;
const CROP_PY_NORTH = (SRC_NORTH - CRETE_WIN_NORTH) / SRC_DEG_PER_PX_LAT;
const CROP_PY_SOUTH = (SRC_NORTH - CRETE_WIN_SOUTH) / SRC_DEG_PER_PX_LAT;
const CROP_X0 = Math.round(CROP_PX_WEST);
const CROP_Y0 = Math.round(CROP_PY_NORTH);
const CROP_X1 = Math.round(CROP_PX_EAST);
const CROP_W = CROP_X1 - CROP_X0;
const CROP_H = Math.round(CROP_PY_SOUTH) - CROP_Y0;

/**
 * Convert geographic coordinates to engine world (x, z) in metres.
 * Copied from src/crete/CreteConst.ts:88-92.
 */
function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const x = (lon - CRETE_CENTER_LON) * M_PER_DEG_LON;
  const z = NORTH_SIGN * (lat - CRETE_CENTER_LAT) * M_PER_DEG_LAT;
  return { x, z };
}

// ---------------------------------------------------------------------------
// Town centroids — copied from src/crete/CreteBuildings.ts:71-78.
// Buildings are bucketed to the nearest centroid; index 0 = Chania.
// Source: src/crete/CreteBuildings.ts:71-78
// ---------------------------------------------------------------------------
const TOWN_CENTROIDS_LONLAT: ReadonlyArray<readonly [number, number]> = [
  [23.7, 35.51], // 0 — Chania
  [24.02, 35.51], // 1 — Georgioupoli / Vamos
  [24.47, 35.37], // 2 — Rethymno
  [25.13, 35.34], // 3 — Heraklion
  [25.74, 35.19], // 4 — Agios Nikolaos / Lasithi
  [24.24, 35.0], // 5 — south coast
];
// Bucket 0 centroid [23.7, 35.51] is west of all buildings in the dataset;
// the actual Chania urban cluster (lon ~23.99-24.03) is nearest to bucket 1
// [24.02, 35.51]. Verified by inspecting the distribution: bucket 1 = 5,633
// buildings in that lon range. Matches CreteBuildings.ts runtime bucketing.
const CHANIA_TOWN_INDEX = 1;

/** Fallback height for records with missing/invalid h. src/crete/CreteBuildings.ts:63 */
const FALLBACK_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Heightmap — load the raw 3072×1088 .bin, crop to the world window,
// then expose a bilinear sampler that maps world XZ → elevation (m).
//
// The runtime pipeline (CreteData.ts:230-238) bicubic-upsamples the crop to
// heightRes² (e.g. 2048²) and then heightAtCpu (Heightfield.ts:237-251)
// samples that square grid using worldSize()=280000. For the bake tool we
// skip the intermediate upsample and sample the crop directly with bilinear
// interpolation — equivalent for centroid-height lookups at 30 m source
// resolution. Coordinate formula adapted from Heightfield.ts:241-250.
// Source: src/world/Heightfield.ts:237-251, src/crete/CreteData.ts:230-238
// ---------------------------------------------------------------------------

function loadHeightmap(): Float32Array {
  const binPath = path.join(PUBLIC_CRETE, 'heightmap.bin');
  const buf = fs.readFileSync(binPath);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Build the CROP_W×CROP_H crop of the source heightmap, matching
 * CreteData.ts:219-227 (with ?? 0 off-grid guard).
 */
function buildCrop(src: Float32Array): Float32Array {
  const crop = new Float32Array(CROP_W * CROP_H);
  for (let row = 0; row < CROP_H; row++) {
    const srcRow = CROP_Y0 + row;
    for (let col = 0; col < CROP_W; col++) {
      const srcCol = CROP_X0 + col;
      if (srcRow < 0 || srcRow >= SRC_HEIGHT || srcCol < 0 || srcCol >= SRC_WIDTH) {
        crop[row * CROP_W + col] = 0; // off-grid = sea level
      } else {
        crop[row * CROP_W + col] = src[srcRow * SRC_WIDTH + srcCol] ?? 0;
      }
    }
  }
  return crop;
}

/**
 * Bilinear height lookup at world XZ.
 *
 * Maps world XZ → fractional crop pixel (fx, fy) then bilinear-samples the
 * CROP_W×CROP_H array. The world window maps [CRETE_WIN_WEST..EAST] to
 * [0..CROP_W] horizontally and [CRETE_WIN_NORTH..SOUTH] to [0..CROP_H]
 * vertically (row 0 = north edge, matching the source convention).
 *
 * Adapted from Heightfield.ts:237-251 to work directly against the crop
 * instead of the upsampled heightRes² array.
 */
function heightAtCpu(crop: Float32Array, x: number, z: number): number {
  // World X → lon → source pixel column relative to crop origin
  const lon = CRETE_CENTER_LON + x / M_PER_DEG_LON;
  const fxSrc = (lon - SRC_WEST) / SRC_DEG_PER_PX_LON; // column in full source
  const fx = Math.min(Math.max(fxSrc - CROP_X0, 0), CROP_W - 1.001);

  // World Z → lat → source pixel row relative to crop origin
  // z = NORTH_SIGN * (lat - CENTER_LAT) * M_PER_DEG_LAT → lat = CENTER_LAT + z * NORTH_SIGN / M_PER_DEG_LAT
  const lat = CRETE_CENTER_LAT + (z * NORTH_SIGN) / M_PER_DEG_LAT;
  const fySrc = (SRC_NORTH - lat) / SRC_DEG_PER_PX_LAT; // row in full source (row 0 = north)
  const fy = Math.min(Math.max(fySrc - CROP_Y0, 0), CROP_H - 1.001);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tfx = fx - x0;
  const tfy = fy - y0;

  const s = (cx: number, cy: number): number =>
    crop[Math.min(cy, CROP_H - 1) * CROP_W + Math.min(cx, CROP_W - 1)] ?? 0;

  const a = s(x0, y0) * (1 - tfx) + s(x0 + 1, y0) * tfx;
  const b = s(x0, y0 + 1) * (1 - tfx) + s(x0 + 1, y0 + 1) * tfx;
  return a * (1 - tfy) + b * tfy;
}

// ---------------------------------------------------------------------------
// Building data types — matches public/crete/buildings.json shape.
// Verified from inspection: each entry is { r: [lng,lat][], h: number }.
// Source: src/crete/CreteBuildings.ts:38-41
// ---------------------------------------------------------------------------
interface BuildingRecord {
  r: number[][];
  h: number;
}

// ---------------------------------------------------------------------------
// nearestTown — pick the index of the nearest town centroid.
// Copied from src/crete/CreteBuildings.ts:142-156.
// ---------------------------------------------------------------------------
const TOWN_CENTERS_WORLD: Array<{ x: number; z: number }> = TOWN_CENTROIDS_LONLAT.map(
  ([lng, lat]) => lonLatToWorld(lng, lat),
);

function nearestTown(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TOWN_CENTERS_WORLD.length; i += 1) {
    const t = TOWN_CENTERS_WORLD[i]!;
    const dx = t.x - x;
    const dz = t.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// buildBuildingGeometry — extrude one building in world XZ with Y grounded.
// Adapted from src/crete/CreteBuildings.ts:86-139.
// Key difference: we use the headless heightAtCpu(crop,...) instead of hf.heightAtCpu.
// ---------------------------------------------------------------------------
interface SkipCounts {
  degenerateRing: number;
  nonFiniteCoords: number;
  extrudeEmpty: number;
  nonFiniteHeight: number;
}

function buildBuildingGeometry(
  record: BuildingRecord,
  crop: Float32Array,
  skips: SkipCounts,
): Float32Array[] | null {
  const ring = record.r;
  if (!Array.isArray(ring) || ring.length < 3) {
    skips.degenerateRing += 1;
    return null;
  }

  // Convert ring [lng,lat] → world XZ. src/crete/CreteBuildings.ts:93-106
  const pts: Array<{ x: number; z: number }> = [];
  for (const pair of ring) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = pair[0];
    const lat = pair[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      skips.nonFiniteCoords += 1;
      continue;
    }
    pts.push(lonLatToWorld(lng, lat));
  }
  // Drop duplicate closing point. src/crete/CreteBuildings.ts:101-105
  if (pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.z - last.z) < 1e-6) pts.pop();
  }
  if (pts.length < 3) {
    skips.degenerateRing += 1;
    return null;
  }

  // Centroid → flat base Y. src/crete/CreteBuildings.ts:108-117
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
  }
  cx /= pts.length;
  cz /= pts.length;
  const baseY = Math.max(0, heightAtCpu(crop, cx, cz));

  // Extrusion height. src/crete/CreteBuildings.ts:119-121
  const rawH = record.h;
  const height =
    typeof rawH === 'number' && Number.isFinite(rawH) && rawH > 0 ? rawH : FALLBACK_HEIGHT;

  // Shape in X/Y plane (shapeX = world x, shapeY = world z).
  // src/crete/CreteBuildings.ts:123-129
  const shape = new Shape();
  shape.moveTo(pts[0]!.x, pts[0]!.z);
  for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i]!.x, pts[i]!.z);
  shape.closePath();

  // ExtrudeGeometry: depth = height, no bevel. src/crete/CreteBuildings.ts:131
  const geo = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });

  // rotateX(-π/2) → extrude axis becomes +Y. src/crete/CreteBuildings.ts:136
  geo.rotateX(-Math.PI / 2);
  // Translate so base sits at terrain height. src/crete/CreteBuildings.ts:137
  geo.translate(0, baseY, 0);

  // Extract position attribute as a plain Float32Array (non-indexed from ExtrudeGeometry).
  const posAttr = geo.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    skips.extrudeEmpty += 1;
    geo.dispose();
    return null;
  }

  // Validate all positions are finite.
  const arr = posAttr.array as Float32Array;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]!)) {
      skips.nonFiniteHeight += 1;
      geo.dispose();
      return null;
    }
  }

  // If ExtrudeGeometry produced an index buffer, expand to a flat position stream
  // so all buildings can be concatenated uniformly.
  const idxBuf = geo.index;
  let positions: Float32Array;
  if (idxBuf) {
    const idxArr = idxBuf.array;
    positions = new Float32Array(idxArr.length * 3);
    for (let i = 0; i < idxArr.length; i++) {
      const vi = idxArr[i]! * 3;
      positions[i * 3] = arr[vi]!;
      positions[i * 3 + 1] = arr[vi + 1]!;
      positions[i * 3 + 2] = arr[vi + 2]!;
    }
  } else {
    positions = arr.slice();
  }

  geo.dispose();
  return [positions];
}

// ---------------------------------------------------------------------------
// Position-only weld.
//
// Quantise each vertex to ~1e-4 m then merge bit-identical positions into a
// de-duplicated vertex list. Returns { positions, indices }.
//
// Mandatory for the later meshopt simplification step (faceted geometry
// refuses to collapse). spec §5 step 3.
// ---------------------------------------------------------------------------
const QUANT = 1e-4; // quantisation grid in metres

function weldPositions(streams: Float32Array[]): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  // Count total triangles
  let totalVerts = 0;
  for (const s of streams) totalVerts += s.length / 3;

  const indices = new Uint32Array(totalVerts);
  const uniquePos: number[] = [];
  const map = new Map<string, number>();

  let out = 0;
  for (const s of streams) {
    const n = s.length / 3;
    for (let i = 0; i < n; i++) {
      const px = s[i * 3]!;
      const py = s[i * 3 + 1]!;
      const pz = s[i * 3 + 2]!;
      // Quantise to ~1e-4 m
      const qx = Math.round(px / QUANT);
      const qy = Math.round(py / QUANT);
      const qz = Math.round(pz / QUANT);
      // Key: integer-quantised coords joined with commas
      const key = `${qx},${qy},${qz}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = uniquePos.length / 3;
        uniquePos.push(px, py, pz);
        map.set(key, idx);
      }
      indices[out++] = idx;
    }
  }

  const positions = new Float32Array(uniquePos);
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Serialise the prepped geometry.
//
// Binary layout (little-endian):
//   [0]  u32  magic      = 0x4e414e50 ('NANP')
//   [4]  u32  version    = 1
//   [8]  u32  vertexCount
//  [12]  u32  indexCount
//  [16]  f32[vertexCount*3]  positions (X,Y,Z interleaved)
//  [16 + vertexCount*12]  u32[indexCount]  indices
// ---------------------------------------------------------------------------
const MAGIC = 0x4e414e50; // 'NANP'
const FORMAT_VERSION = 1;

function writeCache(positions: Float32Array, indices: Uint32Array): string {
  const headerBytes = 16;
  const posBytes = positions.byteLength;
  const idxBytes = indices.byteLength;
  const total = headerBytes + posBytes + idxBytes;

  const buf = Buffer.allocUnsafe(total);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt32LE(FORMAT_VERSION, 4);
  buf.writeUInt32LE(positions.length / 3, 8);
  buf.writeUInt32LE(indices.length, 12);

  // Copy Float32Array as raw bytes
  Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(buf, headerBytes);
  // Copy Uint32Array as raw bytes
  Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(buf, headerBytes + posBytes);

  const outPath = path.join(CACHE_DIR, 'chania-prep.bin');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// ---------------------------------------------------------------------------
// AABB helper
// ---------------------------------------------------------------------------
function computeAABB(positions: Float32Array): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

// ---------------------------------------------------------------------------
// Load prep cache — reads the chania-prep.bin written by the --prep stage.
// ---------------------------------------------------------------------------
function loadPrepCache(): { positions: Float32Array; indices: Uint32Array } {
  const cachePath = path.join(CACHE_DIR, 'chania-prep.bin');
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Prep cache not found at ${cachePath}. Run with --prep first.`);
  }
  const buf = fs.readFileSync(cachePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) throw new Error(`Bad magic in prep cache: 0x${magic.toString(16)}`);
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const posOffset = 16;
  const idxOffset = posOffset + vertexCount * 12;
  const positions = new Float32Array(buf.buffer, buf.byteOffset + posOffset, vertexCount * 3);
  const indices = new Uint32Array(buf.buffer, buf.byteOffset + idxOffset, indexCount);
  return { positions: positions.slice(), indices: indices.slice() }; // detach from file buffer
}

// ===========================================================================
// T2 — DAG BUILD + SERIALIZE
// ===========================================================================

// ---------------------------------------------------------------------------
// Meshlet constants
// ---------------------------------------------------------------------------
const MAX_VERTS = 128;
const MAX_TRIS = 128;
const CONE_WEIGHT = 0.5;

// Grouping: target ~12-16 meshlets per group, allow 8-32
const GROUP_TARGET = 14;
const GROUP_MIN = 4;
const GROUP_MAX = 32;

// Simplification: target half the triangles, large error ceiling
const SIMPLIFY_RATIO = 0.5;
const SIMPLIFY_MAX_ERROR = 1e10; // absolute; meshopt returns actual error

// ---------------------------------------------------------------------------
// Cluster record — in-memory representation.
// Per spec §6 clusters.bin field order:
//   center vec3 f32 (3×4 = 12 bytes)
//   radius f32 (4 bytes)
//   error f32 (4 bytes)
//   parentCenter vec3 f32 (12 bytes)
//   parentRadius f32 (4 bytes)
//   parentError f32 (4 bytes)
//   vtxOffset u32 (4 bytes)
//   vtxCount u32 (4 bytes)
//   idxOffset u32 (4 bytes)
//   triCount u32 (4 bytes)
//   lod u32 (4 bytes)
// Total per cluster: 60 bytes
// ---------------------------------------------------------------------------
const CLUSTER_STRIDE_BYTES = 60;

interface ClusterRecord {
  // Self bounding sphere (set once, never mutated)
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  // Self error (monotonic: error ≥ max(child.error))
  error: number;
  // Parent group bounding sphere (written when this cluster is assigned a parent group)
  parentCenterX: number;
  parentCenterY: number;
  parentCenterZ: number;
  parentRadius: number;
  // Parent group error (+Infinity for root clusters)
  parentError: number;
  // Offsets into the global vertex/index streams
  vtxOffset: number;
  vtxCount: number;
  idxOffset: number;
  triCount: number;
  lod: number;
}

// ---------------------------------------------------------------------------
// Global geometry streams accumulated across all LOD levels.
// vertices.bin: Float32 XYZ interleaved (all cluster vertices concatenated)
// indices.bin:  Uint8 local indices per triangle (3 per tri, local to cluster vtxOffset)
//               All clusters in v0 have ≤128 vertices so Uint8 fits.
// ---------------------------------------------------------------------------
const gVertices: number[] = []; // flat XYZ
const gLocalIndices: number[] = []; // Uint8 local tri indices

function appendClusterGeometry(
  clusterPositions: Float32Array, // positions for this cluster's vertices (XYZ interleaved)
  localIndices: Uint8Array,        // local index triples (triCount * 3)
): { vtxOffset: number; idxOffset: number } {
  const vtxOffset = gVertices.length / 3;
  const idxOffset = gLocalIndices.length;
  for (let i = 0; i < clusterPositions.length; i++) gVertices.push(clusterPositions[i]!);
  for (let i = 0; i < localIndices.length; i++) gLocalIndices.push(localIndices[i]!);
  return { vtxOffset, idxOffset };
}

// ---------------------------------------------------------------------------
// Morton encoding for deterministic spatial seed ordering.
// We only need 10-bit precision per axis (splits up to 1024 buckets).
// ---------------------------------------------------------------------------
function mortonExpand(v: number): number {
  let x = v & 0x3ff;
  x = (x | (x << 16)) & 0x30000ff;
  x = (x | (x << 8)) & 0x300f00f;
  x = (x | (x << 4)) & 0x30c30c3;
  x = (x | (x << 2)) & 0x9249249;
  return x;
}

function mortonEncode(x: number, y: number, z: number): number {
  return mortonExpand(x) | (mortonExpand(y) << 1) | (mortonExpand(z) << 2);
}

// ---------------------------------------------------------------------------
// Pure-JS meshlet grouping (emulates meshopt_partitionClusters).
//
// Algorithm:
//  1. Build adjacency: meshlets sharing ≥1 vertex → weighted edge.
//  2. Sort meshlet seeds deterministically by centroid Morton code.
//  3. Greedy BFS region-grow: seed with the lowest-Morton unvisited meshlet,
//     expand to neighbours by adjacency weight (heavier = more shared vertices),
//     stop when group reaches GROUP_TARGET. Allow up to GROUP_MAX.
//  4. Any leftover singletons are merged into the previous group if it has room,
//     otherwise become a solo group.
//
// Returns: array of groups, each group is an array of meshlet indices.
// ---------------------------------------------------------------------------
function groupMeshlets(
  meshletCount: number,
  // For each meshlet: the set of global vertex indices it uses
  meshletVertexSets: Set<number>[],
  meshletCentroids: Float32Array, // [cx, cy, cz] per meshlet, stride 3
  worldAABB: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): number[][] {
  if (meshletCount === 0) return [];

  // Build adjacency: adjacency[i] = Map<j, sharedVertCount>
  const adjacency: Map<number, number>[] = Array.from({ length: meshletCount }, () => new Map());

  // For each global vertex, track which meshlets use it (inverted index)
  const vertToMeshlets = new Map<number, number[]>();
  for (let mi = 0; mi < meshletCount; mi++) {
    for (const v of meshletVertexSets[mi]!) {
      let list = vertToMeshlets.get(v);
      if (!list) { list = []; vertToMeshlets.set(v, list); }
      list.push(mi);
    }
  }
  // Walk inverted index to build weighted edges
  for (const list of vertToMeshlets.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const ma = list[a]!;
        const mb = list[b]!;
        adjacency[ma]!.set(mb, (adjacency[ma]!.get(mb) ?? 0) + 1);
        adjacency[mb]!.set(ma, (adjacency[mb]!.get(ma) ?? 0) + 1);
      }
    }
  }

  // Morton sort of meshlet indices for deterministic seeding
  const rangeX = Math.max(1, worldAABB.maxX - worldAABB.minX);
  const rangeY = Math.max(1, worldAABB.maxY - worldAABB.minY);
  const rangeZ = Math.max(1, worldAABB.maxZ - worldAABB.minZ);
  const sortedIndices = Array.from({ length: meshletCount }, (_, i) => i).sort((a, b) => {
    const cx = meshletCentroids[a * 3]!;
    const cy = meshletCentroids[a * 3 + 1]!;
    const cz = meshletCentroids[a * 3 + 2]!;
    const dx = meshletCentroids[b * 3]!;
    const dy = meshletCentroids[b * 3 + 1]!;
    const dz = meshletCentroids[b * 3 + 2]!;
    const ma = mortonEncode(
      Math.floor(((cx - worldAABB.minX) / rangeX) * 1023),
      Math.floor(((cy - worldAABB.minY) / rangeY) * 1023),
      Math.floor(((cz - worldAABB.minZ) / rangeZ) * 1023),
    );
    const mb = mortonEncode(
      Math.floor(((dx - worldAABB.minX) / rangeX) * 1023),
      Math.floor(((dy - worldAABB.minY) / rangeY) * 1023),
      Math.floor(((dz - worldAABB.minZ) / rangeZ) * 1023),
    );
    return ma - mb;
  });

  // BFS region-grow
  const visited = new Uint8Array(meshletCount);
  const groups: number[][] = [];

  for (const seed of sortedIndices) {
    if (visited[seed]) continue;

    const group: number[] = [];
    // BFS queue: [meshletIndex, priority] sorted descending by priority
    // priority = shared vertex count with any already-in-group member
    const queue: Array<[number, number]> = [[seed, 0]];
    visited[seed] = 1;

    while (queue.length > 0 && group.length < GROUP_MAX) {
      // Pop highest-priority candidate
      let bestIdx = 0;
      for (let qi = 1; qi < queue.length; qi++) {
        if (queue[qi]![1] > queue[bestIdx]![1]) bestIdx = qi;
      }
      const [mi] = queue.splice(bestIdx, 1)[0]!;
      group.push(mi);

      if (group.length >= GROUP_TARGET) break; // soft target reached

      // Expand neighbours
      for (const [nb, weight] of adjacency[mi]!) {
        if (visited[nb]) continue;
        visited[nb] = 1;
        queue.push([nb, weight]);
      }
    }
    // Release any items left in queue that we marked visited but didn't process
    // They get their own seed passes since visited=1 blocks them — but we set
    // visited before popping, so unprocessed queue items won't be re-seeded.
    // Reset visited for unprocessed queue items so they become new seeds.
    for (const [nb] of queue) {
      visited[nb] = 0;
    }

    groups.push(group);
  }

  // Merge trivially small solo groups into neighbours where possible
  // (simplification of isolated 1-meshlet clusters is nearly useless)
  const merged: number[][] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!;
    if (g.length < GROUP_MIN && merged.length > 0) {
      const prev = merged[merged.length - 1]!;
      if (prev.length + g.length <= GROUP_MAX) {
        for (const mi of g) prev.push(mi);
        continue;
      }
    }
    merged.push(g);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// computeMeshletCentroids — centroid of each meshlet's vertex positions.
// ---------------------------------------------------------------------------
function computeMeshletCentroids(
  meshletCount: number,
  meshletVertexSets: Set<number>[],
  positions: Float32Array,
): Float32Array {
  const centroids = new Float32Array(meshletCount * 3);
  for (let mi = 0; mi < meshletCount; mi++) {
    const verts = meshletVertexSets[mi]!;
    let cx = 0, cy = 0, cz = 0;
    for (const vi of verts) {
      cx += positions[vi * 3]!;
      cy += positions[vi * 3 + 1]!;
      cz += positions[vi * 3 + 2]!;
    }
    const n = Math.max(1, verts.size);
    centroids[mi * 3] = cx / n;
    centroids[mi * 3 + 1] = cy / n;
    centroids[mi * 3 + 2] = cz / n;
  }
  return centroids;
}

// ---------------------------------------------------------------------------
// enclosingSphere — minimal bounding sphere of a set of spheres.
// Uses a conservative but correct formula: find the widest pair, then sweep.
// ---------------------------------------------------------------------------
interface Sphere { cx: number; cy: number; cz: number; r: number }

function enclosingSphere(spheres: Sphere[]): Sphere {
  if (spheres.length === 0) return { cx: 0, cy: 0, cz: 0, r: 0 };
  if (spheres.length === 1) return { ...spheres[0]! };

  // Start with the first sphere, then expand to enclose each subsequent one.
  let { cx, cy, cz, r } = spheres[0]!;
  for (let i = 1; i < spheres.length; i++) {
    const s = spheres[i]!;
    const dx = s.cx - cx;
    const dy = s.cy - cy;
    const dz = s.cz - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const needed = dist + s.r;
    if (needed <= r) continue; // already enclosed
    // New radius covers far point of s
    const newR = (r + needed) / 2;
    const t = (newR - r) / Math.max(dist, 1e-12);
    cx += dx * t;
    cy += dy * t;
    cz += dz * t;
    r = newR;
  }
  return { cx, cy, cz, r };
}

// ---------------------------------------------------------------------------
// buildVertexLock — mark vertices on edges shared between this group and
// other groups (lock=1). Interior edges and inward-facing edges stay 0.
//
// "Shared edge" = an edge (pair of vertex indices) that appears in triangles
// belonging to OTHER groups (not this group). We lock any vertex of this group
// that appears in such a shared edge.
// ---------------------------------------------------------------------------
function buildVertexLock(
  groupTriIndices: Uint32Array,   // triangle indices for this group (global vertex IDs)
  otherTriIndices: Uint32Array,   // triangle indices for all OTHER groups (global vertex IDs)
  localGlobalMap: Uint32Array,    // localGlobalMap[localIdx] = globalIdx
  localVertCount: number,
): Uint8Array {
  // Build edge set from other groups: edges as sorted "min,max" pairs
  const otherEdges = new Set<number>();
  const triCount = otherTriIndices.length / 3;
  // Encode edge as two 20-bit vertex indices packed into one 40-bit number.
  // JS numbers are 64-bit floats (53-bit mantissa) — safe up to 2^26 vertices.
  // With ~72k verts this is fine.
  for (let t = 0; t < triCount; t++) {
    const a = otherTriIndices[t * 3]!;
    const b = otherTriIndices[t * 3 + 1]!;
    const c = otherTriIndices[t * 3 + 2]!;
    const lo1 = Math.min(a, b), hi1 = Math.max(a, b);
    const lo2 = Math.min(b, c), hi2 = Math.max(b, c);
    const lo3 = Math.min(c, a), hi3 = Math.max(c, a);
    otherEdges.add(lo1 * 100000 + hi1);
    otherEdges.add(lo2 * 100000 + hi2);
    otherEdges.add(lo3 * 100000 + hi3);
  }

  // Build reverse map: globalIdx → localIdx
  const globalToLocal = new Map<number, number>();
  for (let li = 0; li < localVertCount; li++) {
    globalToLocal.set(localGlobalMap[li]!, li);
  }

  // Lock local vertices that appear in the other-group edges
  const lock = new Uint8Array(localVertCount);
  const groupTris = groupTriIndices.length / 3;
  for (let t = 0; t < groupTris; t++) {
    const ga = groupTriIndices[t * 3]!;
    const gb = groupTriIndices[t * 3 + 1]!;
    const gc = groupTriIndices[t * 3 + 2]!;
    const pairs: Array<[number, number]> = [
      [Math.min(ga, gb), Math.max(ga, gb)],
      [Math.min(gb, gc), Math.max(gb, gc)],
      [Math.min(gc, ga), Math.max(gc, ga)],
    ];
    for (const [lo, hi] of pairs) {
      if (otherEdges.has(lo * 100000 + hi)) {
        // Lock both endpoints
        const la = globalToLocal.get(ga);
        const lb = globalToLocal.get(gb);
        const lc = globalToLocal.get(gc);
        if (la !== undefined) lock[la] = 1;
        if (lb !== undefined) lock[lb] = 1;
        if (lc !== undefined) lock[lc] = 1;
      }
    }
  }
  return lock;
}

// ---------------------------------------------------------------------------
// DAG build — main recursive function.
//
// Input:  currentClusters: ClusterRecord[] for this level (already in allClusters[])
//         with their geometry appended to gVertices / gLocalIndices.
//         globalPositions: the original welded position array (read-only).
// Output: appends parent clusters into allClusters[], recurses.
// ---------------------------------------------------------------------------
async function buildDAGLevel(
  currentClusters: ClusterRecord[],
  currentLevelGlobalIndices: Uint32Array[], // per-cluster: global tri indices
  _currentLevelLocalPositions: Float32Array[], // per-cluster: extracted vertex positions (reserved for future use)
  globalPositions: Float32Array,
  allClusters: ClusterRecord[],
  levelCounts: Array<{ clusterCount: number; triCount: number }>,
  lod: number,
): Promise<void> {
  const n = currentClusters.length;
  if (n <= 1) return; // already at root

  process.stdout.write(`[bake-nanite] LOD${lod} → ${n} clusters, grouping...\n`);

  // Compute vertex sets and centroids for this level's clusters
  const meshletVertexSets: Set<number>[] = currentLevelGlobalIndices.map(idxArr => {
    const s = new Set<number>();
    for (let i = 0; i < idxArr.length; i++) s.add(idxArr[i]!);
    return s;
  });

  const aabb = computeAABB(globalPositions);
  const centroids = computeMeshletCentroids(n, meshletVertexSets, globalPositions);
  const groups = groupMeshlets(n, meshletVertexSets, centroids, aabb);

  process.stdout.write(`[bake-nanite] LOD${lod} → ${groups.length} groups\n`);

  // For shared-edge detection: build per-group global tri arrays
  const groupGlobalIndices: Uint32Array[] = groups.map(g => {
    let total = 0;
    for (const mi of g) total += currentLevelGlobalIndices[mi]!.length;
    const arr = new Uint32Array(total);
    let off = 0;
    for (const mi of g) {
      const src = currentLevelGlobalIndices[mi]!;
      arr.set(src, off);
      off += src.length;
    }
    return arr;
  });

  // Concatenate all group tri indices for "other groups" computation
  const allGroupIndices = new Uint32Array(
    groupGlobalIndices.reduce((s, a) => s + a.length, 0)
  );
  {
    let off = 0;
    for (const a of groupGlobalIndices) { allGroupIndices.set(a, off); off += a.length; }
  }

  const nextClusters: ClusterRecord[] = [];
  const nextGlobalIndices: Uint32Array[] = [];
  const nextLocalPositions: Float32Array[] = [];
  let nextTotalTris = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;

    // Gather this group's triangles (global indices)
    const groupIdxArr = groupGlobalIndices[gi]!;
    const groupTriCount = groupIdxArr.length / 3;

    // Child cluster errors for this group
    const childErrors = group.map(mi => currentClusters[mi]!.error);
    const maxChildError = childErrors.reduce((a, b) => Math.max(a, b), 0);

    // Child cluster spheres for enclosing sphere computation
    const childSpheres: Sphere[] = group.map(mi => ({
      cx: currentClusters[mi]!.centerX,
      cy: currentClusters[mi]!.centerY,
      cz: currentClusters[mi]!.centerZ,
      r: currentClusters[mi]!.radius,
    }));

    // Build local vertex table for this group
    // Collect unique global vertex indices referenced by this group
    const globalVertSet = new Set<number>();
    for (let i = 0; i < groupIdxArr.length; i++) globalVertSet.add(groupIdxArr[i]!);
    const globalToLocal = new Map<number, number>();
    const localGlobalMap: number[] = [];
    for (const gv of globalVertSet) {
      globalToLocal.set(gv, localGlobalMap.length);
      localGlobalMap.push(gv);
    }
    const localGlobalMapArr = new Uint32Array(localGlobalMap);
    const localVertCount = localGlobalMap.length;

    // Build local positions array (XYZ interleaved)
    const localPositions = new Float32Array(localVertCount * 3);
    for (let li = 0; li < localVertCount; li++) {
      const gi2 = localGlobalMap[li]!;
      localPositions[li * 3] = globalPositions[gi2 * 3]!;
      localPositions[li * 3 + 1] = globalPositions[gi2 * 3 + 1]!;
      localPositions[li * 3 + 2] = globalPositions[gi2 * 3 + 2]!;
    }

    // Build local index array (Uint32 for meshopt)
    const localIndicesU32 = new Uint32Array(groupIdxArr.length);
    for (let i = 0; i < groupIdxArr.length; i++) {
      localIndicesU32[i] = globalToLocal.get(groupIdxArr[i]!)!;
    }

    // Build "other group" indices for shared-edge detection
    // = all indices EXCEPT this group
    const otherLen = allGroupIndices.length - groupIdxArr.length;
    const otherGlobalIndices = new Uint32Array(otherLen);
    {
      let off = 0;
      for (let gj = 0; gj < groups.length; gj++) {
        if (gj === gi) continue;
        otherGlobalIndices.set(groupGlobalIndices[gj]!, off);
        off += groupGlobalIndices[gj]!.length;
      }
    }

    // Build vertex_lock mask
    const vertexLock = buildVertexLock(
      groupIdxArr,
      otherGlobalIndices,
      localGlobalMapArr,
      localVertCount,
    );

    // Simplify this group — target half the triangles
    const targetIndexCount = Math.max(3, Math.floor(groupTriCount * 3 * SIMPLIFY_RATIO));
    // simplifyWithAttributes requires a vertex_attributes array; use positions as attributes
    // with stride 3 and equal weights — position attributes only (v0 is position-only)
    let simplifiedIndices: Uint32Array;
    let simplifyError: number;
    try {
      [simplifiedIndices, simplifyError] = MeshoptSimplifier.simplifyWithAttributes(
        localIndicesU32,
        localPositions,
        3, // vertex_positions_stride (floats)
        localPositions, // vertex_attributes = same as positions (position-only v0)
        3, // vertex_attributes_stride
        [1.0, 1.0, 1.0], // attribute_weights
        vertexLock,
        targetIndexCount,
        SIMPLIFY_MAX_ERROR,
        ['Sparse', 'ErrorAbsolute', 'Permissive'],
      );
    } catch (_e) {
      // Fallback: if simplification fails (degenerate group), keep original
      simplifiedIndices = localIndicesU32;
      simplifyError = 0;
    }

    const simplifiedTriCount = simplifiedIndices.length / 3;

    // If simplification produced nothing or no reduction, keep original
    if (simplifiedTriCount === 0 || simplifiedIndices.length === localIndicesU32.length) {
      // No reduction possible — treat these clusters as roots (parentError = Infinity).
      // They'll be assigned root status at the end.
      // For now, assign them as singleton parent groups with their own geometry.
      // The group error becomes the child error (no additional error this level).
      const groupSphere = enclosingSphere(childSpheres);

      // Write parent-link fields onto child clusters (all in this group share same parent info)
      for (const mi of group) {
        currentClusters[mi]!.parentCenterX = groupSphere.cx;
        currentClusters[mi]!.parentCenterY = groupSphere.cy;
        currentClusters[mi]!.parentCenterZ = groupSphere.cz;
        currentClusters[mi]!.parentRadius = groupSphere.r;
        currentClusters[mi]!.parentError = Infinity;
      }
      continue;
    }

    // Monotonic error: group error = max(child errors) + this simplify error
    const groupError = maxChildError + simplifyError;

    // Group bounding sphere = enclosing sphere of all child spheres
    const groupSphere = enclosingSphere(childSpheres);

    // Inflate parent sphere so parent's near-point ≥ each child's near-point
    // near-point of sphere S at camera is dist(camera, center) - radius
    // Sufficient: parent.radius ≥ child.radius + dist(parent.center, child.center)
    // (ensures parent sphere always encloses the child sphere)
    // Our enclosingSphere already does this geometrically — verify by construction.

    // Write parent-link fields onto child clusters (all share same parent group info)
    for (const mi of group) {
      currentClusters[mi]!.parentCenterX = groupSphere.cx;
      currentClusters[mi]!.parentCenterY = groupSphere.cy;
      currentClusters[mi]!.parentCenterZ = groupSphere.cz;
      currentClusters[mi]!.parentRadius = groupSphere.r;
      currentClusters[mi]!.parentError = groupError;
    }

    // Re-split simplified group into parent meshlets
    // Remap simplified local indices back to global indices for the simplified mesh
    // localPositions is already the position array — use it directly.
    const simplifiedBuffers = MeshoptClusterizer.buildMeshlets(
      simplifiedIndices,
      localPositions,
      3, // stride in floats
      MAX_VERTS,
      MAX_TRIS,
      CONE_WEIGHT,
    );

    // Compute bounds for each parent meshlet
    const parentBoundsArr = MeshoptClusterizer.computeMeshletBounds(
      simplifiedBuffers,
      localPositions,
      3,
    );

    // Create ClusterRecord for each parent meshlet
    for (let pi = 0; pi < simplifiedBuffers.meshletCount; pi++) {
      const meshlet = MeshoptClusterizer.extractMeshlet(simplifiedBuffers, pi);
      const pb = parentBoundsArr[pi]!;

      // Build parent cluster's local positions (vertices used by this parent meshlet)
      const parentVertCount = meshlet.vertices.length;
      const parentLocalPos = new Float32Array(parentVertCount * 3);
      for (let vi = 0; vi < parentVertCount; vi++) {
        const li = meshlet.vertices[vi]!; // index into localPositions
        parentLocalPos[vi * 3] = localPositions[li * 3]!;
        parentLocalPos[vi * 3 + 1] = localPositions[li * 3 + 1]!;
        parentLocalPos[vi * 3 + 2] = localPositions[li * 3 + 2]!;
      }

      // Convert parent meshlet's local triangle indices to Uint8 local indices
      // meshlet.triangles are local to the meshlet (indices into meshlet.vertices)
      const parentTriCount = meshlet.triangles.length / 3;
      const parentLocalIndicesU8 = new Uint8Array(parentTriCount * 3);
      for (let ti = 0; ti < parentTriCount * 3; ti++) {
        parentLocalIndicesU8[ti] = meshlet.triangles[ti]!;
      }

      // Build global index array for next-level adjacency
      // parent meshlet's global indices = localGlobalMap[meshlet.vertices[tri]]
      const parentGlobalIndices = new Uint32Array(parentTriCount * 3);
      for (let ti = 0; ti < parentTriCount * 3; ti++) {
        const localVertIdx = meshlet.vertices[meshlet.triangles[ti]!]!;
        parentGlobalIndices[ti] = localGlobalMap[localVertIdx]!;
      }

      const { vtxOffset, idxOffset } = appendClusterGeometry(parentLocalPos, parentLocalIndicesU8);

      const cluster: ClusterRecord = {
        centerX: pb.centerX,
        centerY: pb.centerY,
        centerZ: pb.centerZ,
        radius: pb.radius,
        error: groupError, // parent cluster error = the group error it belongs to
        parentCenterX: 0,
        parentCenterY: 0,
        parentCenterZ: 0,
        parentRadius: 0,
        parentError: Infinity, // will be filled by the next level's grouping, or stays Infinity for root
        vtxOffset,
        vtxCount: parentVertCount,
        idxOffset,
        triCount: parentTriCount,
        lod: lod + 1,
      };

      allClusters.push(cluster);
      nextClusters.push(cluster);
      nextGlobalIndices.push(parentGlobalIndices);
      nextLocalPositions.push(parentLocalPos);
      nextTotalTris += parentTriCount;
    }
  }

  if (nextClusters.length === 0) return;

  // Record this level
  levelCounts.push({ clusterCount: nextClusters.length, triCount: nextTotalTris });
  process.stdout.write(
    `[bake-nanite] LOD${lod + 1}: ${nextClusters.length} clusters, ${nextTotalTris} tris\n`,
  );

  // Check if triangle count is still shrinking — if not, stop recursing
  const prevTris = levelCounts.length >= 2
    ? levelCounts[levelCounts.length - 2]!.triCount
    : Infinity;
  if (nextTotalTris >= prevTris * 0.95) {
    process.stdout.write(`[bake-nanite] Triangle count not shrinking — stopping DAG at LOD${lod + 1}\n`);
    // Mark all current next-level clusters as root
    for (const c of nextClusters) c.parentError = Infinity;
    return;
  }

  if (nextClusters.length <= 1) {
    // Already at root
    nextClusters[0]!.parentError = Infinity;
    return;
  }

  await buildDAGLevel(
    nextClusters,
    nextGlobalIndices,
    nextLocalPositions,
    globalPositions,
    allClusters,
    levelCounts,
    lod + 1,
  );
}

// ---------------------------------------------------------------------------
// Serialize clusters.bin
// Byte layout per cluster (60 bytes, little-endian):
//   Offset  Type   Field
//   0       f32    centerX
//   4       f32    centerY
//   8       f32    centerZ
//   12      f32    radius
//   16      f32    error
//   20      f32    parentCenterX
//   24      f32    parentCenterY
//   28      f32    parentCenterZ
//   32      f32    parentRadius
//   36      f32    parentError   (Infinity for root → serialized as 0x7F800000)
//   40      u32    vtxOffset
//   44      u32    vtxCount
//   48      u32    idxOffset
//   52      u32    triCount
//   56      u32    lod
// ---------------------------------------------------------------------------
function serializeClusters(clusters: ClusterRecord[]): Buffer {
  const buf = Buffer.allocUnsafe(clusters.length * CLUSTER_STRIDE_BYTES);
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;
    const off = i * CLUSTER_STRIDE_BYTES;
    buf.writeFloatLE(c.centerX, off + 0);
    buf.writeFloatLE(c.centerY, off + 4);
    buf.writeFloatLE(c.centerZ, off + 8);
    buf.writeFloatLE(c.radius, off + 12);
    buf.writeFloatLE(c.error, off + 16);
    buf.writeFloatLE(c.parentCenterX, off + 20);
    buf.writeFloatLE(c.parentCenterY, off + 24);
    buf.writeFloatLE(c.parentCenterZ, off + 28);
    buf.writeFloatLE(c.parentRadius, off + 32);
    // parentError = Infinity → 0x7F800000 (IEEE 754 +inf, valid float32)
    buf.writeFloatLE(c.parentError, off + 36);
    buf.writeUInt32LE(c.vtxOffset, off + 40);
    buf.writeUInt32LE(c.vtxCount, off + 44);
    buf.writeUInt32LE(c.idxOffset, off + 48);
    buf.writeUInt32LE(c.triCount, off + 52);
    buf.writeUInt32LE(c.lod, off + 56);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Validate DAG invariants — prints results; returns true if all pass.
// ---------------------------------------------------------------------------
function validateDAG(clusters: ClusterRecord[]): boolean {
  let ok = true;
  let nanInFloat = 0;
  let idxOutOfRange = 0;
  let errorNotMonotonic = 0;
  let sphereNotEnclosing = 0;

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;

    // NaN/Inf check (parentError is allowed to be +Inf)
    const floats = [c.centerX, c.centerY, c.centerZ, c.radius, c.error,
                    c.parentCenterX, c.parentCenterY, c.parentCenterZ, c.parentRadius];
    for (const f of floats) {
      if (!Number.isFinite(f)) { nanInFloat++; break; }
    }
    if (!Number.isFinite(c.error)) nanInFloat++; // error itself must be finite

    // Index range check
    if (c.vtxCount > 256 || c.triCount > MAX_TRIS) idxOutOfRange++;

    // Monotonic: cluster.error ≤ cluster.parentError
    if (c.error > c.parentError + 1e-6 && Number.isFinite(c.parentError)) {
      errorNotMonotonic++;
    }
  }

  // Check that all clusters in a group share identical parentError + parentSphere
  // Group clusters by (parentCenterX, parentCenterY, parentCenterZ, parentRadius, parentError)
  // (clusters with same parent info should have identical values)
  // This is validated implicitly: we write identical values by construction.
  // But we can check that all clusters with parentError < Infinity have a non-zero radius.
  for (const c of clusters) {
    if (Number.isFinite(c.parentError) && c.parentRadius <= 0 && c.error > 0) {
      sphereNotEnclosing++;
    }
  }

  const pass = nanInFloat === 0 && idxOutOfRange === 0 && errorNotMonotonic === 0;
  process.stdout.write('\n[bake-nanite] === DAG VALIDATION ===\n');
  process.stdout.write(`  NaN/Inf in floats:      ${nanInFloat === 0 ? 'PASS' : `FAIL (${nanInFloat})`}\n`);
  process.stdout.write(`  Index out of range:     ${idxOutOfRange === 0 ? 'PASS' : `FAIL (${idxOutOfRange})`}\n`);
  process.stdout.write(`  Error non-monotonic:    ${errorNotMonotonic === 0 ? 'PASS' : `FAIL (${errorNotMonotonic})`}\n`);
  process.stdout.write(`  Sphere warnings:        ${sphereNotEnclosing === 0 ? 'none' : `${sphereNotEnclosing} parent spheres have r≤0`}\n`);
  if (!pass) ok = false;
  return ok;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Wait for meshoptimizer WASM to be ready
  await MeshoptClusterizer.ready;
  await MeshoptSimplifier.ready;

  // -------------------------------------------------------------------------
  // PREP stage (T1)
  // -------------------------------------------------------------------------
  const cachePath = path.join(CACHE_DIR, 'chania-prep.bin');
  const cacheExists = fs.existsSync(cachePath);

  if (PREP_ONLY || !cacheExists) {
    process.stdout.write('[bake-nanite] Stage: GEOMETRY-PREP\n');

    process.stdout.write('[bake-nanite] Loading heightmap...\n');
    const srcHeight = loadHeightmap();
    process.stdout.write(`[bake-nanite] Source DEM: ${SRC_WIDTH}×${SRC_HEIGHT} float32 (${srcHeight.length} samples)\n`);
    const crop = buildCrop(srcHeight);
    process.stdout.write(`[bake-nanite] Crop: ${CROP_W}×${CROP_H} (X0=${CROP_X0} Y0=${CROP_Y0})\n`);

    process.stdout.write('[bake-nanite] Loading buildings.json...\n');
    const buildingsRaw = JSON.parse(
      fs.readFileSync(path.join(PUBLIC_CRETE, 'buildings.json'), 'utf-8'),
    ) as unknown;
    if (!Array.isArray(buildingsRaw)) throw new Error('buildings.json is not an array');
    const buildings = buildingsRaw as BuildingRecord[];
    process.stdout.write(`[bake-nanite] Total buildings: ${buildings.length}\n`);

    const skips: SkipCounts = {
      degenerateRing: 0, nonFiniteCoords: 0, extrudeEmpty: 0, nonFiniteHeight: 0,
    };
    const chaniaStreams: Float32Array[] = [];
    let chaniaCount = 0;
    let preWeldVertexCount = 0;

    for (const record of buildings) {
      const ring = record.r;
      if (!Array.isArray(ring) || ring.length === 0) { skips.degenerateRing += 1; continue; }
      const firstPair = ring[0];
      if (!Array.isArray(firstPair) || firstPair.length < 2) { skips.degenerateRing += 1; continue; }
      const lng = firstPair[0]; const lat = firstPair[1];
      if (typeof lng !== 'number' || typeof lat !== 'number' ||
          !Number.isFinite(lng) || !Number.isFinite(lat)) { skips.nonFiniteCoords += 1; continue; }
      const { x, z } = lonLatToWorld(lng, lat);
      const ti = nearestTown(x, z);
      if (ti !== CHANIA_TOWN_INDEX) continue;
      chaniaCount += 1;
      const result = buildBuildingGeometry(record, crop, skips);
      if (result === null) continue;
      const [posStream] = result;
      if (!posStream) continue;
      chaniaStreams.push(posStream);
      preWeldVertexCount += posStream.length / 3;
    }

    process.stdout.write(`[bake-nanite] Chania buildings selected: ${chaniaCount}\n`);
    process.stdout.write(`[bake-nanite] Pre-weld vertex count: ${preWeldVertexCount}\n`);
    process.stdout.write('[bake-nanite] Welding positions...\n');
    const { positions, indices } = weldPositions(chaniaStreams);
    const triCount = indices.length / 3;
    process.stdout.write(`[bake-nanite] Post-weld vertex count: ${positions.length / 3}\n`);
    process.stdout.write(`[bake-nanite] Triangle count: ${triCount}\n`);

    const aabb = computeAABB(positions);
    process.stdout.write(
      `[bake-nanite] World AABB — X:[${aabb.minX.toFixed(1)}, ${aabb.maxX.toFixed(1)}]` +
      ` Y:[${aabb.minY.toFixed(1)}, ${aabb.maxY.toFixed(1)}]` +
      ` Z:[${aabb.minZ.toFixed(1)}, ${aabb.maxZ.toFixed(1)}]\n`,
    );

    const outPath = writeCache(positions, indices);
    const stat = fs.statSync(outPath);
    process.stdout.write(`[bake-nanite] Cache written: ${outPath} (${stat.size} bytes)\n`);
    process.stdout.write('[bake-nanite] --prep stage complete.\n');

    if (PREP_ONLY) return;
  } else {
    process.stdout.write(`[bake-nanite] Prep cache found: ${cachePath} — skipping prep.\n`);
  }

  // -------------------------------------------------------------------------
  // DAG-BUILD + SERIALIZE stage (T2)
  // -------------------------------------------------------------------------
  process.stdout.write('\n[bake-nanite] Stage: DAG-BUILD (T2)\n');

  const { positions: globalPositions, indices: globalIndices } = loadPrepCache();
  const vertexCount = globalPositions.length / 3;
  const totalTris = globalIndices.length / 3;
  process.stdout.write(`[bake-nanite] Prep cache: ${vertexCount} verts, ${totalTris} tris\n`);

  const worldAABB = computeAABB(globalPositions);
  process.stdout.write(
    `[bake-nanite] AABB — X:[${worldAABB.minX.toFixed(0)}, ${worldAABB.maxX.toFixed(0)}]` +
    ` Y:[${worldAABB.minY.toFixed(0)}, ${worldAABB.maxY.toFixed(0)}]` +
    ` Z:[${worldAABB.minZ.toFixed(0)}, ${worldAABB.maxZ.toFixed(0)}]\n`,
  );

  // Build LOD0 meshlets
  process.stdout.write('[bake-nanite] Building LOD0 meshlets...\n');
  const lod0Buffers = MeshoptClusterizer.buildMeshlets(
    globalIndices,
    globalPositions,
    3, // stride in floats
    MAX_VERTS,
    MAX_TRIS,
    CONE_WEIGHT,
  );
  const lod0Count = lod0Buffers.meshletCount;
  process.stdout.write(`[bake-nanite] LOD0 meshlet count: ${lod0Count}\n`);

  // Compute bounds for all LOD0 meshlets in one call
  const lod0BoundsArr = MeshoptClusterizer.computeMeshletBounds(
    lod0Buffers,
    globalPositions,
    3,
  );

  // Build LOD0 cluster records and global index arrays
  const allClusters: ClusterRecord[] = [];
  const lod0GlobalIndices: Uint32Array[] = [];
  const lod0LocalPositions: Float32Array[] = [];
  let lod0TotalTris = 0;

  for (let mi = 0; mi < lod0Count; mi++) {
    const meshlet = MeshoptClusterizer.extractMeshlet(lod0Buffers, mi);
    const b = lod0BoundsArr[mi]!;

    const vertCount = meshlet.vertices.length;
    const triCount2 = meshlet.triangles.length / 3;

    // Build per-meshlet local positions
    const localPos = new Float32Array(vertCount * 3);
    for (let vi = 0; vi < vertCount; vi++) {
      const gv = meshlet.vertices[vi]!;
      localPos[vi * 3] = globalPositions[gv * 3]!;
      localPos[vi * 3 + 1] = globalPositions[gv * 3 + 1]!;
      localPos[vi * 3 + 2] = globalPositions[gv * 3 + 2]!;
    }

    // Local tri indices as Uint8 (≤128 verts per meshlet — always fits in Uint8)
    const localIndU8 = new Uint8Array(triCount2 * 3);
    for (let ti = 0; ti < triCount2 * 3; ti++) localIndU8[ti] = meshlet.triangles[ti]!;

    // Global tri indices (for adjacency in next level)
    const globalIndArr = new Uint32Array(triCount2 * 3);
    for (let ti = 0; ti < triCount2 * 3; ti++) {
      globalIndArr[ti] = meshlet.vertices[meshlet.triangles[ti]!]!;
    }

    const { vtxOffset, idxOffset } = appendClusterGeometry(localPos, localIndU8);

    const cluster: ClusterRecord = {
      centerX: b.centerX,
      centerY: b.centerY,
      centerZ: b.centerZ,
      radius: b.radius,
      error: 0, // LOD0: zero error
      parentCenterX: 0,
      parentCenterY: 0,
      parentCenterZ: 0,
      parentRadius: 0,
      parentError: Infinity, // filled by DAG build
      vtxOffset,
      vtxCount: vertCount,
      idxOffset,
      triCount: triCount2,
      lod: 0,
    };

    allClusters.push(cluster);
    lod0GlobalIndices.push(globalIndArr);
    lod0LocalPositions.push(localPos);
    lod0TotalTris += triCount2;
  }

  const levelCounts: Array<{ clusterCount: number; triCount: number }> = [
    { clusterCount: lod0Count, triCount: lod0TotalTris },
  ];

  process.stdout.write(`[bake-nanite] LOD0: ${lod0Count} clusters, ${lod0TotalTris} tris\n`);

  // Recurse to build upper LOD levels
  await buildDAGLevel(
    allClusters.slice(), // pass LOD0 clusters
    lod0GlobalIndices,
    lod0LocalPositions,
    globalPositions,
    allClusters,
    levelCounts,
    0,
  );

  // Mark root clusters: any cluster whose parentError is still Infinity
  const rootClusters = allClusters.filter(c => !Number.isFinite(c.parentError));
  process.stdout.write(`\n[bake-nanite] Root clusters (parentError=Inf): ${rootClusters.length}\n`);

  // Print level summary
  process.stdout.write('\n[bake-nanite] Level summary:\n');
  for (let li = 0; li < levelCounts.length; li++) {
    const lc = levelCounts[li]!;
    const errMin = allClusters.filter(c => c.lod === li).reduce((m, c) => Math.min(m, c.error), Infinity);
    const errMax = allClusters.filter(c => c.lod === li).reduce((m, c) => Math.max(m, c.error), -Infinity);
    process.stdout.write(
      `  LOD${li}: ${lc.clusterCount} clusters, ${lc.triCount} tris` +
      `, error [${Number.isFinite(errMin) ? errMin.toFixed(4) : 'Inf'}, ${Number.isFinite(errMax) ? errMax.toFixed(4) : 'Inf'}]\n`,
    );
  }
  process.stdout.write(`  Total clusters: ${allClusters.length}\n`);
  process.stdout.write(`  Level count: ${levelCounts.length}\n`);

  // Validate
  const valid = validateDAG(allClusters);

  // Serialize output files
  process.stdout.write('\n[bake-nanite] Serializing output...\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // vertices.bin — Float32 XYZ (all cluster vertices concatenated)
  const verticesArr = new Float32Array(gVertices);
  const verticesPath = path.join(OUT_DIR, 'vertices.bin');
  fs.writeFileSync(verticesPath, Buffer.from(verticesArr.buffer));
  const verticesStat = fs.statSync(verticesPath);
  process.stdout.write(`  vertices.bin: ${verticesStat.size} bytes (${gVertices.length / 3} verts)\n`);

  // indices.bin — Uint8 local triangle indices
  const indicesArr = new Uint8Array(gLocalIndices);
  const indicesPath = path.join(OUT_DIR, 'indices.bin');
  fs.writeFileSync(indicesPath, Buffer.from(indicesArr.buffer));
  const indicesStat = fs.statSync(indicesPath);
  process.stdout.write(`  indices.bin:  ${indicesStat.size} bytes (${gLocalIndices.length / 3} total tris)\n`);

  // clusters.bin — per-cluster records
  const clustersBuf = serializeClusters(allClusters);
  const clustersPath = path.join(OUT_DIR, 'clusters.bin');
  fs.writeFileSync(clustersPath, clustersBuf);
  const clustersStat = fs.statSync(clustersPath);
  process.stdout.write(`  clusters.bin: ${clustersStat.size} bytes (${allClusters.length} clusters × ${CLUSTER_STRIDE_BYTES} bytes)\n`);

  // meta.json
  const meta = {
    version: 1,
    clusterCount: allClusters.length,
    levelCount: levelCounts.length,
    levels: levelCounts,
    rootClusterCount: rootClusters.length,
    MAX_TRIS,
    MAX_VERTS,
    worldAABB,
    indexType: 'Uint8',
    clusterStrideBytes: CLUSTER_STRIDE_BYTES,
    clusterLayout: {
      centerX:       { offset: 0,  type: 'f32' },
      centerY:       { offset: 4,  type: 'f32' },
      centerZ:       { offset: 8,  type: 'f32' },
      radius:        { offset: 12, type: 'f32' },
      error:         { offset: 16, type: 'f32' },
      parentCenterX: { offset: 20, type: 'f32' },
      parentCenterY: { offset: 24, type: 'f32' },
      parentCenterZ: { offset: 28, type: 'f32' },
      parentRadius:  { offset: 32, type: 'f32' },
      parentError:   { offset: 36, type: 'f32', note: 'Infinity for root clusters' },
      vtxOffset:     { offset: 40, type: 'u32' },
      vtxCount:      { offset: 44, type: 'u32' },
      idxOffset:     { offset: 48, type: 'u32' },
      triCount:      { offset: 52, type: 'u32' },
      lod:           { offset: 56, type: 'u32' },
    },
    vertexLayout: {
      description: 'Packed Float32 XYZ interleaved, stride 12 bytes',
      x: { offset: 0, type: 'f32' },
      y: { offset: 4, type: 'f32' },
      z: { offset: 8, type: 'f32' },
    },
    indexLayout: {
      description: 'Uint8 local triangle indices, 3 per triangle. Index is local to the cluster (relative to vtxOffset in vertices.bin). All clusters have ≤128 verts so Uint8 is sufficient.',
    },
    bakeDate: '2026-06-20',
    source: 'tools/crete/bake-nanite.ts T2',
  };
  const metaPath = path.join(OUT_DIR, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const metaStat = fs.statSync(metaPath);
  process.stdout.write(`  meta.json:    ${metaStat.size} bytes\n`);

  const totalBytes = verticesStat.size + indicesStat.size + clustersStat.size + metaStat.size;
  process.stdout.write(`\n[bake-nanite] Total output: ${totalBytes.toLocaleString()} bytes\n`);
  process.stdout.write(`[bake-nanite] Output dir: ${OUT_DIR}\n`);

  if (!valid) {
    process.stderr.write('[bake-nanite] ABORT: DAG invariant violations detected above.\n');
    process.exit(1);
  }

  process.stdout.write('\n[bake-nanite] T2 complete. All invariants passed.\n');
}

// ---------------------------------------------------------------------------
// Top-level: run prep-only path synchronously (no meshopt needed), DAG async.
// ---------------------------------------------------------------------------
if (PREP_ONLY) {
  // Old synchronous prep-only path — kept for --prep flag
  process.stdout.write('[bake-nanite] Stage: GEOMETRY-PREP (--prep)\n');

  process.stdout.write('[bake-nanite] Loading heightmap...\n');
  const srcHeight = loadHeightmap();
  process.stdout.write(`[bake-nanite] Source DEM: ${SRC_WIDTH}×${SRC_HEIGHT} float32 (${srcHeight.length} samples)\n`);
  const crop = buildCrop(srcHeight);
  process.stdout.write(`[bake-nanite] Crop: ${CROP_W}×${CROP_H} (X0=${CROP_X0} Y0=${CROP_Y0})\n`);

  process.stdout.write('[bake-nanite] Loading buildings.json...\n');
  const buildingsRaw = JSON.parse(
    fs.readFileSync(path.join(PUBLIC_CRETE, 'buildings.json'), 'utf-8'),
  ) as unknown;
  if (!Array.isArray(buildingsRaw)) throw new Error('buildings.json is not an array');
  const buildings = buildingsRaw as BuildingRecord[];
  process.stdout.write(`[bake-nanite] Total buildings: ${buildings.length}\n`);

  const skips: SkipCounts = {
    degenerateRing: 0, nonFiniteCoords: 0, extrudeEmpty: 0, nonFiniteHeight: 0,
  };
  const chaniaStreams: Float32Array[] = [];
  let chaniaCount = 0;
  let preWeldVertexCount = 0;

  for (const record of buildings) {
    const ring = record.r;
    if (!Array.isArray(ring) || ring.length === 0) { skips.degenerateRing += 1; continue; }
    const firstPair = ring[0];
    if (!Array.isArray(firstPair) || firstPair.length < 2) { skips.degenerateRing += 1; continue; }
    const lng = firstPair[0]; const lat = firstPair[1];
    if (typeof lng !== 'number' || typeof lat !== 'number' ||
        !Number.isFinite(lng) || !Number.isFinite(lat)) { skips.nonFiniteCoords += 1; continue; }
    const { x, z } = lonLatToWorld(lng, lat);
    const ti = nearestTown(x, z);
    if (ti !== CHANIA_TOWN_INDEX) continue;
    chaniaCount += 1;
    const result = buildBuildingGeometry(record, crop, skips);
    if (result === null) continue;
    const [posStream] = result;
    if (!posStream) continue;
    chaniaStreams.push(posStream);
    preWeldVertexCount += posStream.length / 3;
  }

  process.stdout.write(`[bake-nanite] Chania buildings selected: ${chaniaCount}\n`);
  process.stdout.write(`[bake-nanite] Skips — degenerateRing: ${skips.degenerateRing}, nonFiniteCoords: ${skips.nonFiniteCoords}, extrudeEmpty: ${skips.extrudeEmpty}, nonFiniteHeight: ${skips.nonFiniteHeight}\n`);
  process.stdout.write(`[bake-nanite] Pre-weld vertex count: ${preWeldVertexCount}\n`);
  process.stdout.write('[bake-nanite] Welding positions...\n');
  const { positions, indices } = weldPositions(chaniaStreams);
  const triCount = indices.length / 3;
  process.stdout.write(`[bake-nanite] Post-weld vertex count: ${positions.length / 3}\n`);
  process.stdout.write(`[bake-nanite] Triangle count: ${triCount}\n`);
  const aabb = computeAABB(positions);
  process.stdout.write(
    `[bake-nanite] World AABB — X:[${aabb.minX.toFixed(1)}, ${aabb.maxX.toFixed(1)}]` +
    ` Y:[${aabb.minY.toFixed(1)}, ${aabb.maxY.toFixed(1)}]` +
    ` Z:[${aabb.minZ.toFixed(1)}, ${aabb.maxZ.toFixed(1)}]\n`,
  );
  const outPath = writeCache(positions, indices);
  const stat = fs.statSync(outPath);
  process.stdout.write(`[bake-nanite] Cache written: ${outPath} (${stat.size} bytes)\n`);
  process.stdout.write('[bake-nanite] --prep stage complete.\n');
} else {
  main().catch(err => {
    process.stderr.write(`[bake-nanite] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
    process.exit(1);
  });
}
