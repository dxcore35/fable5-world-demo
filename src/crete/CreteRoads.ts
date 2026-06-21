/**
 * CreteRoads — flat road ribbons draped on the terrain for the Crete world.
 *
 * Data: public/crete/roads.json — an array of { p:[lng,lat][], c:string } where
 * `p` is a polyline of [lng,lat] points and `c` is the OSM highway class
 * (motorway|trunk|primary|secondary|tertiary), ~9.7k segments.
 *
 * Pipeline (all done once, asynchronously, after terrain is up):
 *   1. fetch roads.json
 *   2. for each polyline (≥2 points): map [lng,lat] → world XZ via lonLatToWorld,
 *      then build a centerline RIBBON — at each vertex take the averaged 2D
 *      direction of the adjacent segments, rotate it 90° to get the perpendicular,
 *      and emit left/right offset vertices = center ± perp*(width/2). Width is a
 *      per-class lookup. Each emitted vertex sits at ground height + ROAD_LIFT so
 *      the ribbon hovers just above the coarse terrain (no z-fighting). Two
 *      triangles connect each consecutive cross-section.
 *   3. merge ALL road ribbons into ONE BufferGeometry via mergeGeometries →
 *      one Mesh, then computeVertexNormals(). Per-road geometries are disposed.
 *   4. one shared dark-asphalt MeshStandardNodeMaterial; the mesh is added to scene.
 *
 * Per-frame: altitude cull — the ribbon is visible only when the camera is below
 * SHOW_ALT, so thin roads stay hidden at the whole-island overview (where they
 * would only alias) and appear as you descend.
 *
 * The WebGPURenderer renders the whole scene through PostStack (pass(scene,
 * camera)), so a plain Mesh added to engine.scene renders. We use
 * MeshStandardNodeMaterial (the WebGPU node material) to match the renderer,
 * mirroring src/crete/CreteBuildings.ts and src/gavdos/GavdosStructures.ts.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  type Material,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/Engine';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { lonLatToWorld } from './CreteConst';

/** Raw road record as stored in public/crete/roads.json. */
interface RoadRecord {
  p: number[][]; // polyline: [lng, lat] pairs
  c: string; // OSM highway class
}

/** Road ribbon width in metres, keyed by OSM highway class. */
const WIDTH: Readonly<Record<string, number>> = {
  motorway: 16,
  trunk: 12,
  primary: 9,
  secondary: 7,
  tertiary: 5,
};

/** Width used when `c` is missing or not one of the known classes (metres). */
const FALLBACK_WIDTH = 5;

/**
 * Lift the ribbon this many metres above the sampled ground so it sits just
 * above the coarse (~137 m/texel) Crete terrain and avoids z-fighting.
 */
const ROAD_LIFT = 2;

/**
 * Show the road mesh only when the camera is below this altitude (metres).
 * Above it — the whole-island overview — thin roads would just alias, so hide
 * them; they pop in as you descend. Tunable.
 */
const SHOW_ALT = 45_000;

/** Dark-asphalt color (linear RGB), matte. */
const ASPHALT_RGB: readonly [number, number, number] = [0.11, 0.11, 0.12];

/**
 * Build one road's ribbon BufferGeometry, already placed in world space.
 *
 * Returns null if the polyline is degenerate (< 2 usable points, or every
 * segment is zero-length so no direction can be derived). The caller skips nulls.
 */
