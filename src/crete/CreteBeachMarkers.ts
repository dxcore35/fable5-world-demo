/**
 * CreteBeachMarkers — beach POI markers for the Crete world (WebGPU-safe).
 *
 * Renderer-agnostic DOM overlay: each beach is an HTML photo-card floating a
 * fixed screen distance above its GPS point, with an SVG leader line down to the
 * ground point and a name label — the "marker with a line on top" look, ported
 * in spirit from the previous Crete app but drawn over the WebGPU canvas so it
 * needs no TSL/shader work.
 *
 * Placement: CreteConst.lonLatToWorld(lng,lat) → world (x,z); ground Y from the
 * heightfield. Each frame we project the ground point to screen, float the card
 * a constant ~90 px above it, and connect with a leader line. Culled to the
 * nearest N visible within a max distance so 400+ beaches never clutter or
 * thrash the DOM.
 *
 * Data: public/crete/beaches.json — [{slug,name,lng,lat,image,rating,...}].
 */
import { Vector3 } from 'three';
import type { Engine } from '../core/Engine';
import type { LaasHooks } from '../core/Hooks';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { lonLatToWorld } from './CreteConst';

interface Beach {
  slug: string; name: string; lng: number; lat: number;
  image?: string | null; images?: (string | null)[]; rating?: number | null;
}

interface MarkerEl {
  beach: Beach;
  world: Vector3;
  card: HTMLDivElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  imgUrl: string | null;
  imgLoaded: boolean;
  shown: boolean;
}

