# Crete on the Gavdos engine — corrected plan (Gavdos = base)

> User correction (2026-06-20): "Use Gavdos as a base and add things there. I haven't told you
> to use the 3D crit [crete-unified]." → crete-unified direction ABANDONED. Everything is built
> inside `fable5-world-demo` (the Gavdos engine, branch `gavdos`, :5173), keeping its water
> (GavdosOcean), coastline (GavdosCoastline), atmosphere (SunSky), procedural terrain + vegetation.

## Chosen architecture (user pick): "Whole Crete now, detail streams in as you fly close"
- **Base layer:** the entire island + all small islands (Dia, Chrysi/Gaidouronisi, Koufonisi,
  Dragonada/Dionysades, Paximadia, Elafonisi…) + Gavdos, rendered at once in the fable5 engine
  with its water/coastline/atmosphere. Coarser terrain far out is acceptable.
- **Streamed hero detail:** when the camera drops close to a region (a beach, Gavdos, a town),
  stream in full Gavdos-quality terrain + vegetation for that footprint.

## Honest constraint
fable5 is a single fixed-resolution world keyed to one `worldSize()` (flat local tangent plane in
`lonLatToWorld`). At Crete scale (~300 km) the base grid is coarse and the flat-plane assumption
distorts/loses precision near the edges. Plan: base world covers Crete at a manageable grid;
fidelity comes from streamed hero patches (not from enlarging the base grid). Curvature/precision
handled pragmatically (center-relative; revisit if edge distortion is visible).

## Stages
- **A. Whole-Crete BASE world in fable5** — CreteConst + CreteData + buildCreteHeightfield; load a
  Crete-wide heightmap (from crete_dem.tif) covering all islands + Gavdos; boot via `?scene=crete`;
  apply GavdosOcean water + SunSky atmosphere + coastline. CHECK: Crete + islands render with water.
- **B. Beach markers** — 418 beach GPS points as markers + label lines on the Crete base (fable5
  WebGPU — reuse the Gavdos POI/marker path, NOT the crete-unified WebGL place-cards.js).
- **C. Streamed hero detail** — TileManager: on close approach, bake/stream a Gavdos-quality
  heightfield + veg for the active region; hide base under the footprint. The core enabler.
- **D. Shore-wave water** — animated in/out swash at beaches (enhance GavdosOcean run-up).
- **E. Realistic houses + roads** — per hero region from OSM (extrude + draped ribbons).
- **F. UI** — extend fable5 ViewButtons/Bookmarks/FlyCamera: zoom, presets, 360 orbit (done),
  3D tilt, keyboard (native), FPS.
- **G. Optimization** for the big island.

## PROGRESS LOG
- **2026-06-20 — Whole-Crete base heightmap baked** → `public/crete/heightmap.bin` (3072×1088, all
  Crete + islands + Gavdos, real 30m DEM, peak 2434m) + `meta.json`. Tool: `3d/bake_crete_base.py`.
- **2026-06-20 — Stage A (whole-Crete BASE world) 🔧 built, visual pending user.** Added a parallel
  `crete` world in the fable5 engine, gavdos path untouched: `src/crete/CreteConst.ts` (geodesy,
  280km world @ center 24.875/35.24), `CreteData.ts` (`loadCreteData` — height-only, neutral biome,
  reuses Gavdos crop/bicubic/water/normal/noise + `conditionHeightsToCoastline`), `CreteWorld.ts`
  (`buildCreteHeightfield` → `Heightfield.fromGavdos`), `CreteCoastline.ts`; edits in `Params.ts`
  (+`crete` WorldSource), `main.ts` (scene→world bridge + registerScene), `TerrainScene.ts` (crete
  branch + caustics gate→laas + ocean gate +crete reuses GavdosOcean + spawn guard). Boot:
  `?scene=crete&ablate=veg,grass,shell,structures,particles`.
  FAILABLE CHECK (verified by me): `tsc` clean; src/crete only + 3 edits, gavdos core untouched;
  WebGPU inits; **terrain builds ("terrain ready"); ZERO console errors**. GAP: final RENDER not
  visually confirmed — preview tab is rAF-throttled (proven: requestAnimationFrame never fired).
  Needs user's foregrounded browser. KNOWN: preset-scene panel shows procedural bookmarks for crete
  (not Crete viewpoints) — wire crete presets later; 280km world has sea margin N/S (resizable).
