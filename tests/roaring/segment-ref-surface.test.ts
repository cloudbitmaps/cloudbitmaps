import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A new public method that takes a segment ref must be checked for keys it does not take. The inventory is the
 * promised surface (`api-surface/surface.json`, which `api:surface:check` holds equal to the built declarations, so a
 * new method appears there in the same change): every entry whose parameters name a ref type is either in the tables of
 * `segment-ref-keys.test.ts` and `drivers/port-keys.test.ts`, or exempt below with its reason.
 *
 * Known limit: a ref typed inline as `{ segment: string; ... }`, or through a new alias, is not seen; add the alias to
 * REF_PARAM.
 */

const { entries } = JSON.parse(readFileSync('api-surface/surface.json', 'utf8')) as {
  entries: Record<string, unknown>;
};

/** A parameter typed as a ref, or as a type that extends one (an array of them included). */
const REF_PARAM = /:\s*(?:readonly\s+)?(SegmentRef|SegmentInfo|ChunkRef|GenKey)\b/;

/** The text between a signature's first `(` and its matching `)`, or `null` when it has none. */
function paramsOf(sig: string): string | null {
  const open = sig.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) return sig.slice(open + 1, i);
  }
  return null;
}

/** The promised entries whose parameters name a ref type. */
export function refTaking(all: Record<string, unknown>): string[] {
  return Object.entries(all)
    .filter(([, sig]) => {
      if (typeof sig !== 'string') return false;
      const params = paramsOf(sig);
      return params !== null && REF_PARAM.test(params);
    })
    .map(([key]) => key);
}

const STORE = '@cloudbitmaps/roaring CloudRoaring.';
/** The entries `segment-ref-keys.test.ts` runs a typo ref through. */
const TABLED_STORE = [
  'load',
  'exists',
  'generations',
  'rollback',
  'dropSegment',
  'setRetention',
  'getRetention',
  'clearRetention',
  'invalidate',
].map((v) => `${STORE}${v}`);

/** Entries not in a table of `segment-ref-keys.test.ts`, each with where it is covered or why it needs none. */
const EXEMPT: Record<string, string> = {
  '@cloudbitmaps/roaring destroySegment': 'tabled as a free function in segment-ref-keys.test.ts',
  '@cloudbitmaps/roaring ExportSink.open':
    'the library calls it with a ref it built; a sink implements it',
};
const DRIVER_KIT = '@cloudbitmaps/core/driver-kit ';
/** The driver ports and the key builders behind them, each refusing in `drivers/port-keys.test.ts` or the source tests. */
const PORTS = [
  'IRegistryDriver.',
  'IStorageDriver.',
  'ObjectStoreRegistry.',
  'StorageChunkSource.',
  'segmentObjectPrefix',
  'storageObjectKey',
  'validateSegmentRef',
];

const isPort = (key: string): boolean =>
  key.startsWith(DRIVER_KIT) && PORTS.some((p) => key.slice(DRIVER_KIT.length).startsWith(p));

/** The ref-taking entries that no table covers and no exemption names. */
function untabled(all: Record<string, unknown>): string[] {
  const tabled = new Set([...TABLED_STORE, ...Object.keys(EXEMPT)]);
  return refTaking(all).filter((k) => !tabled.has(k) && !isPort(k));
}

describe('every promised entry that takes a ref is covered by a test table', () => {
  it('the inventory finds the store methods, the free function and the ports', () => {
    const found = refTaking(entries);
    for (const key of [...TABLED_STORE, '@cloudbitmaps/roaring destroySegment']) {
      expect(found).toContain(key);
    }
    expect(found.some(isPort)).toBe(true);
  });

  it('none is left out of a table', () => {
    const left = untabled(entries);
    expect(left).toEqual([]);
  });

  it('an added method that takes a ref is found; look-alikes are not', () => {
    const mutated = {
      ...entries,
      [`${STORE}touch`]: 'touch(ref: SegmentRef): Promise<void>;',
      [`${STORE}dropMany`]:
        'dropMany(refs: readonly SegmentRef[], options?: object): Promise<void>;',
      [`${STORE}restore`]: 'restore(row: SegmentInfo): Promise<void>;',
      [`${STORE}byHandle`]: 'byHandle(seg: Segment, report: SubjectSegmentRef): void;',
      [`${STORE}returnsRef`]: 'returnsRef(name: string): SegmentRef;',
    };
    const found = untabled(mutated);
    for (const v of ['touch', 'dropMany', 'restore']) expect(found).toContain(`${STORE}${v}`);
    for (const v of ['byHandle', 'returnsRef']) expect(found).not.toContain(`${STORE}${v}`);
  });
});
