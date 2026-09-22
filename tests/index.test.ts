import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { CloudRoaring, MemoryStorageChunkSource, ValidationError, VERSION } from '@/index';

function store(): CloudRoaring {
  return new CloudRoaring({ storage: new MemoryStorageChunkSource() });
}

describe('public API', () => {
  it('exposes a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The exported marker is what a consumer reads to report "which CloudRoaring am I running". A hand-edited
  // constant drifts silently at the next release, so the manifests are the source of truth and this fails the
  // build the moment a version bump forgets one of them.
  //
  // EVERY package is asserted, derived from the workspace rather than listed here.
  //
  // This named `roaring` and `core` only, on the reasoning that those were the two published packages. The
  // split made that list a subset: `s3`, `gcs` and `azure-blob` could sit at any version and the whole suite
  // stayed green — 150 files, every gate — because nothing looked at them. The release workflow's tag check
  // would have caught it, at tag-push time, after the approval, which is precisely the lateness this test
  // exists to remove.
  //
  // The list is read off the filesystem so a sixth package is covered on the day it is created, rather than
  // on the day someone remembers to add it here.
  const PACKAGES = readdirSync(new URL('../packages', import.meta.url)).filter((d) =>
    existsSync(new URL(`../packages/${d}/package.json`, import.meta.url)),
  );

  it('finds every workspace package', () => {
    // Without this, a bad glob would make the lockstep check below pass over an empty list.
    expect(PACKAGES.length).toBeGreaterThanOrEqual(5);
    expect(PACKAGES).toContain('core');
    expect(PACKAGES).toContain('roaring');
    expect(PACKAGES).toContain('s3');
  });

  it.each(PACKAGES)('keeps VERSION in sync with @cloudbitmaps/%s', (pkg) => {
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

  it('rejects names that could traverse or inject', () => {
    const cr = store();
    for (const bad of ['', 'a'.repeat(257)]) {
      expect(() => cr.segment(bad)).toThrow(ValidationError);
    }
    expect(() => cr.segment('ok', { namespace: '' })).toThrow(ValidationError);
    // Everything that used to be refused is now an ordinary name, escaped at the boundary.
    for (const ok of ['a/b', '../etc', 'a b', 'a#b', '.hidden', 'con', '100%', 'user@example.com'])
      expect(() => cr.segment(ok)).not.toThrow();
  });
});