- **2026-06-20 — Camera + views + water fixes (per user feedback).** (1) **Far-plane bug fixed**:
  camera far was hardcoded 30km → clipped the 280km world at the 50km spawn (terrain invisible).
  Added dynamic near/far scaled to altitude in the crete branch — terrain shows + enables big zoom-out.
  (2) **Real Crete views**: `CRETE_BOOKMARKS` (Whole island, Chania·Balos, Elafonisi, Rethymno,
  Heraklion·Knossos, Samaria·Sfakia, Elounda·Spinalonga, Gavdos) via CreteConst.lonLatToWorld, wired
  into ViewButtons scene panel + Beach→Elafonisi / House→Chania. (3) Zoom buttons now **dolly**
  (altitude-scaled pull-back), not FOV. (4) **Time-of-day** buttons (Dawn/Day/Dusk/Night → setTimeOfDay).
  (5) **Ocean scaled to Crete + shore-wave run-up/foam** (GavdosOcean far disc radius = max(FAR_RADIUS,
  worldHalf*1.5); 3 sin wave-sets move the waterline + leading foam). CHECK: typecheck clean, Crete
  boots "terrain ready", ZERO console errors (ocean TSL shader compiles). Visual = user.
- **2026-06-20 — Stage B beach markers DONE + terrain fixes.** Beach markers: `CreteBeachMarkers.ts`
  — WebGPU-safe DOM overlay (photo card + SVG leader line + name/★ label), 418 placed, culled to
  nearest 30, view distance scales with altitude. Verified: console "418 placed", no errors.
  Terrain biome variety added (CreteData: snow/veg/rock channels by elevation+slope). FPS confirmed
  working (HUD chip, 59fps in user screenshot).
- **2026-06-20 — User feedback "terrible": terrain speckle + bare.** Diagnosed: the Gavdos procedural
  meso/micro detail noise + rock-strata zebra ALIAS into black-white speckle at 280km (~137m/texel);
  no veg = bare brown. FIX 1 (done): crete-only `overview` flag in TerrainMaterial (threaded per-tile
  via TerrainTiles opts) flattens meso/micro to 0.5, flattens strata, softens slope→rock — kills
  speckle, lets biome colours read. typecheck clean, boots, no errors. gavdos/laas unchanged.
  FIX 2 (IN FLIGHT): **satellite imagery drape** — `CreteSatellite.ts` fetches ESRI World Imagery
  tiles (z10) for the DEM bbox; CreteData per-cell-resamples to a heightRes texture aligned to the
  terrain (same crop→lnglat mapping); TerrainMaterial uses it as albedo when present (snow overlay
  kept); threaded like biomeTex; `?sat=0` toggle + graceful fallback to biome. The real-texture fix.
- KNOWN: fable5 is a FLAT world (no Earth curvature → can't show a true globe; can zoom way out flat).
- **2026-06-20 — CURRENT STATE (late session), all verified by tsc + boot + zero console errors:**
  - **Satellite drape**: shipped. (Bug fixed: storage textures CANNOT be sRGB in WebGPU — make the
    StorageTexture LINEAR + `pow(2.2)` in TerrainMaterial. Also: clear `node_modules/.vite` when a
    stale cache masks edits — hit this repeatedly.)
  - **Houses**: `CreteBuildings.ts` — 34,996 OSM footprints extruded, merged per-town (4 towns),
    18km cull. (+ guarded `computeVertexNormals` so they're lit.)
  - **Roads**: `CreteRoads.ts` — 9,700 OSM segments as draped ribbons, merged, 45km cull.
  - **Depth glitch fixed (v2)**: solid-terrain clamp (camera can't enter terrain) + near plane keyed
    to ALTITUDE-ABOVE-GROUND (small near skimming terrain → no see-through; large near high → no
    z-fight). Replaces the absolute-altitude near that caused fly-through-mountain.
  - **Beach interaction**: click card → fly-in + 360 orbit; click empty → orbit stops, camera stays.
    Added a yellow ground dot at the exact beach point + tightened float (48px). GPS verified correct
    (beaches map to sea-level terrain).
  - **Sharp coastline + ocean trim** (user's `natural=coastline` tip): `tools/crete/fetch-coastline.ts`
    stitches OSM `natural=coastline` → 78,508-pt land polygons (`coastline.geojson`); `CreteLandMask.ts`
    rasterizes to a 4096 land mask; `GavdosOcean` discards water where land (clipmap + far disc),
    Crete-only. Water now cut crisply at the true shoreline.
  - **Load optimization (started)**: `tools/crete/bake-satellite-tiles.ts` cached 50 ESRI tiles to
    `public/crete/sat-tiles/`; `CreteSatellite.loadTile` tries local first → fast/rate-limit-free first load.
- **NEXT (open):** smooth fade-in close-up detail (Stage C streamed hero — the real fix for up-close
  blur), more-realistic houses/roads (roofs/colours/lanes), small islands as hero regions, full bake
  for instant load. Most need the user's priority call + visual confirmation (preview tab is
  rAF-throttled so I verify tsc/boot/console; the user is the visual verifier for this WebGPU scene).

## Keep working; gavdos path stays intact (add a parallel `crete` path, don't break `world=gavdos`).
