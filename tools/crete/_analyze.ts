import * as fs from 'node:fs';
import * as path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../../public/crete');
const M = (a: number[], b: number[]): number => {
  const mLon = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * 110540);
};
function analyze(file: string): void {
  const fc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const rings = fc.features.map((f: any) => f.geometry.coordinates[0]).sort((a: any[], b: any[]) => b.length - a.length);
  const ring = rings[0]; // largest = Crete main island
  let total = 0; const segLens: number[] = []; let straightRun = 0, maxStraightRun = 0, longRuns = 0;
  const angles: number[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const d = M(ring[i], ring[i + 1]); total += d; segLens.push(d);
  }
  // turning angle at each interior vertex
  for (let i = 1; i < ring.length - 1; i++) {
    const a = ring[i - 1], b = ring[i], c = ring[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    const m1 = Math.hypot(v1[0], v1[1]), m2 = Math.hypot(v2[0], v2[1]);
    if (m1 < 1e-12 || m2 < 1e-12) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2)))) * 180 / Math.PI;
    angles.push(ang);
    // accumulate straight run length (turn < 3°)
    if (ang < 3) { straightRun += M(b, c); maxStraightRun = Math.max(maxStraightRun, straightRun); }
    else { if (straightRun > 200) longRuns++; straightRun = 0; }
  }
  segLens.sort((x, y) => x - y);
  angles.sort((x, y) => x - y);
  const q = (arr: number[], p: number): number => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const nearStraight = angles.filter((a) => a < 3).length / angles.length;
  console.log(`\n=== ${file} ===`);
  console.log(`  main ring: ${ring.length} pts, ${(total / 1000).toFixed(1)} km perimeter`);
  console.log(`  seg len (m): median ${q(segLens, 0.5).toFixed(0)}, p90 ${q(segLens, 0.9).toFixed(0)}, max ${segLens[segLens.length - 1].toFixed(0)}`);
  console.log(`  turn angle (deg): median ${q(angles, 0.5).toFixed(1)}, p90 ${q(angles, 0.9).toFixed(1)}`);
  console.log(`  near-straight vertices (<3°): ${(nearStraight * 100).toFixed(0)}%`);
  console.log(`  straight runs >200m: ${longRuns}, longest straight run: ${maxStraightRun.toFixed(0)}m`);
}
analyze('coastline.geojson');
analyze('coastline-sds.geojson');
