import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The production guide's "Writes" row names the lifecycle helpers that settle a write that got no answer by reading it
 * back. A helper named there must be one whose code uses the shared settle module, so the row cannot claim a settle a
 * helper does not make.
 *
 * Known limit: the check is file-level. A helper passes when the file that holds it imports `settle.ts`, whether or not
 * that particular write goes through it, so a file that settles one write and sends another unsettled is vouched for as
 * a whole. The code's own tests, one per lost-answer fault, are what hold each write.
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

/** Backticked names in the token-settled sentence that are not lifecycle helpers. */
const NOT_HELPERS: string[] = ['load'];

/** Every backticked identifier in the row's sentence "counts as landed when the row shows its write token: ...". */
function tokenSettledNames(row: string): string[] {
  const start = row.indexOf('counts as landed when the row shows its write token:');
  const end = row.indexOf('A delete that gets no answer', start);
  if (start < 0 || end < 0) throw new Error('the row no longer has the token-settled sentence');
  return [...row.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe('the production guide names only helpers that settle through settle.ts', () => {
  const row = read('docs/guide/production.md')
    .split('\n')
    .find((l) => l.startsWith('| Writes: `load`'))!;

  it.each(Object.entries(SETTLED))('%s', (name, files) => {
    expect(row).toContain(name.startsWith('a load') ? "a load's collection" : '`' + name + '`');
    for (const f of files) expect(read(CORE + f)).toMatch(/from '\.\/settle'/);
  });

  it('names nothing outside the list', () => {
    const named = tokenSettledNames(row);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) {
      if (NOT_HELPERS.includes(n)) continue;
      expect(Object.keys(SETTLED), `\`${n}\` is named as settled by a write token`).toContain(n);
    }
  });
});
