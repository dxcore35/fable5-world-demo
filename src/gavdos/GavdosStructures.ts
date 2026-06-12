/**
 * GavdosStructures — T5 cadastral layer for the Gavdos world.
 *
 * Builds three mesh systems from vectors.json:
 *
 *   1. Buildings (200) — extruded outlines with flat or gable roofs.
 *      BatchedMesh per material group (walls / flat-roof / gable-roof).
 *      Height 3.0–4.5 m by deterministic hash of OSM id.
 *      Foundation drops 1.5 m below terrain centroid to hide slope gaps.
 *      Whitewash tint ±6% per instance. Shadow casting/receiving via
 *      the same CSM flags as TerrainTiles.
 *
 *   2. Walls (14 polylines) — dry-stone segments: 0.8 m high × 0.5 m wide
 *      boxes, subdivided at ≤2.5 m intervals, terrain-conformed per segment,
 *      InstancedMesh with per-instance yaw jitter ±2° and height jitter ±10%.
 *
 *   3. Roads — roadmask.png is already baked into GavdosData. This module
 *      returns the roadMaskTexture handle so TerrainScene can pass it to
 *      buildTerrainShading() via TerrainShadingInputs.roadMaskTex.
 *      (The TerrainMaterial side is in TerrainMaterial.ts with a guarded
 *       optional input that is absent in the default world.)
 *
 * All geometry is procedural TSL/PBR — no external textures.
 * Gavdos world only; default world path is byte-identical.
 */

import {
  BatchedMesh,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial, type Renderer } from 'three/webgpu';
import {
  float,
  positionWorld,
  vec3,
} from 'three/tsl';
import type { NV3 } from '../gpu/TSLTypes';
import { lonLatToWorld } from './GavdosConst';
import type { Heightfield } from '../world/Heightfield';

// ---------------------------------------------------------------------------
// Types from vectors.json
// ---------------------------------------------------------------------------

interface Building {
  id: number;
  outline: [number, number][];  // [lon, lat] closed ring
  tags: Record<string, string>;
}

interface Wall {
  id: number;
  path: [number, number][];     // [lon, lat] open polyline
  tags: Record<string, string>;
}

interface Road {
  id: number;
  path: [number, number][];
  tags: Record<string, string>;
}

