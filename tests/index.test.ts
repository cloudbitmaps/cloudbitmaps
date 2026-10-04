import { MemoryStorageChunkSource } from './helpers/memory-chunk-source';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { CloudRoaring, ValidationError } from '@/index';

function store(): CloudRoaring {
  return new CloudRoaring({ storage: new MemoryStorageChunkSource() });
}

describe('public API', () => {
  // The five packages ship in lockstep, and each manifest is the one place its version is written. This fails
  // the build the moment a version bump forgets one of them.
  //
  // EVERY package is asserted, derived from the workspace rather than listed here.
  //
  // A hand-kept list drifts into a subset: a package it leaves out can sit at any version while the whole suite
  // stays green, because no other test reads its version. The release workflow's tag check would catch it only at
  // tag-push time, after the approval, which is precisely the lateness this test exists to remove.
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

  it('keeps every package at one version', () => {
    const versions = PACKAGES.map((pkg) => {
      const manifest: unknown = JSON.parse(
        readFileSync(new URL(`../packages/${pkg}/package.json`, import.meta.url), 'utf8'),
      );
      return (manifest as { version?: unknown }).version;
    });
    expect(new Set(versions).size, `versions by package: ${versions.join(', ')}`).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+/);
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
    // A handle has no per-id write — data enters a segment as a whole generation. Asserted so a per-id verb has
    // to be added deliberately rather than by accident (an `add` that quietly returned would be the worst
    // possible regression: it would look like it worked).
    for (const verb of ['add', 'addMany', 'remove', 'removeMany']) {
      expect(seg).not.toHaveProperty(verb);
      expect((seg as unknown as Record<string, unknown>)[verb]).toBeUndefined();
    }
    expect(store()).not.toHaveProperty('compact');
  });

  it('rejects names that could traverse or inject', () => {
    const cr = store();
    for (const bad of ['', 'a'.repeat(257)]) {
      expect(() => cr.segment(bad)).toThrow(ValidationError);
    }
    expect(() => cr.segment('ok', { namespace: '' })).toThrow(ValidationError);
    // Everything else is an ordinary name, escaped at the boundary.
    for (const ok of ['a/b', '../etc', 'a b', 'a#b', '.hidden', 'con', '100%', 'user@example.com'])
      expect(() => cr.segment(ok)).not.toThrow();
  });
});
