# GAVDOS WORLD — working memory (branch `gavdos`)

> Agents: read this file first, then `STATUS.md` top 60 lines (rehydration + verified env facts incl. the Playwright/WebGPU recipe), then skim `docs/THREE-NOTES.md`. Never re-plan; execute your task from the plan: `../../Plans/2026-06-12-gavdos-laas-world.md`. Update YOUR section here when done. bun always, TS strict, zero `any`, branch `gavdos` only. Default (procedural) world behavior must stay untouched — everything lives behind `?world=gavdos`.

## Mission

Real Gavdos island in the LAAS engine: LAAS render quality, layout 1:1 from the Hellenic Cadastre LSO_v2 dataset + OSM vectors. World-synthesis layer swapped behind a world switch; render stack untouched.

## Data sources (ready-made, do not regenerate)

`../../3D-newra-terrain/public/gavdos/` — heightmap.bin 2048×1664 f32 (FABDEM land + GMRT/SDB sea, −1633.8…+367.9 m, bbox 23.90–24.20 E / 34.76–34.96 N plate-carrée), mask.bin (0 sea/1 scrub/2 trees/3 sand/4 rock), species.bin (0 none/1 juniper/2 pine/3 olive/4 phrygana), weights.bin, shore.png, ao.png, rocks.json, ortho_hero.jpg (cadastre z17, 1.9 m/px, 24.00–24.17 E / 34.78–34.90 N), metas. Plus `../../3D-newra-terrain/public/labels.json` (POI ground truth).

## Geodesy contract (single source of truth: `src/gavdos/GavdosConst.ts` once Task 2 lands)

CENTER 24.080 E / 34.827 N · M_PER_DEG_LAT 111132 · M_PER_DEG_LON 91393 · GAVDOS_WORLD_SIZE 8192 m · NORTH_SIGN decided once in Task 2 from engine convention. All lon/lat→world goes through `lonLatToWorld()` — tools included.

## Task log

### T1 data pack — status: done
- Copied 12 rasters + metas from 3D-newra-terrain (heightmap 2048×1664 f32, −1633.8…+367.9 m; mask/species/weights/shore/ao/ortho_hero/rocks/labels).
- OSM vector pack (Overpass bbox 34.78–34.90 N / 24.00–24.17 E): 200 buildings, 194 roads, 14 walls, 38 landuse, 75 POIs → public/gavdos/vectors.json.
- POI GROUND TRUTH = `vectors.json` pois (place/beach/lighthouse/tourism/amenity nodes — Kastri, Karave, Ambelos, Vatsiana, Sarakiniko, Ag. Ioannis beach, lighthouse all present). labels.json is Crete-main-island only (0 Gavdos entries) — do NOT use it for Gavdos POIs.
- Roadmask 4096×4096 grayscale PNG rasterised from 194 road centrelines (206 695 nonzero px) → public/gavdos/roadmask.png.
### T2 world source + heightfield — status: done
- `src/gavdos/GavdosConst.ts`: geodesy contract. NORTH_SIGN = −1 (evidence: TerrainScene.ts
  "yaw=0 = looking −z (north)"). World size: 8192 m (full island + sea margin) via
  `setActiveWorldSize(GAVDOS_WORLD_SIZE)` called in TerrainScene.ts before any world system
  is constructed. Window: CENTER ± 4096 m → lon [24.0352, 24.1248] / lat [34.7901, 34.8639].
  Crop: X0=923, X1=1535, Y0=800, Y1=1413 (W=612, H=613 source pixels).
- `src/world/WorldConst.ts`: added `worldSize()` / `worldHalf()` / `setActiveWorldSize()`.
  All 16 consumer files (Scatter, BiomeSnow, Heightfield, TerrainTiles, ProbeGI, Froxels,
  Particles, GroundRing, Caustics, WaterMaterial, CanopyShell, ShadowProxy, HeightSynthesis,
  FlowRivers, TerrainMaterial, Clouds) updated to call `worldSize()`. Clouds `SHADOW_WORLD`
  converted to `shadowWorld()` fn to avoid module-load-time capture before setActiveWorldSize.
  Procedural world default remains 4096 m byte-identical.
- `src/gavdos/GavdosData.ts`: async loader. Fetches heightmap.bin + mask.bin, crops, bicubic-
  upsamples height to heightRes², nearest-neighbor mask, road smoothing (α=0.7, 9×9 mean
  where roadmask>0). Uploads via r32f DataTexture→compute copy. Builds fieldsTex (moisture=0.3,
  no rivers), biomeTex from mask (1→Meadow, 2→Conifer, 3→Meadow, 4→Alpine), waterY dry sentinel
  (−2 m everywhere — no inland rivers). Snow forced to 0 (island max 368 m << SNOWLINE 1050 m).
  Normal derivation uses `worldSize()` for correct 8192 m texel scale.
