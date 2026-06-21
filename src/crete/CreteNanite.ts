/**
 * CreteNanite.ts — Nanite cluster-LOD loader + GPU storage-buffer setup (T3a)
 *                  + T3b render: LOD0 cluster draw (961 clusters, 1 draw call).
 *
 * STEP T3a: data loading, parsing, and buffer declaration.
 * STEP T3b: buildNaniteChaniaMesh — one indirect indexed-instanced draw for all
 *           LOD0 clusters. GPU cut/cull/compaction is T4; T3b uses a CPU-set
 *           instanceCount=961 so T4 can later overwrite it on the GPU.
 *
 * Binary layout (public/crete/meshlets/chania/):
 *   vertices.bin  — Float32 XYZ packed, stride 12 bytes, 171 837 verts
 *   indices.bin   — Uint8 local triangle indices, 725 622 bytes
 *   clusters.bin  — 1 943 records × 60 bytes (see ClusterRecord below)
 *   meta.json     — version, counts, MAX_TRIS, worldAABB …
 */

import { BufferGeometry, Mesh, Sphere } from 'three';
import {
  IndirectStorageBufferAttribute,
  MeshStandardNodeMaterial,
  StorageBufferAttribute,
} from 'three/webgpu';
import type { StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  float,
  instanceIndex,
  normalFlat,
  select,
  uint,
  vec3,
  vertexIndex,
} from 'three/tsl';
import * as Meshoptimizer from 'meshoptimizer';

// ---------------------------------------------------------------------------
// Cluster stride / offsets — mirrored from meta.json clusterLayout
// ---------------------------------------------------------------------------
const CLUSTER_STRIDE_BYTES = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterRecord {
  /** Bounding-sphere centre (world space) */
  centerX: number;
  centerY: number;
  centerZ: number;
  /** Bounding-sphere radius */
  radius: number;
  /** Cluster projected-error (for LOD selection) */
  error: number;
  /** Parent bounding-sphere centre */
  parentCenterX: number;
  parentCenterY: number;
  parentCenterZ: number;
  /** Parent bounding-sphere radius */
  parentRadius: number;
  /** Parent error — Infinity for root clusters */
  parentError: number;
  /** Absolute vertex offset into positions array (in vertex units, not bytes) */
  vtxOffset: number;
  vtxCount: number;
  /** Byte offset into indices.bin (== u32-array index into indexU32) */
  idxOffset: number;
  triCount: number;
  lod: number;
}

export interface NaniteCounts {
  clusterCount: number;
  lod0Count: number;
  vertexCount: number;
  maxTris: number;
}

export interface NaniteParsed {
  /** Flat Float32 XYZ positions; length == vertexCount * 3 */
  positions: Float32Array;
  /**
   * Expanded index array: each element corresponds to one byte of indices.bin.
   * A cluster's idxOffset (bytes) works directly as the u32-array index.
   * length == 725 622
   */
  indexU32: Uint32Array;
  /** All 1 943 parsed cluster records */
  clusters: ClusterRecord[];
  /**
   * Per lod==0 cluster: [vtxOffset, idxOffset, triCount] packed u32 triples.
   * length == lod0Count * 3 == 961 * 3 == 2 883
   */
  lod0SurvivorData: Uint32Array;
  counts: NaniteCounts;
}

// ---------------------------------------------------------------------------
// GPU handle bundle (returned by createNaniteBuffers; consumed by T3b render)
// ---------------------------------------------------------------------------

export interface NaniteGpuBuffers {
  /** storage node for positions as flat float array (N*3 floats) */
  positionsBuf: StorageBufferNode<'float'>;
  /** storage node for the expanded u32 index array */
  indexBuf: StorageBufferNode<'uint'>;
  /** storage node for lod0SurvivorData u32 triples */
  lod0Buf: StorageBufferNode<'uint'>;
}

// ---------------------------------------------------------------------------
// Pure parse — no fetch, no DOM, no GPU; safe to call from Node
// ---------------------------------------------------------------------------

/**
 * Parse the three raw ArrayBuffers + meta JSON into a NaniteParsed result.
 * This function is intentionally pure so it can be tested headlessly in Node.
 */
