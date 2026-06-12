/**
 * Composed bookmarks + flythrough (Phase 7, spec §8: "9 bookmarks,
 * 90 s flythrough"). Showcase viewpoints are COMPOSED, not found
 * (Pillar E) — each pairs a verified framing with its best time of day.
 *
 * Keys 1–9 jump to a bookmark (pose + ToD); ?shot=N boots into one.
 * ?fly=1 (or key F) runs a looping ~90 s Catmull-Rom flythrough through
 * a subset of the bookmarks at a fixed golden-hour ToD; the fly camera's
 * ground/water clamps keep the path out of terrain and water.
 */

import type { PerspectiveCamera } from 'three';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { Engine } from '../core/Engine';
import type { LaasHooks } from '../core/Hooks';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';

// ---------------------------------------------------------------------------
// Gavdos bookmarks (active ONLY when world=gavdos, keys 1–8)
// Geodesy: lonLatToWorld(), north = −Z (NORTH_SIGN = −1).
// All coords computed from GavdosConst.lonLatToWorld() at their POI lon/lat.
// ---------------------------------------------------------------------------

/**
 * 8 composed Gavdos viewpoints — keys 1–8 when ?world=gavdos.
 * Positions come from lonLatToWorld() applied to the OSM POI coordinates;
 * camera offsets are additive (approach direction + altitude above terrain).
 *
 * Coordinate reference (world-space):
 *   Sarakiniko hamlet   lon=24.1109 lat=34.8581  → x≈2405, z≈-2153
 *   Ag. Ioannis beach   lon=24.0847 lat=34.8676  → x≈7,    z≈-3214
 *   Kastri village      lon=24.0848 lat=34.8350  → x≈16,   z≈412
 *   Karave port         lon=24.1183 lat=34.8487  → x≈3079, z≈-1110
 *   Lighthouse (W)      lon=24.0587 lat=34.8390  → x≈-2368,z≈-30
 *   Tripiti south       lon=24.1236 lat=34.8045  → x≈3563, z≈3804
 *   Summit              lon=24.0846 lat=34.8600  → x≈0,    z≈-2367
 *   Offshore SW 2500 m  →                           x≈-1767,z≈1768
 */
export const GAVDOS_BOOKMARKS: Bookmark[] = [
  // 1 — Sarakiniko bay: low over the water, looking NW at beach + hamlet
  { name: 'Sarakiniko bay', x: 2300, z: -2000, alt: 8, yaw: -0.8, pitch: -0.08, tod: 12 },

  // 2 — Ag. Ioannis dunes: low in the dune field, looking S at junipers
  { name: 'Ag. Ioannis dunes', x: 7, z: -3050, alt: 3, yaw: 3.14, pitch: -0.05, tod: 11 },

  // 3 — Kastri village: ~100 m above, ~300 m south, looking N-ish down at white houses
  { name: 'Kastri village', x: 16, z: 712, alt: 100, yaw: 0.0, pitch: -0.35, tod: 13 },

  // 4 — Karave port: harbour buildings + sea, looking W from just offshore
  { name: 'Karave port', x: 3350, z: -1110, alt: 30, yaw: -2.8, pitch: -0.1, tod: 10 },

  // 5 — Lighthouse west: cliff + tower area (west coast, y derived from terrain)
  { name: 'Lighthouse west', x: -2368, z: -30, alt: 40, yaw: 1.57, pitch: -0.15, tod: 14 },

  // 6 — Tripiti south cliffs: southernmost land, dramatic cliffs + open sea S
  { name: 'Tripiti south cliffs', x: 3450, z: 3900, alt: 50, yaw: 3.14, pitch: -0.18, tod: 15.5 },

  // 7 — Summit vista: highest point ~368 m, wide view north over island to sea
  { name: 'Summit vista', x: 0, z: -2367, alt: 80, yaw: 0.0, pitch: -0.3, tod: 14 },

  // 8 — Whole-island offshore: ~2500 m SW, y≈900, looking NE over full island
  { name: 'Whole-island offshore', x: -1767, z: 1768, alt: 900, yaw: -2.36, pitch: -0.35, tod: 13 },
];

export interface Bookmark {
  name: string;
  x: number;
  z: number;
  /** meters above ground (water-guarded at apply time) */
  alt: number;
  yaw: number;
  pitch: number;
  tod: number;
}

/** nine composed viewpoints — verified framings from the phase shots */
export const BOOKMARKS: Bookmark[] = [
  { name: 'Gorge stream (scene1)', x: 620, z: 650, alt: 1.3, yaw: 0.5, pitch: -0.12, tod: 12.5 },
  { name: 'Dawn lake mist', x: 11, z: 1338, alt: 9, yaw: 1.2, pitch: -0.06, tod: 7.5 },
  { name: 'Golden vista (Witcher)', x: 1500, z: 1900, alt: 250, yaw: 0.65, pitch: -0.18, tod: 19 },
  { name: 'Morning meadow shafts', x: -870, z: 862, alt: 1.8, yaw: -1.45, pitch: 0.02, tod: 8.2 },
  { name: 'Alpine tarn', x: 805, z: -1464, alt: 2.2, yaw: 1.57, pitch: -0.4, tod: 15.5 },
  { name: 'Karst ravine mouth', x: 650, z: 700, alt: 5, yaw: 0.6, pitch: -0.06, tod: 15 },
  { name: 'Forest interior dapple', x: -850, z: 850, alt: 4, yaw: -0.785, pitch: -0.05, tod: 12.5 },
  { name: 'Lakeshore golden', x: -1400, z: 1250, alt: 2.5, yaw: 3.14, pitch: -0.12, tod: 18.5 },
  { name: 'Valley network aerial', x: -600, z: 700, alt: 260, yaw: -0.6, pitch: -0.5, tod: 17.5 },
];

