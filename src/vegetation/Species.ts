/**
 * Species presets — 6+ species per spec §2 (conifer ×2, broadleaf ×2,
 * karst-gnarled cliff tree, standing snag). Numbers are growth-grammar
 * parameters (Skeleton.ts); foliage geometry params feed LeafMesh.ts.
 *
 * Structure rule (user feedback): foliage NEVER sits on primaries — every
 * species ends in a fine twig/branchlet level (planar lattice for spruce
 * boughs / beech plates) and the needles/leaves attach THERE. The lushness
 * comes from thousands of small sprays on that lattice.
 */

import type { SpeciesParams } from './VegTypes';

export const SPRUCE: SpeciesParams = {
  id: 'spruce',
  label: 'Spruce (conifer)',
  kind: 'conifer',
  height: [19, 27],
  trunkRadiusK: 0.017,
  crown: 'cone',
  asym: 0.22,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 16, wander: 0.015, gravitropism: 0.05, droop: 0, tipCurl: 0, taper: 1.0,
    },
    {
      // primaries: near-horizontal spokes, slight sag, up-hooked tips
      density: 5.0, whorl: 4, childStart: 0.09, childEnd: 0.985,
      angleBase: 1.78, angleTip: 0.55, lenRatio: 0.19, lenJitter: 0.2, radRatio: 0.32,
      segs: 6, wander: 0.06, gravitropism: -0.03, droop: 0.3, tipCurl: 0.28, taper: 1.05,
    },
    {
      // branchlets: two-sided planar lattice filling the bough plane
      density: 5.5, whorl: 0, childStart: 0.12, childEnd: 0.98,
      angleBase: 1.05, angleTip: 0.8, lenRatio: 0.24, lenJitter: 0.35, radRatio: 0.4,
      segs: 3, wander: 0.08, gravitropism: -0.05, droop: 0.45, tipCurl: 0.12, taper: 0.9,
      planar: 1,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 2,
    spacing: 0.16,
    tStart: 0.05,
    scale: [0.22, 0.35],
    tilt: 0.5,
    clusterSize: [1, 1],
    normalBend: 0.62,
    planarLeaves: true,
    card: { mode: 'lying', sizeK: 2.6 },
    leaf: { len: 0.1, width: 0.024, shapePow: 1, fold: 0, curl: 0, needleCount: 30, brush: 0 },
  },
  flare: { amp: 0.5, height: 1.0, lobes: 5 },
  barkLayer: 0,
  barkRepeats: 5,
  foliageColor: { r: 0.045, g: 0.10, b: 0.05, hueVar: 0.24 },
  brokenTop: 0,
  stubChance: 0.02,
};

export const PINE: SpeciesParams = {
  id: 'pine',
  label: 'Mountain pine (conifer)',
  kind: 'conifer',
  height: [12, 19],
  trunkRadiusK: 0.021,
  crown: 'dome',
  asym: 0.34,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 12, wander: 0.06, gravitropism: 0.03, droop: 0, tipCurl: 0, taper: 0.92,
    },
    {
      density: 1.8, whorl: 3, childStart: 0.42, childEnd: 0.97,
      angleBase: 1.5, angleTip: 0.55, lenRatio: 0.45, lenJitter: 0.32, radRatio: 0.4,
      segs: 8, wander: 0.14, gravitropism: 0.08, droop: 0.3, tipCurl: 0.32, taper: 0.85,
    },
    {
      density: 2.6, whorl: 0, childStart: 0.35, childEnd: 1.0,
      angleBase: 0.9, angleTip: 0.55, lenRatio: 0.32, lenJitter: 0.34, radRatio: 0.45,
      segs: 4, wander: 0.13, gravitropism: 0.06, droop: 0.16, tipCurl: 0.22, taper: 0.85,
    },
    {
      // twiglets rising at the ends — pine carries needles on these
      density: 4.2, whorl: 0, childStart: 0.4, childEnd: 1.0,
      angleBase: 0.8, angleTip: 0.5, lenRatio: 0.4, lenJitter: 0.4, radRatio: 0.5,
      segs: 2, wander: 0.15, gravitropism: 0.1, droop: 0.1, tipCurl: 0.15, taper: 0.8,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 3,
    spacing: 0.11,
    tStart: 0.3,
    scale: [0.26, 0.42],
    tilt: 0.55,
    clusterSize: [1, 1],
    normalBend: 0.66,
    card: { mode: 'cross', sizeK: 2.2 },
    leaf: { len: 0.21, width: 0.018, shapePow: 1, fold: 0, curl: 0, needleCount: 88, brush: 1 },
  },
  flare: { amp: 0.42, height: 0.8, lobes: 4 },
  barkLayer: 1,
  barkRepeats: 4,
  foliageColor: { r: 0.04, g: 0.092, b: 0.048, hueVar: 0.22 },
  brokenTop: 0,
  stubChance: 0.04,
};