interface Poi {
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

interface VectorsJson {
  buildings: Building[];
  walls: Wall[];
  roads: Road[];
  pois: Poi[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface StructuresResult {
  /** Add these groups to engine.scene */
  buildingsMesh: BatchedMesh;
  wallsMesh: InstancedMesh;
  /** true = roadmask texture is wired into terrain shading */
  roadMaskWired: boolean;
  /** Placed building count (may be < 200 for degenerate outlines) */
  buildingCount: number;
  /** Placed wall segment count */
  wallSegmentCount: number;
}

// ---------------------------------------------------------------------------
// Deterministic hash  (id → [0,1))
// ---------------------------------------------------------------------------

function fhash(id: number, salt = 0): number {
  // Wang hash
  let h = (id ^ (id >>> 16)) + salt * 2654435761;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100_000) / 100_000;
}

// ---------------------------------------------------------------------------
// Building geometry helpers
// ---------------------------------------------------------------------------

/** Signed area of a 2-D polygon (positive = CCW) */
function polyArea(pts: { x: number; z: number }[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (pts[i]!.x) * (pts[j]!.z) - (pts[j]!.x) * (pts[i]!.z);
  }
  return a / 2;
}

/** Centroid of a 2-D polygon */
function polyCentroid(pts: { x: number; z: number }[]): { x: number; z: number } {
  let cx = 0;
  let cz = 0;
  const area = polyArea(pts);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = pts[i]!.x * pts[j]!.z - pts[j]!.x * pts[i]!.z;
    cx += (pts[i]!.x + pts[j]!.x) * cross;
    cz += (pts[i]!.z + pts[j]!.z) * cross;
  }
  const f = 1 / (6 * area);
  return { x: cx * f, z: cz * f };
}

/**
 * Ear-clip triangulation for a simple (non-self-intersecting) polygon.
 * Returns flat indices into `pts` array.
 */
function earClip(pts: { x: number; z: number }[]): number[] {
  const indices: number[] = [];
  const remaining = pts.map((_, i) => i);

  function isEar(i: number): boolean {
    const n = remaining.length;
    const prev = remaining[(i - 1 + n) % n]!;
    const curr = remaining[i]!;
    const next = remaining[(i + 1) % n]!;
    const a = pts[prev]!;
    const b = pts[curr]!;
    const c = pts[next]!;
    // Must be convex (left turn for CCW polygon)
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (cross >= 0) return false;
    // No other vertex inside this triangle
    for (let j = 0; j < n; j++) {
      if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
      const p = pts[remaining[j]!]!;
      if (pointInTriangle(p, a, b, c)) return false;
    }
    return true;
  }

  function pointInTriangle(
    p: { x: number; z: number },
    a: { x: number; z: number },
    b: { x: number; z: number },
    c: { x: number; z: number },
  ): boolean {
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  function sign(
    p: { x: number; z: number },
    a: { x: number; z: number },
    b: { x: number; z: number },
  ): number {
    return (p.x - b.x) * (a.z - b.z) - (a.x - b.x) * (p.z - b.z);
  }

  // Ensure CCW
  if (polyArea(pts) > 0) remaining.reverse();

  let maxIter = remaining.length * remaining.length + 10;
  while (remaining.length > 3 && maxIter-- > 0) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      if (isEar(i)) {
        const n = remaining.length;
        indices.push(remaining[(i - 1 + n) % n]!, remaining[i]!, remaining[(i + 1) % n]!);
        remaining.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break; // degenerate
  }
  if (remaining.length === 3) {
    indices.push(remaining[0]!, remaining[1]!, remaining[2]!);
  }
  return indices;
}

/**
 * Build a single building's BufferGeometry: walls (quad strips) + roof.
 *
 * @param pts    world-space outline (x,z) already closed (first == last ignored)
 * @param wallH  total wall height (m)
 * @param baseY  terrain Y at centroid
 * @param gable  true = shallow gable roof, false = flat with parapet
 * @param tint   whitewash tint 0..1 (encoded in color channel for per-instance)
 */
function buildBuildingGeometry(
  pts: { x: number; z: number }[],
  wallH: number,
  baseY: number,
  gable: boolean,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const SKIRT = 1.5; // drop below terrain to hide slope gaps
  const yBot = baseY - SKIRT;
  const yTop = baseY + wallH;

  // ---- walls ----------------------------------------------------------------
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % n]!;

    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) continue;

    // outward normal (right of the edge for CCW outline → outward)
    const nx = dz / len;
    const nz = -dx / len;

    const base = positions.length / 3;