function poseY(hf: Heightfield, b: Bookmark): number {
  const ground = hf.heightAtCpu(b.x, b.z) + b.alt;
  const water = hf.waterYAtCpu(b.x, b.z) + 0.6;
  return Math.max(ground, water);
}

export function installBookmarks(
  engine: Engine,
  hf: Heightfield,
  hooks: LaasHooks,
  params: LaasParams,
): void {
  const apply = (i: number): void => {
    const b = BOOKMARKS[i];
    if (!b) return;
    hooks.setPose?.({ p: [b.x, poseY(hf, b), b.z], yaw: b.yaw, pitch: b.pitch });
    hooks.setTimeOfDay?.(b.tod);
  };

  window.addEventListener('keydown', (e) => {
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) {
      if (params.world === 'gavdos') {
        // Gavdos bookmarks on keys 1–8; key 9 falls through to procedural set
        const gi = Number(m[1]) - 1;
        const gb = GAVDOS_BOOKMARKS[gi];
        if (gb) {
          hooks.setPose?.({ p: [gb.x, poseY(hf, gb), gb.z], yaw: gb.yaw, pitch: gb.pitch });
          hooks.setTimeOfDay?.(gb.tod);
          return;
        }
      }
      apply(Number(m[1]) - 1);
    }
    if (e.code === 'KeyF') fly.toggle();
  });

  // ---- flythrough -------------------------------------------------------------
  const FLY_SECONDS = 92;
  // a tour that reads as one continuous shot: vista → descend the valley →
  // lake → meadow forest edge → gorge mouth → aerial pull-out
  const TOUR: { x: number; z: number; alt: number; yaw: number; pitch: number }[] = [
    { x: 1500, z: 1900, alt: 250, yaw: 0.65, pitch: -0.18 },
    { x: 900, z: 1500, alt: 120, yaw: 1.0, pitch: -0.12 },
    { x: 300, z: 1400, alt: 40, yaw: 1.35, pitch: -0.08 },
    { x: 11, z: 1338, alt: 12, yaw: 1.2, pitch: -0.05 },
    { x: -500, z: 1100, alt: 25, yaw: 2.0, pitch: -0.06 },
    { x: -870, z: 880, alt: 8, yaw: 2.6, pitch: -0.03 },
    { x: -600, z: 720, alt: 60, yaw: 3.5, pitch: -0.15 },
    { x: 100, z: 680, alt: 35, yaw: 4.3, pitch: -0.08 },
    { x: 620, z: 660, alt: 6, yaw: 4.9, pitch: -0.05 },
    { x: 900, z: 900, alt: 180, yaw: 5.6, pitch: -0.3 },
    { x: 1500, z: 1900, alt: 250, yaw: 0.65 + Math.PI * 2, pitch: -0.18 },
  ];

  class Flythrough {
    private active = false;
    private t = 0;
    private curve: CatmullRomCurve3 | null = null;

    toggle(): void {
      this.active = !this.active;
      hooks.flyCamEnabled?.(!this.active);
      if (this.active && !this.curve) {
        this.curve = new CatmullRomCurve3(
          TOUR.map((w) => new Vector3(w.x, poseY(hf, { ...w, tod: 0, name: '' } as Bookmark), w.z)),
          false,
          'centripetal',
          0.5,
        );
      }
      if (!this.active) this.t = 0;
    }

    update(dt: number, cam: PerspectiveCamera): void {
      if (!this.active || !this.curve) return;
      this.t = (this.t + dt / FLY_SECONDS) % 1;
      const u = this.t;
      const p = this.curve.getPointAt(u);
      cam.position.copy(p);
      // yaw/pitch: linear over the waypoint list (yaws authored unwrapped)
      const seg = u * (TOUR.length - 1);
      const i0 = Math.min(Math.floor(seg), TOUR.length - 2);
      const f = seg - i0;
      const w0 = TOUR[i0];
      const w1 = TOUR[i0 + 1];
      if (!w0 || !w1) return;
      const yaw = w0.yaw + (w1.yaw - w0.yaw) * f;
      const pitch = w0.pitch + (w1.pitch - w0.pitch) * f;
      hooks.setPose?.({ p: [p.x, p.y, p.z], yaw, pitch });
    }
  }
  const fly = new Flythrough();
  engine.onUpdate((dt) => fly.update(dt, engine.camera));
  if (new URLSearchParams(window.location.search).get('fly') === '1') {
    fly.toggle();
  }

  // boot directly into a bookmark (?shot=N) — pose via initialPose (the
  // fly rig applies it after this scene finishes building)
  if (params.shot !== null && params.cam === null) {
    if (params.world === 'gavdos') {
      const gb = GAVDOS_BOOKMARKS[params.shot - 1];
      if (gb) {
        hooks.initialPose = { p: [gb.x, poseY(hf, gb), gb.z], yaw: gb.yaw, pitch: gb.pitch };
        hooks.setTimeOfDay?.(gb.tod);
      }
    } else {
      const b = BOOKMARKS[params.shot - 1];
      if (b) {
        hooks.initialPose = { p: [b.x, poseY(hf, b), b.z], yaw: b.yaw, pitch: b.pitch };
      }
    }
  }
}
