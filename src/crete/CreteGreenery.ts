/**
 * CreteGreenery — real, OSM-placed 3D greenery for the Crete world (WebGPU-safe).
 *
 * Unlike the procedural vegetation system (intentionally ablated for crete in
 * TerrainScene so it doesn't hide the live cadastre orthophoto map), this places
 * SPARSE, REAL, TYPED features exactly where OSM says they are:
 *   - instanced 3D trees inside actual wood + park polygons
 *   - flat translucent water meshes for real inland lakes / reservoirs
 * so the cadastre map underneath stays visible between them.
 *
 * Data: public/crete/greenery.json — an array of { t, r } where:
 *   t = 'wood' | 'park' | 'water'
 *   r = polygon ring of [lng, lat] pairs.
 * Counts (as fetched): wood 1131, park 325, water 814 (2270 total).
 *
 * Pipeline (all done once, asynchronously, after terrain is up):
 *   1. fetch greenery.json.
 *   2. TREES (wood + park): for each polygon, shoelace area (m²) → a target
 *      point count = round(area / spacing). A pre-pass sums the natural count
 *      across all polygons; if it exceeds GLOBAL_TREE_CAP the per-polygon
 *      spacing is scaled up by one shared factor so the final total stays under
 *      the cap (perf). Points are sampled by random rejection inside the
 *      polygon bbox with an even-odd point-in-polygon test. Each accepted land
 *      point (skipping sea, height < SEA_EPS) becomes one instance with random
 *      yaw and per-instance scale jitter. ONE tree geometry (trunk cylinder +
 *      stacked foliage cones, vertex-colored brown/green) → ONE InstancedMesh,
 *      ONE MeshStandardNodeMaterial, ONE draw call.
 *   3. LAKES (water): skip polygons whose area > LAKE_MAX_AREA_M2 (coastal /
 *      lagoon — the ocean handles those) or that touch the world window edge.
 *      Triangulate the remaining rings (ShapeUtils.triangulateShape) into flat
 *      horizontal meshes at y = min(ring terrain height) + LAKE_LIFT, merge
 *      them into ONE mesh with a translucent blue MeshStandardNodeMaterial.
 *   4. Per-frame altitude cull: trees visible below TREES_SHOW_ALT, lakes below
 *      LAKES_SHOW_ALT (mirrors the roads cull pattern).
 *
 * Every polygon's processing is wrapped in try/catch so one bad ring never
 * aborts the batch. Failures are logged, not thrown, so a bad dataset never
 * aborts world boot. Mirrors src/crete/CreteRoads.ts (install/fetch/merge/cull)
 * and src/crete/CreteBuildings.ts (lonLatToWorld + hf.heightAtCpu placement).
 */