// Resolve a usable photo URL for a beach. beaches.json stores local paths as
// "/beaches/<slug>.jpg", but in this build the assets live under public/crete/
// beaches, so a bare "/beaches/..." 404s to Vite's index.html (text/html) and
// the photo never loads. Prefix local paths with "/crete"; pass http(s) URLs
// through; fall back to the first usable entry in images[] when image is
// missing or the literal string "null".
function resolveBeachImage(b: Beach): string | null {
  const candidates = [b.image, ...(b.images ?? [])];
  for (const c of candidates) {
    if (typeof c !== 'string' || c === 'null') continue;
    if (/^https?:\/\//.test(c)) return c;
    if (c.startsWith('/')) return `/crete${c}`;
  }
  return null;
}

const MAX_DIST = 55_000;   // only show beaches within 55 km of the camera
const MAX_VISIBLE = 30;    // cap simultaneously-shown cards (nearest first)
const FLOAT_PX = 48;       // card floats this many screen px above the ground point (closer = reads as ON the spot)
// click-to-focus 360 orbit
const ORBIT_RADIUS = 1300; // m — camera distance around the beach
const ORBIT_ALT = 650;     // m — camera height above the beach
const ORBIT_PERIOD = 38;   // s per lap

export function installBeachMarkers(engine: Engine, hf: Heightfield, hooks: LaasHooks, params: LaasParams): void {
  if (params.world !== 'crete') return;

  // ---- DOM layers ----------------------------------------------------------
  const lineSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  lineSvg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:900;pointer-events:none;overflow:visible';
  document.body.appendChild(lineSvg);

  const cardRoot = document.createElement('div');
  cardRoot.style.cssText = 'position:fixed;inset:0;z-index:901;pointer-events:none';
  document.body.appendChild(cardRoot);

  const markers: MarkerEl[] = [];
  const tmp = new Vector3();

  function makeCard(b: Beach): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'position:absolute', 'transform:translate(-50%,-100%)', 'width:104px',
      'background:rgba(10,16,22,0.82)', 'border:1px solid rgba(220,235,250,0.28)',
      'border-radius:8px', 'overflow:hidden', 'display:none', 'pointer-events:auto',
      'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
      'backdrop-filter:blur(3px)', 'font:11px/1.25 ui-sans-serif,system-ui,sans-serif',
    ].join(';');
    const ph = document.createElement('div');
    ph.style.cssText = 'width:104px;height:64px;background:#243; background-size:cover;background-position:center';
    card.appendChild(ph);
    const cap = document.createElement('div');
    cap.textContent = b.rating != null ? `${b.name}  ★${b.rating}` : b.name;
    cap.style.cssText = 'color:#e6f0fa;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    card.appendChild(cap);
    // swallow pointer events so a card click never reaches the empty-space
    // listener (which stops the orbit) nor the camera drag-look.
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    (card as unknown as { _photo: HTMLDivElement })._photo = ph;
    return card;
  }

  // ---- click-to-focus 360 orbit -------------------------------------------
  let orbitBeach: MarkerEl | null = null;
  let orbitAngle = 0;
  function focusBeach(m: MarkerEl): void {
    orbitBeach = m;
    orbitAngle = 0;
    hooks.flyCamEnabled?.(false); // we drive the camera while orbiting
  }
  function stopOrbit(): void {
    if (!orbitBeach) return;
    orbitBeach = null;
    hooks.flyCamEnabled?.(true); // hand control back AT the current pose (camera stays)
  }
  // Click empty space (canvas) → stop orbit; the camera stays where it is.
  // Card clicks are stopPropagation'd above so they don't trigger this.
  window.addEventListener('pointerdown', () => { if (orbitBeach) stopOrbit(); });

  function makeLine(): SVGLineElement {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('stroke', 'rgba(220,235,250,0.7)');
    ln.setAttribute('stroke-width', '1.5');
    ln.style.display = 'none';
    lineSvg.appendChild(ln);
    return ln;
  }

  // a small bright dot pinned to the EXACT beach ground point (the line's foot),
  // so the marked location is unambiguous (the card floats just above it).
  function makeDot(): SVGCircleElement {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '3.5');
    c.setAttribute('fill', '#ffe14d');
    c.setAttribute('stroke', 'rgba(10,16,22,0.9)');
    c.setAttribute('stroke-width', '1.5');
    c.style.display = 'none';
    lineSvg.appendChild(c);
    return c;
  }

  // ---- load beaches --------------------------------------------------------
  fetch('/crete/beaches.json')
    .then((r) => r.json())
    .then((list: Beach[]) => {
      for (const b of list) {
        if (typeof b.lng !== 'number' || typeof b.lat !== 'number') continue;
        const { x, z } = lonLatToWorld(b.lng, b.lat);
        const gy = Math.max(0, hf.heightAtCpu(x, z));
        const m: MarkerEl = {
          beach: b, world: new Vector3(x, gy, z),
          card: makeCard(b), line: makeLine(), dot: makeDot(),
          imgUrl: resolveBeachImage(b), imgLoaded: false, shown: false,
        };
        m.card.addEventListener('click', (e) => { e.stopPropagation(); focusBeach(m); });
        markers.push(m);
        cardRoot.appendChild(m.card);
      }
      // eslint-disable-next-line no-console
      console.log(`[crete] beach markers: ${markers.length} placed (DOM overlay)`);
    })
    .catch((e) => console.warn('[crete] beaches.json load failed', e));

  // ---- per-frame projection + cull ----------------------------------------
  const cam = engine.camera;
  engine.onUpdate((dt: number) => {
    // 360° drone orbit around a clicked beach — drives the camera via setPose.
    if (orbitBeach) {
      orbitAngle += dt * (Math.PI * 2 / ORBIT_PERIOD);
      const b = orbitBeach.world;
      const px = b.x + Math.cos(orbitAngle) * ORBIT_RADIUS;
      const pz = b.z + Math.sin(orbitAngle) * ORBIT_RADIUS;
      const py = b.y + ORBIT_ALT;
      const dx = b.x - px, dy = b.y - py, dz = b.z - pz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const yaw = Math.atan2(-dx / len, -dz / len);
      const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
      hooks.setPose?.({ p: [px, py, pz], yaw, pitch });
    }
    if (markers.length === 0) return;
    cam.updateMatrixWorld();
    const W = window.innerWidth, H = window.innerHeight;
    // Show markers farther out as you climb, so when zoomed over the whole island
    // the nearest 30 beaches still appear (not just a 55 km bubble).
    const maxDist = Math.max(MAX_DIST, cam.position.y * 2.5);
    // collect on-screen candidates within range, nearest first
    const cand: { m: MarkerEl; sx: number; sy: number; dist: number }[] = [];
    for (const m of markers) {
      const dist = cam.position.distanceTo(m.world);
      if (dist > maxDist) { hide(m); continue; }
      tmp.copy(m.world).project(cam);
      if (tmp.z > 1) { hide(m); continue; } // behind camera / beyond far
      const sx = (tmp.x * 0.5 + 0.5) * W;
      const sy = (-tmp.y * 0.5 + 0.5) * H;
      if (sx < -60 || sx > W + 60 || sy < -10 || sy > H + 60) { hide(m); continue; }
      cand.push({ m, sx, sy, dist });
    }
    cand.sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < cand.length; i++) {
      if (i < MAX_VISIBLE) show(cand[i].m, cand[i].sx, cand[i].sy);
      else hide(cand[i].m);
    }
  });

  function show(m: MarkerEl, sx: number, sy: number): void {
    if (!m.imgLoaded && m.imgUrl) {
      m.imgLoaded = true;
      const ph = (m.card as unknown as { _photo: HTMLDivElement })._photo;
      const url = m.imgUrl;
      const img = new Image();
      img.onload = () => { ph.style.backgroundImage = `url("${url}")`; };
      img.src = url;
    }
    m.card.style.display = 'block';
    m.card.style.left = `${sx}px`;
    m.card.style.top = `${sy - FLOAT_PX}px`;
    m.line.style.display = '';
    m.line.setAttribute('x1', `${sx}`); m.line.setAttribute('y1', `${sy}`);
    m.line.setAttribute('x2', `${sx}`); m.line.setAttribute('y2', `${sy - FLOAT_PX}`);
    m.dot.style.display = '';
    m.dot.setAttribute('cx', `${sx}`); m.dot.setAttribute('cy', `${sy}`);
    m.shown = true;
  }
  function hide(m: MarkerEl): void {
    if (!m.shown) return;
    m.card.style.display = 'none';
    m.line.style.display = 'none';
    m.dot.style.display = 'none';
    m.shown = false;
  }
}
