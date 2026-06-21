/**
 * CreteLandMask — high-res land/sea mask used to trim the ocean crisply at the
 * shoreline (water opacity -> 0 on land).
 *
 * SOLE method = the VECTOR coastline (no colour/imagery detection at runtime):
 *   1. A chosen coastline source geojson is fetched (cadastre / osm), with a safe
 *      fallback chain so the engine never breaks before the cadastre bake exists.
 *   2. Rasterize the land polygons into the mask (point inside any polygon = land).
 *
 * Two coastline SOURCES are switchable at runtime:
 *   - 'cadastre' : /crete/coastline-cadastre.geojson (derived FROM the cadastre
 *                  orthophoto so it matches the surface) — falls back to
 *                  coastline-sds.geojson then coastline.geojson.
 *   - 'osm'      : /crete/coastline.geojson (raw OSM natural=coastline, the "tweet").
 *
 * Alignment: lon/lat -> world (lonLatToWorld) -> uv (worldXZ/worldSize()+0.5), the
 * SAME uv the terrain + ocean sample by. (1 = land, 0 = sea.) Crete-world only;
 * returns null if no vector coastline is available (caller leaves the ocean untrimmed).
 *
 * Runtime source-switch: the ocean material captured ONE landMask StorageTexture by
 * reference. To switch source without rebuilding the material, build a fresh mask
 * texture from the new source then COMPUTE-COPY its texels into the existing ocean
 * landMask texture in place (`refillCreteLandMask`) — mirrors how CreteMapStream
 * re-fills the drape StorageTexture. The GPU sampling path is unchanged; only the
 * texels under the same texture handle change.
 */
import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import type { Renderer } from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import {
  Fn, If, Return, float, instanceIndex, texture, textureStore, uvec2, vec2, vec4,
} from 'three/tsl';
import { lonLatToWorld } from './CreteConst';
import { worldSize } from '../world/WorldConst';

interface GeoJSON {
  features: { geometry: { type: string; coordinates: number[][][] } }[];
}

/** Coastline vector source. 'off' is a UI/overlay state only — the land mask keeps
 *  its last contents on 'off' (handled by the caller), so this type is the two
 *  fetchable sources. */
export type CoastlineSource = 'cadastre' | 'osm';

/** Source -> ordered fetch URL list. 'cadastre' falls back to the SDS bake then raw
 *  OSM so nothing breaks before coastline-cadastre.geojson is baked. */
function sourceUrls(source: CoastlineSource): string[] {
  return source === 'cadastre'
    ? ['/crete/coastline-cadastre.geojson', '/crete/coastline-sds.geojson', '/crete/coastline.geojson']
    : ['/crete/coastline.geojson'];
}

/** Fetch the first available geojson for `source`; returns the parsed FC + the url used. */
async function fetchCoastline(source: CoastlineSource): Promise<{ geo: GeoJSON; url: string } | null> {
  for (const url of sourceUrls(source)) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return { geo: (await resp.json()) as GeoJSON, url };
    } catch { /* try next */ }
  }
  return null;
}

/** Rasterize the land polygons of a coastline geojson into a res×res Uint8 land mask
 *  (1 = land, 0 = sea), using the SAME lon/lat -> world -> uv mapping the ocean samples
 *  by. Returns null if no Polygon rings or no 2D context. */
function rasterizeLand(geo: GeoJSON, res: number): Uint8Array | null {
  const polys = geo.features
    .filter((f) => f.geometry?.type === 'Polygon')
    .map((f) => f.geometry.coordinates[0]);
  if (polys.length === 0) return null;

  const W = worldSize();
  const N = res * res;
  const canvas = new OffscreenCanvas(res, res);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, res, res);
  ctx.fillStyle = '#fff';
  for (const ring of polys) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const { x, z } = lonLatToWorld(ring[i][0], ring[i][1]);
      const px = (x / W + 0.5) * res, py = (z / W + 0.5) * res;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  const d = ctx.getImageData(0, 0, res, res).data;
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = d[i * 4] > 127 ? 1 : 0;
  return land;
}

