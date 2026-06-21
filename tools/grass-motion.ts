/**
 * Motion reconvergence test: the user's "renders bottom-to-up, circle spreads,
 * re-renders until detailed" is a MOTION artifact (TRAA history rejection on
 * camera change). Reproduce it: converge at pose A, hard-cut to pose B (worst
 * case — a smooth fly rejects far less), then capture the reconvergence at
 * 1/2/4/8/20 settled frames so we can SEE how fast/clean it resolves and
 * whether a dither stipple appears.
 *
 *   bunx tsx tools/grass-motion.ts --tag motion
 */
import { mkdirSync } from 'node:fs';
import { launchWebGPU, laasUrl } from './launch';

const A = { x: -870, z: 862, alt: 1.7, yaw: -1.45, pitch: -0.16 };
// pose B: walked ~14 m forward and turned — a real camera move
const B = { x: -858, z: 869, alt: 1.7, yaw: -1.2, pitch: -0.16 };
const STEPS = [1, 2, 4, 8, 20];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tag = (() => {
    const i = args.indexOf('--tag');
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : 'motion';
  })();
  const width = 1280;
  const height = 720;
  mkdirSync('shots', { recursive: true });

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  const url = laasUrl({ scene: 'gavdos', width, height, hud: false, freeze: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 180000, polling: 250 },
  );
  if (await page.evaluate(() => window.__laas.error)) throw new Error('fatal');

  // converge fully at pose A
  await page.evaluate((p) => {
    const g = window.__laas.groundProbe?.(p.x, p.z) ?? { ground: 0, water: 0 };
    window.__laas.setPose?.({ p: [p.x, g.ground + p.alt, p.z], yaw: p.yaw, pitch: p.pitch });
  }, A);
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(40)));

  // hard cut to pose B, then capture reconvergence frame-by-frame
  await page.evaluate((p) => {
    const g = window.__laas.groundProbe?.(p.x, p.z) ?? { ground: 0, water: 0 };
    window.__laas.setPose?.({ p: [p.x, g.ground + p.alt, p.z], yaw: p.yaw, pitch: p.pitch });
  }, B);

  let done = 0;
  for (const target of STEPS) {
    await page.evaluate(async (n) => window.__laas.settle && (await window.__laas.settle(n)), target - done);
    done = target;
    const out = `shots/grass-${tag}-f${String(target).padStart(2, '0')}.png`;
    await page.screenshot({ path: out });
    console.log(`[motion] reconverged frame ${target} → ${out}`);
  }
  await browser.close();
}

void main();