export const BEECH: SpeciesParams = {
  id: 'beech',
  label: 'Beech (broadleaf)',
  kind: 'broadleaf',
  height: [13, 20],
  trunkRadiusK: 0.024,
  crown: 'ellipsoid',
  asym: 0.3,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 9, wander: 0.05, gravitropism: 0.04, droop: 0, tipCurl: 0, taper: 1.25,
    },
    {
      density: 1.5, whorl: 0, childStart: 0.32, childEnd: 0.94,
      angleBase: 1.05, angleTip: 0.5, lenRatio: 0.56, lenJitter: 0.26, radRatio: 0.5,
      segs: 8, wander: 0.1, gravitropism: 0.085, droop: 0.22, tipCurl: 0.12, taper: 0.95,
    },
    {
      density: 2.3, whorl: 0, childStart: 0.25, childEnd: 0.97,
      angleBase: 0.92, angleTip: 0.55, lenRatio: 0.46, lenJitter: 0.3, radRatio: 0.52,
      segs: 5, wander: 0.13, gravitropism: 0.05, droop: 0.3, tipCurl: 0.08, taper: 0.9,
    },
    {
      // distichous twig plates — beech's layered horizontal foliage
      density: 8.0, whorl: 0, childStart: 0.15, childEnd: 1.0,
      angleBase: 0.9, angleTip: 0.6, lenRatio: 0.28, lenJitter: 0.35, radRatio: 0.55,
      segs: 3, wander: 0.1, gravitropism: -0.02, droop: 0.15, tipCurl: 0.04, taper: 0.85,
      planar: 1,
    },
  ],
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 3,
    spacing: 0.13,
    tStart: 0.1,
    scale: [0.16, 0.24],
    tilt: 1.0,
    clusterSize: [2, 3],
    normalBend: 0.7,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.3 },
    leaf: { len: 1.0, width: 0.42, shapePow: 1.15, fold: 0.32, curl: 0.22, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.55, height: 1.2, lobes: 6 },
  barkLayer: 2,
  barkRepeats: 4,
  foliageColor: { r: 0.06, g: 0.145, b: 0.035, hueVar: 0.3 },
  brokenTop: 0,
  stubChance: 0.02,
};

