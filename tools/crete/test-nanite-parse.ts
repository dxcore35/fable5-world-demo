/**
 * test-nanite-parse.ts — headless parse test for CreteNanite.ts (T3a).
 *
 * Run:  bun tools/crete/test-nanite-parse.ts
 *
 * Reads the baked binaries from disk, calls parseNaniteChania, prints counts,
 * and asserts correctness. No DOM, no GPU, no fetch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseNaniteChania } from '../../src/crete/CreteNanite';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, 'public/crete/meshlets/chania');

const read = (name: string): ArrayBuffer => {
  const buf = fs.readFileSync(path.join(DIR, name));
  // Convert Node Buffer to a plain ArrayBuffer
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8')) as {
  clusterCount: number;
  MAX_TRIS: number;
  levels: Array<{ clusterCount: number }>;
};

const verticesBuf = read('vertices.bin');
const indicesBuf  = read('indices.bin');
const clustersBuf = read('clusters.bin');

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
const result = parseNaniteChania(verticesBuf, indicesBuf, clustersBuf, meta);
const { positions, indexU32, clusters, lod0SurvivorData, counts } = result;

// ---------------------------------------------------------------------------
// Print counts
// ---------------------------------------------------------------------------
console.log('=== CreteNanite T3a parse test ===');
console.log(`clusterCount        : ${counts.clusterCount}   (expect 1943)`);
console.log(`lod0Count           : ${counts.lod0Count}    (expect 961)`);
console.log(`vertexCount         : ${counts.vertexCount} (expect 171837)`);
console.log(`maxTris             : ${counts.maxTris}  (expect 128)`);
console.log(`indexU32.length     : ${indexU32.length}  (expect 725622)`);
console.log(`positions.length    : ${positions.length} (expect 515511)`);
console.log(`lod0SurvivorData.length : ${lod0SurvivorData.length}  (expect 2883)`);
console.log('');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(label: string, actual: number, expected: number): void {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}: got ${actual}, expected ${expected}`);
    failed++;
  }
}

function assertBool(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

console.log('--- Count assertions ---');
assert('clusterCount == 1943',            counts.clusterCount, 1943);
assert('lod0Count == 961',                counts.lod0Count,    961);
assert('vertexCount == 171837',           counts.vertexCount,  171837);
assert('positions.length == 515511',      positions.length,    171837 * 3);
assert('indexU32.length == 725622',       indexU32.length,     725622);
assert('lod0SurvivorData.length == 2883', lod0SurvivorData.length, 961 * 3);
assert('maxTris == 128',                  counts.maxTris,      128);

// ---------------------------------------------------------------------------
// Bounds checks on sampled lod0 clusters
// ---------------------------------------------------------------------------
console.log('');
console.log('--- Bounds checks (sampled lod0 clusters) ---');

// Collect lod0 cluster indices
const lod0Indices: number[] = [];
for (let c = 0; c < clusters.length; c++) {
  if (clusters[c].lod === 0) lod0Indices.push(c);
}

assert('lod0Indices.length == 961', lod0Indices.length, 961);

// Sample: first, last, and a few in the middle
const sampleIdxInLod0 = [0, 1, 100, 400, 700, 960];

for (const si of sampleIdxInLod0) {
  if (si >= lod0Indices.length) continue;
  const ci = lod0Indices[si];
  const rec = clusters[ci];

  // idxOffset + triCount*3 <= indexU32.length
  assertBool(
    `cluster[${ci}] (lod0[${si}]): idxOffset(${rec.idxOffset}) + triCount*3(${rec.triCount * 3}) <= indexU32.length(${indexU32.length})`,
    rec.idxOffset + rec.triCount * 3 <= indexU32.length,
  );

  // Find max local index within this cluster's index range
  let maxLocalIdx = 0;
  for (let t = 0; t < rec.triCount * 3; t++) {
    const v = indexU32[rec.idxOffset + t];
    if (v > maxLocalIdx) maxLocalIdx = v;
  }

  // vtxOffset + (maxLocalIdx + 1) <= vertexCount
  assertBool(
    `cluster[${ci}] (lod0[${si}]): vtxOffset(${rec.vtxOffset}) + maxLocalIdx+1(${maxLocalIdx + 1}) <= vertexCount(${counts.vertexCount})`,
    rec.vtxOffset + maxLocalIdx + 1 <= counts.vertexCount,
  );
}

// Also verify lod0SurvivorData triples match the cluster records
console.log('');
console.log('--- lod0SurvivorData triple consistency ---');
for (const si of [0, 1, 100, 960]) {
  if (si >= lod0Indices.length) continue;
  const ci = lod0Indices[si];
  const rec = clusters[ci];
  const base = si * 3;
  assertBool(
    `lod0Survivor[${si}] vtxOffset matches cluster[${ci}]`,
    lod0SurvivorData[base + 0] === rec.vtxOffset,
  );
  assertBool(
    `lod0Survivor[${si}] idxOffset matches cluster[${ci}]`,
    lod0SurvivorData[base + 1] === rec.idxOffset,
  );
  assertBool(
    `lod0Survivor[${si}] triCount matches cluster[${ci}]`,
    lod0SurvivorData[base + 2] === rec.triCount,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