export function parseNaniteChania(
  verticesBuf: ArrayBuffer,
  indicesBuf: ArrayBuffer,
  clustersBuf: ArrayBuffer,
  meta: { clusterCount: number; MAX_TRIS: number; levels: Array<{ clusterCount: number }> },
): NaniteParsed {
  // --- positions -----------------------------------------------------------
  const positions = new Float32Array(verticesBuf);
  const vertexCount = positions.length / 3;

  // --- indexU32: expand Uint8 → Uint32 one-for-one -------------------------
  const srcU8 = new Uint8Array(indicesBuf);
  const indexU32 = new Uint32Array(srcU8.length);
  for (let i = 0; i < srcU8.length; i++) {
    indexU32[i] = srcU8[i];
  }

  // --- clusters ------------------------------------------------------------
  const clusterCount = meta.clusterCount;
  const dv = new DataView(clustersBuf);
  const clusters: ClusterRecord[] = new Array(clusterCount);

  let lod0Count = 0;
  for (let c = 0; c < clusterCount; c++) {
    const base = c * CLUSTER_STRIDE_BYTES;
    const rec: ClusterRecord = {
      centerX:      dv.getFloat32(base +  0, true),
      centerY:      dv.getFloat32(base +  4, true),
      centerZ:      dv.getFloat32(base +  8, true),
      radius:       dv.getFloat32(base + 12, true),
      error:        dv.getFloat32(base + 16, true),
      parentCenterX: dv.getFloat32(base + 20, true),
      parentCenterY: dv.getFloat32(base + 24, true),
      parentCenterZ: dv.getFloat32(base + 28, true),
      parentRadius: dv.getFloat32(base + 32, true),
      parentError:  dv.getFloat32(base + 36, true),
      vtxOffset:    dv.getUint32(base + 40, true),
      vtxCount:     dv.getUint32(base + 44, true),
      idxOffset:    dv.getUint32(base + 48, true),
      triCount:     dv.getUint32(base + 52, true),
      lod:          dv.getUint32(base + 56, true),
    };
    clusters[c] = rec;
    if (rec.lod === 0) lod0Count++;
  }

  // --- lod0SurvivorData: 3 u32 per lod==0 cluster -------------------------
  const lod0SurvivorData = new Uint32Array(lod0Count * 3);
  let si = 0;
  for (let c = 0; c < clusterCount; c++) {
    const rec = clusters[c];
    if (rec.lod === 0) {
      lod0SurvivorData[si++] = rec.vtxOffset;
      lod0SurvivorData[si++] = rec.idxOffset;
      lod0SurvivorData[si++] = rec.triCount;
    }
  }

  const counts: NaniteCounts = {
    clusterCount,
    lod0Count,
    vertexCount,
    maxTris: meta.MAX_TRIS,
  };

  return { positions, indexU32, clusters, lod0SurvivorData, counts };
}

// ---------------------------------------------------------------------------
// Async loader — fetches the 4 files then calls parseNaniteChania
// ---------------------------------------------------------------------------

/**
 * Fetch + parse all Chania nanite data.
 * Uses the same parallel-fetch pattern as GavdosData.ts §244-256.
 */
export async function loadNaniteChania(
  baseUrl = '/crete/meshlets/chania/',
): Promise<NaniteParsed> {
  const url = (name: string) => `${baseUrl}${name}`;

  const [metaResp, vertResp, idxResp, clusResp] = await Promise.all([
    fetch(url('meta.json')),
    fetch(url('vertices.bin')),
    fetch(url('indices.bin')),
    fetch(url('clusters.bin')),
  ]);

  const [meta, verticesBuf, indicesBuf, clustersBuf] = await Promise.all([
    metaResp.json() as Promise<{
      clusterCount: number;
      MAX_TRIS: number;
      levels: Array<{ clusterCount: number }>;
    }>,
    vertResp.arrayBuffer(),
    idxResp.arrayBuffer(),
    clusResp.arrayBuffer(),
  ]);

  return parseNaniteChania(verticesBuf, indicesBuf, clustersBuf, meta);
}

// ---------------------------------------------------------------------------
// GPU storage-buffer setup (T3a declaration — consumed by T3b render pass)
// ---------------------------------------------------------------------------

/**
 * Create TSL storage buffers from parsed nanite data.
 * Call after WebGPURenderer is initialised; do NOT call from Node tests.
 *
 * The GPU imports are deferred via dynamic import so this module can be
 * imported headlessly in Node (e.g. parse tests) without pulling in
 * three/webgpu, which requires a browser/GPU environment.
 *
 * Positions: flat float array (N*3 floats) — T3b shader accesses as
 *   positionsBuf.element(vtxOffset*3 + localIdx*3 + axis)
 * IndexBuf: u32 array (one entry per original index byte) — shader indexes as
 *   indexBuf.element(idxOffset + triIdx*3 + corner)
 * Lod0Buf: u32 triples [vtxOffset, idxOffset, triCount] per lod0 cluster
 */
