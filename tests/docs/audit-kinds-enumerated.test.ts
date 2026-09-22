import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pages that enumerate the audit event kinds must enumerate ALL of them.
 *
 * WHY THIS EXISTS. Two surfaces promised a complete list and delivered five of seven.
 * `site/architecture.html` said "Every change of state is an audit event beside it:" and then named five;
 * `docs/guide/dashboards.md` introduced "what lands in the log" the same way. Both omitted
 * `segment.rollback` and `segment.load-refused`.
 *
 * Neither omission is cosmetic. `segment.rollback` records an operator moving the pointer BACKWARDS, and the
 * disaster-recovery guide tells operators it is the one event whose effect cannot be reconstructed from the
 * objects in the bucket — so a compliance reader building a trail from the enumerated list would have left
 * out the only irreversible one. `segment.load-refused` is how a refused load is distinguished from a job
 * that never ran; without it, the absence of a `segment.publish` means two different things.
 *
 * The list is DERIVED from `audit.ts` rather than restated here, so a new kind is covered on the day it is
 * added rather than on the day someone remembers these pages exist.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `readonly kind: '…'` in the audit record union. */
function auditKinds(): string[] {
  const src = readFileSync(join(ROOT, 'packages/core/src/core/audit.ts'), 'utf8');
  return [...new Set([...src.matchAll(/readonly kind: '([a-z.-]+)'/g)].map((m) => m[1] as string))];
}

/** Pages whose wording promises the whole set. */
const ENUMERATING_PAGES = [
  join('docs', 'guide', 'dashboards.md'),
  join('site', 'architecture.html'),
] as const;

describe('a page that lists the audit kinds lists all of them', () => {
  const kinds = auditKinds();

  it('finds the kinds in the source, so this cannot pass vacuously', () => {
    // If the union is ever restructured, an empty list would make every assertion below trivially true.
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    expect(kinds).toContain('segment.publish');
    expect(kinds).toContain('segment.rollback');
    expect(kinds).toContain('segment.load-refused');
  });

  it.each(ENUMERATING_PAGES)('%s names every audit kind', (page) => {
    const src = readFileSync(join(ROOT, page), 'utf8');
    const missing = kinds.filter((k) => !src.includes(k));
    expect(
      missing,
      `${page} enumerates the audit kinds but omits ${missing.join(', ')}. Either name them, or reword so ` +
        'the page no longer promises a complete list.',
    ).toEqual([]);
  });
});
