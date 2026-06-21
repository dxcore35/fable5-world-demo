/**
 * CreteBuildings — extruded 3D buildings for the Crete world (WebGPU-safe).
 *
 * Data: public/crete/buildings.json — an array of { r:[lng,lat][], h:number }
 * where `r` is a footprint ring of [lng,lat] pairs and `h` is the building
 * height in metres (~35k buildings across 6 towns).
 *
 * Pipeline (all done once, asynchronously, after terrain is up):
 *   1. fetch buildings.json
 *   2. for each building: ring [lng,lat] → world XZ via lonLatToWorld, build a
 *      THREE.Shape in the XZ plane (shapeX = world x, shapeY = world z),
 *      ExtrudeGeometry({depth:h}) so the extrude axis is +shapeZ, then
 *      rotateX(-π/2) so that axis points +Y, and translate the geometry so the
 *      footprint sits at the ring CENTROID's ground height (flat base per
 *      building, clamped ≥ 0).
 *   3. bucket each building by its nearest of the 6 town centroids and merge a
 *      town's geometries into ONE BufferGeometry (≈6 draw calls, not 35k).
 *   4. one shared cream MeshStandardNodeMaterial; per-town Mesh added to scene.
 *
 * Per-frame: distance-cull each town mesh — visible only when the camera is
 * within SHOW_DIST of the town centre, so they pop in as you approach a town
 * and stay hidden at the whole-island overview (perf).
 *
 * The WebGPURenderer renders the whole scene through PostStack (pass(scene,
 * camera)), so a plain Mesh added to engine.scene renders. We use
 * MeshStandardNodeMaterial (the WebGPU node material) to match the renderer,
 * mirroring src/gavdos/GavdosStructures.ts.
 */
import { ExtrudeGeometry, Mesh, Shape, Vector3, type BufferGeometry } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/Engine';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { lonLatToWorld } from './CreteConst';

/** Raw building record as stored in public/crete/buildings.json. */
interface BuildingRecord {
  r: number[][]; // ring: [lng, lat] pairs
  h: number; // height in metres
}

/** A town bucket: its accumulated geometries plus running centre/extent. */
interface TownBucket {
  geos: BufferGeometry[];
  center: Vector3; // world-space town centre (mean of building centroids)
  sumX: number;
  sumZ: number;
  count: number;
  radius: number; // farthest building centroid from the running centre
}

/** A finished, merged town: one mesh + its cull sphere. */
interface TownMesh {
  mesh: Mesh;
  center: Vector3;
}

/** Show a town's buildings only within this distance of its centre (metres). */
const SHOW_DIST = 18_000;

/** Default fallback height for records with a missing/invalid `h` (metres). */
const FALLBACK_HEIGHT = 6;

/**
 * The 6 town centroids in world XZ. Buildings are bucketed to the nearest one.
 * Coordinates are lon/lat of each town centre, converted to world space at
 * install time. Chosen to cover the six populated areas the dataset spans
 * (north-coast towns west→east plus the south coast).
 */
const TOWN_CENTROIDS_LONLAT: ReadonlyArray<readonly [number, number]> = [
  [23.7, 35.51], // Chania
  [24.02, 35.51], // Georgioupoli / Vamos area
  [24.47, 35.37], // Rethymno
  [25.13, 35.34], // Heraklion
  [25.74, 35.19], // Agios Nikolaos / Lasithi
  [24.24, 35.0], // south coast (Plakias / Frangokastello)
];

/**
 * Build one building's extruded BufferGeometry, already placed in world space.
 *
 * Returns null if the ring is degenerate (< 3 distinct points) or if extrusion
 * produces no geometry. The caller skips nulls.
 */
function buildBuildingGeometry(record: BuildingRecord, hf: Heightfield): BufferGeometry | null {
  const ring = record.r;
  if (!Array.isArray(ring) || ring.length < 3) return null;

  // Convert ring [lng,lat] → world XZ. Drop a trailing point that duplicates
  // the first (closed rings) so Shape doesn't get a zero-length edge.
  const pts: Array<{ x: number; z: number }> = [];
  for (const pair of ring) {
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

  // Centroid (mean of vertices) → flat base Y for the whole building.
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
  }
  cx /= pts.length;
  cz /= pts.length;
  const baseY = Math.max(0, hf.heightAtCpu(cx, cz));

  // Extrude height: clamp to a sane positive value.
  const rawH = record.h;
  const height = typeof rawH === 'number' && Number.isFinite(rawH) && rawH > 0 ? rawH : FALLBACK_HEIGHT;

  // Shape lives in the X/Y plane; we map world x → shapeX, world z → shapeY.
  // ExtrudeGeometry then extrudes along +shapeZ; rotateX(-π/2) turns that into
  // +worldY so the building rises out of the ground.
  const shape = new Shape();
  shape.moveTo(pts[0]!.x, pts[0]!.z);
  for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i]!.x, pts[i]!.z);
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });

  // Orient extrude axis to +Y. After rotateX(-π/2): shapeX→worldX,
  // shapeY→worldZ keeps sign, shapeZ(depth)→worldY (up). The base (depth 0)
  // ends up at worldY = 0 before translate.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, baseY, 0);
  return geo;
}