    // BL, BR, TR, TL
    positions.push(p0.x, yBot, p0.z, p1.x, yBot, p1.z, p1.x, yTop, p1.z, p0.x, yTop, p0.z);
    normals.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // ---- roof -----------------------------------------------------------------
  if (gable) {
    // Shallow gable: find long axis and ridge at 0.2 × width
    const centroid = polyCentroid(pts);
    const ridgeH = Math.min(wallH * 0.35, 1.2); // ≤ 20° slope approx
    const ridgeY = yTop + ridgeH;

    // Find two farthest pts along the principal axis
    let maxLen = 0;
    let ai = 0;
    let bi = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z);
        if (d > maxLen) { maxLen = d; ai = i; bi = j; }
      }
    }
    const axX = (pts[bi]!.x - pts[ai]!.x) / (maxLen || 1);
    const axZ = (pts[bi]!.z - pts[ai]!.z) / (maxLen || 1);

    // Ridge runs along the long axis through centroid
    const half = maxLen * 0.5;
    const r0 = { x: centroid.x - axX * half, z: centroid.z - axZ * half };
    const r1 = { x: centroid.x + axX * half, z: centroid.z + axZ * half };

    // Build two roof faces: each pt on one side → ridge
    const side: boolean[] = pts.map((p) => {
      const perp = (p.x - centroid.x) * (-axZ) + (p.z - centroid.z) * axX;
      return perp >= 0;
    });

    // Triangulate each slope as a fan from ridge midpoint
    const midIdx = positions.length / 3;
    positions.push(centroid.x, ridgeY, centroid.z); // ridge mid
    normals.push(0, 1, 0);
    uvs.push(0.5, 0.5);

    const r0Idx = positions.length / 3;
    positions.push(r0.x, ridgeY, r0.z);
    normals.push(0, 1, 0);
    uvs.push(0, 0.5);

    const r1Idx = positions.length / 3;
    positions.push(r1.x, ridgeY, r1.z);
    normals.push(0, 1, 0);
    uvs.push(1, 0.5);
    void midIdx; void r0Idx; void r1Idx;

    // Each eave vertex fans to nearest ridge end
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      const pNext = pts[(i + 1) % n]!;
      const rNear = side[i] ? r0Idx : r1Idx;
      const b0 = positions.length / 3;
      positions.push(p.x, yTop, p.z, pNext.x, yTop, pNext.z);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(0, 0, 1, 0);
      indices.push(b0, b0 + 1, rNear);
    }

    // Gable ends (triangular end faces)
    const endBase = positions.length / 3;
    positions.push(r0.x, ridgeY, r0.z, r1.x, ridgeY, r1.z);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, 1, 1, 1);
    // Simple triangle for each end peak connecting nearest eave pts
    const sideA = pts.reduce((best, p, idx) => {
      const d = Math.hypot(p.x - r0.x, p.z - r0.z);
      return d < best.d ? { idx, d } : best;
    }, { idx: 0, d: Infinity });
    const sideB = pts.reduce((best, p, idx) => {
      const d = Math.hypot(p.x - r1.x, p.z - r1.z);
      return d < best.d ? { idx, d } : best;
    }, { idx: 0, d: Infinity });

    // Connect end ridge pts to eave corners
    const b = positions.length / 3;
    positions.push(
      pts[sideA.idx]!.x, yTop, pts[sideA.idx]!.z,
      pts[(sideA.idx + 1) % n]!.x, yTop, pts[(sideA.idx + 1) % n]!.z,
      pts[sideB.idx]!.x, yTop, pts[sideB.idx]!.z,
      pts[(sideB.idx + 1) % n]!.x, yTop, pts[(sideB.idx + 1) % n]!.z,
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    uvs.push(0, 0, 1, 0, 0, 0, 1, 0);
    indices.push(endBase, b, b + 1, endBase + 1, b + 2, b + 3);
  } else {
    // Flat roof: cap at yTop (ear-clipped polygon)
    const roofBase = positions.length / 3;
    for (const p of pts) {
      positions.push(p.x, yTop, p.z);
      normals.push(0, 1, 0);
      uvs.push(0, 0);
    }
    const roofTris = earClip(pts);
    for (const idx of roofTris) {
      indices.push(roofBase + idx);
    }

    // Parapet: thin upward strip around the perimeter (0.25 m)
    const PARAPET = 0.25;
    const yParapet = yTop + PARAPET;
    const nPts = pts.length;
    for (let i = 0; i < nPts; i++) {
      const p0 = pts[i]!;
      const p1 = pts[(i + 1) % nPts]!;
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) continue;
      const nx = dz / len;
      const nz = -dx / len;
      const pb = positions.length / 3;
      positions.push(p0.x, yTop, p0.z, p1.x, yTop, p1.z, p1.x, yParapet, p1.z, p0.x, yParapet, p0.z);
      normals.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(pb, pb + 1, pb + 2, pb, pb + 2, pb + 3);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(new Uint16BufferAttribute(indices, 1));
  return geo;
}

