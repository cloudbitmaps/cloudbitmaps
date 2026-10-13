/**
 * What the plan of a batch combine holds, measured against what the ledger charges for it. The plan is built before the
 * first chunk is read and lives for the whole call, so its charge has to be an upper bound for the call to keep its budget.
 * Each shape runs in a process of its own with the collector exposed: the planner is bundled from its source, given a source
 * that reports an index and then refuses its first read, and the heap and external memory are taken at that read, after a
 * full collection, over a baseline taken before the request was compiled (the caller's own expression objects are in both).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const PLANNER = join(__dirname, '..', '..', 'packages', 'core', 'src', 'core', 'combine-many.ts');

const ENTRY = `
import { compileCombineMany, runCombineMany } from ${JSON.stringify(PLANNER)};
const shape = JSON.parse(process.argv[2]);
const used = () => { const m = process.memoryUsage(); return m.heapUsed + m.external; };
const names = Array.from({ length: shape.operands }, (_, i) => 'op' + i);
const leaf = (i) => names[i % names.length];
// A tree of about shape.nodes nodes: wide (one operator over leaves) or deep (a chain of operators).
const tree = (o) => {
  if (shape.kind === 'deep') {
    let e = leaf(o);
    for (let d = 0; d < shape.nodes / 2; d++) e = { [d % 3 === 0 ? 'and' : d % 3 === 1 ? 'or' : 'andNot']: [e, leaf(o + d + 1)] };
    return e;
  }
  return { or: Array.from({ length: shape.nodes - 1 }, (_, i) => leaf(o + i)) };
};
const outputs = Array.from({ length: shape.outputs }, (_, o) => ({ expr: tree(o), publish: async () => 0 }));
const operands = names.map((name) => ({ name, ref: { segment: name } }));
const keys = Array.from({ length: shape.keys }, (_, i) => i);
let measured = null;
const source = {
  listChunkKeys: async () => [...keys],
  cardinalities: async () => new Map(keys.map((k) => [k, 10])),
  sizeOf: async () => ({ sizeBytes: 1000 }),
  getChunk: async () => null,
  getChunks() {
    return { [Symbol.asyncIterator]() { return { next: async () => {
      if (measured === null) { global.gc(); global.gc(); measured = used() - base; }
      throw new Error('stop');
    } }; } };
  },
};
const codec = { empty() {}, fromValues() {}, safeDeserialize() {} };
global.gc(); global.gc();
const base = used();
const compiled = compileCombineMany({ operands, outputs, keep: 1, maxBufferedBytes: 4 * 2 ** 30, publishConcurrency: 8, concurrency: 1, allowAbsentOperands: true });
const run = await runCombineMany(compiled, { source, codec, clock: { now: () => 0, sleep: async () => {} } });
console.log(JSON.stringify({ measured, charged: run.stats.memory.highWaterBytes, plan: run.stats.memory.planBytes }));
`;

const shapes = [
  { name: 'node-dense', kind: 'wide', outputs: 10_000, nodes: 8, keys: 20, operands: 20 },
  { name: 'node-heavy', kind: 'wide', outputs: 2_000, nodes: 64, keys: 20, operands: 20 },
  { name: 'deep', kind: 'deep', outputs: 2_000, nodes: 60, keys: 20, operands: 20 },
  { name: 'key-dense', kind: 'wide', outputs: 1_000, nodes: 8, keys: 2_000, operands: 20 },
  { name: 'key-dense, wide', kind: 'wide', outputs: 300, nodes: 40, keys: 2_000, operands: 50 },
];

describe('the plan charge is an upper bound on what the plan holds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-memory-'));
  const entry = join(dir, 'entry.mjs');
  const bundle = join(dir, 'bundle.mjs');
  writeFileSync(entry, ENTRY);
  it.each(shapes)(
    '$name',
    async (shape) => {
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
      });
      const out = execFileSync(process.execPath, ['--expose-gc', bundle, JSON.stringify(shape)], {
        encoding: 'utf8',
        maxBuffer: 1 << 24,
      });
      const { measured, charged, plan } = JSON.parse(out.trim().split('\n').pop()!) as {
        measured: number;
        charged: number;
        plan: number;
      };
      expect(plan).toBeGreaterThan(0);
      // what the ledger held at its peak (the plan, and the first group's own plan and streams) covers what the heap and
      // external memory held at the first read
      expect(charged).toBeGreaterThanOrEqual(measured);
    },
    120_000,
  );
});