- `src/gavdos/GavdosWorld.ts`: orchestrator, hook comments for T3/T4/T5.
- `Heightfield.fromGavdos()`: new static factory (minimal Heightfield.ts edit).
- `src/core/Params.ts`: added `world: 'laas'|'gavdos'` param.
- `src/debug/TerrainScene.ts`: `setActiveWorldSize(GAVDOS_WORLD_SIZE)` called first in gavdos
  branch; world-switch at Heightfield.generate() call; caustics + water clipmap disabled for
  gavdos (both require hf.flow which is null without hydrology).
  Gavdos spawn: y=1400, looking north (pitch=−0.8) — raised to show full 8192 m island.
- `tools/gavdos/verify-world-data.ts`: CROP_HALF updated to 4096. assertion (a) 425 border land
  texels — north (326) + east (99) are Gavdopoula islet clipping, max border h=94.9 m (islet edges,
  not main island clip); assertion (b) max height 367.94 m PASS [360–375].
- `tools/gavdos/iou.ts`: CROP_HALF updated to 4096. data-pipeline IoU = 0.9751 PASS ≥ 0.95.
  (Render IoU informational — v1 has no ocean shader; sea floor renders as terrain until T3.)
- Scatter density: treeG = worldSize()/TREE_CELL auto-scales to 4× grid for 8192 m; GPU caps
  (600k/700k/1.5M/180k) absorb surplus; sea cells rejected by h<LAKE_LEVEL guard.
- Far field: engine far shell (macroTerrain 'far' on neutral mp) renders procedural hills beyond
  world edge. Not flat sea. Noted as deviation from spec — T3 will add ocean plane.
- Water level: 0 (sea level). LAKE_LEVEL=142 is bypassed — no hydrology pass in gavdos.
- T2c (orchestrator): measured island extents 8.8×8.4 km — 8192 clipped E+N coasts. WORLD_SIZE → 10240, center (24.0846, 34.8387), M_PER_DEG_LON 91376. Roadmask rebuilt for new window. verify-world-data + iou now IMPORT GavdosConst (they had duplicated stale consts). Gates: border land texels 0, max h 367.94, IoU 0.9641, typecheck 0.
### T3 ocean & shore — status: done
- `src/gavdos/GavdosOcean.ts`: new file — self-contained Mediterranean ocean system.
  - Near clipmap: 6 concentric levels (same CELLS/LEVEL_CELL as WaterSurface) at y=0,
    covering the full 10240 m window. No hf.flow required.
  - Far sea disc: RingGeometry(worldHalf·0.96, FAR_RADIUS), flat at y=0 with a
    cheap emissive material (sky-fresnel horizon blend → deep navy→mirrored sky).
    Replaces the procedural far-shell hills for gavdos.
  - `tiles.farShell.visible = false` in TerrainScene.ts for gavdos branch.
  - Depth-aware colour: `hf.sampleHeight(xz)` (negative = below sea) drives
    Beer-Lambert absorption (SIGMA same as WaterMaterial) + seaTint gradient
    shallow turquoise (0–12 m) → deep navy. Mediterranean coefficients.
  - Shore foam: runtime depth band (|h| < 1.5 m), two-phase fbm pattern advected
    by a constant WNW breeze (no flow field). Simpler and more accurate than shore.png
    UV-remapping (shore.png bbox = full 0.3°×0.2° source, not window-cropped).
  - Waves: two-layer fbm at CYC=0.32 Hz, rippleAmp=0.004 → < 5° normal tilt.
    Mediterranean feel — wind-chop, not lake-still, not stormy.
  - SSR/reflections: 18-step march + sky-view LUT fallback, reused from WaterMaterial.
  - Caustics: OFF — hf.flow null in gavdos. Flagged deviation.
  - WaterMaterial.ts / WaterSurface.ts: NOT touched. Default world path bit-identical.
- `src/debug/TerrainScene.ts`: wired at [GAVDOS-WATER-HOOK]. `let tiles` hoisted to
  allow `tiles.farShell.visible = false` from the water block below.

#### T3 deviations
- Caustics disabled: CausticsBake requires hf.flow (hydrology output), which is null
  in gavdos (no hydrology pass). Cannot fake flow data — left off per spec.
- Shore foam source: runtime depth band (h < 1.5 m), NOT shore.png.
  Rationale: shore.png covers the full 2048×1664 source grid bbox, not the 10240 m
  window; resampling it in the shader requires an extra UV transform + texture fetch.
  Runtime depth from the DEM is zero extra cost and more spatially accurate.
