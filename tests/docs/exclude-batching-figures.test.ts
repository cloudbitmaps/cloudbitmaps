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

  it('the guide and the changelog state the bytes of the spread-survivors shape the engine test pins', () => {
    // tests/core/exclude-batching.test.ts: 8 to 10 requests and 5.6 to 6.3 MB, where reading each key was 32 and 262,656.
    const cost = flat('docs/guide/cost.md');
    const log = flat('CHANGELOG.md');
    for (const text of [cost, log]) {
      expect(text).toContain('8 to 10 ');
      expect(text).toContain('5.7 to 6.2 MB');
      expect(text).toContain('262,656');
    }
    expect(cost).toContain('reading each key on its own made 32 requests');
    expect(cost).toContain('about 83 ms against 105 ms, about 27% longer');
    expect(log).toContain('about 27% longer');
    const engineTest = readFileSync(join(ROOT, 'tests/core/exclude-batching.test.ts'), 'utf8');
    expect(engineTest).toContain('toBeGreaterThanOrEqual(8)');
    expect(engineTest).toContain('toBeLessThanOrEqual(10)');
    expect(engineTest).toContain('toBe(262_656)');
  });
});
