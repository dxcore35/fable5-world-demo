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
### T3 ocean & shore — status: pending
### T4 mediterranean vegetation — status: pending
### T5 buildings/roads/walls — status: pending
### T6 QA battery + bookmarks — status: pending

## Blockers

(none)

## Deviations

- Cadastral parcel vectors not publicly fetchable; 1:1 layout authority = LSO_v2 ortho + OSM walls/landuse. (All three known ktimatologio INSPIRE WFS endpoints returned fetch-failed or 404.)