export const BIRCH: SpeciesParams = {
  id: 'birch',
  label: 'Birch (broadleaf)',
  kind: 'broadleaf',
  height: [9, 15],
  trunkRadiusK: 0.015,
  crown: 'column',
  asym: 0.26,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 11, wander: 0.05, gravitropism: 0.045, droop: 0, tipCurl: 0, taper: 1.1,
    },
    {
      density: 2.2, whorl: 0, childStart: 0.3, childEnd: 0.96,
      angleBase: 0.95, angleTip: 0.45, lenRatio: 0.4, lenJitter: 0.3, radRatio: 0.42,
      segs: 7, wander: 0.11, gravitropism: 0.02, droop: 0.4, tipCurl: -0.04, taper: 0.95,
    },
    {
      density: 3.8, whorl: 0, childStart: 0.3, childEnd: 1.0,
      angleBase: 0.8, angleTip: 0.5, lenRatio: 0.42, lenJitter: 0.34, radRatio: 0.5,
      segs: 4, wander: 0.14, gravitropism: -0.1, droop: 0.5, tipCurl: -0.05, taper: 0.9,
    },
    {
      // weeping twig streamers
      density: 6.0, whorl: 0, childStart: 0.3, childEnd: 1.0,
      angleBase: 0.7, angleTip: 0.45, lenRatio: 0.35, lenJitter: 0.4, radRatio: 0.5,
      segs: 3, wander: 0.12, gravitropism: -0.3, droop: 0.7, tipCurl: -0.05, taper: 0.85,
      planar: 0.5,
    },
  ],
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 3,
    spacing: 0.11,
    tStart: 0.15,
    scale: [0.1, 0.16],
    tilt: 0.9,
    clusterSize: [2, 3],
    normalBend: 0.66,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.3 },
    leaf: { len: 1.0, width: 0.55, shapePow: 1.4, fold: 0.22, curl: 0.3, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.32, height: 0.7, lobes: 4 },
  barkLayer: 3,
  barkRepeats: 3,
  foliageColor: { r: 0.075, g: 0.15, b: 0.03, hueVar: 0.34 },
  brokenTop: 0,
  stubChance: 0.03,
};

export const KARST_GNARL: SpeciesParams = {
  id: 'karst',
  label: 'Karst gnarl (cliff broadleaf)',
  kind: 'broadleaf',
  height: [3.5, 6.5],
  trunkRadiusK: 0.045,
  crown: 'irregular',
  asym: 0.5,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 9, wander: 0.34, gravitropism: -0.05, droop: 0, tipCurl: 0.1, taper: 0.8,
    },
    {
      density: 2.6, whorl: 0, childStart: 0.15, childEnd: 0.95,
      angleBase: 1.35, angleTip: 0.7, lenRatio: 0.62, lenJitter: 0.45, radRatio: 0.55,
      segs: 7, wander: 0.3, gravitropism: 0.06, droop: 0.35, tipCurl: 0.18, taper: 0.8,
    },
    {
      density: 3.8, whorl: 0, childStart: 0.2, childEnd: 1.0,
      angleBase: 1.0, angleTip: 0.6, lenRatio: 0.42, lenJitter: 0.4, radRatio: 0.55,
      segs: 4, wander: 0.3, gravitropism: 0.05, droop: 0.25, tipCurl: 0.1, taper: 0.85,
    },
    {
      // gnarled twiglets carrying layered leaf plates
      density: 5.0, whorl: 0, childStart: 0.25, childEnd: 1.0,
      angleBase: 0.85, angleTip: 0.55, lenRatio: 0.4, lenJitter: 0.45, radRatio: 0.5,
      segs: 2, wander: 0.25, gravitropism: 0.04, droop: 0.2, tipCurl: 0.1, taper: 0.85,
      planar: 0.4,
    },
  ],
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 3,
    spacing: 0.055,
    tStart: 0.12,
    scale: [0.11, 0.16],
    tilt: 0.9,
    clusterSize: [2, 4],
    normalBend: 0.66,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.2 },
    leaf: { len: 1.0, width: 0.5, shapePow: 1.2, fold: 0.3, curl: 0.24, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.9, height: 0.7, lobes: 6 },
  barkLayer: 4,
  barkRepeats: 3,
  foliageColor: { r: 0.05, g: 0.12, b: 0.04, hueVar: 0.24 },
  brokenTop: 0,
  stubChance: 0.1,
};

