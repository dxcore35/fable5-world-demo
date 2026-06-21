/**
 * CreteCoastlineOverlay — the DETECTED coastline drawn as a bright line laid
 * directly over the 3D terrain surface, visible at EVERY zoom, with a SOURCE
 * toggle. This is the simple, explicit overlay of the detection result on top of
 * what's already there — independent of the ocean mask / terrain resolution.
 *
 * Two switchable SOURCES + an Off state:
 *   - 'cadastre' : public/crete/coastline-cadastre.geojson (derived FROM the
 *                  cadastre orthophoto) — falls back to coastline-sds then coastline.
 *   - 'osm'      : public/crete/coastline.geojson (raw OSM natural=coastline).
 *   - 'off'      : the line mesh is hidden.
 *
 * Each land ring -> a flat horizontal ribbon draped on the terrain at the coast.
 * The ribbon's half-width is applied in the VERTEX shader as cameraDistance·scale
 * (clamped), so the line stays a few pixels wide from a beach close-up all the way
 * to the whole-island overview (a fixed-width ribbon would vanish when zoomed out).
 *
 * WebGPU: one merged Mesh + MeshBasicNodeMaterial (unlit -> always vivid). The
 * width is a positionNode displacement along the per-vertex perpendicular (stored
 * in the `aOff` attribute). Switching source rebuilds ONLY the geometry on the
 * existing mesh/material. Crete-world only.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, cameraPosition, clamp, float, positionLocal, vec3 } from 'three/tsl';
import type { NV2 } from '../gpu/TSLTypes';
import type { Engine } from '../core/Engine';
import type { LaasHooks } from '../core/Hooks';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { lonLatToWorld } from './CreteConst';

interface GeoJSON {
  features: { geometry: { type: string; coordinates: number[][][] } }[];
}

/** Coastline overlay source (incl. the Off state, which hides the line). */
export type CoastlineSource = 'cadastre' | 'osm' | 'off';

const LIFT = 1.5;            // m above the surface (sits over ocean y=0 + coast terrain)
const PIXEL_SCALE = 0.003;   // half-width = camDist · this  (~ a few px on screen)
const MIN_HALF = 2;          // m — never thinner than this up close
const MAX_HALF = 6000;       // m — cap at the whole-island overview
const COLOR: readonly [number, number, number] = [0.15, 0.95, 1.0]; // cyan "detected" line

/** Source -> ordered fetch URL list (same mapping as CreteLandMask). 'off' fetches
 *  nothing. 'cadastre' falls back to the SDS bake then raw OSM. */
function sourceUrls(source: CoastlineSource): string[] {
  if (source === 'off') return [];
  return source === 'cadastre'
    ? ['/crete/coastline-cadastre.geojson', '/crete/coastline-sds.geojson', '/crete/coastline.geojson']
    : ['/crete/coastline.geojson'];
}

async function fetchRings(source: CoastlineSource): Promise<number[][][]> {
  let geo: GeoJSON | null = null;
  for (const url of sourceUrls(source)) {
    try {
      const r = await fetch(url);
      if (r.ok) { geo = (await r.json()) as GeoJSON; break; }
    } catch { /* try next */ }
  }
  return geo?.features.filter((f) => f.geometry?.type === 'Polygon').map((f) => f.geometry.coordinates[0]) ?? [];
}

/** Build the merged ribbon geometry for a set of coastline rings (reused on every
 *  source switch). Returns null if nothing usable. */
