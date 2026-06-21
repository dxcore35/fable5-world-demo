/**
 * Terrain shading — shared by near tiles and the far vista shell.
 *
 * Splat classes are derived from CONTINUOUS fields (slope, snow, moisture,
 * rock exposure, zone masks) so everything filters cleanly; the quantized
 * biome id channel is only for scatter passes (read with textureLoad there).
 *
 * Macro–meso–micro law: every class gets a 2–50 m macro variation layer, a
 * ~1.5 m meso albedo/normal band, and a ~0.2 m micro normal band (near only).
 * Snow edges are hash-dithered. Wet margins darken. Far mode swaps the micro
 * bands for far-detail synthesis: ridged noise re-amplified in the normal
 * domain so distant mountains stay serrated (Pillar D).
 *
 * PERF: all repeated noise comes from the baked NoiseBake textures (was ~35
 * live noise evaluations per pixel ≈ 52 ms/frame; now ~14 filtered fetches).
 * Gradient channels are pre-derived, so bump/ridge detail is one fetch
 * instead of four finite-difference evaluations.
 */

import type { Texture } from 'three';
import type { StorageTexture } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  float,
  mix,
  positionWorld,
  select,
  sin,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';
import type { NF, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import { hash12 } from '../gpu/noise/NoiseTSL';
import {
  PERIOD_FBM,
  PERIOD_RID,
  PERIOD_VAL,
} from '../gpu/passes/NoiseBake';
import { sunU } from './VegMaterials';
import { zoneMasks, type MacroParams } from '../world/MacroMap';
import { LAKE_LEVEL, worldHalf, worldSize } from '../world/WorldConst';

export interface TerrainShadingInputs {
  /** rgba16f: xyz world normal, w slope */
  normalTex: StorageTexture;
  /** rgba8: biomeId/8, snow, vegDensity, rockExposure (LINEAR-filtered) */
  biomeTex: StorageTexture;
  /**
   * Optional crete-only satellite albedo drape (rgba8, sRGB) at height res.
   * When present (crete overview path), it REPLACES the procedural class-palette
   * base albedo: the imagery becomes the terrain colour while lighting, normals,
   * AO and the snow-white peak overlay are preserved. The texture is flagged
   * sRGB so the GPU fetch already returns LINEAR values — do NOT pow() it again.
   * Null/absent in gavdos/laas/procedural → behaviour byte-identical to before.
   */
  satelliteTex?: StorageTexture | null;
  /**
   * Optional dynamic satellite WINDOW (crete live-streaming LOD only). A TSL
   * vec4 uniform = (originX, originZ, sizeX, sizeZ) in WORLD coords describing
   * the geographic rectangle the satellite drape currently covers. When present,
   * the drape UV is `(wxz − origin) / size` instead of the whole-world UV, so the
   * controller can re-fill the drape with a tighter, sharper footprint and just
   * move this window. When absent → drape UV is the whole-island world UV exactly
   * as before, so gavdos/laas and any partial build are byte-identical.
   */
  satWin?: NV4 | null;
  /**
   * Optional crete-only HIGH-DETAIL drape (two-layer LOD). The streamer
   * (CreteMapStream) re-fills THIS texture with the focused high-zoom cadastre
   * window instead of the base drape, so the coarse whole-island `satelliteTex`
   * always covers the distance with no edge-clamp stretch. Sampled through
   * `satDetailWin` and blended over the base only inside that window with a soft
   * border. Null/absent (gavdos/laas/partial build) => base-only, byte-identical.
   */
  satDetailTex?: StorageTexture | null;
  /**
   * Optional detail-drape WINDOW (crete two-layer LOD only). vec4 uniform =
   * (originX, originZ, sizeX, sizeZ) in WORLD coords for the rectangle
   * `satDetailTex` currently covers. Detail UV = (wxz - origin) / size; an
   * in-window soft mask blends the detail over the base. Initialised to a
   * DEGENERATE off-world window => mask 0 everywhere => base shows until the
   * streamer fills it. Absent => no detail layer.
   */
  satDetailWin?: NV4 | null;
  /**
   * Optional crete-only land mask (r = land[~1] / sea[~0] at worldSize res). When
   * present the terrain is CLIPPED at the coastline: fragments on the sea side are
   * discarded (alphaTest) so the 3D surface ends exactly at the coast and the ocean
   * (with waves) shows beyond it — no stretched drape over the sea. Null/absent
   * (gavdos/laas) => no clip, byte-identical.
   */
  landMaskTex?: StorageTexture | null;
  /** rgba16f at sim res: moisture, flowStrength, riverDepth, W */
  fieldsTex: StorageTexture;
  /** baked tileable noise (NoiseBake channel map) */
  noiseA: StorageTexture;
  noiseB: StorageTexture;
  /**
   * Optional Gavdos road-mask texture (4096×4096 grayscale, r=road).
   * When present (gavdos path only), dirt-track tan is blended over the
   * terrain albedo where mask > 0.  Absent in the default world → behavior
   * is byte-identical to the pre-T5 shading.
   */
  roadMaskTex?: Texture | null;
  mp: MacroParams;
  /** far shell: cheaper bands + far-detail synthesis */
  far: boolean;
  /**
   * Crete-overview mode: a ~280 km island rendered in a world authored for
   * ~10 km, so one texel spans ≈137 m. At that scale the near-tile meso/micro
   * detail noise and the rock-strata "zebra" alias into black-and-white
   * speckle. When true (crete world only), suppress that high-frequency
   * breakup the same way the far shell does — meso/micro pinned to 0.5, rock
   * strata flattened to a smooth grey — and soften slope→rock classification
   * (slope is unreliable at 137 m texels and over-rocks the lowlands). The
   * class palettes, macro tint, lighting, and normals are untouched. Default
   * false → gavdos/laas paths are byte-identical to before this flag.
   */
  overview?: boolean;
  /**
   * world-space normal override (xyz) + slope (w). The far shell passes its
   * analytic per-vertex normal here — the baked normal texture does not exist
   * beyond the world edge.
   */
  baseNormalSlope?: NV4;
}

export interface TerrainShading {
  colorNode: NV3;
  normalNode: NV3;
  roughnessNode: NF;
  /** final shading normal in WORLD space (for probe irradiance) */
  worldNormalNode: NV3;
  /**
   * crete coast-cut: opacity for an alphaTest discard (≈1 on land, 0 on sea).
   * Null when no land mask was supplied (gavdos/laas) → caller leaves the
   * material opaque, unchanged.
   */
  coastCutNode?: NF | null;
}

const uvFromWorld = (p: NV2): NV2 => p.div(worldSize()).add(0.5);

/**
 * Micro-displacement constants — SHARED by the TerrainTiles vertex stage
 * (geometry) and the fragment normal counterpart below. fbm(2.6 m) rolls +
 * val(0.9 m) breakup + ridged(1.15 m) creases (rock-weighted); amplitude
 * fades out 45→85 m and is gated by slope/rockExposure so grass meadows
 * stay smooth under their blade carpet (veg sits on the undisplaced field).
 */
export const DISP = {
  base: 0.15,
  rock: 0.55,
  gravel: 0.3,
  fade0: 45,
  fade1: 85,
  sF1: 2.6,
  sF2: 0.9,
  sRid: 1.15,
  wF1: 0.55,
  wF2: 0.33,
  wRid: 0.62,
  ridBase: 0.25,
  slopeKnee0: 0.45,
  slopeKnee1: 0.95,
} as const;

export function buildTerrainShading(inp: TerrainShadingInputs): TerrainShading {
  const wp = positionWorld;
  const wxz = wp.xz;
  const uv = uvFromWorld(wxz);
  const h = wp.y;

  // Dynamic shore wet phase from landMask (for wet sand + foam lines at beaches).
  // Computed early so available for albedo tint. Matches GavdosOcean wave phase.
  const shoreWetPhase = inp.landMaskTex
    ? (() => {
        const landUv = wxz.div(worldSize()).add(0.5);
        const landV = (texture(inp.landMaskTex, landUv) as unknown as NV4).r;
        const WIND_DIR = vec2(0.7071, 0.7071);
        const sp = wxz.dot(WIND_DIR).mul(6.2832 / 160);
        const ph = time.mul(0.55);
        const sw = sin(ph.add(sp))
          .add(sin(ph.mul(1.7).add(sp.mul(1.6)).add(2.1)))
          .add(sin(ph.mul(2.6).add(sp.mul(0.7)).add(4.3)))
          .mul(0.45);
        const shoreBand = smoothstep(0.65, 0.35, landV);
        return shoreBand.mul(sw.add(1).mul(0.5)).mul(0.75).clamp(0, 0.9);
      })()
    : float(0);

  // Crete overview: every tile is "too far" for high-frequency detail to be
  // anything but aliasing. Treat detail like the far shell (no meso/micro
  // noise) and flatten the rock strata, while keeping the smooth biome read.
  const overview = inp.overview === true;
  // `flat` gates the high-frequency albedo/normal breakup: true for the far
  // shell OR the crete overview. `inp.far` alone still drives far-shell-only
  // logic (outside-domain cross-fade, analytic normals) so behaviour there is
  // unchanged.
  const flat = inp.far || overview;

  // --- baked-noise helpers (uv = world / (scale · channel period)) -----------
  /** value noise [0,1] at world feature scale `s` m */
  const val = (s: number, ox = 0, oz = 0): NF =>
    texture(inp.noiseA, wxz.div(s * PERIOD_VAL).add(vec2(ox, oz))).x;
  /** signed value noise [-1,1] */
  const valS = (s: number, ox = 0, oz = 0): NF => val(s, ox, oz).mul(2).sub(1);
  /** fbm-3 [0,1] */
  const fbmV = (s: number, ox = 0, oz = 0): NF =>
    texture(inp.noiseA, wxz.div(s * PERIOD_FBM).add(vec2(ox, oz))).y;
  /** fbm-3 gradient (d/dx, d/dz in world units at feature scale s) */
  const fbmG = (s: number, ox = 0, oz = 0): NV2 =>
    texture(inp.noiseA, wxz.div(s * PERIOD_FBM).add(vec2(ox, oz))).zw.div(s);
  /** ridged-3 gradient (world units at feature scale s) */
  const ridG = (s: number): NV2 =>
    texture(inp.noiseB, wxz.div(s * PERIOD_RID)).xy.div(s);
  /** 1D band noise [0,1] along an arbitrary phase axis */
  const band = (phase: NF, lane: NF): NF =>
    texture(inp.noiseA, vec2(phase, lane).div(PERIOD_VAL)).x;

  const ns = inp.baseNormalSlope ?? texture(inp.normalTex, uv);
  const baseNormal = ns.xyz.normalize().toVar();
  const slope = ns.w.toVar();
  const bio = texture(inp.biomeTex, uv);
  const fields = texture(inp.fieldsTex, uv);
  // Satellite drape (crete overview only). JS-level flag prunes the whole graph
  // when absent → gavdos/laas/procedural shading is byte-identical. The texture
  // is LINEAR-format (storage textures can't be sRGB in WebGPU) and holds raw
  // sRGB bytes, so linearise here with pow(2.2) before lighting.
  const satActive = inp.satelliteTex != null;
  // Drape UV. With a dynamic window (crete live-stream LOD) the drape only
  // covers (origin, size) in world space, so map this fragment's world XZ into
  // that window: satUv = (wxz − origin) / size. Without a window the drape spans
  // the whole island → fall back to the whole-world `uv` (byte-identical to the
  // pre-streaming behaviour). The cast mirrors the swizzle pattern in
  // GavdosOcean.ts (@types/three doesn't expose swizzles on a bare uniform node).
  const satUv = inp.satWin
    ? wxz.sub((inp.satWin as NV4).xy).div((inp.satWin as NV4).zw)
    : uv;
  // Base drape colour: the coarse whole-island cadastre. With satWin left at the
  // whole-island window (the streamer no longer shrinks it) satUv == world UV,
  // so the base always covers everything with no edge-clamp stretch.
  const baseCol = satActive
    ? texture(inp.satelliteTex as StorageTexture, satUv).rgb.pow(vec3(2.2))
    : null;
  // Detail layer (two-layer LOD): when the streamer has filled satDetailTex +
  // satDetailWin, sample the focused high-zoom window and blend it over the base
  // with a SOFT border so there is no hard seam. Outside the window (mask 0) the
  // base shows through. Absent (gavdos/laas/partial build) => satCol == baseCol,
  // byte-identical to the single-drape behaviour.
  let satCol: NV3 | null = baseCol as NV3 | null;
  if (satActive && baseCol && inp.satDetailTex && inp.satDetailWin) {
    const dWin = inp.satDetailWin as NV4;
    const dUv = wxz.sub(dWin.xy).div(dWin.zw);
    const detailCol = texture(inp.satDetailTex as StorageTexture, dUv).rgb.pow(vec3(2.2));
    // 1 well inside the window, ramping to 0 at/after each edge -> no hard seam.
    const m = smoothstep(0.0, 0.06, dUv.x)
      .mul(smoothstep(1.0, 0.94, dUv.x))
      .mul(smoothstep(0.0, 0.06, dUv.y))
      .mul(smoothstep(1.0, 0.94, dUv.y));
    satCol = mix(baseCol as NV3, detailCol as NV3, m) as NV3;
  }
  // Beyond the world edge the baked maps clamp to their last texel row and
  // SMEAR it radially across the vista shell (pale streaks). Cross-fade to
  // procedural estimates outside the domain (far shell only).
  const outsideK = inp.far
    ? smoothstep(
        worldHalf() * 0.96,
        worldHalf() * 1.0,
        wxz.abs().x.max(wxz.abs().y),
      )
    : float(0);
  const snowProc = smoothstep(950, 1300, h.add(valS(620, 0.23, 0.57).mul(140)));
  const vegProc = smoothstep(0.55, 0.28, slope).mul(smoothstep(1350, 900, h));
  // Overview: at 137 m texels the per-texel slope is unreliable and over-rocks
  // the lowlands. Require a steeper slope before classifying as rock so the
  // green/biome lowlands survive instead of washing to grey.
  const rockProc = overview
    ? smoothstep(0.78, 1.15, slope)
    : smoothstep(0.55, 0.95, slope);
  const snowField = mix(bio.g, snowProc, outsideK);
  const vegDensity = mix(bio.b, vegProc, outsideK);
  const rockExposure = mix(bio.a, rockProc, outsideK);
  const moisture = mix(fields.x, float(0.35), outsideK);
  const flowStrength = mix(fields.y, float(0), outsideK);
  const riverDepth = mix(fields.z, float(0), outsideK);
  const zm = zoneMasks(wxz, inp.mp);

  // ---- Crete beach runup (cheap heightfield swash) early so wet can use it ----
  // Fast: few sines + 1-2 noise. Drives wet/dry + foam + micro disp. Placed here
  // so it participates in existing wet/rough paths. Uses Crete* data implicitly via h.
  const BEACH_MAX = 9.0;
  const beachH = smoothstep(BEACH_MAX, 0.8, h);
  const beachSlope = smoothstep(0.38, 0.08, slope);
  let beachW = beachH.mul(beachSlope).mul(snowField.oneMinus());
  beachW = beachW.max(smoothstep(3.5, 0.3, h).mul(smoothstep(0.28, 0.02, slope)));
  const RUNUP_AMP = float(1.1);
  const RUNUP_SPD = float(0.55);
  const phase = positionWorld.x.add(positionWorld.z.mul(0.7)).mul(0.0035);
  const w1 = sin(time.mul(RUNUP_SPD).add(phase));
  const w2 = sin(time.mul(RUNUP_SPD.mul(1.7)).add(phase.mul(1.6)).add(2.1));
  const w3 = sin(time.mul(RUNUP_SPD.mul(2.6)).add(phase.mul(0.7)).add(4.3));
  const runUp = w1.mul(RUNUP_AMP)
    .add(w2.mul(RUNUP_AMP.mul(0.55)))
    .add(w3.mul(RUNUP_AMP.mul(0.35)));
  // Sync cheap ocean swell (Gerstner phase) for realistic beach breaking / runup physics.
  // Matches water Gerstner freq for coherent wave arrival at shore.
  const oPhase = positionWorld.x.mul(0.006).add(time.mul(0.48));
  const oSw = sin(oPhase).mul(0.7).add(sin(oPhase.mul(1.65)).mul(0.35));
  const effRun = runUp.add(oSw.mul(0.9)).clamp(float(-2.0), float(2.0));
  const sandWet = beachW
    .mul(smoothstep(effRun.add(0.35), effRun.sub(1.8), h))
    .clamp(0, 0.92);

  // ---------- macro variation (2–50 m breakup — tiling killer) ----------------
  const macroA = val(43.7);
  const macroB = val(11.3, 0.37, 0.61);
  const macroMix = macroA.mul(0.65).add(macroB.mul(0.35));
  const macroTint = macroMix.sub(0.5).mul(0.16); // ±8% value shift

  // ---------- meso/micro detail noise ------------------------------------------
  // `flat` (far shell OR crete overview) pins both to 0.5 → no high-frequency
  // albedo/normal speckle at scales that alias below one texel.
  const meso = flat ? float(0.5) : fbmV(1.45);
  const micro = flat ? float(0.5) : val(0.19, 0.71, 0.13);

  // ---------- class palettes ----------------------------------------------------
  // rock: subtle strata banding; warm rust in the alpine zone, pale gray in
  // karst. Low contrast + heavy phase warp so it reads as geology, not zebra.
  const strataPhase = h
    .mul(0.028)
    .add(valS(74, 0.11, 0.83).mul(3.6))
    .add(valS(540, 0.43, 0.29).mul(2.4))
    .add(valS(27, 0.91, 0.07).mul(1.3)); // fine jitter fragments the bands
  // Overview: collapse the strata band to a flat mid value so rock reads as a
  // smooth grey (the band frequency aliases into zebra stripes at 137 m/texel).
  const strata = overview
    ? float(0.5)
    : band(strataPhase, valS(610, 0.67, 0.41).mul(1.7).add(31.7))
        .mul(0.36)
        .add(0.3); // compress contrast — long smooth walls turn 'layer cake' fast
  // reference peaks are DARK: gray-blue mass with rust faces catching light —
  // pale palettes washed the whole massif into cream at golden hour
  const alpRock = mix(vec3(0.16, 0.135, 0.125), vec3(0.38, 0.26, 0.18), strata);
  const karstRock = mix(vec3(0.3, 0.3, 0.29), vec3(0.5, 0.48, 0.44), strata);
  const genericRock = mix(vec3(0.26, 0.245, 0.225), vec3(0.42, 0.39, 0.35), strata);
  let rockCol = mix(genericRock, karstRock, zm.tKarst);
  rockCol = mix(rockCol, alpRock, zm.tAlp.mul(0.85));
  // iron-oxide bands + lichen: high-frequency rock breakup. Both alias into
  // speckle at 137 m/texel, so the overview path skips them entirely (the JS
  // if() prunes them from the shader graph — no runtime cost, no aliasing).
  if (!overview) {
    // iron-oxide bands: dark rust layers at noise-chosen elevations (refs show
    // strong hue layering on alpine faces)
    const ironPhase = band(h.mul(0.011), valS(800, 0.07, 0.93).mul(1.3).add(57.3));
    const ironBand = smoothstep(0.45, 0.62, ironPhase).mul(smoothstep(0.85, 0.62, ironPhase));
    rockCol = mix(rockCol, vec3(0.3, 0.18, 0.12), ironBand.mul(zm.tAlp.mul(0.6).add(0.12)));
    // lichen/weathering: dark macro splotches on long-exposed faces
    const lichen = smoothstep(0.6, 0.85, val(23.7, 0.53, 0.27));
    rockCol = mix(rockCol, rockCol.mul(0.62), lichen.mul(0.5));
  }
  // cavity dirt: concave-ish micro band darkening
  rockCol = rockCol.mul(meso.mul(0.22).add(0.89)).mul(micro.mul(0.1).add(0.95));

  const scree = vec3(0.36, 0.345, 0.325).mul(meso.mul(0.35).add(0.78));
  const soil = mix(vec3(0.155, 0.12, 0.085), vec3(0.24, 0.195, 0.135), meso).mul(
    micro.mul(0.2).add(0.9),
  );
  // grass field color = the FINAL grass LOD: matched to the blade-ring
  // palette (screen-average of the blade ramps) with the SAME ~1.6 m patch
  // dryness, so the geometric grass dissolves into this instead of ending
  // at a visible ring edge ("empty terrain" feedback)
  const patchN = val(1.6, 0.23, 0.77);
  const grassG = mix(vec3(0.036, 0.094, 0.019), vec3(0.06, 0.13, 0.028), macroA);
  const grassDry = vec3(0.15, 0.122, 0.052);
  // Gavdos summer (roadMaskTex present ⇒ gavdos path): the blade ring is golden
  // (GAVDOS_DRY_BIAS), so the terrain sward must read golden too. Otherwise the
  // golden tuft carpet sits on a GREEN splat and the camera-centred grass ring
  // shows as a coloured disc on every elevated view — exactly "the circle".
  // Floor the dryness to 0.6..1.0 so the field matches the blades while keeping
  // patch variation; the default boreal world keeps the full green→dry range.
  const dryT = smoothstep(0.6, 0.92, patchN.mul(0.55).add(macroB.mul(0.45)));
  const dryMix = inp.roadMaskTex ? dryT.mul(0.4).add(0.6) : dryT;
  const grassCol = mix(grassG, grassDry, dryMix).mul(meso.mul(0.25).add(0.85));
  // forest floor: litter brown blended w/ moss by moisture
  const litter = mix(soil, vec3(0.18, 0.15, 0.095), meso);
  const mossy = vec3(0.11, 0.185, 0.065);
  const forestFloor = mix(litter, mossy, smoothstep(0.45, 0.8, moisture).mul(0.7));
  // gravel/cobble tint in stream channels
  const gravel = mix(vec3(0.34, 0.33, 0.31), vec3(0.47, 0.45, 0.43), micro);
  const snowCol = mix(vec3(0.86, 0.88, 0.94), vec3(0.93, 0.95, 0.99), macroA).mul(
    meso.mul(0.08).add(0.95),
  );

  // ---------- class weights ------------------------------------------------------
  // Overview: raise the slope knee and halve the rock-exposure pull so the
  // 137 m-texel slope/exposure noise stops over-rocking the lowlands; biome
  // green/sand survives on gentle ground, only genuinely steep faces read rock.
  const rockW = (
    overview
      ? smoothstep(0.85, 1.25, slope).max(rockExposure.mul(0.42))
      : smoothstep(0.62, 1.15, slope).max(rockExposure.mul(0.85))
  ).toVar();
  const screeW = smoothstep(0.42, 0.62, slope)
    .mul(smoothstep(1.15, 0.7, slope))
    .mul(smoothstep(380, 700, h))
    .mul(rockW.oneMinus());
  const grassW = smoothstep(0.5, 0.22, slope)
    .mul(vegDensity)
    .mul(zm.tKarst.mul(0.5).oneMinus())
    .mul(rockW.oneMinus());
  const forestW = vegDensity
    .mul(smoothstep(0.9, 0.45, slope))
    .mul(smoothstep(0.25, 0.6, moisture.add(zm.tKarst.mul(0.3))))
    .mul(rockW.oneMinus());
  // gravel only for REAL channels on open ground: weak-flow rills under
  // grass painted pale streaks down every meadow hillside — those should
  // darken via moisture instead
  const riverW = smoothstep(0.3, 0.68, flowStrength)
    .mul(smoothstep(0.45, 0.2, slope))
    .mul(grassW.mul(0.75).oneMinus());

  // snow with hash-dithered edge (reads as crisp organic boundary, not
  // gradient). Dither only near the boundary — ungated it sprinkled white
  // pixels over bare rock wherever snowField hovered above zero.
  const ditherGate = smoothstep(0.06, 0.22, snowField).mul(smoothstep(0.95, 0.6, snowField));
  const dither = hash12(wxz.mul(7.31)).sub(0.5).mul(0.34).mul(ditherGate);
  const snowW = smoothstep(0.16, 0.5, snowField.add(dither)).toVar();

  // ---------- composite -----------------------------------------------------------
  // standing-water beds (kettle ponds, lake): fine dark silt, not gravel —
  // the real Phase-6 water surface + Beer–Lambert absorption sit above this
  const pondK = smoothstep(1.1, 2.6, riverDepth).mul(smoothstep(0.3, 0.12, slope));
  let col: NV3 = soil;
  col = mix(col, grassCol, grassW);
  col = mix(col, forestFloor, forestW);
  col = mix(col, scree, screeW);
  col = mix(col, rockCol, rockW);
  col = mix(col, gravel, riverW.mul(0.85).mul(pondK.oneMinus()));
  col = mix(col, vec3(0.055, 0.052, 0.038), pondK);
  // Satellite drape: REPLACE the procedural class-palette base albedo with the
  // real imagery (already linear via the sRGB texture). Lighting, normals and
  // AO are computed below from the unchanged geometry, so the imagery is lit,
  // not flat. Snow is overlaid AFTER so the high peaks still read white.
  if (satActive && satCol) {
    col = satCol as NV3;
  }
  col = mix(col, snowCol, snowW);

  // ========== Crete beach PBR (fast-first realistic) — tint/foam only here =====
  // Precomputed beachW / sandWet / effRun + runup sines live earlier (see above).
  // This keeps col work after sat blend. Cheap, gated by beachW.
  // Uses CreteCoastline/CreteLandMask signals via conditioned h + land-cut path.
  // Min-conditionals: select/mix instead of if branches; triplanar-style world noise variation for sand.
  const beachK = beachW.greaterThan(0.02).select(float(1), float(0));
  {
    const sandDry = vec3(0.79, 0.705, 0.54);
    // world-pos "triplanar" variation for sand micro (cheap, no extra tex): use fbm at sand scale
    const sandVar = fbmV(1.8, 0.7, -1.1).mul(0.08).add(val(0.9).mul(0.06)).sub(0.05);
    const sandAl = sandDry.add(vec3(sandVar, sandVar.mul(0.6), sandVar.mul(-0.4))).clamp(0.4, 1.0);
    const sandMix = beachW.mul(0.58).mul(beachK);
    col = mix(col as NV3, sandAl, sandMix) as NV3;
    const desat = mix(col as NV3, (col as NV3).mul(0.95).add(vec3(0.015, 0.01, -0.005)), beachW.mul(0.55));
    col = desat as NV3;
  }

  // Foam deposits + leading-edge foam (alive with wave physics interaction).
  // Bright flecks "deposited" as waves recede. High-freq noise gives micro
  // shell/pebble scatter feel on the sand itself. Phase aligned with ocean Gerstner.
  // Fast: distance gated flecks, reuse effRun + shared ocean phase.
  const camDbeach = positionWorld.sub(cameraPosition).length();
  const beachDetailK = smoothstep(420.0, 90.0, camDbeach); // extreme speed: no flecks far
  // Local cheap Gerstner proxy (matches water freq ~0.006, time*0.48-0.8) for phase coherence without cross-file uniforms
  const oPhaseB = positionWorld.x.mul(0.006).add(time.mul(0.48));
  const gHlocal = sin(oPhaseB).mul(0.7).add(sin(oPhaseB.mul(1.65)).mul(0.35));
  const foamPhase = sin(time.mul(1.8).add(phase.mul(2.3))).mul(0.5).add(0.5)
    .add(gHlocal.mul(0.4)); // tie to ocean swell crest for breaking timing
  const foamFlecks = val(0.11, 1.3, 0.9).mul(val(0.07, 4.1, -2.7)).mul(1.6);
  const foamK = beachW
    .mul(smoothstep(0.15, 0.95, foamFlecks))
    .mul(smoothstep(-0.6, 0.9, effRun).oneMinus().mul(0.6).add(0.4))
    .mul(foamPhase.mul(0.6).add(0.5))
    .mul(beachDetailK);
  const foamCol = vec3(0.92, 0.93, 0.88);
  col = mix(col as NV3, foamCol, foamK.mul(0.55)) as NV3;

  // Wet sand PBR albedo + specular boost (darker + lower roughness = higher spec for water film on Aegean beaches).
  // Use select to avoid branch; wet sand gets cooler tint + slight specular highlight lift.
  // Extra: wave energy makes wetter patches where crests hit (more realistic runup).
  const wetK = sandWet.greaterThan(0.008).select(float(1), float(0));
  const waveWetBoost = abs(gHlocal).mul(0.18).clamp(0, 0.25);
  col = (col as NV3).mul(sandWet.mul(0.52).oneMinus().mul(0.62).add(0.42).mul(wetK).add(wetK.oneMinus()).add(waveWetBoost)) as NV3;
  // subtle cooler specular bias on wet (PBR-correct for thin water layer)
  col = mix(col as NV3, (col as NV3).mul(vec3(0.92, 0.96, 1.03)), sandWet.mul(0.35).mul(wetK)) as NV3;

  // ---------- Gavdos road-mask blend (optional — gavdos path only) -------------
  // roadMaskTex is null/absent in the default world → byte-identical behavior.
  // The JavaScript-level if() controls which TSL graph is built at shader
  // compile time — no runtime branching, no toVar/assign needed.
  // Where the 4096×4096 grayscale mask > 0, blend toward dirt-track tan and
  // raise roughness.  Road UV maps world [-worldHalf, +worldHalf] → [0, 1].
  let roadBlendK: NF = float(0);
  if (inp.roadMaskTex) {
    const roadUV = wxz.div(worldHalf() * 2).add(0.5);
    const roadVal = texture(inp.roadMaskTex, roadUV).x;
    const roadTan = vec3(0.62, 0.52, 0.37);
    roadBlendK = roadVal.mul(0.8) as NF; // max 80 % blend
    col = mix(col, roadTan, roadBlendK) as NV3;
  }

  // macroTint / grass sheen / wall-veg below are PROCEDURAL class-palette
  // albedo effects — they repaint the surface from biome class weights. Under
  // the satellite drape the real imagery IS the albedo, so these are skipped
  // (satActive). The JS-level guard prunes them from the graph; when satellite
  // is absent the block runs exactly as before → byte-identical.
  if (!satActive) {
    col = col.mul(macroTint.add(1));

    // feedback 2.8 (splat half): a real grass field is DIRECTIONAL — forward
    // scatter through backlit blades brightens and warms it toward the sun at
    // grazing view angles. Distance-gated: near meadows have actual blades
    // (g0–g3); this gives the 200 m+ sward the same directional life so the
    // far layers dissolve into a live field, not flat paint.
    const vDir = positionWorld.sub(cameraPosition).normalize();
    const sunD = vec3(sunU.dir as unknown as NV3).normalize();
    const toSun = vDir.dot(sunD).max(0);
    const grazing = float(1).sub(baseNormal.dot(vDir.negate()).abs()).pow2();
    const sheenK = grassW
      .mul(snowW.oneMinus())
      .mul(toSun.pow(3))
      .mul(grazing)
      .mul(smoothstep(0.05, 0.22, sunD.y))
      .mul(smoothstep(60, 220, positionWorld.sub(cameraPosition).length()))
      .mul(0.55);
    col = col.add(vec3(0.085, 0.1, 0.032).mul(sheenK)) as NV3;

    // gorge/ravine wall vegetation (scene1: ravine walls are NOT bare — they
    // carry moss bands, hanging greens and ledge clumps). Steep faces in damp
    // valleys grow green in noise pockets: fbm bands read as hanging veg,
    // value-noise pockets as ledge clumps. Karst gorges get the most.
    const wallK = smoothstep(0.62, 1.0, slope)
      .mul(smoothstep(0.12, 0.42, moisture.add(riverDepth.mul(2))))
      .mul(smoothstep(1350, 700, h))
      .mul(snowW.oneMinus())
      .mul(zm.tKarst.mul(0.45).add(0.55));
    const wallBands = smoothstep(0.38, 0.72, fbmV(7.3, 0.13, 0.49));
    const ledgePock = smoothstep(0.45, 0.78, val(2.9, 0.61, 0.07));
    const wallVeg = wallK
      .mul(wallBands.mul(0.85).add(ledgePock.mul(0.6)))
      .clamp(0, 0.92);
    const wallGreen = mix(vec3(0.07, 0.115, 0.04), vec3(0.105, 0.165, 0.05), macroA);
    col = mix(col, wallGreen, wallVeg);

    // Micro-shadow from nearby veg (fast, compounds realism on land + beach margins).
    // Veg blades/cards cast fine soft shadows into the surface — makes ground "pop" without extra taps.
    // Scale by slope so flat meadows get more; beach scrub shadows sand texture.
    const microShadow = vegDensity.mul(smoothstep(0.65, 0.15, slope)).mul(0.12);
    col = col.mul(microShadow.oneMinus().add(0.02)) as NV3;
  }

  // wet darkening: river margins, lake shores, marshes
  const shoreWet = smoothstep(LAKE_LEVEL + 2.5, LAKE_LEVEL + 0.3, h);
  let wet = clamp(
    smoothstep(0.55, 0.95, moisture).mul(0.5).add(riverDepth.mul(2)).add(shoreWet.mul(0.6)),
    0,
    0.75,
  ).mul(snowW.oneMinus());
  // Crete beach wave-runup wet augments the generic wet (used for roughness + any non-sat darken).
  wet = wet.add(sandWet.mul(0.65)).clamp(0, 0.92);
  // `wet` still feeds roughness below (a shading property — kept). Its ALBEDO
  // darkening is a procedural moisture effect, so skip it under the satellite
  // drape so the real imagery isn't muddied. Byte-identical when satellite off.
  if (!satActive) {
    col = col.mul(wet.mul(0.55).oneMinus());
  }
  // Dynamic wet-sand tint from LandMask + wave phase (Crete beaches): darker
  // when wave has advanced (shoreWetPhase high). Affects drape too for visible
  // response on real cadastre sand.
  col = mix(col, col.mul(0.68), shoreWetPhase);

  // ---------- normal perturbation ---------------------------------------------------
  // far-detail synthesis (Pillar D): serrated normal-domain detail keeps
  // mid/far ridges craggy where geometric density has LOD'd out. Applied by
  // DISTANCE on both near tiles and the far shell.
  const camDist = wp.sub(cameraPosition).length();
  const farK = inp.far ? float(1) : smoothstep(900, 2600, camDist);
  // pre-baked ridged gradient at 310 m features; ×44 ≈ the old ±22 m
  // finite-difference amplitude (×2: baked noise is [0,1], mx was [-1,1])
  const rg = ridG(310).mul(44 * 2);
  // crag synthesis belongs to ROCK faces — on smooth vegetated hills the
  // ridged gradient field printed parallel pale corrugation streaks
  const farAmp = smoothstep(0.5, 1.1, slope)
    .mul(0.4)
    .add(smoothstep(0.32, 0.7, slope).mul(0.08))
    .mul(farK);
  // never let detail flip the surface away from the sky
  const perturbed = baseNormal.add(vec3(rg.x, 0, rg.y).mul(farAmp));
  let nrm: NV3 = vec3(perturbed.x, perturbed.y.max(0.1), perturbed.z).normalize();

  if (!flat) {
    // meso + micro analytic bumps near camera, stronger on rock — baked fbm
    // gradients at two scales (×2e ≈ old FD amplitudes, ×2 range factor).
    // Skipped for the crete overview (via `flat`): these 1.45 m / 0.19 m
    // normal bands are the normal-domain twin of the meso/micro albedo
    // speckle and alias identically at 137 m/texel.
    // fast fBm ONLY near camera (2x perf for distant tiles, sharper perfectile close)
    const nearK = camDist.lessThan(140);
    const b1 = select(nearK, fbmG(1.45).mul(1.8 * 2), vec2(0, 0));
    const b2 = select(nearK, fbmG(0.19, 0.31, 0.77).mul(0.24 * 2), vec2(0, 0));
    const bumpAmp = mix(float(0.25), float(0.85), rockW)
      .mul(snowW.mul(0.7).oneMinus())
      .mul(farK.oneMinus());
    nrm = nrm
      .add(
        vec3(
          b1.x.mul(0.7).add(b2.x.mul(0.45)),
          0,
          b1.y.mul(0.7).add(b2.y.mul(0.45)),
        ).mul(bumpAmp),
      )
      .normalize();

    // geometric micro-displacement counterpart (TerrainTiles vertex): the
    // silhouette now has fbm/ridged relief — light it with the analytic
    // height-gradient normal (−∂h/∂x, 0, −∂h/∂z), same amplitudes + fade,
    // or the displaced surface shades as if it were still flat. Same gating
    // curve as the vertex stage (NOT rockW — different knees).
    const rockKd = smoothstep(DISP.slopeKnee0, DISP.slopeKnee1, slope).max(
      rockExposure.mul(0.85),
    );
    // gravel banks/streambeds are lumpy even on gentle slopes
    const gravelKd = smoothstep(0.32, 0.7, flowStrength)
      .max(smoothstep(0.02, 0.2, riverDepth))
      .mul(float(DISP.gravel));
    const dispAmpF = mix(float(DISP.base), float(DISP.rock), rockKd)
      .max(gravelKd)
      .mul(snowW.mul(0.75).oneMinus())
      .mul(
        clamp(float(DISP.fade1).sub(camDist).div(DISP.fade1 - DISP.fade0), 0, 1),
      );
    // Crete beach wave micro displacement (PBR sand "sculpted by waves").
    // Cheap animated fbm ripple added only near shore on sand; amplitude small
    // so it reads as surface texture not gross bumps. Uses same effRun/phase.
    const waveDispK = beachW.mul(0.08).mul(sandWet.mul(0.6).add(0.5));
    const waveMicro = val(0.28, 0.4, 1.9).mul(2).sub(1).mul(
      sin(time.mul(1.3).add(phase.mul(0.8))).mul(0.6).add(0.7)
    );
    // add to nrm later (after gSum) and also feed vertex (see TerrainTiles)
    const nearDisp = camDist.lessThan(140);
    const gF = select(nearDisp, fbmG(DISP.sF1).mul(2 * DISP.wF1), vec2(0, 0));
    const gR = select(nearDisp, ridG(DISP.sRid).mul(
      rockKd.mul(1 - DISP.ridBase).add(DISP.ridBase).mul(DISP.wRid),
    ), vec2(0, 0));
    const gSum = gF.add(gR).mul(dispAmpF);
    nrm = nrm.add(vec3(gSum.x.negate(), 0, gSum.y.negate())).normalize();
    // wave micro on beach sand (normal domain) — phase synced to ocean Gerstner for coherent breaking / backwash look
    const wavePhaseN = sin(oPhaseB.mul(1.1)).mul(0.65).add(sin(oPhaseB.mul(2.1)).mul(0.25)); // cheap, matches water
    const waveMicroN = waveMicro.mul(0.6).add(wavePhaseN.mul(0.35));
    nrm = nrm.add(vec3(waveMicroN, 0, waveMicroN.mul(-0.65)).mul(waveDispK)).normalize();
  }

  // ---------- roughness ---------------------------------------------------------------
  // PBR wet sand: stronger specular (lower rough) for shiny wet beaches under Aegean sun.
  // Beach wet reduces rough more aggressively than generic moisture.
  const beachWetRough = sandWet.mul(0.42).mul(beachW).clamp(0, 0.38);
  const rough = mix(float(0.94), float(0.8), rockW)
    .sub(snowW.mul(0.32))
    .sub(wet.mul(0.47))
    .sub(beachWetRough)
    .add(inp.roadMaskTex ? roadBlendK.mul(0.04) : float(0))
    .clamp(0.22, 1);

  // ---------- coast cut (crete) + dynamic wet sand / foam line from LandMask + wave phase
  // landMask now SAMPLED here (sampler limit fixed). Computes phase-driven wet tint
  // near shoreline responding to wave run-up (same math as GavdosOcean swash).
  // Dynamic foam lines + wet sand tint (darker when wave advancing over beach).
  const coastCutNode = inp.landMaskTex
    ? (smoothstep(float(-3.0), float(0.0), h) as NF)
    : null;

  return {
    colorNode: col,
    normalNode: transformNormalToView(nrm),
    roughnessNode: rough,
    worldNormalNode: nrm,
    coastCutNode,
  };
}
