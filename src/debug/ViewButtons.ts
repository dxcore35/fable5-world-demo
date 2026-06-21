/**
 * ViewButtons — on-screen camera-view controls.
 *
 * A small bottom-centre button bar:
 *   • Ground   — drop to eye height (1.7 m) at the current x/z, keep heading
 *   • Beach    — jump to a shoreline viewpoint
 *   • House    — jump to ground level beside the village houses
 *   • Drone ↻  — TOGGLE: 360° orbit around whatever the camera is currently
 *                looking at. Works from ANY view (location button, bookmark,
 *                or free-fly): it captures the current focus point and circles it.
 *
 * Drives the camera exactly like the flythrough: while the orbit is active it
 * disables the manual fly cam and feeds poses via hooks.setPose each frame;
 * toggling off hands control back at the current pose (smooth, no snap).
 *
 * Camera convention (from FlyCamera): forward =
 *   (-cos(pitch)·sin(yaw), sin(pitch), -cos(pitch)·cos(yaw))
 * → to look at a target: yaw = atan2(-d.x, -d.z), pitch = asin(d.y).
 */
import type { Engine } from '../core/Engine';
import type { CamPose, LaasHooks } from '../core/Hooks';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { BOOKMARKS, GAVDOS_BOOKMARKS, CRETE_BOOKMARKS, type Bookmark } from './Bookmarks';
import { lonLatToWorld as creteLonLatToWorld } from '../crete/CreteConst';

interface ViewPreset { x: number; z: number; alt: number; yaw: number; pitch: number; }

/** Eye-safe Y at (x,z): above terrain and above water. */
function floorY(hf: Heightfield, x: number, z: number, alt: number): number {
  return Math.max(hf.heightAtCpu(x, z), hf.waterYAtCpu(x, z) + 0.6) + alt;
}

const ORBIT_PERIOD = 42; // seconds per full revolution

