import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The production guide's "Writes" row names the lifecycle helpers that settle a write that got no answer by reading it
 * back. A helper named there must be one whose code uses the shared settle module, so the row cannot claim a settle a
 * helper does not make.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const CORE = 'packages/core/src/core/';
const SETTLED: Record<string, string[]> = {
  destroySegment: ['erasure.ts'],
  eraseNamespace: ['erasure.ts'],
  dropSegment: ['erasure.ts'],
  retireExpired: ['retention-sweep.ts'],
  setRetention: ['retention.ts'],
  clearRetention: ['retention.ts'],
  rollback: ['rollback.ts'],
  eraseSubject: ['erase-id.ts'],
  "a load's collection": ['generation-gc.ts'],
};

describe('the production guide names only helpers that settle through settle.ts', () => {
  const row = read('docs/guide/production.md')
    .split('\n')
    .find((l) => l.startsWith('| Writes: `load`'))!;

  it.each(Object.entries(SETTLED))('%s', (name, files) => {
    expect(row).toContain(name.startsWith('a load') ? "a load's collection" : '`' + name + '`');
    for (const f of files) expect(read(CORE + f)).toMatch(/from '\.\/settle'/);
  });

  it('names nothing outside the list', () => {
    const named = [
      ...row.matchAll(
        /`(destroySegment|eraseNamespace|dropSegment|retireExpired|setRetention|clearRetention|rollback|eraseSubject)`/g,
      ),
    ].map((m) => m[1]);
    for (const n of named) expect(Object.keys(SETTLED)).toContain(n);
  });
});