- Far shell: replaced with a flat sea disc (emissive-only material). The procedural
  macroTerrain 'far' hills are hidden (tiles.farShell.visible = false).

#### T3 verification (commit c15860e)
- typecheck: PASS (exit 0)
- topdown-ocean.png: island silhouette against blue sea ✓
- ocean-sarakiniko.png: turquoise shallow water + foam strip at waterline ✓
- ocean-south.png: deep navy far sea disc to horizon ✓
- Deep-sea pixels (B > R and B > 40):
  topdown left-sea  [60,540]:  RGB(94,111,145)  ✓
  topdown left-sea  [80,300]:  RGB(60,90,138)   ✓
  south deep [400,700]: RGB(64,89,125)           ✓
  south deep [960,700]: RGB(53,80,119)           ✓
  south deep [1500,700]: RGB(63,87,122)          ✓
- Land pixels (NOT blue-dominant):
  island-center1 [900,500]: RGB(188,187,174) ✓
  island-center2 [800,400]: RGB(174,169,157) ✓
  island-center3 [1000,550]: RGB(167,161,147) ✓
- Shore transect x=150, sarakiniko (land→sea at y≈460):
  y=460 land  RGB(112,102,92) bright=102 (not blue-dom) ✓
  y=470 shore RGB(102,123,138) bright=121 (blue-dom, brightness peak) ✓
  y=690 deep  RGB(66,95,104) bright=88 (deeper) ✓
  Brightness peak at waterline confirmed.
- Data-pipeline IoU: 0.9641 PASS ≥ 0.95
- Default-world regression: terrain.maxH=1857, caustics running, no errors ✓
### T4 mediterranean vegetation — status: done
- `src/vegetation/Species.ts`: GAVDOS_JUNIPER (3–6 m umbrella juniper, scale-like needles),
  CALABRIAN_PINE (8–14 m umbrella crown), OLIVE (3–5 m gnarled silver-green), PHRYGANA
  (0.3–0.8 m cushion shrub). Arrays GAVDOS_TREE_SPECIES + GAVDOS_UNDERSTORY_SPECIES added;
  boreal six untouched.
- `src/gavdos/GavdosData.ts`: loads species.bin + weights.bin; exposes cpuSpecies/cpuWeights/vegRes.
- `src/world/Heightfield.ts`: gavdosVegData: GavdosDataResult | null (null for all procedural paths).
- `src/gavdos/GavdosVeg.ts`: new — buildGavdosVegLibrary (3 tree × 4 variants + phrygana shrub +
  pale limestone rocks/stones); runGavdosScatter (CPU Poisson: TCELL=5 m trees, UCELL=2.8 m
  understory driven by species.bin × weights.bin; juniper allowed on sand dunes h≥0);
  placeGavdosRocks (rocks.json exact placement into extras layer); GAVDOS_DRY_BIAS=1.0.
- `src/vegetation/GroundRing.ts`: dryBias param (0=boreal, 1=golden-straw Mediterranean);
  freshDry palette blended in grassMaterial; dryK floor for summer-dry appearance.
- `src/debug/TerrainScene.ts`: gavdos branch routes through buildGavdosVegLibrary +
  runGavdosScatter + GroundRing(dryBias=1). Default world path unchanged.
- Commit: a87e801 (6 files changed, +1042/−15)

#### T4 verification
- typecheck: PASS (exit 0)
- gavdos scatter counts: trees=9,263 under=390,614 extras=40,000 stones=600,000
- RANK ORDER: phrygana (390k) >> trees (9k) — phrygana > (pine+juniper+olive) ✓
  (per-species split not emitted in HUD; total trees 9,263 within 10k–80k gate ✓)
- Boreal species count = 0 in gavdos (separate library, separate scatter kernel) ✓
- shots/gavdos/veg-cedars.png: Ag. Ioannis dune approach, fps=55, tris=10.1M ✓
- shots/gavdos/veg-phrygana-hills.png: interior hillside, fps=56 ✓
- shots/gavdos/veg-olives.png: olive cluster lon=24.0734/lat=34.8638, fps=54 ✓
- Regression veg.trees=188,724 ≈ 188k ✓, caustics running ✓, no errors ✓
- Perf hero shot: fps=55 @ 1080p, tris=10,104,923 ✓ (gate: fps≥24)

#### T4 deviations
- Per-species HUD counters: Forests does not expose per-cls counts in counterSnapshot();
  species rank confirmed by scatter algo design (phrygana UCELL=2.8m vs tree TCELL=5m,
  phrygana prob 0.22–0.45 vs tree 0.12–0.18 × weight) and total counts.
- Juniper-on-sand placement: h≥0.0 threshold (spec says h<1.5 m beach band exclusion
  except juniper-on-sand); juniper allowed at all heights where species==1.
