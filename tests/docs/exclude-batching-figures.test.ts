import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The guide, the cost model's doc and the changelog state when an exclude's batch is read and what it costs. The numbers
 * they state are derived here from the constants the engine uses, so a change to the engine's batch size or its quiet
 * wait fails here until the prose is changed with it. Nothing here counts requests: `tests/core/exclude-batching.test.ts`
 * does that against the engine.
 *
 * KNOWN LIMIT. It reads the figures, not the sentences around them.
 */
const ROOT = join(__dirname, '..', '..');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
const engine = readFileSync(join(ROOT, 'packages/core/src/core/engine.ts'), 'utf8');

const DEFAULT_CONCURRENCY = Number(/DEFAULT_INTERSECT_CONCURRENCY = (\d+);/.exec(engine)![1]);
const QUIET_HOPS = Number(/const BATCH_QUIET_HOPS = (\d+);/.exec(engine)![1]);
const HALF = Math.max(1, Math.ceil(DEFAULT_CONCURRENCY / 2));
const BATCHES_OF_1000 = Math.ceil(1_000 / HALF);

describe('the figures of an exclude read in batches', () => {
  it('the engine sizes a batch at half the concurrency, which is what the docs say', () => {
    expect(engine).toContain('Math.max(1, Math.ceil(concurrency / 2))');
    for (const rel of ['docs/guide/reading.md', 'docs/guide/cost.md', 'CHANGELOG.md']) {
      expect(flat(rel), rel).toContain(`half of \`concurrency\``);
    }
    expect(flat('docs/guide/reading.md')).toContain(
      `(${HALF} of ${DEFAULT_CONCURRENCY} by default)`,
    );
    expect(flat('docs/guide/cost.md')).toContain(`(${HALF} of ${DEFAULT_CONCURRENCY} by default)`);
    expect(flat('CHANGELOG.md')).toContain(`(${HALF} of ${DEFAULT_CONCURRENCY} by default)`);
  });

  it('the guide states the quiet wait the engine makes', () => {
    expect(flat('docs/guide/reading.md')).toContain(`${QUIET_HOPS} turns of the microtask queue`);
  });

  it('the guide and the changelog state the requests of 1,000 survivors, whole intersect and exclude', () => {
    const exclude = BATCHES_OF_1000;
    const whole = exclude + 2; // an include range each
    const cost = flat('docs/guide/cost.md');
    expect(cost).toContain(
      `1,000 surviving keys cost the exclude itself ${exclude} range requests`,
    );
    expect(cost).toContain(`the whole intersect ${whole}`);
    const log = flat('CHANGELOG.md');
    expect(log).toContain(`1,000 range requests before and ${exclude} now`);
    expect(log).toContain(`1,002 and ${whole}`);
    expect(flat('packages/tools/src/cost.ts')).toContain(
      `63 requests, where it was 1,000`.replace('63', String(exclude)),
    );
  });
});