export const SNAG: SpeciesParams = {
  id: 'snag',
  label: 'Snag (dead standing)',
  kind: 'snag',
  height: [8, 15],
  trunkRadiusK: 0.022,
  crown: 'cone',
  asym: 0.3,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 13, wander: 0.06, gravitropism: 0.04, droop: 0, tipCurl: 0, taper: 0.9,
    },
    {
      density: 2.4, whorl: 0, childStart: 0.2, childEnd: 0.97,
      angleBase: 1.6, angleTip: 0.85, lenRatio: 0.38, lenJitter: 0.45, radRatio: 0.32,
      segs: 6, wander: 0.14, gravitropism: -0.1, droop: 0.6, tipCurl: 0.05, taper: 0.75,
    },
    {
      density: 1.8, whorl: 0, childStart: 0.2, childEnd: 1.0,
      angleBase: 1.1, angleTip: 0.7, lenRatio: 0.3, lenJitter: 0.5, radRatio: 0.4,
      segs: 3, wander: 0.2, gravitropism: -0.08, droop: 0.4, tipCurl: 0, taper: 0.7,
    },
  ],
  foliage: null,
  flare: { amp: 0.6, height: 0.9, lobes: 5 },
  barkLayer: 5,
  barkRepeats: 4,
  foliageColor: { r: 0.1, g: 0.09, b: 0.07, hueVar: 0.1 },
  brokenTop: 0.62,
  stubChance: 0.28,
};

export const TREE_SPECIES: readonly SpeciesParams[] = [
  SPRUCE,
  PINE,
  BEECH,
  BIRCH,
  KARST_GNARL,
  SNAG,
];

// ============================================================================
// Mediterranean species — Gavdos world only (T4)
// ADD-ONLY: never edit the boreal six above.
// ============================================================================

/**
 * Gavdos Juniper (Juniperus macrocarpa) — the "cedar" hero species.
 * 3–6 m, broad wind-flagged / umbrella crown, twisted multi-stem.
 * Grows on sand dunes (species==1) and coastal rock.
 * Foliage: scale-like needles, deep grey-green.
 */
