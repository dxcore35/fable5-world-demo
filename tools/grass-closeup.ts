/**
 * One-off grass inspection: boots Gavdos once, then captures several poses that
 * actually FILL the frame with near grass (the scenic bookmarks all face the
 * sea). Uses __laas.groundProbe to place the camera a few metres above inland
 * ground, so we can judge blade realism / repeat-pattern / LOD directly.
 *
 *   bunx tsx tools/grass-closeup.ts --settle 36 --tag before
 */
import { mkdirSync } from 'node:fs';
import { launchWebGPU, laasUrl } from './launch';

interface Pose {
  name: string;
  x: number;
  z: number;
  alt: number;
  yaw: number;
  pitch: number;
}

// inland Gavdos points the bookmarks treat as grassy (meadow + gorge banks)
const POSES: Pose[] = [
  { name: 'meadow-eye', x: -870, z: 862, alt: 1.7, yaw: -1.45, pitch: -0.16 },
  { name: 'meadow-down', x: -870, z: 862, alt: 10, yaw: -1.45, pitch: -0.95 },
  { name: 'gorge-eye', x: 620, z: 655, alt: 1.6, yaw: 0.5, pitch: -0.2 },
  { name: 'meadow-high', x: -870, z: 862, alt: 120, yaw: -1.45, pitch: -0.7 },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
  };
  const settle = Number(get('settle', '36'));
  const tag = get('tag', 'shot');
  const width = 1280;
  const height = 720;
  mkdirSync('shots', { recursive: true });

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page:error] ${m.text()}`);
  });

  const url = laasUrl({ scene: 'gavdos', width, height, hud: false, freeze: true });
  console.log(`[closeup] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 180000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(`fatal: ${err}`);

  for (const pose of POSES) {
    const info = await page.evaluate((p) => {
      const h = window.__laas.groundProbe?.(p.x, p.z) ?? { ground: 0, water: 0 };
      const y = h.ground + p.alt;
      window.__laas.setPose?.({ p: [p.x, y, p.z], yaw: p.yaw, pitch: p.pitch });
      return { ground: h.ground, water: h.water, y };
    }, pose);
    await page.evaluate(async (f) => window.__laas.settle && (await window.__laas.settle(f)), settle);
    const out = `shots/grass-${tag}-${pose.name}.png`;
    await page.screenshot({ path: out });
    const stats = await page.evaluate(() => window.__laas.stats);
    const c = (stats?.counters ?? {}) as Record<string, number>;
    console.log(
      `[closeup] ${pose.name} ground=${info.ground.toFixed(0)} water=${info.water.toFixed(0)} ` +
        `fps=${stats?.fps?.toFixed(1)} g0=${c['veg.g0']} g1=${c['veg.g1']} g2=${c['veg.g2']} g3=${c['veg.g3']} → ${out}`,
    );
  }
  await browser.close();
}

void main();
