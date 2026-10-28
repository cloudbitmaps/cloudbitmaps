import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A page that marks a version "unreleased", or says a block needs a build of `main` "until it is published", is
// true only until that version is published. Cutting the release bumps the manifests; this fails on every page
// that still carries such a note for the version the manifests now name, or for one below it, so a note cannot
// outlive the release it was about.
//
// What is read: every tracked `.md`, `.html` and `.txt` file, found with `git ls-files`, so a page added later is
// read without anyone listing it. Left out: `tests/` (its fixtures plant notes on purpose) and `node_modules`;
// symbolic links (the same page is read under its real name). The changelog is read too: its `[Unreleased]`
// heading and its links to that heading are section names, not claims, and are blanked before matching.
//
// What counts: a note marks one version, the one beside its marker. The version is looked for inside the
// innermost parenthetical that holds the marker ("(0.25.0 and later; unreleased)"), else in the marker's own
// sentence or list or table row, and the one nearest the marker wins ("0.25.0, unreleased", "until 0.25.0 is
// published"). A version elsewhere in the paragraph is not that note's version, so a note for a later release
// beside a sentence naming an earlier one stays quiet.
//
// Known limit: a marker with no version in its sentence ("the class is unreleased") names nothing the manifests
// can be compared with, so it cannot be judged and is not flagged; the playbooks and pages that carry such a
// sentence say the version in the same clause.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const UNRELEASED_RE = /\bunreleased\b/gi;
const UNTIL_RE = /\buntil\b(?:[^.]|\.\d)*?\bpublished\b/gi;
const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)\b/g;
const SEGMENT_RE = /\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.|\|)\s)|(?<=[.!?])\s+(?=[A-Z`[(<])/;

type Triple = [number, number, number];
interface Hit {
  version: Triple;
  at: number;
}

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

function versionsIn(text: string, base: number): Hit[] {
  return [...text.matchAll(VERSION_RE)].map((m) => ({
    version: parse(m[0]),
    at: base + (m.index ?? 0),
  }));
}

/** The span of the innermost parenthetical of `seg` that holds `index`, or null. */
function parenthetical(seg: string, index: number): [number, number] | null {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i--) {
    const ch = seg[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = index; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return [open, i + 1];
      depth--;
    }
  }
  return null;
}

function nearest(hits: Hit[], at: number): Hit | undefined {
  return hits.reduce<Hit | undefined>(
    (best, h) => (best === undefined || Math.abs(h.at - at) < Math.abs(best.at - at) ? h : best),
    undefined,
  );
}

/** The version one marker (at `index`, `length` long) in `seg` is about, or undefined when it names none. */
function markedVersion(seg: string, index: number, length: number): Triple | undefined {
  const inside = versionsIn(seg.slice(index, index + length), index);
  if (inside.length > 0) return nearest(inside, index)?.version;
  const span = parenthetical(seg, index);
  if (span !== null) {
    const inParen = nearest(versionsIn(seg.slice(span[0], span[1]), span[0]), index);
    if (inParen !== undefined) return inParen.version;
  }
  return nearest(versionsIn(seg, 0), index)?.version;
}

/** Notes in `text` that mark `current`, or a version below it, as unreleased or until-published. */
export function staleNotes(text: string, current: string): string[] {
  const cur = parse(current);
  const found: string[] = [];
  // The changelog's section name and links to it are not a claim about a version.
  const prose = text.replace(/\[Unreleased\]|CHANGELOG\.md#unreleased/gi, (m) =>
    ' '.repeat(m.length),
  );
  for (const seg of prose.split(SEGMENT_RE)) {
    for (const re of [UNRELEASED_RE, UNTIL_RE]) {
      for (const m of seg.matchAll(re)) {
        const v = markedVersion(seg, m.index ?? 0, m[0].length);
        if (v !== undefined && atOrBelow(v, cur)) found.push(seg.trim().slice(0, 100));
      }
    }
  }
  return [...new Set(found)];
}

function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.html', '*.txt'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\0')
    .filter(
      (f) =>
        f !== '' &&
        !f.startsWith('tests/') &&
        !f.split('/').includes('node_modules') &&
        existsSync(join(ROOT, f)) &&
        !lstatSync(join(ROOT, f)).isSymbolicLink(),
    );
}

const version = (
  JSON.parse(readFileSync(join(ROOT, 'packages/roaring/package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('unreleased notes', () => {
  it('reads every published page, including the root pages and the site', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(20);
    for (const f of [
      'CONTRIBUTING.md',
      'RELEASING.md',
      'CHANGELOG.md',
      'site/flavors/roaring.html',
      'site/llms.txt',
      'docs/playbooks/counting.md',
    ]) {
      expect(files, f).toContain(f);
    }
    expect(files.filter((f) => f.startsWith('tests/'))).toEqual([]);
  });

  it(`no page still marks ${version}, or an older version, as unreleased or until-published`, () => {
    const bad = scannedFiles().flatMap((f) =>
      staleNotes(readFileSync(join(ROOT, f), 'utf8'), version).map((p) => `${f}: ${p}`),
    );
    expect(bad, 'drop these notes with the cut').toEqual([]);
  });

  it('fires on a note for the current or an older version', () => {
    expect(staleNotes('Runs in 0.25.0 and later (unreleased).', '0.25.0')).toHaveLength(1);
    expect(
      staleNotes('Runs in 0.25.0 and later (0.25.0 and later; unreleased).', '0.25.0'),
    ).toHaveLength(1);
    expect(staleNotes('Needs 0.24.0 or later until it is published.', '0.25.0')).toHaveLength(1);
    expect(staleNotes('Needs a build until 0.25.0 is published.', '0.25.0')).toHaveLength(1);
    expect(staleNotes('This is in 0.25.0 and later;\nunreleased.', '0.25.1')).toHaveLength(1);
    expect(staleNotes('Added in 0.25.0, unreleased, and used here.', '0.25.0')).toHaveLength(1);
    expect(
      staleNotes('From 0.25.0 on (unreleased), a RoaringBitmap is public.', '0.25.0'),
    ).toHaveLength(1);
    expect(
      staleNotes('Added in 0.26.0 and later (unreleased). Also 0.25.0 (unreleased).', '0.25.0'),
    ).toHaveLength(1);
    expect(
      staleNotes('| a | 0.25.0 and later; unreleased |\n| b | shipped |', '0.25.0'),
    ).toHaveLength(1);
  });

  it('reads an html page too', () => {
    const html = '<p>from <code>0.25.0</code> on (unreleased), a class\nis public.</p>';
    expect(staleNotes(html, '0.25.0')).toHaveLength(1);
    expect(staleNotes(html, '0.24.0')).toEqual([]);
  });

  it('stays quiet on look-alikes', () => {
    expect(staleNotes('## [Unreleased]\n\nNothing yet for 0.24.0.', '0.25.0')).toEqual([]);
    expect(
      staleNotes('See [the changelog](CHANGELOG.md#unreleased) for 0.24.0.', '0.25.0'),
    ).toEqual([]);
    expect(staleNotes('Runs in 0.26.0 and later (unreleased).', '0.25.0')).toEqual([]);
    expect(staleNotes('Needs a build until 0.26.0 is published.', '0.25.0')).toEqual([]);
    // A later version's note beside a sentence, or a list or table row, that names an earlier one.
    expect(
      staleNotes('Added in 0.25.0. The class is in 0.26.0 and later (unreleased).', '0.25.0'),
    ).toEqual([]);
    expect(
      staleNotes('Shipped in 0.25.0 and used here, and 0.26.0 and later; unreleased.', '0.25.0'),
    ).toEqual([]);
    expect(
      staleNotes('- added in 0.25.0\n- 0.26.0 and later; unreleased\n- added in 0.24.0', '0.25.0'),
    ).toEqual([]);
    expect(
      staleNotes('| a | added in 0.25.0 |\n| b | 0.26.0 and later; unreleased |', '0.25.0'),
    ).toEqual([]);
    expect(
      staleNotes('A bare shipped is in 0.24.0; see [it](../CHANGELOG.md#unreleased).', '0.25.0'),
    ).toEqual([]);
    expect(staleNotes('Added in 0.24.0.\n\nThe next one is unreleased.', '0.25.0')).toEqual([]);
  });

  it('does not judge a note that names no version', () => {
    // Nothing to compare with the manifests; the limit is stated at the top of this file.
    expect(staleNotes('The class is unreleased.', '0.25.0')).toEqual([]);
    expect(staleNotes('Unreleased changes live in the changelog.', '0.25.0')).toEqual([]);
  });
});