export function installViewButtons(
  engine: Engine,
  hf: Heightfield,
  hooks: LaasHooks,
  params: LaasParams,
): void {
  const gavdos = params.world === 'gavdos';
  const crete = params.world === 'crete';
  // Crete world-coords helper (lng/lat → world via CreteConst geodesy).
  const creteVP = (lng: number, lat: number, alt: number, yaw: number, pitch: number): ViewPreset => {
    const { x, z } = creteLonLatToWorld(lng, lat);
    return { x, z, alt, yaw, pitch };
  };
  // Shoreline + dwelling presets, per world.
  const BEACH: ViewPreset = gavdos
    ? { x: 2300, z: -2000, alt: 6, yaw: -0.8, pitch: -0.06 }   // Sarakiniko bay
    : crete
    ? creteVP(23.54, 35.27, 3500, 0.2, -0.45)                  // Elafonisi (pink-sand lagoon)
    : { x: -1400, z: 1250, alt: 2.5, yaw: 3.14, pitch: -0.1 };  // Lakeshore
  const HOUSE: ViewPreset = gavdos
    ? { x: 24, z: 560, alt: 3, yaw: 0.08, pitch: -0.02 }        // Kastri village, ground
    : crete
    ? creteVP(24.019, 35.515, 3000, 0.0, -0.45)                // Chania old town
    : { x: -850, z: 850, alt: 2, yaw: -0.785, pitch: -0.02 };   // Forest interior

  // ---- orbit ---------------------------------------------------------------
  const orbit = {
    active: false,
    fx: 0, fy: 0, fz: 0, // focus point
    radius: 60, height: 30, angle: 0, lastPose: null as CamPose | null,
  };

  function captureFocus(): void {
    const pose = hooks.getPose?.();
    if (!pose) return;
    const [cx, cy, cz] = pose.p;
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const fwd = [-cp * Math.sin(pose.yaw), sp, -cp * Math.cos(pose.yaw)];
    // march the view ray forward until it dips below terrain
    let fx = NaN, fy = NaN, fz = NaN;
    for (let t = 20; t < 4000; t += 10) {
      const px = cx + fwd[0] * t, py = cy + fwd[1] * t, pz = cz + fwd[2] * t;
      if (py <= hf.heightAtCpu(px, pz)) { fx = px; fy = hf.heightAtCpu(px, pz); fz = pz; break; }
    }
    if (Number.isNaN(fx)) {
      // looking at/above the horizon: focus a point ahead on the ground plane
      const R = Math.max(60, cy - hf.heightAtCpu(cx, cz));
      fx = cx - Math.sin(pose.yaw) * R; fz = cz - Math.cos(pose.yaw) * R; fy = hf.heightAtCpu(fx, fz);
    }
    orbit.fx = fx; orbit.fy = fy; orbit.fz = fz;
    orbit.radius = Math.hypot(cx - fx, cz - fz);
    if (orbit.radius < 15) orbit.radius = Math.max(40, cy - fy);
    orbit.height = Math.max(cy - fy, 6);
    orbit.angle = Math.atan2(cz - fz, cx - fx);
  }

  function setOrbit(on: boolean): void {
    if (on === orbit.active) return;
    orbit.active = on;
    if (on) { captureFocus(); hooks.flyCamEnabled?.(false); }
    else {
      if (orbit.lastPose) hooks.setPose?.(orbit.lastPose); // hand back at current pose
      hooks.flyCamEnabled?.(true);
    }
    btnOrbit.dataset.on = on ? '1' : '0';
    btnOrbit.style.background = on ? 'rgba(70,140,90,0.85)' : 'rgba(8,12,10,0.62)';
    btnOrbit.textContent = on ? '⏹ Stop orbit' : '↻ Drone orbit';
  }

  engine.onUpdate((dt) => {
    if (!orbit.active) return;
    orbit.angle += (Math.PI * 2 / ORBIT_PERIOD) * dt;
    const px = orbit.fx + Math.cos(orbit.angle) * orbit.radius;
    const pz = orbit.fz + Math.sin(orbit.angle) * orbit.radius;
    let py = orbit.fy + orbit.height;
    const floor = floorY(hf, px, pz, 2);
    if (py < floor) py = floor;
    const dx = orbit.fx - px, dy = orbit.fy - py, dz = orbit.fz - pz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const yaw = Math.atan2(-dx / len, -dz / len);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    const pose: CamPose = { p: [px, py, pz], yaw, pitch };
    orbit.lastPose = pose;
    hooks.setPose?.(pose);
  });

  // ---- DOM bar -------------------------------------------------------------
  const bar = document.createElement('div');
  bar.id = 'view-buttons';
  bar.style.cssText = [
    'position:fixed', 'bottom:14px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:1000', 'display:flex', 'gap:8px', 'pointer-events:auto',
  ].join(';');

  const mkBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'color:#d9e8e0', 'background:rgba(8,12,10,0.62)', 'border:1px solid rgba(217,232,224,0.25)',
      'padding:7px 13px', 'font:12px/1.2 ui-monospace,Menlo,monospace', 'border-radius:5px',
      'cursor:pointer', 'backdrop-filter:blur(3px)', '-webkit-backdrop-filter:blur(3px)',
    ].join(';');
    b.addEventListener('click', () => { b.blur(); onClick(); });
    bar.appendChild(b);
    return b;
  };

  const jump = (v: ViewPreset): void => {
    setOrbit(false);
    hooks.setPose?.({ p: [v.x, floorY(hf, v.x, v.z, v.alt), v.z], yaw: v.yaw, pitch: v.pitch });
  };

  mkBtn('▣ Ground', () => {
    setOrbit(false);
    const pose = hooks.getPose?.();
    if (!pose) return;
    const [x, , z] = pose.p;
    hooks.setPose?.({ p: [x, floorY(hf, x, z, 1.7), z], yaw: pose.yaw, pitch: 0 });
  });
  mkBtn('🏖 Beach', () => jump(BEACH));
  mkBtn('🏠 House', () => jump(HOUSE));

  // ---- zoom (dolly along view) + tilt (pitch) ------------------------------
  // dir: -1 = zoom OUT (dolly back), +1 = zoom IN (dolly forward). Step scales
  // with altitude so you can pull WAY back over the big island, not just nudge.
  const dolly = (dir: number): void => {
    setOrbit(false);
    const pose = hooks.getPose?.();
    if (!pose) return;
    const [x, y, z] = pose.p;
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const fx = -cp * Math.sin(pose.yaw), fy = sp, fz = -cp * Math.cos(pose.yaw);
    const step = Math.max(500, y * 0.7) * dir; // accelerates with altitude → reach orbit-high fast
    const nx = x + fx * step, nz = z + fz * step;
    const ny = Math.max(y + fy * step, floorY(hf, nx, nz, 2));
    hooks.setPose?.({ ...pose, p: [nx, ny, nz] });
  };
  const tilt = (delta: number): void => {
    setOrbit(false); // orbit drives pitch every frame; manual tilt would fight it
    const pose = hooks.getPose?.();
    if (!pose) return;
    const pitch = Math.max(-1.5, Math.min(1.5, pose.pitch + delta));
    hooks.setPose?.({ ...pose, pitch });
  };
  mkBtn('➖ Zoom out', () => dolly(-1));
  mkBtn('➕ Zoom in', () => dolly(+1));
  mkBtn('⤒ Tilt up', () => tilt(+0.12));
  mkBtn('⤓ Tilt down', () => tilt(-0.12));
  const btnOrbit = mkBtn('↻ Drone orbit', () => setOrbit(!orbit.active));
  // ---- detected-coastline source cycle (crete only) ------------------------
  // 3-state: Cadastre (coast from the cadastre orthophoto) -> OSM (raw OSM coastline)
  // -> Off (hide line, keep last ocean trim) -> back. Each click switches BOTH the
  // ocean trim (land mask) and the cyan overlay line via setCoastlineSource. Green
  // tint while a source is active; neutral on Off. Default = Cadastre (matches scene).
  if (crete) {
    const COAST_CYCLE = ['cadastre', 'osm', 'off'] as const;
    const COAST_LABEL: Record<(typeof COAST_CYCLE)[number], string> = {
      cadastre: '〰 Coast: Cadastre',
      osm: '〰 Coast: OSM',
      off: '〰 Coast: Off',
    };
    let coastIdx = 2; // starts OFF — no colored line; the overlay is hidden by
    // default (the coast is meant to be cut from the terrain, not drawn as a line).
    // This keeps the button in sync with the hidden overlay so it never reappears.
    const btnCoast = mkBtn(COAST_LABEL[COAST_CYCLE[coastIdx]], () => {
      coastIdx = (coastIdx + 1) % COAST_CYCLE.length;
      const next = COAST_CYCLE[coastIdx];
      hooks.setCoastlineSource?.(next);
      btnCoast.textContent = COAST_LABEL[next];
      btnCoast.style.background = next === 'off' ? 'rgba(8,12,10,0.62)' : 'rgba(70,140,90,0.85)';
    });
    btnCoast.style.background = 'rgba(8,12,10,0.62)'; // Off on start (no line)
  }
  // ---- time of day ---------------------------------------------------------
  const setTod = (h: number): void => hooks.setTimeOfDay?.(h);
  mkBtn('🌅 Dawn', () => setTod(6.5));
  mkBtn('☀ Day', () => setTod(13));
  mkBtn('🌇 Dusk', () => setTod(19));
  mkBtn('🌙 Night', () => setTod(0));

  document.body.appendChild(bar);

  // ---- preset-scene panel (top-right): jump to composed bookmarks -----------
  const scenes: Bookmark[] = gavdos ? GAVDOS_BOOKMARKS : crete ? CRETE_BOOKMARKS : BOOKMARKS;
  const scenePanel = document.createElement('div');
  scenePanel.id = 'view-scenes';
  scenePanel.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:1000', 'display:flex',
    'flex-direction:column', 'gap:5px', 'pointer-events:auto', 'max-width:200px',
  ].join(';');
  const sceneTitle = document.createElement('div');
  sceneTitle.textContent = '◳ Preset scenes';
  sceneTitle.style.cssText = [
    'color:#d9e8e0', 'background:rgba(8,12,10,0.62)', 'padding:5px 9px',
    'font:11px/1.2 ui-monospace,Menlo,monospace', 'border-radius:5px', 'opacity:0.85',
  ].join(';');
  scenePanel.appendChild(sceneTitle);
  scenes.forEach((b, i) => {
    const sb = document.createElement('button');
    sb.textContent = `${i + 1}. ${b.name}`;
    sb.style.cssText = [
      'color:#d9e8e0', 'background:rgba(8,12,10,0.55)', 'border:1px solid rgba(217,232,224,0.2)',
      'padding:5px 9px', 'font:11px/1.2 ui-monospace,Menlo,monospace', 'border-radius:5px',
      'cursor:pointer', 'text-align:left', 'backdrop-filter:blur(3px)',
    ].join(';');
    sb.addEventListener('click', () => {
      sb.blur();
      setOrbit(false);
      hooks.setPose?.({ p: [b.x, floorY(hf, b.x, b.z, b.alt), b.z], yaw: b.yaw, pitch: b.pitch });
      hooks.setTimeOfDay?.(b.tod);
    });
    scenePanel.appendChild(sb);
  });
  document.body.appendChild(scenePanel);

  // ---- controls hint -------------------------------------------------------
  const hint = document.createElement('div');
  hint.textContent = 'WASD move · drag look · scroll = speed · Shift boost · 1–9 scenes · F flythrough';
  hint.style.cssText = [
    'position:fixed', 'bottom:54px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:1000', 'color:#cdddd4', 'background:rgba(8,12,10,0.5)', 'padding:4px 10px',
    'font:10px/1.3 ui-monospace,Menlo,monospace', 'border-radius:4px', 'pointer-events:none',
    'opacity:0.8', 'white-space:nowrap',
  ].join(';');
  document.body.appendChild(hint);
}
