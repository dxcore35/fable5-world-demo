/**
 * ?scene=terrain — terrain inspection scene (also currently ?scene=world).
 * Real CDLOD tiles + far shell + PBR terrain material, temporary sun/sky
 * lighting (replaced by the Phase-2 atmosphere stack).
 *
 * Views: ?view=hydro paints hydrology diagnostics on a preview grid.
 * ?alt=N puts the camera N meters above ground (ground-clamped spawn).
 */

import { TextureLoader, type Texture, InstancedMesh, PlaneGeometry, Matrix4, Euler, Color, Vector3 } from 'three';
import { BOOKMARKS, installBookmarks } from './Bookmarks';
import { installViewButtons } from './ViewButtons';
import { installBeachMarkers } from '../crete/CreteBeachMarkers';
import { installCreteBuildings } from '../crete/CreteBuildings';
import { buildNaniteChaniaMesh } from '../crete/CreteNanite';
import { installCreteRoads } from '../crete/CreteRoads';
import { installCreteGreenery } from '../crete/CreteGreenery';
import { buildCreteScatter } from '../crete/CreteScatter';
import { installCreteMapStream } from '../crete/CreteMapStream';
import { installCreteCoastlineOverlay } from '../crete/CreteCoastlineOverlay';
import { buildCreteLandMask, refillCreteLandMask } from '../crete/CreteLandMask';
import type { StorageTexture } from 'three/webgpu';
import { Froxels } from '../gpu/passes/Froxels';
import { PARTICLE_COUNT, Particles } from '../gpu/passes/Particles';
import { ProbeGI } from '../gpu/passes/ProbeGI';
import { buildCanopyMap, runScatter } from '../gpu/passes/Scatter';
import { addScatterDebug } from './ScatterDebug';
import { Forests } from '../vegetation/Forests';
import { GroundRing } from '../vegetation/GroundRing';
import { buildVegLibrary } from '../vegetation/VegLibrary';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { worldSize } from '../world/WorldConst';
import { CausticsBake, setCausticContext } from '../render/Caustics';
import { setWindContext, windU } from '../render/Wind';
import { sunU, updateSunUniforms } from '../render/VegMaterials';
import { buildCanopyShell } from '../world/CanopyShell';
import { Heightfield } from '../world/Heightfield';
import { buildTerrainShadowProxy } from '../world/ShadowProxy';
import { makeMacroParams } from '../world/MacroMap';
import { qualityConfig, setActiveWorldSize } from '../world/WorldConst';
import { buildGavdosHeightfield } from '../gavdos/GavdosWorld';
import { GAVDOS_WORLD_SIZE } from '../gavdos/GavdosConst';
import { buildCreteHeightfield } from '../crete/CreteWorld';
import { CRETE_WORLD_SIZE } from '../crete/CreteConst';
import { GavdosOcean } from '../gavdos/GavdosOcean';
import {
  buildGavdosVegLibrary,
  runGavdosScatter,
  placeGavdosRocks,
  GAVDOS_DRY_BIAS,
} from '../gavdos/GavdosVeg';
import { buildGavdosStructures } from '../gavdos/GavdosStructures';
import { TerrainTiles } from '../world/TerrainTiles';
import { WaterSurface } from '../world/WaterSurface';
import { PostStack } from '../render/PostStack';
import { setupSunShadows } from '../render/ShadowSetup';
import { Clouds } from '../sky/Clouds';
import { SunSky } from '../sky/SunSky';
import type { WorldContext } from './Scenes';