function buildOverlayGeometry(rings: number[][][], hf: Heightfield): BufferGeometry | null {
  const positions: number[] = [];
  const offsets: number[] = []; // per-vertex signed unit perpendicular in XZ
  const indices: number[] = [];
  let base = 0;
  for (const ring of rings) {
    // world XZ, dropping consecutive duplicates
    const pts: { x: number; z: number }[] = [];
    for (const c of ring) {
      const w = lonLatToWorld(c[0], c[1]);
      const p = pts[pts.length - 1];
      if (p && Math.abs(p.x - w.x) < 1e-6 && Math.abs(p.z - w.z) < 1e-6) continue;
      pts.push(w);
    }
    const n = pts.length;
    if (n < 2) continue;

    for (let i = 0; i < n; i++) {
      // averaged adjacent-segment direction, rotated 90 deg -> perpendicular
      let dx = 0, dz = 0;
      if (i > 0) { const ax = pts[i].x - pts[i - 1].x, az = pts[i].z - pts[i - 1].z; const l = Math.hypot(ax, az) || 1; dx += ax / l; dz += az / l; }
      if (i < n - 1) { const bx = pts[i + 1].x - pts[i].x, bz = pts[i + 1].z - pts[i].z; const l = Math.hypot(bx, bz) || 1; dx += bx / l; dz += bz / l; }
      let l = Math.hypot(dx, dz); if (l < 1e-6) { dx = 1; dz = 0; l = 1; } dx /= l; dz /= l;
      const px = dz, pz = -dx; // perpendicular
      const cx = pts[i].x, cz = pts[i].z;
      const y = Math.max(0, hf.heightAtCpu(cx, cz)) + LIFT;
      // two coincident centerline verts; the +/-perp offset is applied in the shader
      positions.push(cx, y, cz, cx, y, cz);
      offsets.push(px, pz, -px, -pz);
    }
    for (let i = 0; i < n - 1; i++) {
      const l0 = base + i * 2, r0 = base + i * 2 + 1, l1 = base + (i + 1) * 2, r1 = base + (i + 1) * 2 + 1;
      indices.push(l0, l1, r0, r0, l1, r1);
    }
    base += n * 2;
  }
  if (positions.length === 0) return null;

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('aOff', new BufferAttribute(new Float32Array(offsets), 2));
  g.setIndex(indices);
  return g;
}

export interface CoastlineOverlay {
  /** Rebuild the line from a chosen source, or hide it on 'off'. */
  setSource(s: CoastlineSource): Promise<void>;
  source: CoastlineSource;
}

export async function installCreteCoastlineOverlay(
  engine: Engine,
  hf: Heightfield,
  hooks: LaasHooks,
  params: LaasParams,
): Promise<CoastlineOverlay | null> {
  if (params.world !== 'crete') return null;

  // Initial source: cadastre (matches the live cadastre surface). Build its geometry.
  const initialSource: CoastlineSource = 'cadastre';
  const rings = await fetchRings(initialSource);
  if (rings.length === 0) { console.warn('[crete] coastline overlay: no vector data'); return null; }
  const geom = buildOverlayGeometry(rings, hf);
  if (!geom) return null;

  const mat = new MeshBasicNodeMaterial();
  const aOff = attribute('aOff', 'vec2') as unknown as NV2;
  // screen-scaled half-width so the line reads at every zoom (vertex displacement)
  const halfW = clamp(cameraPosition.distance(positionLocal).mul(float(PIXEL_SCALE)), float(MIN_HALF), float(MAX_HALF));
  mat.positionNode = positionLocal.add(vec3(aOff.x, float(0), aOff.y).mul(halfW));
  mat.colorNode = vec3(COLOR[0], COLOR[1], COLOR[2]);
  mat.toneMapped = false; // keep the cyan vivid through tone mapping
  mat.side = DoubleSide;

  const mesh = new Mesh(geom, mat);
  mesh.name = 'crete-coastline-overlay';
  mesh.frustumCulled = false; // spans the whole island; shader widens past the bbox
  mesh.renderOrder = 10;
  // Hidden by DEFAULT: the coast is cut directly out of the 3D surface (terrain
  // discards on the sea side via the land mask) + ocean on top, so the explicit
  // line is redundant. The Coast toggle (cadastre/osm/off) still turns it back on
  // for debugging the detection. Geometry is pre-built so toggling on is instant.
  mesh.visible = false;
  engine.scene.add(mesh);

  const overlay: CoastlineOverlay = {
    source: 'off',
    async setSource(s: CoastlineSource) {
      this.source = s;
      if (s === 'off') { mesh.visible = false; return; }
      const r = await fetchRings(s);
      const g = r.length ? buildOverlayGeometry(r, hf) : null;
      if (g) {
        mesh.geometry.dispose();
        mesh.geometry = g;
        mesh.visible = true;
      } else {
        // no data for this source -> keep the existing geometry but show it
        mesh.visible = true;
        console.warn(`[crete] coastline overlay: no data for source=${s}, keeping previous line`);
      }
    },
  };
  hooks.setCoastlineSource = (s: CoastlineSource) => { void overlay.setSource(s); };
  console.log(`[crete] coastline overlay: ${rings.length} rings built, hidden by default (toggle to show)`);
  return overlay;
}
