import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A page that marks a version "unreleased", or says a block needs a build of `main` "until it is published", is
// true only until that version is published. Cutting the release bumps the manifests; this fails on every page
// that still carries such a note for the version the manifests now name, or for one below it, so a note cannot
// outlive the release it was about.
//
// A paragraph is the unit, because a note wraps across lines. Only prose is read: the changelog is skipped (its
// `[Unreleased]` heading is a section name, not a claim), and a note about a later version is left alone.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const NOTE_RE = /\bunreleased\b|\buntil\b[^.]*\bpublished\b/i;
const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)\b/g;

type Triple = [number, number, number];

function parse(v: string): Triple {
  const [a = 0, b = 0, c = 0] = v.split('.').map((n) => Number.parseInt(n, 10));
  return [a, b, c];
}

function atOrBelow(v: Triple, current: Triple): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== current[i]) return (v[i] as number) < (current[i] as number);
  }
  return true;
}

/** Paragraphs of `text` that carry an unreleased/until-published note naming `current` or an older version. */
export function staleNotes(text: string, current: string): string[] {
  const cur = parse(current);
  const found: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    // Mentions of the changelog section by name are not a claim about a version.
    const prose = para.replace(/\[Unreleased\]|CHANGELOG\.md#unreleased/gi, ' ');
    if (!NOTE_RE.test(prose)) continue;
    const versions = [...prose.matchAll(VERSION_RE)].map((m) => parse(m[0]));
    if (versions.some((v) => atOrBelow(v, cur))) found.push(para.trim().slice(0, 100));
  }
  return found;
}

function scannedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'README.md', 'docs', 'packages/*/README.md', 'site/llms.txt'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out.split('\n').filter((f) => f !== '' && (f.endsWith('.md') || f === 'site/llms.txt'));
}

const version = (
  JSON.parse(readFileSync(join(ROOT, 'packages/roaring/package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('unreleased notes', () => {
  it('reads the pages at all', () => {
    expect(scannedFiles().length).toBeGreaterThan(20);
  });

  it(`no page still marks ${version}, or an older version, as unreleased or until-published`, () => {
    const bad = scannedFiles().flatMap((f) =>
      staleNotes(readFileSync(join(ROOT, f), 'utf8'), version).map((p) => `${f}: ${p}`),
    );
    expect(bad, 'drop these notes with the cut').toEqual([]);
  });

  it('fires on a note for the current or an older version', () => {
    expect(staleNotes('Runs in 0.25.0 and later (unreleased).', '0.25.0')).toHaveLength(1);
    expect(staleNotes('Needs 0.24.0 or later until it is published.', '0.25.0')).toHaveLength(1);
    expect(staleNotes('This is in 0.25.0 and later;\nunreleased.', '0.25.1')).toHaveLength(1);
  });

  it('stays quiet on look-alikes', () => {
    expect(staleNotes('## [Unreleased]\n\nNothing yet for 0.24.0.', '0.25.0')).toEqual([]);
    expect(
      staleNotes('See [the changelog](CHANGELOG.md#unreleased) for 0.24.0.', '0.25.0'),
    ).toEqual([]);
    expect(staleNotes('Runs in 0.26.0 and later (unreleased).', '0.25.0')).toEqual([]);
    expect(
      staleNotes('A bare shipped is in 0.24.0; see [it](../CHANGELOG.md#unreleased).', '0.25.0'),
    ).toEqual([]);
    expect(staleNotes('Added in 0.24.0.\n\nThe next one is unreleased.', '0.25.0')).toEqual([]);
  });
});
