import { readFileSync } from 'node:fs';
import { CloudRoaring, MemoryColdChunkSource, ValidationError, VERSION } from '@/index';

function store(): CloudRoaring {
  return new CloudRoaring({ cold: new MemoryColdChunkSource() });
}

describe('public API', () => {
  it('exposes a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The exported marker is what a consumer reads to report "which CloudRoaring am I running". A hand-edited
  // constant drifts silently at the next release, so the manifests are the source of truth and this fails the
  // build the moment a version bump forgets one of the three.
  //
  // BOTH packages are asserted: the release workflow requires every package version to equal the pushed tag
  // ("the family releases in lockstep"), and that invariant otherwise had no test — core could drift all the
  // way to tag-push time, long after merge.
  it.each(['roaring', 'core'])('keeps VERSION in sync with @cloudbitmaps/%s', (pkg) => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL(`../packages/${pkg}/package.json`, import.meta.url), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    expect(version).toBe(VERSION);
  });

  it('accepts valid segment / namespace names', () => {
    expect(() => store().segment('paying_users')).not.toThrow();
    expect(() => store().segment('seg-1.v2', { namespace: 'acme' })).not.toThrow();
  });

  it('exposes the store lifecycle methods', () => {
    const cr = store();
    for (const method of [
      'eraseSubject',
      'subjectReport',
      'dropSegment',
      'setRetention',
      'getRetention',
      'clearRetention',
      'retireExpired',
      'checkConsistency',
      'exportSegments',
    ] as const) {
      expect(typeof cr[method]).toBe('function');
    }
  });

  it('exposes the segment verbs, and no write verb', () => {
    const seg = store().segment('s');
    for (const method of [
      'has',
      'count',
      'iterate',
      'intersect',
      'union',
      'andNot',
      'intersectInto',
      'unionInto',
      'andNotInto',
      'costReport',
    ] as const) {
      expect(typeof seg[method]).toBe('function');
    }
    // The write verbs are gone with the warm tier — data enters a segment as a whole generation. Asserted so a
    // re-introduction has to be deliberate rather than accidental (an `add` that quietly returned would be the
    // worst possible regression: it would look like it worked).
    for (const gone of ['add', 'addMany', 'remove', 'removeMany', 'claimMany']) {
      expect(seg).not.toHaveProperty(gone);
      expect((seg as unknown as Record<string, unknown>)[gone]).toBeUndefined();
    }
    expect(store()).not.toHaveProperty('compact');
  });

  it('rejects names that could traverse or inject (S2)', () => {
    const cr = store();
    for (const bad of ['', 'a/b', '../etc', 'a..b', 'a b', 'a#b', '.hidden']) {
      expect(() => cr.segment(bad)).toThrow(ValidationError);
    }
    expect(() => cr.segment('ok', { namespace: 'a/b' })).toThrow(ValidationError);
  });
});