function buildRoadGeometry(record: RoadRecord, hf: Heightfield): BufferGeometry | null {
  const line = record.p;
  if (!Array.isArray(line) || line.length < 2) return null;

  // Convert polyline [lng,lat] → world XZ, dropping malformed / non-finite
  // points and collapsing consecutive duplicates (zero-length segments break
  // direction math and add degenerate triangles).
  const pts: Array<{ x: number; z: number }> = [];
  for (const pair of line) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = pair[0];
    const lat = pair[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const w = lonLatToWorld(lng, lat);
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev.x - w.x) < 1e-6 && Math.abs(prev.z - w.z) < 1e-6) continue;
    pts.push(w);
  }
  const n = pts.length;
  if (n < 2) return null;

  // Per-vertex 2D direction in XZ: the normalized average of the incoming and
  // outgoing segment directions (just the single adjacent segment at the ends).
  // Then perp = rotate dir 90° in XZ → (dz, -dx). Offset ± perp * halfWidth.
  const rawW = WIDTH[record.c];
  const halfWidth = (typeof rawW === 'number' ? rawW : FALLBACK_WIDTH) / 2;

  // Precompute normalized segment directions (n-1 of them).
  const segDx: number[] = new Array(n - 1);
  const segDz: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      // Should not happen (duplicates were collapsed) but guard anyway.
      dx = 0;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }
    segDx[i] = dx;
    segDz[i] = dz;
  }

  // Emit two vertices (left, right) per centerline vertex → 2*n vertices.
  const positions = new Float32Array(n * 2 * 3);
  let emitted = 0;
  for (let i = 0; i < n; i += 1) {
    // Averaged direction at vertex i.
    let dx = 0;
    let dz = 0;
    if (i > 0) {
      dx += segDx[i - 1]!;
      dz += segDz[i - 1]!;
    }
    if (i < n - 1) {
      dx += segDx[i]!;
      dz += segDz[i]!;
    }
    let dlen = Math.hypot(dx, dz);
    if (dlen < 1e-6) {
      // Opposite adjacent segments cancelled (180° hairpin) — fall back to the
      // incoming segment direction so we still get a valid perpendicular.
      if (i > 0) {
        dx = segDx[i - 1]!;
        dz = segDz[i - 1]!;
      } else if (i < n - 1) {
        dx = segDx[i]!;
        dz = segDz[i]!;
      }
      dlen = Math.hypot(dx, dz);
    }
    if (dlen < 1e-6) return null; // no derivable direction anywhere → skip road
    dx /= dlen;
    dz /= dlen;

    // Perpendicular in XZ (90° rotation).
    const px = dz;
    const pz = -dx;

    const c = pts[i]!;
    const lx = c.x + px * halfWidth;
    const lz = c.z + pz * halfWidth;
    const rx = c.x - px * halfWidth;
    const rz = c.z - pz * halfWidth;

    const ly = Math.max(0, hf.heightAtCpu(lx, lz)) + ROAD_LIFT;
    const ry = Math.max(0, hf.heightAtCpu(rx, rz)) + ROAD_LIFT;

    const base = i * 2 * 3;
    positions[base + 0] = lx;
    positions[base + 1] = ly;
    positions[base + 2] = lz;
    positions[base + 3] = rx;
    positions[base + 4] = ry;
    positions[base + 5] = rz;
    emitted += 2;
  }
  if (emitted < 4) return null; // need ≥2 cross-sections for ≥1 quad

  // Two triangles per centerline segment, winding so the ribbon faces up (+Y).
  // Cross-section i has vertices [2i]=left, [2i+1]=right.
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const l0 = i * 2;
    const r0 = i * 2 + 1;
    const l1 = (i + 1) * 2;
    const r1 = (i + 1) * 2 + 1;
    // Triangle 1: l0, l1, r0 ; Triangle 2: r0, l1, r1
    indices.push(l0, l1, r0, r0, l1, r1);
  }
  if (indices.length === 0) return null;

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Install draped Crete road ribbons. No-op unless params.world === 'crete'.
 *
 * Fetches roads.json, builds + merges all ribbons into one mesh asynchronously,
 * and wires a per-frame altitude cull. Failures are logged, not thrown, so a bad
 * dataset never aborts world boot.
 */
export function installCreteRoads(engine: Engine, hf: Heightfield, params: LaasParams): void {
  if (params.world !== 'crete') return;

  // One shared dark-asphalt material — matte, non-metallic.
  const material: Material = new MeshStandardNodeMaterial();
  (material as MeshStandardNodeMaterial).color.setRGB(
    ASPHALT_RGB[0],
    ASPHALT_RGB[1],
    ASPHALT_RGB[2],
  );
  (material as MeshStandardNodeMaterial).roughness = 0.95;
  (material as MeshStandardNodeMaterial).metalness = 0;

  // Filled in once the merge completes; the cull no-ops until then.
  let roadMesh: Mesh | null = null;

  fetch('/crete/roads.json')
    .then((r) => {
      if (!r.ok) throw new Error(`roads.json HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    })
    .then((data: unknown) => {
      if (!Array.isArray(data)) throw new Error('roads.json is not an array');

      const geos: BufferGeometry[] = [];
      let built = 0;
      let skipped = 0;
      for (const raw of data) {
        // Wrap each ribbon so one bad polyline never aborts the batch.
        try {
          const record = raw as RoadRecord;
          const geo = buildRoadGeometry(record, hf);
          if (!geo) {
            skipped += 1;
            continue;
          }
          geos.push(geo);
          built += 1;
        } catch (e) {
          skipped += 1;
          if (skipped <= 5) console.warn('[crete] road ribbon failed; skipping', e);
        }
      }

      if (geos.length === 0) {
        console.warn('[crete] roads: no usable ribbons; nothing drawn');
        return;
      }

      const merged = mergeGeometries(geos, false);
      // Free per-road geometries now that they're merged.
      for (const g of geos) g.dispose();
      if (!merged) {
        console.warn(`[crete] mergeGeometries returned null for roads (${geos.length} ribbons)`);
        return;
      }
      merged.computeVertexNormals();

      const mesh = new Mesh(merged, material);
      mesh.name = 'crete-roads';
      mesh.castShadow = false; // perf: flat ribbons cast no useful shadow
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      // Start hidden if we boot at the overview; the per-frame cull corrects it.
      mesh.visible = engine.camera.position.y < SHOW_ALT;
      engine.scene.add(mesh);
      roadMesh = mesh;

      console.log(
        `[crete] roads: ${built} segments draped` + (skipped > 0 ? ` (${skipped} skipped)` : ''),
      );
    })
    .catch((e) => console.warn('[crete] roads.json load failed', e));

  // Per-frame altitude cull. Cheap: one comparison per frame.
  const cam = engine.camera;
  engine.onUpdate(() => {
    if (roadMesh === null) return;
    roadMesh.visible = cam.position.y < SHOW_ALT;
  });
}