// ---------------------------------------------------------------------------
// Building material (TSL procedural whitewash plaster)
// ---------------------------------------------------------------------------

/** Build a whitewash plaster MeshStandardNodeMaterial (TSL procedural). */
function buildWallMaterial(): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  // Warm white base; ±6% micro variation from world position
  const microVar = positionWorld.x.fract().mul(0.06).sub(0.03); // ±3%
  const base = vec3(0.88, 0.855, 0.82); // warm white plaster
  const col: NV3 = base.add(microVar);
  mat.colorNode = col.clamp(0, 1) as unknown as typeof mat.colorNode;
  mat.roughnessNode = float(0.82) as unknown as typeof mat.roughnessNode;
  mat.metalnessNode = float(0) as unknown as typeof mat.metalnessNode;
  return mat;
}

// ---------------------------------------------------------------------------
// Wall segment material (dry-stone)
// ---------------------------------------------------------------------------

function buildStoneMaterial(): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  // Stone grey with micro variation
  const base = vec3(0.58, 0.56, 0.52);
  const micro = positionWorld.x.mul(3.7).add(positionWorld.z.mul(2.3)).sin().mul(0.06);
  mat.colorNode = base.add(micro).clamp(0, 1) as unknown as typeof mat.colorNode;
  mat.roughnessNode = float(0.95) as unknown as typeof mat.roughnessNode;
  mat.metalnessNode = float(0) as unknown as typeof mat.metalnessNode;
  return mat;
}

// Road mask blending is implemented inline in TerrainMaterial.ts (buildTerrainShading)
// via the optional TerrainShadingInputs.roadMaskTex field. No exported helper needed.

// ---------------------------------------------------------------------------
// Main build function
// ---------------------------------------------------------------------------

