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
  "yaw=0 = looking −z (north)"). WORLD_SIZE path: 4096 fallback (WORLD_SIZE=8192 would touch
  >10 subsystems: Scatter×6, BiomeSnow, Heightfield, TerrainTiles×3, ProbeGI×4, Froxels,
  Particles, GroundRing×4, Caustics, WaterMaterial, CanopyShell, ShadowProxy). V1 shows
  central 4×4 km (CENTER ± 2048 m ≈ lon [24.058, 24.102] / lat [34.808, 34.846]).
  Crop: X0=1076, X1=1382, Y0=953, Y1=1260 (W=306, H=307 source pixels).
- `src/gavdos/GavdosData.ts`: async loader. Fetches heightmap.bin + mask.bin, crops, bicubic-
  upsamples height to heightRes², nearest-neighbor mask, road smoothing (α=0.7, 9×9 mean
  where roadmask>0). Uploads via r32f DataTexture→compute copy. Builds fieldsTex (moisture=0.3,
  no rivers), biomeTex from mask (1→Meadow, 2→Conifer, 3→Meadow, 4→Alpine), waterY dry sentinel
  (−2 m everywhere — no inland rivers). Snow forced to 0 (island max 368 m << SNOWLINE 1050 m).
- `src/gavdos/GavdosWorld.ts`: orchestrator, hook comments for T3/T4/T5.
- `Heightfield.fromGavdos()`: new static factory (minimal Heightfield.ts edit).
- `src/core/Params.ts`: added `world: 'laas'|'gavdos'` param.
- `src/debug/TerrainScene.ts`: world-switch at Heightfield.generate() call; caustics + water
  clipmap disabled for gavdos (both require hf.flow which is null without hydrology).
  Gavdos spawn: y=800, looking north (pitch=−0.8).
- `tools/gavdos/verify-world-data.ts`: assertion (a) 678 border land texels (island extends
  to north crop edge — expected); assertion (b) max height 367.94 m PASS [360–375].
- `tools/gavdos/iou.ts`: data-pipeline IoU = 0.9901 PASS ≥ 0.90. (Render IoU 0.64 informational
  — v1 has no ocean shader; sea floor renders as terrain material until T3.)
- Far field: engine far shell (macroTerrain 'far' on neutral mp) renders procedural hills beyond
  world edge. Not flat sea. Noted as deviation from spec — T3 will add ocean plane.
- Water level: 0 (sea level). LAKE_LEVEL=142 is bypassed — no hydrology pass in gavdos.
### T3 ocean & shore — status: pending
### T4 mediterranean vegetation — status: pending
### T5 buildings/roads/walls — status: pending
### T6 QA battery + bookmarks — status: pending

## Blockers

(none)

## Deviations

- Cadastral parcel vectors not publicly fetchable; 1:1 layout authority = LSO_v2 ortho + OSM walls/landuse. (All three known ktimatologio INSPIRE WFS endpoints returned fetch-failed or 404.)