export const GAVDOS_JUNIPER: SpeciesParams = {
  id: 'gavdosJuniper',
  label: 'Gavdos Juniper (Juniperus macrocarpa)',
  kind: 'conifer',
  height: [3, 6],
  trunkRadiusK: 0.052,
  crown: 'irregular',
  asym: 0.55,
  levels: [
    {
      // trunk: strongly wandering multi-stem base, low taper
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 7, wander: 0.38, gravitropism: -0.06, droop: 0, tipCurl: 0.08, taper: 0.75,
    },
    {
      // primaries: wide umbrella — near-horizontal, wind-flagged to leeward
      density: 2.8, whorl: 0, childStart: 0.1, childEnd: 0.92,
      angleBase: 1.45, angleTip: 0.85, lenRatio: 0.7, lenJitter: 0.45, radRatio: 0.52,
      segs: 6, wander: 0.28, gravitropism: 0.04, droop: 0.28, tipCurl: 0.14, taper: 0.78,
    },
    {
      // branchlets: dense scale-bearing spray, two-sided in bough plane
      density: 5.5, whorl: 0, childStart: 0.15, childEnd: 1.0,
      angleBase: 0.9, angleTip: 0.55, lenRatio: 0.38, lenJitter: 0.38, radRatio: 0.48,
      segs: 3, wander: 0.22, gravitropism: 0.02, droop: 0.18, tipCurl: 0.1, taper: 0.85,
      planar: 0.7,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 2,
    spacing: 0.065,
    tStart: 0.08,
    scale: [0.14, 0.22],
    tilt: 0.45,
    clusterSize: [1, 1],
    normalBend: 0.58,
    planarLeaves: true,
    card: { mode: 'lying', sizeK: 2.4 },
    leaf: { len: 0.04, width: 0.009, shapePow: 1, fold: 0, curl: 0, needleCount: 20, brush: 0 },
  },
  flare: { amp: 0.85, height: 0.55, lobes: 5 },
  barkLayer: 4,   // reuse karst/juniper bark (gnarled)
  barkRepeats: 3,
  foliageColor: { r: 0.032, g: 0.078, b: 0.05, hueVar: 0.15 },
  brokenTop: 0,
  stubChance: 0.08,
};

/**
 * Calabrian Pine (Pinus brutia) — 8–14 m, umbrella/irregular crown,
 * reddish bark, sparse stands on hills (species==2).
 */
export const CALABRIAN_PINE: SpeciesParams = {
  id: 'calabrianPine',
  label: 'Calabrian Pine (Pinus brutia)',
  kind: 'conifer',
  height: [8, 14],
  trunkRadiusK: 0.025,
  crown: 'dome',
  asym: 0.42,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 10, wander: 0.08, gravitropism: 0.04, droop: 0, tipCurl: 0, taper: 0.88,
    },
    {
      // primaries: irregular umbrella — lighter branching than boreal pine
      density: 1.6, whorl: 3, childStart: 0.38, childEnd: 0.96,
      angleBase: 1.48, angleTip: 0.6, lenRatio: 0.52, lenJitter: 0.38, radRatio: 0.42,
      segs: 7, wander: 0.18, gravitropism: 0.1, droop: 0.28, tipCurl: 0.3, taper: 0.82,
    },
    {
      density: 2.2, whorl: 0, childStart: 0.3, childEnd: 1.0,
      angleBase: 0.88, angleTip: 0.5, lenRatio: 0.34, lenJitter: 0.36, radRatio: 0.46,
      segs: 4, wander: 0.16, gravitropism: 0.08, droop: 0.14, tipCurl: 0.2, taper: 0.82,
    },
    {
      // twiglets — needle-bearing
      density: 3.8, whorl: 0, childStart: 0.35, childEnd: 1.0,
      angleBase: 0.78, angleTip: 0.48, lenRatio: 0.38, lenJitter: 0.4, radRatio: 0.5,
      segs: 2, wander: 0.18, gravitropism: 0.12, droop: 0.08, tipCurl: 0.12, taper: 0.78,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 3,
    spacing: 0.12,
    tStart: 0.28,
    scale: [0.28, 0.44],
    tilt: 0.52,
    clusterSize: [1, 1],
    normalBend: 0.64,
    card: { mode: 'cross', sizeK: 2.2 },
    leaf: { len: 0.22, width: 0.016, shapePow: 1, fold: 0, curl: 0, needleCount: 80, brush: 1 },
  },
  flare: { amp: 0.38, height: 0.7, lobes: 4 },
  barkLayer: 1,   // pine bark (reddish)
  barkRepeats: 4,
  foliageColor: { r: 0.038, g: 0.088, b: 0.045, hueVar: 0.2 },
  brokenTop: 0,
  stubChance: 0.04,
};

/**
 * Olive (Olea europaea) — 3–5 m, dense rounded silver-green crown,
 * short gnarled trunk, in grove clusters (species==3).
 */
export const OLIVE: SpeciesParams = {
  id: 'olive',
  label: 'Olive (Olea europaea)',
  kind: 'broadleaf',
  height: [3, 5],
  trunkRadiusK: 0.058,
  crown: 'ellipsoid',
  asym: 0.3,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 7, wander: 0.26, gravitropism: 0.05, droop: 0, tipCurl: 0.06, taper: 0.82,
    },
    {
      // gnarled main scaffold: twisting, dense
      density: 2.4, whorl: 0, childStart: 0.12, childEnd: 0.9,
      angleBase: 1.15, angleTip: 0.6, lenRatio: 0.6, lenJitter: 0.38, radRatio: 0.52,
      segs: 6, wander: 0.25, gravitropism: 0.08, droop: 0.22, tipCurl: 0.12, taper: 0.82,
    },
    {
      density: 3.8, whorl: 0, childStart: 0.2, childEnd: 1.0,
      angleBase: 0.95, angleTip: 0.55, lenRatio: 0.44, lenJitter: 0.38, radRatio: 0.5,
      segs: 4, wander: 0.2, gravitropism: 0.06, droop: 0.28, tipCurl: 0.08, taper: 0.86,
    },
    {
      // fine spray twigs — olive leaf clusters attach here
      density: 7.5, whorl: 0, childStart: 0.18, childEnd: 1.0,
      angleBase: 0.88, angleTip: 0.55, lenRatio: 0.3, lenJitter: 0.38, radRatio: 0.52,
      segs: 2, wander: 0.18, gravitropism: 0.04, droop: 0.18, tipCurl: 0.06, taper: 0.85,
      planar: 0.5,
    },
  ],
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 3,
    spacing: 0.07,
    tStart: 0.12,
    scale: [0.08, 0.13],
    tilt: 0.95,
    clusterSize: [2, 3],
    normalBend: 0.68,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.2 },
    // silver-green lanceolate leaf
    leaf: { len: 1.0, width: 0.18, shapePow: 1.4, fold: 0.12, curl: 0.08, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.95, height: 0.65, lobes: 6 },
  barkLayer: 2,   // broadleaf bark (gnarled grey)
  barkRepeats: 3,
  // silver-green: higher blue component than standard green for olive shimmer
  foliageColor: { r: 0.07, g: 0.10, b: 0.065, hueVar: 0.18 },
  brokenTop: 0,
  stubChance: 0.05,
};