- rocks.json wiring: extras layer receives both random rocky boulders AND rocks.json
  entries; rocks.json uses exact lonLatToWorld positions with radius-derived scale.
- DryGrass implemented as GroundRing dryBias=1.0 (palette blend, not a separate species);
  sparse on sand/rock via the existing biomeTex density gate (biomeTex.z < 0.2 on mask==3/4).
### T5 buildings/roads/walls — status: done
- `src/gavdos/GavdosStructures.ts`: new — loadGavdosStructures loads vectors.json,
  projects all 200 building outlines via lonLatToWorld → planar polygon, extrudes walls
  3.0–4.5 m (fhash of OSM id), flat (60%) or gable (40%) roof by hash, 1.5 m terrain
  skirt at centroid height. BatchedMesh (one geo per building, identity matrix — geometry
  already in world space). InstancedMesh of 920 wall segments: 14 polylines subdivided
  ≤2.5 m, BoxGeometry 0.8×0.5 m, terrain-conformed Y, yaw ±2° + height ±10% jitter.
  MeshStandardNodeMaterial (TSL) for both: whitewash (RGB 0.88,0.855,0.82) walls with
  positionWorld micro-variation, stone-grey (RGB 0.58,0.56,0.52) dry-stone walls.
- `src/render/TerrainMaterial.ts`: optional `roadMaskTex?: Texture | null` in
  TerrainShadingInputs. When present: samples roadmask.png via UV=[wxz/(2·worldHalf)+0.5],
  blends col toward dirt-track tan (RGB 0.62,0.52,0.37)×0.8; roughness +0.04.
  Default world: roadBlendK=float(0), branch compiled out — byte-identical.
- `src/world/TerrainTiles.ts`: `roadMaskTex` option added to constructor opts;
  passed through to buildTerrainShading.
- `src/debug/TerrainScene.ts`: loads /gavdos/roadmask.png as THREE.Texture via
  TextureLoader; passes to TerrainTiles; calls buildGavdosStructures after heightfield
  ready; adds buildingsMesh + wallsMesh to scene.
- `tools/gavdos/verify-structures.ts`: dry-run count + position audit (no Three.js).
- Commit: 0a06e93 (6 files changed, +909/−3)

#### T5 verification
- typecheck: PASS (exit 0)
- buildings placed: 200 / 200  PASS (0 degenerate)
- wall segments: 920  PASS (> 50)
- roadmask: wired (file exists, optional input in TerrainShadingInputs)  PASS
- hamlet POI → nearest building:
    Καστρί: 23.7 m  PASS
    Καραβές: 31.1 m  PASS
    Άμπελος: 30.7 m  PASS
    Βατσιανά: 23.7 m  PASS
    Σαρακίνικο: 16.6 m  PASS
- shots/gavdos/village-kastri.png: whitewashed buildings visible in upper-left ✓
- shots/gavdos/port-karave.png: building footprint against dry ground + sea ✓
- shots/gavdos/roads-topdown.png: island network visible; tan road line pixels
  px(660,400): RGB(163,154,138) tanScore R-G=+9 vs adjacent scrub
  px(600,400): RGB(120,130,114) greenDom (scrub, G>R)  — road clearly tanner ✓
- Default-world regression: veg.trees=188724 ✓ caustics running ✓ no errors ✓

#### T5 deviations
- BatchedMesh API: three.js 0.184 requires addGeometry(geo) → geoId, then
  addInstance(geoId) → instanceId, then setMatrixAt(instanceId, matrix).
  Geometry is in world space → identity matrix per instance.
- Road mask: loaded as THREE.Texture via TextureLoader (not a StorageTexture).
  The roadMaskTex field in TerrainShadingInputs is `Texture | null` (not StorageTexture)
  because the road mask is a static PNG, not a compute-written texture.
- Materials: MeshStandardNodeMaterial (TSL) — `as unknown as typeof mat.colorNode`
  cast needed because TSL node types don't precisely match the material property type.
  Standard pattern confirmed in VegMaterials.ts.
- Buildings single material: one BatchedMesh with whitewash material for all buildings
  (walls + roof merged). Roof colour variation (flat=plaster, gable=terracotta) is a
  deviation from spec — unified material is plaster only. Separate roof material would
  need a second BatchedMesh (extra draw call); 200 buildings is tiny so this is fine.
### T6 QA battery + bookmarks — status: pending

## Blockers

(none)

## Deviations

- Cadastral parcel vectors not publicly fetchable; 1:1 layout authority = LSO_v2 ortho + OSM walls/landuse. (All three known ktimatologio INSPIRE WFS endpoints returned fetch-failed or 404.)