export async function createNaniteBuffers(parsed: NaniteParsed): Promise<NaniteGpuBuffers> {
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { storage } = await import('three/tsl');
  const { positions, indexU32, lod0SurvivorData, counts } = parsed;

  const positionsBuf = storage(
    new StorageBufferAttribute(positions, 1),
    'float',
    counts.vertexCount * 3,
  );

  const indexBuf = storage(
    new StorageBufferAttribute(indexU32, 1),
    'uint',
    indexU32.length,
  );

  const lod0Buf = storage(
    new StorageBufferAttribute(lod0SurvivorData, 1),
    'uint',
    lod0SurvivorData.length,
  );

  return { positionsBuf, indexBuf, lod0Buf };
}

// ---------------------------------------------------------------------------
// T3b — render setup: one indirect indexed-instanced draw for all LOD0 clusters
// ---------------------------------------------------------------------------

/**
 * Maximum triangles per cluster (from meta.json MAX_TRIS = 128).
 * Each "virtual vertex" slot in the dummy index geometry covers one corner of
 * one triangle: MAX_TRIS * 3 = 384 index entries per cluster instance.
 */
const MAX_TRIS = 128;
const VERTS_PER_INSTANCE = MAX_TRIS * 3; // 384

/**
 * Number of LOD0 clusters for Chania.
 * Matches lod0SurvivorData.length / 3 == 961.
 */
const LOD0_COUNT = 961;

/**
 * T3b: build a single THREE.Mesh that issues ONE indirect indexed-instanced
 * draw covering all 961 LOD0 Chania clusters.
 *
 * The mesh uses vertex pulling: the real position is fetched from storage
 * buffers inside positionNode — the geometry's placeholder position attribute
 * is ignored by the GPU. The indirect buffer is CPU-written (instanceCount=961)
 * so T4 can later overwrite it from a compute pass without changing any geometry.
 *
 * @returns The constructed mesh; add it to engine.scene to render.
 */