import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three';
import { InstancedMesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/Engine';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { lonLatToWorld, CRETE_CROP_HALF } from './CreteConst';

/** Greenery feature kind. */
type GreeneryKind = 'wood' | 'park' | 'water';

/** Raw greenery record as stored in public/crete/greenery.json. */
export interface GreeneryRecord {
  t: GreeneryKind;
  r: number[][]; // ring: [lng, lat] pairs
}

/** A polygon ring already projected to world XZ. */
export type WorldRing = ReadonlyArray<{ x: number; z: number }>;

// --- Tree placement tuning ---------------------------------------------------

/** One tree per this many m² inside dense wood polygons. */
const WOOD_SPACING_M2 = 900;
/** One tree per this many m² inside parks (sparser than wood). */
const PARK_SPACING_M2 = 2_500;
/** Hard upper bound on total tree instances (fps guard). */
const GLOBAL_TREE_CAP = 60_000;
/** Below this sampled ground height (m) a point is treated as sea — no tree. */
const SEA_EPS = 0.5;
/** Per-instance uniform scale jitter range so the canopy isn't uniform. */
const TREE_SCALE_MIN = 0.7;
const TREE_SCALE_MAX = 1.5;
/** Base tree height in world metres at scale 1 (trunk + foliage stack). */
const TREE_BASE_HEIGHT = 9;
/** Show the tree field only below this camera altitude (m) — matches roads. */
const TREES_SHOW_ALT = 25_000;

// --- Lake placement tuning ---------------------------------------------------

/**
 * Skip water polygons larger than this (m²) — those are coastal water / lagoons
 * the ocean surface already handles. ~2 km² as specified.
 */
const LAKE_MAX_AREA_M2 = 2_000_000;
/** Lift the flat lake surface this far above the lowest ring terrain (m). */
const LAKE_LIFT = 0.3;
/** Translucent lake water color (linear RGB). */
const LAKE_RGB: readonly [number, number, number] = [0.04, 0.22, 0.38];
/** Lake surface opacity. */
const LAKE_OPACITY = 0.82;
/** Show lakes only below this camera altitude (m). */
const LAKES_SHOW_ALT = 60_000;
/**
 * A ring "touches the world edge" if any vertex lands within this margin (m) of
 * the ±CRETE_CROP_HALF window boundary — such polygons are clipped by the crop
 * and would render as a straight artificial shoreline, so they're skipped.
 */
const EDGE_MARGIN_M = 200;

/**
 * Deterministic PRNG (mulberry32) so placement is stable across reloads. A fixed
 * seed keeps the forest identical every boot (no shimmering between sessions).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Project a raw [lng,lat] ring to world XZ, dropping malformed / non-finite
 * points and a trailing point that duplicates the first (closed rings).
 * Returns null if fewer than 3 distinct vertices survive.
 */
export function ringToWorld(raw: number[][]): WorldRing | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const pts: Array<{ x: number; z: number }> = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = pair[0];
    const lat = pair[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    pts.push(lonLatToWorld(lng, lat));
  }
  if (pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.z - last.z) < 1e-6) pts.pop();
  }
  if (pts.length < 3) return null;
  return pts;
}

/** Absolute polygon area in m² (shoelace) for a world-XZ ring. */
export function ringAreaM2(ring: WorldRing): number {
  let twice = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

/** Axis-aligned bounding box of a world-XZ ring. */
function ringBounds(ring: WorldRing): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Even-odd point-in-polygon test in the XZ plane. */
function pointInRing(x: number, z: number, ring: WorldRing): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects =
      a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True if any ring vertex lands within EDGE_MARGIN_M of the crop window edge. */
function ringTouchesEdge(ring: WorldRing): boolean {
  const lim = CRETE_CROP_HALF - EDGE_MARGIN_M;
  for (const p of ring) {
    if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) return true;
  }
  return false;
}

/**
 * Build ONE genuine 3D tree geometry: a short brown trunk (cylinder) plus three
 * stacked green foliage cones. Trunk vertices carry a brown vertex color, foliage
 * vertices green, so a single vertex-colored MeshStandardNodeMaterial lights the
 * whole tree in one draw. Centered on XZ with its base at y = 0 so an instance
 * matrix placing the origin on the ground sits the trunk on the terrain.
 *
 * NOT a billboard — real extruded geometry per the repo's "true 3D, never
 * sprites" rule for trees/rocks.
 */
function buildTreeGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Trunk: short cylinder, base at y=0.
  const trunkH = TREE_BASE_HEIGHT * 0.3;
  const trunk = new CylinderGeometry(TREE_BASE_HEIGHT * 0.05, TREE_BASE_HEIGHT * 0.07, trunkH, 6);
  trunk.translate(0, trunkH / 2, 0);
  applyVertexColor(trunk, 0.32, 0.21, 0.11); // brown
  parts.push(trunk);

  // Three stacked foliage cones tapering upward → a layered conifer/broadleaf.
  const foliageColor: readonly [number, number, number] = [0.13, 0.32, 0.1]; // green
  const layers: ReadonlyArray<{ y: number; r: number; h: number }> = [
    { y: trunkH, r: TREE_BASE_HEIGHT * 0.42, h: TREE_BASE_HEIGHT * 0.4 },
    { y: trunkH + TREE_BASE_HEIGHT * 0.28, r: TREE_BASE_HEIGHT * 0.32, h: TREE_BASE_HEIGHT * 0.35 },
    { y: trunkH + TREE_BASE_HEIGHT * 0.52, r: TREE_BASE_HEIGHT * 0.2, h: TREE_BASE_HEIGHT * 0.3 },
  ];
  for (const l of layers) {
    const cone = new ConeGeometry(l.r, l.h, 7);
    cone.translate(0, l.y + l.h / 2, 0);
    applyVertexColor(cone, foliageColor[0], foliageColor[1], foliageColor[2]);
    parts.push(cone);
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) {
    // Extremely unlikely (all parts share attribute layout); fall back to a bare
    // cone so the InstancedMesh always has a valid geometry.
    const fallback = new ConeGeometry(1, TREE_BASE_HEIGHT, 6);
    fallback.translate(0, TREE_BASE_HEIGHT / 2, 0);
    applyVertexColor(fallback, foliageColor[0], foliageColor[1], foliageColor[2]);
    return fallback;
  }
  return merged;
}

/** Attach a flat per-vertex color attribute (linear RGB) to a geometry. */
function applyVertexColor(geo: BufferGeometry, r: number, g: number, b: number): void {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
}

/** A tree placement candidate (world XZ inside a wood/park polygon). */
export interface TreePoint {
  x: number;
  z: number;
}

/**
 * Sample up to `target` land points inside a world-XZ ring by random rejection
 * within its bounding box. Caps the attempt count so a thin/sliver polygon (low
 * fill ratio) can't loop forever. Sea points (ground < SEA_EPS) are rejected.
 */
export function samplePointsInRing(
  ring: WorldRing,
  target: number,
  hf: Heightfield,
  rng: () => number,
  out: TreePoint[],
): void {
  if (target <= 0) return;
  const { minX, maxX, minZ, maxZ } = ringBounds(ring);
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  if (spanX <= 0 || spanZ <= 0) return;
  // Bounded attempts: at most 20 tries per requested point so sparse fills give
  // up gracefully instead of spinning.
  const maxAttempts = target * 20;
  let placed = 0;
  for (let attempt = 0; attempt < maxAttempts && placed < target; attempt += 1) {
    const x = minX + rng() * spanX;
    const z = minZ + rng() * spanZ;
    if (!pointInRing(x, z, ring)) continue;
    if (hf.heightAtCpu(x, z) < SEA_EPS) continue; // trees only on land
    out.push({ x, z });
    placed += 1;
  }
}

/**
 * Triangulate a world-XZ ring into a flat horizontal BufferGeometry at constant
 * y. Returns null if triangulation fails or produces no triangles.
 */