/** Pick the index of the nearest town centroid to a world XZ point. */
function nearestTown(x: number, z: number, towns: ReadonlyArray<Vector3>): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < towns.length; i += 1) {
    const t = towns[i]!;
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

/**
 * Install extruded Crete buildings. No-op unless params.world === 'crete'.
 *
 * Fetches buildings.json, builds + merges per-town geometry asynchronously, and
 * wires a per-frame distance cull. Failures are logged, not thrown, so a bad
 * dataset never aborts world boot.
 *
 * @param skipTownIndices - town bucket indices to omit from the scene (e.g. [0]
 *   skips Chania when the Nanite renderer handles it instead).
 */
export function installCreteBuildings(
  engine: Engine,
  hf: Heightfield,
  params: LaasParams,
  skipTownIndices: ReadonlySet<number> = new Set(),
): void {
  if (params.world !== 'crete') return;

  // Resolve town centroids to world space once.
  const townCenters: Vector3[] = TOWN_CENTROIDS_LONLAT.map(([lng, lat]) => {
    const { x, z } = lonLatToWorld(lng, lat);
    return new Vector3(x, 0, z);
  });

  // One shared cream material — Cretan whitewashed plaster, matte.
  const material = new MeshStandardNodeMaterial();
  material.color.setRGB(0.9, 0.88, 0.84);
  material.roughness = 0.9;
  material.metalness = 0;

  const townMeshes: TownMesh[] = [];

  fetch('/crete/buildings.json')
    .then((r) => {
      if (!r.ok) throw new Error(`buildings.json HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    })
    .then((data: unknown) => {
      if (!Array.isArray(data)) throw new Error('buildings.json is not an array');

      // One bucket per town centroid.
      const buckets: TownBucket[] = townCenters.map((c) => ({
        geos: [],
        center: c.clone(),
        sumX: 0,
        sumZ: 0,
        count: 0,
        radius: 0,
      }));

      let built = 0;
      let skipped = 0;
      for (const raw of data) {
        // Wrap each extrusion so one bad polygon never aborts the batch.
        try {
          const record = raw as BuildingRecord;
          const geo = buildBuildingGeometry(record, hf);
          if (!geo) {
            skipped += 1;
            continue;
          }
          // Bucket by the ring's first world vertex (cheap, stable proxy for the
          // footprint position) → nearest town.
          const ring = record.r;
          const firstPair = ring[0]!;
          const { x, z } = lonLatToWorld(firstPair[0]!, firstPair[1]!);
          const ti = nearestTown(x, z, townCenters);
          const bucket = buckets[ti]!;
          bucket.geos.push(geo);
          bucket.sumX += x;
          bucket.sumZ += z;
          bucket.count += 1;
          built += 1;
        } catch (e) {
          skipped += 1;
          if (skipped <= 5) console.warn('[crete] building extrude failed; skipping', e);
        }
      }

      // Merge each non-empty bucket into one mesh; compute its real centre.
      let townsWithBuildings = 0;
      for (let bi = 0; bi < buckets.length; bi++) {
        const bucket = buckets[bi]!;
        if (bucket.geos.length === 0) continue;

        const center = new Vector3(bucket.sumX / bucket.count, 0, bucket.sumZ / bucket.count);
        const merged = mergeGeometries(bucket.geos, false);
        // Free per-building geometries now that they're merged.
        for (const g of bucket.geos) g.dispose();
        if (!merged) {
          console.warn(`[crete] mergeGeometries returned null for a town (${bucket.count} buildings); skipping`);
          continue;
        }
        if (!merged.getAttribute('normal')) merged.computeVertexNormals(); // ensure lit shading

        // T3b: skip towns handled by the Nanite renderer (e.g. Chania = bucket 0).
        if (skipTownIndices.has(bi)) {
          merged.dispose();
          continue;
        }

        const mesh = new Mesh(merged, material);
        mesh.name = `crete-buildings-town-${townsWithBuildings}`;
        mesh.castShadow = false; // perf: shadows off for the building mass
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        mesh.visible = false; // start hidden; the per-frame cull reveals it
        engine.scene.add(mesh);
        townMeshes.push({ mesh, center });
        townsWithBuildings += 1;
      }

      console.log(
        `[crete] buildings: ${built} built across ${townsWithBuildings} towns` +
          (skipped > 0 ? ` (${skipped} skipped)` : ''),
      );
    })
    .catch((e) => console.warn('[crete] buildings.json load failed', e));

  // Per-frame distance cull. Cheap: ≤6 distance checks per frame.
  const cam = engine.camera;
  const showDistSq = SHOW_DIST * SHOW_DIST;
  engine.onUpdate(() => {
    if (townMeshes.length === 0) return;
    const px = cam.position.x;
    const py = cam.position.y;
    const pz = cam.position.z;
    for (const t of townMeshes) {
      const dx = px - t.center.x;
      const dy = py - t.center.y;
      const dz = pz - t.center.z;
      t.mesh.visible = dx * dx + dy * dy + dz * dz < showDistSq;
    }
  });
}