/**
 * Phrygana (Sarcopoterium spinosum / Thymus character) — low cushion shrubs
 * 0.3–0.8 m, dominant ground cover on Gavdos (species==4).
 * Implemented via the shrub grammar with very low height.
 */
export const PHRYGANA: SpeciesParams = {
  id: 'phrygana',
  label: 'Phrygana (spiny cushion shrub)',
  kind: 'conifer',   // conifer path gives compact needle-like foliage cards
  height: [0.3, 0.8],
  trunkRadiusK: 0.06,
  crown: 'dome',
  asym: 0.4,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 3, wander: 0.45, gravitropism: -0.08, droop: 0, tipCurl: 0.12, taper: 0.75,
    },
    {
      // spiny radiating stems — very dense, near-horizontal
      density: 9, whorl: 0, childStart: 0.05, childEnd: 1.0,
      angleBase: 1.6, angleTip: 0.8, lenRatio: 0.88, lenJitter: 0.45, radRatio: 0.62,
      segs: 3, wander: 0.35, gravitropism: 0.06, droop: 0.22, tipCurl: 0.22, taper: 0.82,
    },
    {
      // twig tips carrying tiny scale-like foliage
      density: 9, whorl: 0, childStart: 0.3, childEnd: 1.0,
      angleBase: 0.85, angleTip: 0.5, lenRatio: 0.35, lenJitter: 0.42, radRatio: 0.55,
      segs: 2, wander: 0.28, gravitropism: 0.04, droop: 0.1, tipCurl: 0.1, taper: 0.82,
      planar: 0.6,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 2,
    spacing: 0.055,
    tStart: 0.1,
    scale: [0.08, 0.14],
    tilt: 0.5,
    clusterSize: [1, 1],
    normalBend: 0.55,
    planarLeaves: true,
    card: { mode: 'lying', sizeK: 2.2 },
    leaf: { len: 0.03, width: 0.007, shapePow: 1, fold: 0, curl: 0, needleCount: 18, brush: 0 },
  },
  flare: { amp: 0.2, height: 0.2, lobes: 3 },
  barkLayer: 4,   // gnarly bark
  barkRepeats: 2,
  // warm grey-green — dry Mediterranean cushion shrub
  foliageColor: { r: 0.055, g: 0.082, b: 0.038, hueVar: 0.2 },
  brokenTop: 0,
  stubChance: 0.12,
};

/** Gavdos tree species (no boreal species) — cls 0=juniper, 1=pine, 2=olive */
export const GAVDOS_TREE_SPECIES: readonly SpeciesParams[] = [
  GAVDOS_JUNIPER,
  CALABRIAN_PINE,
  OLIVE,
];

/** Gavdos understory species — phrygana dominates */
export const GAVDOS_UNDERSTORY_SPECIES: readonly SpeciesParams[] = [
  PHRYGANA,
];