function buildLakeGeometry(ring: WorldRing, y: number): BufferGeometry | null {
  // ShapeUtils.triangulateShape works in 2D (x,y). Map world (x,z) → (x, z).
  const contour = ring.map((p) => new Vector2(p.x, p.z));
  const faces = ShapeUtils.triangulateShape(contour, []);
  if (faces.length === 0) return null;

  const positions = new Float32Array(ring.length * 3);
  for (let i = 0; i < ring.length; i += 1) {
    positions[i * 3 + 0] = ring[i]!.x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = ring[i]!.z;
  }

  // ShapeUtils winds CCW in (x,y); after mapping y→z and viewing from +Y the
  // winding flips, so reverse each triangle to face up (+Y).
  const indices: number[] = [];
  for (const f of faces) {
    const a = f[0]!;
    const b = f[1]!;
    const c = f[2]!;
    indices.push(a, c, b);
  }
  if (indices.length === 0) return null;

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Lowest sampled terrain height across a ring's vertices (m, clamped ≥ 0). */
function minRingHeight(ring: WorldRing, hf: Heightfield): number {
  let min = Infinity;
  for (const p of ring) {
    const h = hf.heightAtCpu(p.x, p.z);
    if (h < min) min = h;
  }
  return Math.max(0, min === Infinity ? 0 : min);
}

/**
 * Install OSM-placed Crete greenery (instanced trees + flat lakes).
 * No-op unless params.world === 'crete'.
 *
 * Fetches greenery.json, builds the tree InstancedMesh and the merged lake mesh
 * asynchronously, and wires a per-frame altitude cull for each. Failures are
 * logged, not thrown, so a bad dataset never aborts world boot.
 */
export function installCreteGreenery(
  engine: Engine,
  hf: Heightfield,
  params: LaasParams,
  opts: { trees?: boolean } = {},
): void {
  if (params.world !== 'crete') return;
  // When the Forests procedural-veg pipeline (CreteScatter) renders the real 3D
  // LOD trees, skip these simple cone trees so the two never double up. Lakes
  // always render. Defaults to true to preserve standalone behaviour.
  const renderTrees = opts.trees !== false;

  // Filled in once the async builds complete; the culls no-op until then.
  let treeMesh: InstancedMesh | null = null;
  let lakeMesh: Mesh | null = null;

  fetch('/crete/greenery.json')
    .then((r) => {
      if (!r.ok) throw new Error(`greenery.json HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    })
    .then((data: unknown) => {
      if (!Array.isArray(data)) throw new Error('greenery.json is not an array');

      // --- Partition + project rings once -----------------------------------
      // Each tree polygon keeps its world ring and spacing; lakes are handled
      // separately below.
      interface TreePoly {
        ring: WorldRing;
        spacing: number;
      }
      const treePolys: TreePoly[] = [];
      const waterRings: WorldRing[] = [];
      let naturalTreeCount = 0;

      for (const raw of data) {
        try {
          const record = raw as GreeneryRecord;
          const kind = record.t;
          const ring = ringToWorld(record.r);
          if (!ring) continue;

          if (kind === 'wood' || kind === 'park') {
            const spacing = kind === 'wood' ? WOOD_SPACING_M2 : PARK_SPACING_M2;
            const area = ringAreaM2(ring);
            const count = Math.round(area / spacing);
            if (count <= 0) continue;
            naturalTreeCount += count;
            treePolys.push({ ring, spacing });
          } else if (kind === 'water') {
            waterRings.push(ring);
          }
          // Unknown kinds are silently ignored (forward-compatible with new t's).
        } catch (e) {
          console.warn('[crete] greenery: bad record skipped', e);
        }
      }

      // --- Trees (simple cone fallback) -------------------------------------
      // Gated: skipped when the Forests pipeline (CreteScatter) renders the real
      // 3D LOD trees, so the two systems never double up.
      if (renderTrees) {
        // If the natural count exceeds the cap, scale every polygon's spacing up
        // by one shared factor so the final total stays under GLOBAL_TREE_CAP
        // (proportional thinning — denser woods still get more trees).
        const capScale =
          naturalTreeCount > GLOBAL_TREE_CAP ? naturalTreeCount / GLOBAL_TREE_CAP : 1;

        const treePoints: TreePoint[] = [];
        const rng = makeRng(0x0c12e7e); // fixed seed → stable placement across reloads
        let woodCount = 0;
        for (const poly of treePolys) {
          try {
            const area = ringAreaM2(poly.ring);
            const effectiveSpacing = poly.spacing * capScale;
            const target = Math.round(area / effectiveSpacing);
            const before = treePoints.length;
            samplePointsInRing(poly.ring, target, hf, rng, treePoints);
            if (treePoints.length > before) woodCount += 1;
          } catch (e) {
            console.warn('[crete] greenery: tree polygon failed; skipping', e);
          }
          if (treePoints.length >= GLOBAL_TREE_CAP) break; // hard stop at the cap
        }

        if (treePoints.length > 0) {
          const treeGeo = buildTreeGeometry();
          const treeMat = new MeshStandardNodeMaterial();
          treeMat.vertexColors = true; // trunk brown + foliage green baked per-vertex
          treeMat.roughness = 0.9;
          treeMat.metalness = 0;

          const mesh = new InstancedMesh(treeGeo, treeMat, treePoints.length);
          mesh.name = 'crete-greenery-trees';
          mesh.castShadow = false; // perf: skip shadow pass for the canopy
          mesh.receiveShadow = false;
          mesh.frustumCulled = true;

          const m = new Matrix4();
          const q = new Quaternion();
          const pos = new Vector3();
          const scl = new Vector3();
          const up = new Vector3(0, 1, 0);
          for (let i = 0; i < treePoints.length; i += 1) {
            const p = treePoints[i]!;
            const y = Math.max(0, hf.heightAtCpu(p.x, p.z));
            const s = TREE_SCALE_MIN + rng() * (TREE_SCALE_MAX - TREE_SCALE_MIN);
            q.setFromAxisAngle(up, rng() * Math.PI * 2);
            pos.set(p.x, y, p.z);
            scl.set(s, s, s);
            m.compose(pos, q, scl);
            mesh.setMatrixAt(i, m);
          }
          mesh.instanceMatrix.needsUpdate = true;
          // Start hidden if we boot at the overview; the per-frame cull corrects it.
          mesh.visible = engine.camera.position.y < TREES_SHOW_ALT;
          engine.scene.add(mesh);
          treeMesh = mesh;
        }
        console.log(
          `[crete] greenery: ${treePoints.length} cone trees in ${woodCount} woods/parks` +
            (capScale > 1 ? ` (thinned ${naturalTreeCount}→cap ${GLOBAL_TREE_CAP})` : ''),
        );
      }

      // --- Lakes -------------------------------------------------------------
      const lakeGeos: BufferGeometry[] = [];
      let lakeCount = 0;
      for (const ring of waterRings) {
        try {
          const area = ringAreaM2(ring);
          if (area > LAKE_MAX_AREA_M2) continue; // coastal/lagoon → ocean handles it
          if (ringTouchesEdge(ring)) continue; // clipped by crop → would look fake
          const y = minRingHeight(ring, hf) + LAKE_LIFT;
          const geo = buildLakeGeometry(ring, y);
          if (!geo) continue;
          lakeGeos.push(geo);
          lakeCount += 1;
        } catch (e) {
          console.warn('[crete] greenery: lake polygon failed; skipping', e);
        }
      }

      if (lakeGeos.length > 0) {
        const merged = mergeGeometries(lakeGeos, false);
        for (const g of lakeGeos) g.dispose();
        if (merged) {
          const lakeMat = new MeshStandardNodeMaterial();
          lakeMat.color.setRGB(LAKE_RGB[0], LAKE_RGB[1], LAKE_RGB[2]);
          lakeMat.roughness = 0.1;
          lakeMat.metalness = 0;
          lakeMat.transparent = true;
          lakeMat.opacity = LAKE_OPACITY;

          const mesh = new Mesh(merged, lakeMat);
          mesh.name = 'crete-greenery-lakes';
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = true;
          mesh.visible = engine.camera.position.y < LAKES_SHOW_ALT;
          engine.scene.add(mesh);
          lakeMesh = mesh;
        } else {
          console.warn(`[crete] greenery: mergeGeometries returned null for ${lakeGeos.length} lakes`);
        }
      }

      console.log(`[crete] greenery: ${lakeCount} lakes`);
    })
    .catch((e) => console.warn('[crete] greenery.json load failed', e));

  // Per-frame altitude cull. Cheap: two comparisons per frame.
  const cam = engine.camera;
  engine.onUpdate(() => {
    if (treeMesh !== null) treeMesh.visible = cam.position.y < TREES_SHOW_ALT;
    if (lakeMesh !== null) lakeMesh.visible = cam.position.y < LAKES_SHOW_ALT;
  });
}
