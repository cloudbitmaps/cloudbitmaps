import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { MOVED_OPTIONS } from '@/moved-options';

/**
 * Every constructor option the previous release had, and this one does not, must be REJECTED BY NAME.
 *
 * WHY THIS FILE EXISTS. `MOVED_OPTIONS` is the guard that catches an upgrader's stale option and tells them
 * where it went. It was keyed on `storageGenTtlMs`, `storageReaderCacheMax` and `storageReaderCacheMaxBytes`
 * — three names that **never appeared in any release**. They existed between two unreleased commits of this
 * cycle, and the rename to them happened after `0.9.0` shipped. So the guard written for an upgrader named
 * nothing an upgrader could have, and `coldGenTtlMs` — what `0.9.0` actually had — was accepted in silence.
 *
 * Silence is the whole problem. The doc comment on `MOVED_OPTIONS` spells out why an ignored option is worse
 * than a rejected one: a dropped `requireEncryption` reads cleartext when the caller demanded encryption; a
 * dropped reader-cache ceiling restores a 64 MiB default someone had lowered for a small heap. None of it
 * announces itself. The guard warned about exactly that hazard while being blind to the names that trigger it.
 *
 * Eight of seventeen removed options were silently ignored, including `warm` — which was **required** in
 * `0.9.x`, so every single upgrader passes one.
 *
 * DERIVED FROM THE TAG, not from a list. The set is computed by diffing `CloudRoaringOptions` at `v0.9.0`
 * against HEAD, so it cannot drift: add an option, remove one, rename one, and this test re-derives. A
 * hardcoded list is what failed here — it was written once, from the shape of the code at that moment.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PREVIOUS_TAG = 'v0.9.0';

function optionNames(src: string): Set<string> {
  // Comments stripped FIRST. Without it the ground truth is raw text, so a `readonly foo?:` written inside a
  // JSDoc — an upgrader note in the interface, say — counts as a live option, is subtracted from `removed`,
  // and its case simply stops existing. Measured: one such comment took the suite from 19 tests to 17, all
  // green, while the constructor silently ignored `occBackoff` again. `previous-release-claims.test.ts` had
  // already learned this and written it down; the lesson did not travel to this file until it bit here too.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body = /export interface CloudRoaringOptions[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
  return new Set([...body.matchAll(/readonly\s+([A-Za-z0-9_]+)\??:/g)].map((m) => m[1] as string));
}

function atTag(path: string): string | null {
  try {
    return execFileSync('git', ['show', `${PREVIOUS_TAG}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

describe(`every ${PREVIOUS_TAG} option that no longer exists is rejected by name`, () => {
  const old = atTag('packages/roaring/src/index.ts');
  const current = optionNames(readFileSync(join(ROOT, 'packages/roaring/src/index.ts'), 'utf8'));

  it(`can read ${PREVIOUS_TAG} (a guard that cannot see the tag proves nothing)`, () => {
    expect(old, `could not read the tag — CI needs fetch-depth: 0`).not.toBeNull();
    expect(optionNames(old ?? '').size).toBeGreaterThan(15);
  });

  const removed = [...optionNames(old ?? '')].filter((n) => !current.has(n)).sort();

  it('found exactly the removed options, so a silent shrink is loud', () => {
    // An EXACT set, not a floor. `> 10` let the count drop 17 → 14 without a word — and a dropped entry is
    // precisely a constructor that goes back to ignoring an option in silence.
    expect(removed).toEqual(
      [
        'cold',
        'coldGenTtlMs',
        'coldReaderCacheMax',
        'coldReaderCacheMaxBytes',
        'cacheMaxChunks',
        'cacheTtlMs',
        'clock',
        'keystore',
        'maxWarmScanBytes',
        'occBackoff',
        'onRetry',
        'registry',
        'requireEncryption',
        'rng',
        'warm',
        'warmReadConsistency',
        'writeConcurrency',
      ].sort(),
    );
  });

  it('the advice is pinned, so changing what an upgrader is told is a deliberate edit', () => {
    // Shape checks alone were not enough: repointing `warm` at `cache.maxChunks` and calling it a `group`
    // satisfies every structural rule while telling an upgrader to move a removed tier into a cache ceiling.
    // The guidance IS the product here, so it is pinned verbatim — a change has to be typed on purpose, in a
    // diff someone reads, rather than arrived at.
    expect(MOVED_OPTIONS.filter(([, , k]) => k === 'gone')).toEqual([
      ['warm', 'the live tier is gone', 'gone'],
      ['warmReadConsistency', 'it tuned the live tier', 'gone'],
      ['maxWarmScanBytes', 'it tuned the live tier', 'gone'],
      ['writeConcurrency', 'it bounded the live tier\u2019s flusher', 'gone'],
      ['occBackoff', 'it tuned the live tier\u2019s read-modify-write', 'gone'],
    ]);
    expect(MOVED_OPTIONS.filter(([, , k]) => k === 'renamed').map(([from]) => from)).toEqual([
      'registry',
      'cold',
    ]);
  });

  it('the advice each one gives is structurally valid', () => {
    // Rejection alone was the only thing asserted, so the moved/removed correctness this guard is ABOUT was
    // ungated: repointing `warm` at `cache.maxChunks` left the suite 19/19 green while the shipped error told
    // every upgrader to move a removed tier into a cache ceiling.
    const live = optionNames(readFileSync(join(ROOT, 'packages/roaring/src/index.ts'), 'utf8'));
    const groups = new Set(['cache', 'encryption', 'retry', 'seams']);
    for (const [from, to, kind] of MOVED_OPTIONS) {
      if (kind === 'gone') continue; // no successor to check — that IS the claim
      if (kind === 'renamed') {
        // A rename points at a live top-level option, or explains itself in prose.
        expect(live.has(to) || to.includes(' '), `${from} → ${to}`).toBe(true);
        continue;
      }
      const [group, key] = to.split('.');
      expect(
        groups.has(group ?? ''),
        `${from} → ${to}: \`${group}\` is not one of the four groups`,
      ).toBe(true);
      expect(key, `${from} → ${to} names no key inside the group`).toBeTruthy();
    }
  });

  it.each(removed)('`%s` throws instead of being ignored', (name) => {
    let thrown: unknown;
    try {
      new CloudRoaring({ storage: new MemoryStorage(), [name]: 1 } as never);
    } catch (err) {
      thrown = err;
    }
    expect(
      thrown,
      `\`${name}\` was a ${PREVIOUS_TAG} option and is gone, but the constructor ACCEPTED it. An ignored ` +
        `option is silent and wrong — add it to MOVED_OPTIONS with where it went, or that it went nowhere.`,
    ).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain(name);
  });
});