/** Compute-copy a land[] mask into a (new or existing) LINEAR StorageTexture via a
 *  staging DataTexture + a WebGPU compute kernel. When `into` is given its texels are
 *  re-filled in place (must be res×res); otherwise a fresh StorageTexture is made. */
async function uploadLandMask(
  renderer: Renderer, land: Uint8Array, res: number, into: StorageTexture | null,
): Promise<StorageTexture> {
  const N = res * res;
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const v = land[i] ? 255 : 0;
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  const staging = new DataTexture(out, res, res, RGBAFormat, UnsignedByteType);
  staging.needsUpdate = true;

  let tex = into;
  if (!tex) {
    tex = new StorageTexture(res, res);
    tex.magFilter = LinearFilter; tex.minFilter = LinearFilter; tex.generateMipmaps = false;
  }
  const target = tex;

  const kernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(res * res), () => { Return(); });
    const x = i.mod(res); const y = i.div(res);
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
    const s = texture(staging, uv);
    textureStore(target, uvec2(x.toUint(), y.toUint()), vec4(s.r, s.r, s.r, float(1))).toWriteOnly();
  })().compute(res * res);
  kernel.setName(into ? 'creteLandMaskRefill' : 'creteLandMask');
  await renderer.computeAsync(kernel);
  staging.dispose();
  return target;
}

/** Initial build: fetch + rasterize + upload a fresh land-mask StorageTexture.
 *  Defaults to the 'cadastre' source (matches the live cadastre surface). */
export async function buildCreteLandMask(
  renderer: Renderer,
  res = 4096, // 4096 ~ 68 m/texel. (8192 + the 8192 drape together thrashed memory;
              // the precise coast still shows via the cyan CreteCoastlineOverlay line.)
  source: CoastlineSource = 'cadastre',
): Promise<StorageTexture | null> {
  const fetched = await fetchCoastline(source);
  if (!fetched) {
    // eslint-disable-next-line no-console
    console.error('[crete] land mask: NO vector coastline found — ocean will not be trimmed');
    return null;
  }
  const land = rasterizeLand(fetched.geo, res);
  if (!land) {
    // eslint-disable-next-line no-console
    console.error('[crete] land mask: coastline geojson has no Polygon rings');
    return null;
  }
  // eslint-disable-next-line no-console
  console.log(`[crete] land mask: VECTOR coastline @ ${res} from ${fetched.url} (source=${source})`);
  return uploadLandMask(renderer, land, res, null);
}

/** Rebuild the land mask from a CHOSEN source as a FRESH StorageTexture (used to feed
 *  refillCreteLandMask). Same fetch/raster path as the initial build. Returns null if
 *  no usable coastline for the source. */
export async function rebuildCreteLandMask(
  renderer: Renderer,
  source: CoastlineSource,
  res = 4096,
): Promise<StorageTexture | null> {
  return buildCreteLandMask(renderer, res, source);
}

/** Re-fill the ocean's EXISTING landMask StorageTexture in place from a chosen
 *  source — build a fresh mask, then compute-copy its texels into `into` (same res).
 *  This swaps the source at runtime WITHOUT rebuilding the ocean material (which
 *  captured `into` by reference). Returns true on success, false if no coastline.
 *  Mirrors CreteMapStream's drape re-fill pattern. */
export async function refillCreteLandMask(
  renderer: Renderer,
  into: StorageTexture,
  source: CoastlineSource,
  res = 4096,
): Promise<boolean> {
  const fetched = await fetchCoastline(source);
  if (!fetched) return false;
  const land = rasterizeLand(fetched.geo, res);
  if (!land) return false;
  await uploadLandMask(renderer, land, res, into);
  // eslint-disable-next-line no-console
  console.log(`[crete] land mask: re-filled in place from ${fetched.url} (source=${source})`);
  return true;
}