export async function buildTerrainScene(ctx: WorldContext): Promise<void> {
  const { engine, params, seed } = ctx;

  let hf: Heightfield;
  if (params.world === 'gavdos') {
    // Set world size BEFORE any system is constructed (gavdos = full island 10240 m)
    setActiveWorldSize(GAVDOS_WORLD_SIZE);
    // Real-data world: skip procedural synthesis/erosion/hydrology
    const baseCfg = qualityConfig(params.preset);
    // Gavdos source elevation is 30 m (FABDEM). heightRes>2048 over the 10240 m
    // window just oversamples (2048 = 5 m texels ≈ 6× source); the cost falls on
    // every CPU pass, GPU kernel, texture upload, the veg grid and GI ray-march —
    // and on runtime fps. Cap grids for speed + smoothness. ?hres=N overrides (A/B).
    const hresQ = Number(new URLSearchParams(location.search).get('hres'));
    const heightRes = Number.isFinite(hresQ) && hresQ > 0 ? hresQ : Math.min(baseCfg.heightRes, 2048);
    const cfg = { ...baseCfg, heightRes, simRes: Math.min(baseCfg.simRes, 1024) };
    if (cfg.heightRes !== baseCfg.heightRes || cfg.simRes !== baseCfg.simRes) {
      console.log(`[gavdos] grids capped for 30 m source: heightRes ${baseCfg.heightRes}→${cfg.heightRes}, simRes ${baseCfg.simRes}→${cfg.simRes}`);
    }
    const mp = makeMacroParams(seed); // neutral mp (only far-shell analytic uses it)
    hf = await buildGavdosHeightfield(
      engine.renderer,
      cfg,
      mp,
      (p, m) => ctx.progress(p * 0.92, m),
    );
    // Gavdos spawn: 1800 m above origin — whole island reads in frame at 10240 m world size
    if (params.cam === null) {
      ctx.hooks.initialPose = { p: [0, 1800, 0], yaw: 0, pitch: -0.8 };
      ctx.hooks.initialPoseMode = 'fly';
      engine.camera.position.set(0, 1800, 0);
    }
  } else if (params.world === 'crete') {
    // Set world size BEFORE any system is constructed (crete = whole island 280000 m)
    setActiveWorldSize(CRETE_WORLD_SIZE);
    // Whole-Crete base layer: skip procedural synthesis/erosion/hydrology.
    const baseCfg = qualityConfig(params.preset);
    // The Crete window is huge (280 km); cap the grid at 2048 for fast load
    // (3072 pushed load to 40 s — unacceptable; brute-force resolution doesn't
    // scale here, that's what the streamed detail-on-demand layer is for).
    // ?hres=N overrides (A/B).
    const hresQ = Number(new URLSearchParams(location.search).get('hres'));
    const heightRes = Number.isFinite(hresQ) && hresQ > 0 ? hresQ : Math.min(baseCfg.heightRes, 2048);
    const cfg = { ...baseCfg, heightRes, simRes: Math.min(baseCfg.simRes, 1024) };
    if (cfg.heightRes !== baseCfg.heightRes || cfg.simRes !== baseCfg.simRes) {
      console.log(`[crete] grids capped: heightRes ${baseCfg.heightRes}→${cfg.heightRes}, simRes ${baseCfg.simRes}→${cfg.simRes}`);
    }
    const mp = makeMacroParams(seed); // neutral mp (only far-shell analytic uses it)
    hf = await buildCreteHeightfield(
      engine.renderer,
      cfg,
      mp,
      (p, m) => ctx.progress(p * 0.92, m),
    );
    // Crete spawn: high over origin so the whole 280 km world frames in view.
    if (params.cam === null) {
      const eyeY = CRETE_WORLD_SIZE * 0.18;
      ctx.hooks.initialPose = { p: [0, eyeY, 0], yaw: 0, pitch: -0.85 };
      ctx.hooks.initialPoseMode = 'fly';
      engine.camera.position.set(0, eyeY, 0);
    }
    // Per-frame camera conditioning: solid-terrain clamp + adaptive near/far.
    const updateCreteCamera = (): void => {
      const cam = engine.camera;
      const ground = Math.max(0, hf.heightAtCpu(cam.position.x, cam.position.z));
      // SOLID TERRAIN: never let the fly camera sink into the ground/mountains.
      // "Flying through a mountain and seeing the sea" is the camera being INSIDE
      // terrain while the near plane clips its front faces. Keep ≥25 m above ground.
      const minY = ground + 25;
      if (cam.position.y < minY) cam.position.y = minY;
      // NEAR keyed off ALTITUDE-ABOVE-GROUND (not absolute altitude): tiny when
      // skimming terrain so nearby slopes can never be near-clipped (no
      // see-through); large only when high over open sea, for depth precision
      // (kills the z-fighting "see under mountains" at the overview). FAR keys off
      // absolute altitude so you can still zoom right out.
      const agl = Math.max(10, cam.position.y - ground);
      // tuned draw distances for crete: sharper closeups (smaller near at low agl), no pop at speed
      const far = Math.max(cam.position.y * 7.5, 42000);
      const near = Math.min(Math.max(agl * 0.28, 0.8), far * 0.45);
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    };
    updateCreteCamera();
    engine.onUpdate(updateCreteCamera);
  } else {
    hf = await Heightfield.generate(
      engine.renderer,
      params,
      seed,
      (p, m) => ctx.progress(p * 0.92, m),
    );
  }
  (engine as unknown as { heightfield?: Heightfield }).heightfield = hf;

  if (hf.cpuHeights) {
    let maxH = -Infinity;
    for (let i = 0; i < hf.cpuHeights.length; i += 7) {
      const v = hf.cpuHeights[i] as number;
      if (v > maxH) maxH = v;
    }
    engine.stats.counters['terrain.maxH'] = Math.round(maxH);
  }

  // physical sky first: probe gathering needs the atmosphere LUTs.
  // ?shot=N boots straight into a composed bookmark — use ITS time of day
  const bootBm = params.shot !== null ? BOOKMARKS[params.shot - 1] : undefined;
  const bootTod = bootBm?.tod ?? params.timeOfDay;
  ctx.progress(0.93, 'sky: baking atmosphere LUTs');
  const sunSky = new SunSky(engine, bootTod);
  await sunSky.init(engine.renderer);
  (engine as unknown as { sunSky?: SunSky }).sunSky = sunSky;
  // tooling probe handle (tools/probe-state.ts) — light/scene state triage
  (window as unknown as { __laasDbg?: unknown }).__laasDbg = { engine, sunSky };

  // vegetation/rock placement (Phase 5): GPU clustered-Poisson scatter +
  // canopy coverage map — BEFORE the probe field (probes ray-march the bare
  // heightfield; the canopy map is their only knowledge of the forest) and
  // before tiles (under-crown ambient)
  ctx.progress(0.94, 'vegetation: scattering instances');
  let scatter: Awaited<ReturnType<typeof runScatter>>;
  if (params.world === 'gavdos' && hf.gavdosVegData !== null) {
    // Gavdos: CPU-driven Mediterranean scatter (species.bin × weights.bin)
    const gavdosScatter = await runGavdosScatter(engine.renderer, hf.gavdosVegData);
    // Wire rocks.json detected boulders into the extras layer
    const rocksPlaced = await placeGavdosRocks(gavdosScatter, hf.gavdosVegData);
    console.log(`[gavdos] scatter: trees=${gavdosScatter.trees.count} under=${gavdosScatter.understory.count} extras=${gavdosScatter.extras.count} stones=${gavdosScatter.stones.count} rocksJson=${rocksPlaced}`);
    scatter = gavdosScatter as unknown as typeof scatter;
  } else if (params.world === 'crete') {
    // Crete: real OSM-polygon Mediterranean scatter (trees + phrygana shrubs)
    // placed ONLY inside wood/park outlines, fed into the SAME Forests pipeline
    // as the default scene. Cities/roads/fields stay bare so the cadastre map shows.
    const creteScatter = await buildCreteScatter(hf);
    scatter = creteScatter as unknown as typeof scatter;
  } else {
    scatter = await runScatter(engine.renderer, hf, seed);
  }
  const canopyTex = await buildCanopyMap(engine.renderer, scatter.trees);
  engine.stats.counters['veg.trees'] = scatter.trees.count;
  engine.stats.counters['veg.under'] = scatter.understory.count;
  engine.stats.counters['veg.extras'] = scatter.extras.count;
  engine.stats.counters['veg.stones'] = scatter.stones.count;

  const ablate = new Set(
    (new URLSearchParams(window.location.search).get('ablate') ?? '').split(','),
  );
  // Crete: render real OSM-placed Mediterranean trees + shrubs (CreteScatter) via
  // the Forests pipeline, but keep the full-island grass carpet / shell / particles
  // / froxels OFF so the cadastre orthophoto stays visible between the trees.
  // (?veg=0 restores the old map-only view for A/B.)
  if (params.world === 'crete') {
    // Enable the near-camera GRASS ring (like the default demo) — it sits on the
    // cadastre and only appears close to the ground, so it adds lushness without
    // hiding the map from altitude. Keep the full-screen shell/particles/froxels off.
    for (const a of ['shell', 'particles', 'froxels']) ablate.add(a);
    if (new URLSearchParams(window.location.search).get('veg') === '0') ablate.add('veg');
  }

  // irradiance probe field (Phase 3 GI; canopy-aware since Phase 5 —
  // ?ablate=canopygi rebuilds the bare-heightfield field for A/B)
  ctx.progress(0.95, 'gi: gathering irradiance probes');
  const gi = new ProbeGI(
    hf,
    sunSky.atmosphere,
    ablate.has('canopygi') ? null : canopyTex,
  );
  await gi.init(engine.renderer);
  sunSky.dimAmbientForGI();
  engine.onUpdate(() => gi.tick(engine.renderer));

  // Phase 6 caustics: per-frame analytic bake + module context — MUST be
  // set before any material factory runs (terrain tiles, rocks, debris all
  // self-apply at build time). ?ablate=caustics to A/B, ?caustk=N to tune.
  // Real-DEM worlds (gavdos/crete) have no hydrology flow field (hf.flow === null)
  // → caustics disabled. Only the procedural 'laas' world has the flow field.
  if (!ablate.has('caustics') && params.world === 'laas') {
    const bake = new CausticsBake();
    const ck = Number(new URLSearchParams(window.location.search).get('caustk') ?? NaN);
    if (Number.isFinite(ck)) bake.focusK.value = ck;
    setCausticContext({ hf, bake, sunDir: sunU.dir });
    engine.onUpdate(() => bake.update(engine.renderer));
  }

  // Phase 6 wind: global gust field for all vegetation (?wind=N strength,
  // ?winddir=deg, ?ablate=wind to A/B) — context before veg materials build
  if (!ablate.has('wind') && hf.noiseA) {
    setWindContext({ noiseA: hf.noiseA, canopyTex });
    const q0 = new URLSearchParams(window.location.search);
    const ws = Number(q0.get('wind') ?? NaN);
    if (Number.isFinite(ws)) windU.strength.value = ws;
    const wdeg = Number(q0.get('winddir') ?? NaN);
    if (Number.isFinite(wdeg)) {
      windU.dir.value.set(Math.cos((wdeg * Math.PI) / 180), Math.sin((wdeg * Math.PI) / 180));
    }
  }

  // [GAVDOS-STRUCT-HOOK] Load road-mask texture for terrain shading (gavdos only)
  let gavdosRoadMaskTex: Texture | null = null;
  if (params.world === 'gavdos') {
    try {
      gavdosRoadMaskTex = await new Promise<Texture>((resolve, reject) => {
        new TextureLoader().load('/gavdos/roadmask.png', (t) => { t.anisotropy = 8; t.generateMipmaps = true; resolve(t); }, undefined, reject);
      });
    } catch {
      // roadmask texture optional — roads just won't tint terrain
    }
  }

  // Crete land mask (rasterised OSM/cadastre coastline; r ≈ land[1]/sea[0]). Built
  // BEFORE the tiles so the terrain material can CLIP the 3D surface at the coast
  // (sea-side fragments discarded), and reused by the ocean below so both meet at
  // the same edge. null for gavdos/laas → no clip. The runtime coastline-source
  // toggle re-fills this same texture in place, keeping terrain + ocean in sync.
  let creteLandMaskTex: StorageTexture | null =
    params.world === 'crete' ? await buildCreteLandMask(engine.renderer) : null;

  ctx.progress(0.958, 'terrain: building tiles');
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'scatter') addScatterDebug(engine.scene, scatter);
  let tiles: TerrainTiles | null = null;
  if (view === 'split' && hf.preErosion) {
    // erosion before/after: pre-erosion clay on the left, eroded on the right
    const pre = new TerrainTiles(hf, null, {
      heightBuf: hf.preErosion,
      neutral: true,
      screenHalf: 'left',
    });
    const post = new TerrainTiles(hf, null, { neutral: true, screenHalf: 'right' });
    engine.scene.add(pre.mesh, post.mesh);
    engine.onUpdate(() => {
      pre.update(engine.camera);
      post.update(engine.camera);
    });
  } else {
    tiles = new TerrainTiles(hf, view, {
      gi,
      canopyTex,
      roadMaskTex: gavdosRoadMaskTex,
      // Crete is a ~280 km island in a ~10 km world (≈137 m/texel): suppress
      // the meso/micro detail + rock-strata zebra that alias into B/W speckle.
      // false for gavdos/laas → their shading is unchanged.
      overview: params.world === 'crete',
      // Crete coast-cut: clip the 3D surface at the chosen coastline (sea-side
      // fragments discarded) so the map ends at the shore and the ocean meets it
      // cleanly. Re-enabled now the 16-texture limit is fixed (Engine.ts requests
      // the adapter max). ?coastcut=0 disables it for A/B.
      landMaskTex:
        new URLSearchParams(window.location.search).get('coastcut') === '0'
          ? null
          : creteLandMaskTex,
    });
    engine.scene.add(tiles.mesh);
    engine.scene.add(tiles.farShell);
    // ?ablate=proxy — drop the terrain shadow caster (shadow-debug bisect)
    if (!ablate.has('proxy')) engine.scene.add(buildTerrainShadowProxy(hf));
    engine.onUpdate(() => {
      (tiles as TerrainTiles).update(engine.camera);
      engine.stats.counters['terrain.tiles'] = (tiles as TerrainTiles).activeTiles;
    });
  }

  // Phase 6: stream/lake water clipmap (?ablate=water to A/B)
  // Gavdos: WaterMaterial requires hf.flow (hydrology); gavdos has none.
  // [GAVDOS-WATER-HOOK] — T3 ocean: GavdosOcean replaces WaterSurface + far shell.
  if (view !== 'split' && !ablate.has('water')) {
    if (params.world === 'gavdos' || params.world === 'crete') {
      // Real Mediterranean ocean: no flow field required.
      // Far shell already added above is the procedural terrain ring — hide it
      // for gavdos (the far sea disc inside GavdosOcean replaces it).
      if (tiles) tiles.farShell.visible = false;
      // crete: sharp-trim the sea at the OSM coastline via the rasterized land mask
      // already built above (same texture the terrain coast-cut uses). gavdos = null.
      const landMask = creteLandMaskTex;
      const ocean = new GavdosOcean(
        hf,
        sunSky.atmosphere,
        ablate.has('gi') ? null : gi,
        landMask,
      );
      engine.scene.add(ocean.group);
      engine.onUpdate(() => ocean.update(engine.camera));

      // Crete beach shell/pebble scatter (instanced low-poly cards for speed).
      // Fast: low count (capped), aggressive distance cull, cheap plane cards.
      // Uses CreteCoastline-conditioned heights + CreteLandMask (via coastal h band).
      // Placement scans cpuHeights (cheap O(res) at boot). Interacts with water via
      // terrain sand wet/runup (pebbles sit on animated wet/dry PBR sand).
      if (params.world === 'crete' && hf.cpuHeights) {
        const MAX_BEACH = 14000;
        const STEP = 3; // subsample the height grid for coastal only
        const BEACH_H0 = 0.15, BEACH_H1 = 8.5;
        const pos: Array<{x:number; y:number; z:number; yaw:number; s:number; c:number}> = [];
        const res = hf.res;
        const ws = worldSize();
        const cell = ws / res;
        const rng = (i: number) => ((i * 1664525 + 1013904223) >>> 0) / 0xffffffff;
        for (let y = 1; y < res - 1; y += STEP) {
          for (let x = 1; x < res - 1; x += STEP) {
            const i = y * res + x;
            const h = hf.cpuHeights[i] ?? 0;
            if (h <= BEACH_H0 || h >= BEACH_H1) continue;
            if (rng(i) > 0.22) continue;
            const wx = ((x + 0.5) / res - 0.5) * ws;
            const wz = ((y + 0.5) / res - 0.5) * ws;
            const jitter = (rng(i+7)-0.5) * cell * 0.8;
            const jz = (rng(i+11)-0.5) * cell * 0.8;
            const hy = hf.heightAtCpu(wx + jitter, wz + jz) + 0.018 + rng(i+3) * 0.03;
            if (hy < 0.05) continue;
            pos.push({
              x: wx + jitter, y: hy, z: wz + jz,
              yaw: rng(i+5) * Math.PI * 2,
              s: 0.12 + rng(i+9) * 0.19,
              c: rng(i+13),
            });
            if (pos.length >= MAX_BEACH) break;
          }
          if (pos.length >= MAX_BEACH) break;
        }
        if (pos.length > 0) {
          // low-poly card (two tri) — threejs-geometry (low poly) + cards for speed.
          const card = new PlaneGeometry(0.9, 0.6);
          card.rotateX(-Math.PI * 0.5 + 0.12);
          const beachMat = new MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.82, envMapIntensity: 0.15 });
          const inst = new InstancedMesh(card, beachMat, pos.length);
          inst.castShadow = true; inst.receiveShadow = true;
          const m4 = new Matrix4(); const eul = new Euler(); const col = new Color();
          pos.forEach((p, k) => {
            eul.set(0, p.yaw, (p.c - 0.5) * 0.11);
            m4.makeRotationFromEuler(eul);
            m4.setPosition(p.x, p.y, p.z);
            const sc = p.s * (0.7 + (p.c > 0.6 ? 0.35 : 0));
            m4.scale(new Vector3(sc, sc * (0.6 + p.c * 0.1), sc));
            inst.setMatrixAt(k, m4);
            col.set(p.c > 0.62 ? 0xe8d9b8 : (p.c > 0.38 ? 0xb8b2a3 : 0x8f8a7f));
            inst.setColorAt(k, col);
          });
          inst.instanceMatrix.needsUpdate = true;
          if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
          engine.scene.add(inst);

          // Aggressive distance cull (fast first). Repack near matrices.
          const CULL = 520;
          engine.onUpdate(() => {
            const cx = engine.camera.position.x, cy = engine.camera.position.y, cz = engine.camera.position.z;
            const near: number[] = [];
            for (let k = 0; k < pos.length; k++) {
              const p = pos[k];
              const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
              if ((dx * dx + dy * dy + dz * dz) < CULL * CULL) near.push(k);
            }
            if (near.length === 0) { inst.count = 0; return; }
            for (let j = 0; j < near.length; j++) {
              inst.getMatrixAt(near[j], m4);
              inst.setMatrixAt(j, m4);
              if (inst.instanceColor) { inst.getColorAt(near[j], col); inst.setColorAt(j, col); }
            }
            inst.count = near.length;
            inst.instanceMatrix.needsUpdate = true;
            if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
          });
          // eslint-disable-next-line no-console
          console.log(`[crete] beach pebbles: ${pos.length} instanced cards (cull ${CULL}m)`);
        }
      }
    } else {
      const water = new WaterSurface(
        hf,
        sunSky.atmosphere,
        canopyTex,
        ablate.has('gi') ? null : gi,
      );
      engine.scene.add(water.group);
      engine.onUpdate(() => water.update(engine.camera));
    }
  }

  // Phase 5: variant pools + GPU cull → compacted indirect draws
  let forestsRef: Forests | null = null;
  if (view !== 'scatter' && !ablate.has('veg')) {
    // Crete reuses the gavdos Mediterranean library (juniper/pine/olive + phrygana)
    // so its trees look right for a Greek island, with the same LOD/impostor/shadow
    // rendering as the default scene.
    const lib = params.world === 'gavdos' || params.world === 'crete'
      ? await buildGavdosVegLibrary(engine.renderer, seed, (p, m) =>
          ctx.progress(0.963 + p * 0.006, m))
      : await buildVegLibrary(engine.renderer, seed, (p, m) =>
          ctx.progress(0.963 + p * 0.006, m));
    const forests = new Forests(
      hf,
      scatter,
      lib,
      ablate.has('gi') ? null : gi,
      canopyTex,
    );
    forests.init(engine.renderer);
    forestsRef = forests;
    engine.scene.add(forests.group);
    updateSunUniforms(sunSky.sun);
  if (params.world === 'crete') {
    // Aegean beach pop: stronger direct sun for wet-sand specular + bright land
    sunSky.sun.intensity = Math.max(sunSky.sun.intensity, 5.8);
  }
    engine.onUpdate(() => {
      forests.update(engine.renderer, engine.camera);
      Object.assign(engine.stats.counters, forests.counterSnapshot());
    });

    // near-field carpets: 800k-blade grass ring + 80k debris ring
    if (!ablate.has('grass')) {
      // Crete uses the gavdos Mediterranean library, so its grass takes the same
      // dry-golden bias + phrygana atlas (the 'beech' atlas only exists in the laas
      // library). Crete a touch less golden than arid Gavdos.
      const grassDryBias =
        params.world === 'gavdos' ? GAVDOS_DRY_BIAS : params.world === 'crete' ? 0.7 : 0;
      const ring = new GroundRing(hf, canopyTex, seed, ablate.has('gi') ? null : gi, grassDryBias);
      const medLib = params.world === 'gavdos' || params.world === 'crete';
      const atlasRef = medLib
        ? (lib.atlases.get('phrygana') ?? lib.atlases.get('gavdosJuniper') ?? null)
        : lib.atlases.get('beech') ?? null;
      ring.init(atlasRef);
      engine.scene.add(ring.group);
      engine.onUpdate(() => {
        ring.update(engine.renderer, engine.camera);
        Object.assign(engine.stats.counters, ring.counterSnapshot());
      });
    }

    // far forests: aggregate canopy shell beyond the impostor mid-band
    if (!ablate.has('shell')) {
      engine.scene.add(buildCanopyShell(hf, canopyTex));
    }
  }

  // [GAVDOS-STRUCT-HOOK] T5: buildings/walls from OSM vectors (gavdos only)
  if (params.world === 'gavdos' && !ablate.has('structures')) {
    ctx.progress(0.969, 'gavdos: placing buildings and walls');
    const structs = await buildGavdosStructures(engine.renderer, hf);
    engine.scene.add(structs.buildingsMesh);
    engine.scene.add(structs.wallsMesh);
    console.log(
      `[gavdos] structures: buildings placed=${structs.buildingCount}` +
      ` wallSegments=${structs.wallSegmentCount}` +
      ` roadMaskWired=${structs.roadMaskWired}`,
    );
  }

  // volumetric clouds (noise bake + sun-shadow map)
  ctx.progress(0.97, 'sky: baking cloud noise');
  const clouds = new Clouds(sunSky.atmosphere);
  await clouds.init(engine.renderer);
  // Crete = map explorer: thin/sparse clouds so they never white out the cadastre
  // map + greenery (default 0.62/0.85 covered the whole island). ?cov/?dens override.
  if (params.world === 'crete') {
    const cq = new URLSearchParams(location.search);
    if (!cq.has('cov')) clouds.coverage.value = 0.20;
    if (!cq.has('dens')) clouds.density.value = 0.45;
  }
  // weather motion (Pillar F): drift on WORLD time so ?freeze=1 shots stay
  // deterministic; the drifted shadow map re-bakes itself every ~2.5 s
  let lastWt = 0;
  engine.onUpdate((_dt, wt) => {
    clouds.tick(engine.renderer, wt - lastWt);
    lastWt = wt;
  });

  // 4-cascade CSM + PCSS contact hardening; cloud shadows gate the sun term
  // Crete 280 km world: pass large maxFar + lightMargin so distant massifs cast
  // into valleys/beaches. Per-cascade map sizes for tight near + cheap far.
  // (Gallery/ShadowTest keep their small values for their ~1 km test scenes.)
  const isCrete = params.world === 'crete';
  const shadowOpts = isCrete
    ? {
        maxFar: 95000,
        lightMargin: 4500,
        cascadeMapSizes: [2048, 1536, 1024, 512],
      }
    : undefined;
  const shadowRig = setupSunShadows(sunSky.sun, engine.camera, (wxz) =>
    clouds.shadowAt(wxz),
    shadowOpts,
  );
  // cascade cameras drive the per-cascade caster cull in Forests
  forestsRef?.setCSM(shadowRig.csm ?? null);
  (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg = {
    engine,
    sunSky,
    shadowRig,
  };

  // GPU particles: snow/pollen/leaves riding the wind (?ablate=particles)
  if (view !== 'split' && !ablate.has('particles')) {
    const parts = new Particles(hf, canopyTex, ablate.has('gi') ? null : gi);
    engine.scene.add(parts.mesh);
    engine.onUpdate((dt) => parts.update(engine.renderer, engine.camera, dt));
    engine.stats.counters['particles'] = PARTICLE_COUNT;
  }

  // froxel volumetrics: canopy shafts + valley fog (?ablate=froxels, ?fog=N)
  let froxels: Froxels | null = null;
  if (!ablate.has('froxels')) {
    froxels = new Froxels(hf, sunSky.atmosphere, canopyTex, clouds);
    const fq = Number(new URLSearchParams(window.location.search).get('fog') ?? NaN);
    if (Number.isFinite(fq)) froxels.fogK.value = fq;
    const fx = froxels;
    engine.onUpdate(() => fx.update(engine.renderer, engine.camera));
  }

  // HDR post stack: aerial perspective, clouds, GTAO, TRAA, bloom, exposure, grade
  ctx.progress(0.98, 'post: building pipeline');
  const post = new PostStack(engine, sunSky.atmosphere, bootTod, clouds, froxels);
  engine.post = post;

  ctx.hooks.setTimeOfDay = (t: number) => {
    void (async () => {
      await sunSky.setTimeOfDay(t);
      await clouds.refreshShadow(engine.renderer);
      gi.invalidate();
      post.setTimeOfDay(t);
    })();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      void clouds.refreshShadow(engine.renderer);
      post.setTimeOfDay(sunSky.timeOfDay);
    }
  });

  // terrain/water probe for the camera rig: walk-mode ground physics + the
  // fly-mode soft collision / underwater guard both live in FlyCamera now
  ctx.hooks.groundProbe = (x, z) => ({
    ground: hf.heightAtCpu(x, z),
    water: hf.waterYAtCpu(x, z),
  });

  // camera spawn: ground-clamped (?alt/x/z → fly) or the DEFAULT WALK SPAWN
  // at the map center — first dry, reasonably flat spot on a spiral out
  // from (0,0), eye at head height, facing the NE massif
  // Gavdos/crete spawn is set inside the world-branch above; skip this block for them.
  const q = new URLSearchParams(window.location.search);
  const alt = Number(q.get('alt') ?? NaN);
  if (params.cam === null && params.world !== 'gavdos' && params.world !== 'crete') {
    if (Number.isFinite(alt)) {
      const x = Number(q.get('x') ?? 600);
      const z = Number(q.get('z') ?? 900);
      const yaw = Number(q.get('yaw') ?? 2.4); // rad; 0 = looking −z (north)
      const pitch = Number(q.get('pitch') ?? -0.04); // rad; negative = down
      const y = hf.heightAtCpu(x, z) + alt;
      // the fly camera doesn't exist yet — main applies this after rigging
      ctx.hooks.initialPose = { p: [x, y, z], yaw, pitch };
      ctx.hooks.initialPoseMode = 'fly';
      engine.camera.position.set(x, y, z);
    } else {
      const spawn = findWalkSpawn(hf);
      ctx.hooks.initialPose = {
        p: [spawn.x, hf.heightAtCpu(spawn.x, spawn.z) + 1.7, spawn.z],
        yaw: -0.78, // face NE — the serrated massif anchors the first frame
        pitch: -0.02,
      };
      ctx.hooks.initialPoseMode = 'walk';
      engine.camera.position.set(spawn.x, ctx.hooks.initialPose.p[1], spawn.z);
    }
  }

  // composed bookmarks (keys 1-9, ?shot=N) + 92 s flythrough (?fly=1 / F)
  installBookmarks(engine, hf, ctx.hooks, params);

  // on-screen camera-view buttons: Ground / Beach / House + Drone-orbit toggle
  installViewButtons(engine, hf, ctx.hooks, params);

  // Beach POI markers (Crete world only) — DOM-overlay photo cards + leader lines.
  installBeachMarkers(engine, hf, ctx.hooks, params);

  // Extruded 3D buildings (Crete world only) — merged per-town, distance-culled.
  // ?nanite=1: skip the real Chania bucket — Nanite renderer covers it.
  // NB: town index 1 ([24.02]) holds the dense Chania-city buildings (≈5,633);
  // index 0 ([23.7], labelled "Chania") is ~30km west and catches ~none.
  const naniteSkip = params.nanite ? new Set([1]) : new Set<number>();
  installCreteBuildings(engine, hf, params, naniteSkip);

  // T3b Nanite: one indirect indexed-instanced draw for all 961 LOD0 Chania clusters.
  if (params.nanite) {
    buildNaniteChaniaMesh()
      .then((mesh) => {
        engine.scene.add(mesh);
        console.log('[nanite] T3b: Chania LOD0 mesh added (961 clusters, 1 draw call)');
      })
      .catch((e) => console.error('[nanite] buildNaniteChaniaMesh failed', e));
  }

  // Draped road ribbons (Crete world only) — merged, altitude-culled.
  installCreteRoads(engine, hf, params);

  // Real OSM-placed greenery (Crete world only): sparse instanced 3D trees inside
  // actual wood/park polygons + flat translucent lakes for real inland water.
  // Async (fetches greenery.json); altitude-culled; cadastre map stays visible.
  // Trees now come from the Forests pipeline (CreteScatter); CreteGreenery keeps
  // only the inland lakes. ?veg=0 (map-only) → restore the simple cone trees.
  installCreteGreenery(engine, hf, params, {
    trees: new URLSearchParams(window.location.search).get('veg') === '0',
  });

  // Live map-tile streaming (Crete world only): re-textures the terrain drape
  // with high-zoom Hellenic Cadastre orthophoto tiles for the visible footprint
  // as the camera zooms/moves. No-op unless the satellite drape loaded. Runs
  // after the tiles mesh is added so the material already references hf.satWin.
  installCreteMapStream(engine, hf, params);

  // Detected coastline drawn as a bright line over the surface (Crete only), visible
  // at every zoom + a 3-state Coast button (cadastre / osm / off). Async (fetches geojson).
  // Once the overlay exists, register setCoastlineSource to switch BOTH detectors at
  // runtime: re-fill the ocean's land mask in place from the chosen source AND retarget
  // the overlay line. 'off' keeps the LAST ocean mask (re-filling needs a source) and
  // just hides the overlay line — simplest, and the trim is invisible without the line.
  installCreteCoastlineOverlay(engine, hf, ctx.hooks, params)
    .then((overlay) => {
      if (!overlay) return;
      ctx.hooks.setCoastlineSource = async (s) => {
        if (s !== 'off' && creteLandMaskTex) {
          await refillCreteLandMask(engine.renderer, creteLandMaskTex, s);
        }
        await overlay.setSource(s);
      };
    })
    .catch((e) => console.error('[crete] coastline overlay failed', e));

  ctx.progress(1, 'terrain ready');
}

/**
 * Default walk spawn: first dry, reasonably flat spot on a coarse spiral
 * out from the map center (dry = waterY sits below the bed there; flat =
 * central-difference slope under ~19°).
 */
function findWalkSpawn(hf: Heightfield): { x: number; z: number } {
  for (let r = 0; r <= 240; r += 12) {
    const steps = Math.max(1, Math.round((2 * Math.PI * r) / 18));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = hf.heightAtCpu(x, z);
      if (hf.waterYAtCpu(x, z) > h - 0.05) continue; // wet or waterline
      const sx = hf.heightAtCpu(x + 6, z) - hf.heightAtCpu(x - 6, z);
      const sz = hf.heightAtCpu(x, z + 6) - hf.heightAtCpu(x, z - 6);
      if (Math.hypot(sx, sz) / 12 > 0.35) continue; // too steep
      return { x, z };
    }
  }
  return { x: 0, z: 0 };
}
