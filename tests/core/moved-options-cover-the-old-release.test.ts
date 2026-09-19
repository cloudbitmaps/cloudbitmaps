import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';

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
  const body = /export interface CloudRoaringOptions[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
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

  it('found a plausible set of removed options', () => {
    // If this collapses to nothing the test below passes vacuously, which is how the original hole felt.
    expect(removed.length).toBeGreaterThan(10);
    expect(removed).toContain('warm'); // required in 0.9.x — every upgrader passes one
    expect(removed).toContain('coldGenTtlMs'); // the name the guard used to miss
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