export async function buildNaniteChaniaMesh(): Promise<Mesh> {
  // ---- fetch + parse + upload to GPU ------------------------------------
  const parsed = await loadNaniteChania();
  const { positionsBuf, indexBuf, lod0Buf } = await createNaniteBuffers(parsed);

  // ---- dummy geometry ---------------------------------------------------
  // Index buffer: [0, 1, 2, …, 383] — one entry per vertex slot per instance.
  // The positionNode ignores these values and computes the actual vertex
  // position from storage buffers using vertexIndex + instanceIndex directly.
  const indexData = new Uint16Array(VERTS_PER_INSTANCE);
  for (let i = 0; i < VERTS_PER_INSTANCE; i++) indexData[i] = i;

  // Use meshoptimizer for vertex cache optimization (perf for high-speed perfectile draws)
  await Meshoptimizer.MeshoptEncoder.ready;
  // reorderMesh(indices: Uint32, triangles, optsize) => [Uint32Array, vertexCount]
  // remap the dummy indices for better post-T&L cache during vertex-pulled nanite
  const idxU32 = new Uint32Array(indexData.length);
  for (let i = 0; i < indexData.length; i++) idxU32[i] = indexData[i] as number;
  const [optIndex] = Meshoptimizer.MeshoptEncoder.reorderMesh(idxU32, true, false);
  if (optIndex && optIndex.length === indexData.length) {
    for (let i = 0; i < optIndex.length; i++) indexData[i] = optIndex[i] as number;
  }

  // Placeholder position attribute — must match index count so three.js doesn't
  // complain about a missing position attribute, but the GPU never reads it
  // (positionNode overrides it completely).
  const posPlaceholder = new Float32Array(VERTS_PER_INSTANCE * 3); // all zeros

  const geo = new BufferGeometry();
  geo.setIndex(Array.from(indexData));
  geo.setAttribute('position', new StorageBufferAttribute(posPlaceholder, 3));

  // ---- indirect buffer --------------------------------------------------
  // WebGPU indirect indexed draw args layout (5× uint32):
  //   [0] indexCount      = VERTS_PER_INSTANCE (384)  — tris per instance × 3
  //   [1] instanceCount   = LOD0_COUNT (961)            — CPU-written; T4 overwrites
  //   [2] firstIndex      = 0
  //   [3] baseVertex      = 0
  //   [4] firstInstance   = 0
  const indirectData = new Uint32Array(5);
  indirectData[0] = VERTS_PER_INSTANCE; // indexCount
  indirectData[1] = LOD0_COUNT;         // instanceCount (CPU-set for T3b)
  indirectData[2] = 0;                  // firstIndex
  indirectData[3] = 0;                  // baseVertex
  indirectData[4] = 0;                  // firstInstance

  const indirectAttr = new IndirectStorageBufferAttribute(indirectData, 5);
  // byteOffset = 0 (single draw, single entry in the indirect buffer)
  geo.setIndirect(indirectAttr, 0);

  // Disable three.js frustum culling — we vertex-pull so the mesh has no real
  // bounding box that three can test. A large bounding sphere ensures it's
  // always considered in-view by the renderer's internal checks.
  geo.boundingSphere = new Sphere(undefined, 1e6);

  // ---- positionNode (TSL vertex puller) ---------------------------------
  // Per vertex:
  //   inst      = instanceIndex  (0..960)
  //   vi        = vertexIndex    (0..383)
  //   tri       = vi / 3         (integer divide)
  //   triCount  = lod0Buf[inst*3 + 2]
  //   If tri >= triCount → emit degenerate (NaN) position so the triangle is
  //   silently discarded by the rasteriser (handles clusters with < 128 tris).
  //   corner    = vi % 3
  //   idxOffset = lod0Buf[inst*3 + 1]
  //   vtxOffset = lod0Buf[inst*3 + 0]
  //   li        = indexBuf[idxOffset + tri*3 + corner]  (local vertex index 0..127)
  //   g         = vtxOffset + li                         (global vertex index)
  //   position  = vec3(positionsBuf[g*3+0], positionsBuf[g*3+1], positionsBuf[g*3+2])
  //
  // Positions are already in fable5 world space — no extra transform.

  const positionNode = Fn(() => {
    const inst = instanceIndex.toVar('inst');
    const vi   = uint(vertexIndex).toVar('vi');

    const base     = inst.mul(3).toVar('base');
    const vtxOff   = uint(lod0Buf.element(base)).toVar('vtxOff');
    const idxOff   = uint(lod0Buf.element(base.add(1))).toVar('idxOff');
    const triCount = uint(lod0Buf.element(base.add(2))).toVar('triCount');

    const tri    = vi.div(3).toVar('tri');
    const corner = vi.mod(3).toVar('corner');

    // Padding slot: tri >= triCount — all corners map to a zero-area point at
    // the origin so the rasteriser silently discards the triangle.
    // Real slot: fetch the global vertex index via the local index buffer, then
    // read XYZ from the flat positions buffer.
    const isPad = tri.greaterThanEqual(triCount);

    // For padding we read slot 0 of this cluster (safe, always valid) and
    // discard by mapping all three corners to the same vertex → zero-area tri.
    const safeTri    = select(isPad, uint(0), tri);
    const safeCorner = select(isPad, uint(0), corner);

    const li = uint(indexBuf.element(idxOff.add(safeTri.mul(3)).add(safeCorner))).toVar('li');
    const g  = select(isPad, vtxOff, vtxOff.add(li)).toVar('g');

    const g3 = g.mul(3);
    const px = float(positionsBuf.element(g3));
    const py = float(positionsBuf.element(g3.add(1)));
    const pz = float(positionsBuf.element(g3.add(2)));

    return vec3(px, py, pz);
  });

  // ---- material ---------------------------------------------------------
  // Cadastre cream — matches CreteBuildings (0.9, 0.88, 0.84, roughness 0.9).
  // normalFlat derives face normals from screen-space derivatives of positionView
  // (built into three/tsl as: positionView.dFdx().cross(positionView.dFdy()).normalize()).
  // This works correctly with vertex-pulled geometry.
  const mat = new MeshStandardNodeMaterial();
  mat.color.setRGB(0.9, 0.88, 0.84);
  mat.roughness = 0.9;
  mat.metalness = 0;
  mat.normalNode = normalFlat;
  mat.positionNode = positionNode();

  // ---- mesh -------------------------------------------------------------
  const mesh = new Mesh(geo, mat);
  mesh.name = 'nanite-chania-lod0';
  mesh.frustumCulled = false; // vertex-pull; three must not cull the whole draw
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  return mesh;
}
