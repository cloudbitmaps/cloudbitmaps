import type { CloudRoaring, SegmentRef } from '@/index';

/** A ref with a misspelt `namespace`: read as `{ segment: 'a' }` it would address the default namespace. */
export const TYPO = { segment: 'a', namspace: 'eu' } as unknown as SegmentRef;

/**
 * Every store method that takes a ref, each called with {@link TYPO}. `segment-ref-keys.test.ts` runs the table, and
 * `segment-ref-surface.test.ts` derives from it the methods it counts as covered, so a verb cannot be listed as covered
 * without a row here.
 */
export const storeCalls: Array<[string, (s: CloudRoaring) => unknown]> = [
  ['load', (s) => s.load(TYPO, [1])],
  ['exists', (s) => s.exists(TYPO)],
  ['generations', (s) => s.generations(TYPO)],
  ['rollback', (s) => s.rollback(TYPO, 0)],
  ['dropSegment', (s) => s.dropSegment(TYPO, { confirmSegment: 'a' })],
  ['setRetention', (s) => s.setRetention(TYPO, { expiresAt: Date.now() + 2 * 365 * 86_400_000 })],
  ['getRetention', (s) => s.getRetention(TYPO)],
  ['clearRetention', (s) => s.clearRetention(TYPO)],
  ['invalidate', (s) => s.invalidate(TYPO)],
];