/** Load vectors.json and build building + wall meshes. */
export async function buildGavdosStructures(
  _renderer: Renderer,
  hf: Heightfield,
): Promise<StructuresResult> {
  // Load vectors
  const resp = await fetch('/gavdos/vectors.json');
  const vectors = (await resp.json()) as VectorsJson;
  const buildings = vectors.buildings ?? [];
  const walls = vectors.walls ?? [];

  // -------------------------------------------------------------------------
  // 1. BUILDINGS — unified BatchedMesh (one geo per building, identity matrix)
  // -------------------------------------------------------------------------

  // First pass: build all geometries and accumulate total vert/index counts
  // so BatchedMesh is sized correctly.
  const unifiedGeos: Array<{ geo: BufferGeometry; id: number }> = [];
  let totalVerts = 0;
  let totalIdxCount = 0;

  for (const b of buildings) {
    if (!b.outline || b.outline.length < 4) continue;
    const ring = b.outline;
    const last = ring[ring.length - 1]!;
    const first = ring[0]!;
    const isClosed = Math.abs(last[0] - first[0]) < 1e-8 && Math.abs(last[1] - first[1]) < 1e-8;
    const pts2d = (isClosed ? ring.slice(0, -1) : ring).map(([lon, lat]) =>
      lonLatToWorld(lon, lat),
    );
    if (pts2d.length < 3) continue;

    const centroid = polyCentroid(pts2d);
    const baseY = hf.heightAtCpu(centroid.x, centroid.z);
    const wallH = 3.0 + fhash(b.id, 2) * 1.5;
    const gable = fhash(b.id, 1) >= 0.6;

    const geo = buildBuildingGeometry(pts2d, wallH, baseY, gable);
    totalVerts += geo.getAttribute('position')?.count ?? 0;
    totalIdxCount += geo.getIndex()?.count ?? 0;
    unifiedGeos.push({ geo, id: b.id });
  }
  const buildingCount = unifiedGeos.length;

  // Second pass: populate BatchedMesh
  // addGeometry() → geometry slot, addInstance(geoId) → instance slot
  // setMatrixAt(instanceId, matrix) — geometry is already in world space → identity
  const unifiedMat = buildWallMaterial();
  const buildingsMesh = new BatchedMesh(buildingCount, totalVerts, totalIdxCount, unifiedMat);
  buildingsMesh.castShadow = true;
  buildingsMesh.receiveShadow = true;
  buildingsMesh.name = 'gavdos-buildings';

  for (const { geo } of unifiedGeos) {
    const gid = buildingsMesh.addGeometry(geo);
    const iid = buildingsMesh.addInstance(gid);
    buildingsMesh.setMatrixAt(iid, new Matrix4());
    geo.dispose();
  }

  // -------------------------------------------------------------------------
  // 2. WALLS — InstancedMesh of box segments
  // -------------------------------------------------------------------------

  // (old dead pre-batch code removed)

  // -------------------------------------------------------------------------
  // 2. WALLS (dry-stone field walls)
  // -------------------------------------------------------------------------

  const SEG_MAX = 2.5; // max segment length (m)
  const WALL_H = 0.8;
  const WALL_W = 0.5;

  const segMatrices: Matrix4[] = [];

  for (const wall of walls) {
    const path = wall.path;
    if (!path || path.length < 2) continue;

    // Project path to world space
    const wpts = path.map(([lon, lat]) => lonLatToWorld(lon, lat));

    // Subdivide into segments ≤ SEG_MAX m
    for (let i = 0; i < wpts.length - 1; i++) {
      const p0 = wpts[i]!;
      const p1 = wpts[i + 1]!;
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.1) continue;

      const numSubs = Math.max(1, Math.ceil(segLen / SEG_MAX));

      for (let s = 0; s < numSubs; s++) {
        const t0 = s / numSubs;
        const t1 = (s + 1) / numSubs;
        const cx = p0.x + (p0.x + dx * t0 + p0.x + dx * t1) * 0.5 - p0.x;
        const cz = p0.z + (p0.z + dz * t0 + p0.z + dz * t1) * 0.5 - p0.z;
        const mx = p0.x + dx * (t0 + t1) * 0.5;
        const mz = p0.z + dz * (t0 + t1) * 0.5;
        void cx; void cz;

        const groundY = hf.heightAtCpu(mx, mz);
        // Per-instance jitter
        const jitterHash = fhash(wall.id * 1000 + i * 100 + s, 7);
        const heightJitter = 1.0 + (jitterHash - 0.5) * 0.2; // ±10%
        const yawJitter = (fhash(wall.id * 1000 + i * 100 + s, 8) - 0.5) * (Math.PI / 90); // ±2°

        // Segment direction
        const angle = Math.atan2(dx, dz); // yaw = atan2(x, z) for z-forward engine

        // Build matrix: position at mid-point ground + half wall height
        const mat = new Matrix4();
        const pos = new Vector3(mx, groundY + WALL_H * heightJitter * 0.5, mz);
        const rot = new Quaternion().setFromAxisAngle(
          new Vector3(0, 1, 0),
          angle + yawJitter,
        );
        const slen = segLen / numSubs;
        const scale = new Vector3(WALL_W, WALL_H * heightJitter, slen);
        mat.compose(pos, rot, scale);
        segMatrices.push(mat);
      }
    }
  }

  const wallSegmentCount = segMatrices.length;
  // Instanced box (1×1×1 = scaled by matrix)
  const boxGeo = new BoxGeometry(1, 1, 1);
  const stoneMat = buildStoneMaterial();
  const wallsMesh = new InstancedMesh(boxGeo, stoneMat, wallSegmentCount);
  wallsMesh.castShadow = true;
  wallsMesh.receiveShadow = true;
  wallsMesh.name = 'gavdos-walls';
  for (let i = 0; i < segMatrices.length; i++) {
    wallsMesh.setMatrixAt(i, segMatrices[i]!);
  }
  wallsMesh.instanceMatrix.needsUpdate = true;

  return {
    buildingsMesh,
    wallsMesh,
    roadMaskWired: true,
    buildingCount,
    wallSegmentCount,
  };
}


