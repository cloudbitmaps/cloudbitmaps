import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The library is described by what it is, not by what it used to be. The code and its comments (which ship in the
 * `.d.ts` files and sourcemaps), the docs, the READMEs and the site say what is true now; how a function, a field or
 * a page came to be that way is in the git history. `earlier-releases.test.ts` keeps earlier versions out; this
 * keeps out the wording that tells the library's past without naming a version:
 * - a habit in the past ("the message used to say", "this branch used to do");
 * - "previously" and "formerly";
 * - a component the library does not have (a warm, delta or live tier, a NoSQL registry, "the removed tier");
 * - "the library no longer …" and "no longer ships";
 * - "was renamed".
 *
 * Each is a phrase with one reading. "No longer", "is now", "is gone" and "has never" are not refused, because
 * they describe what happens at run time as often as what happened to the library ("a segment the id is no longer
 * in", "the bit is gone"). "Used to" as a purpose ("the key used to look it up", "(used to type `storage`)") is not
 * a habit; after a noun it reads as one either way, so such a sentence says "that builds" or "for building" instead.
 *
 * Read: `packages/[pkg]/src`, `docs/`, `site/`, and the Markdown at the root and in each package, but the
 * changelog, whose job is the history. The tests, scripts and benches are not read: their comments record why a check
 * exists, which is often the defect it was written for.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PAST = {
  'a habit in the past': new RegExp(
    String.raw`(?<![,(—–:;][ \t]*|\b(?:is|are|was|were|be|been|being|gets?|got|also|only|not|mainly|typically|often|then)[ \t]+)\bused[ \t]+to\b`,
    'g',
  ),
  'previously or formerly': /\b(?:previously|formerly)\b/gi,
  'a component the library does not have':
    /\b(?:warm|delta|live)[ \t-]+tier\b|\bNoSQL\b|\bthe[ \t]+(?:removed|former|old)[ \t]+(?:\w+[ \t]+)?(?:tier|registry|grammar|layout|API|package|option|name)s?\b/gi,
  'the library no longer':
    /\b(?:the library|this library|CloudBitmaps|the package)[ \t]+(?:\w+[ \t]+)?no[ \t]+longer\b|\bno[ \t]+longer[ \t]+ships\b/gi,
  'was renamed': /\b(?:was|were|has been|have been)[ \t]+renamed\b/gi,
} as const;

/**
 * Where a sentence continues on the next line: a line break with the comment or quote marker that starts the next
 * line, or two string literals joined by `+` across a line break. Each is read as the space or the nothing it
 * stands for, so a wrap cannot split a phrase; a blank line still ends a paragraph.
 */
const SEAM = /['"`][ \t]*\+[ \t]*\n[ \t]*['"`]|\n(?![ \t]*\n)[ \t]*(?:\/\/+|\*(?!\/)|>|#+)?[ \t]*/g;

/** `text` with every seam read through, and for each character of it, where it was in `text`. */
function unwrap(text: string): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  let from = 0;
  for (const m of text.matchAll(SEAM)) {
    const i = m.index ?? 0;
    for (let k = from; k < i; k++) {
      flat += text[k];
      at.push(k);
    }
    if (m[0].includes('\n') && !m[0].includes('+')) {
      flat += ' ';
      at.push(i);
    }
    from = i + m[0].length;
  }
  for (let k = from; k < text.length; k++) {
    flat += text[k];
    at.push(k);
  }
  return { flat, at };
}

/**
 * The only lines that may match, each named by its file and a phrase of its own. Every entry must still match, so
 * the list shrinks rather than goes stale.
 *
 * The July 2026 calibration run measured a registry and a write path the library does not have, and these lines
 * say so beside its figures. Whether the figures stay is open; until it is decided, these are its exceptions.
 * Two backends refuse, by name, what a caller wiring them the way an earlier release did would pass: the
 * local-filesystem backend a `cold/` directory, and the GCS backend a `storage` option. Whether those refusals
 * stay is open too.
 */
const EXCEPTIONS: ReadonlyArray<readonly [file: string, phrase: string]> = [
  ['README.md', 'pointer in a NoSQL table the library no longer ships'],
  ['docs/benchmarks.md', 'a retired one: the pointer lived in a NoSQL table'],
  ['docs/benchmarks.md', 'The registry in that run was a NoSQL table'],
  ['docs/benchmarks.md', "topology's NoSQL uses: the delta tier the library no longer has"],
  ['docs/benchmarks.md', 'was billed to the NoSQL registry, whose line items are withheld'],
  ['docs/benchmarks.md', 'Generation resolution ran against a NoSQL table'],
  ['docs/ROADMAP.md', 'figures described the removed warm tier'],
  ['docs/ROADMAP.md', 'other half metered the removed delta tier'],
  ['packages/roaring/README.md', 'which kept the pointer in a NoSQL registry'],
  ['site/benchmarks.html', 'was billed to a NoSQL registry that no longer'],
  ['site/benchmarks.html', "The other half's line items metered a NoSQL delta tier"],
  ['site/benchmarks.html', 'Its other half metered a NoSQL delta tier'],
  ['site/benchmarks.html', 'Generation resolution ran against a NoSQL table in the July run'],
  ['site/llms.txt', 'which kept the pointer in a NoSQL registry that no longer ships'],
  [
    'packages/core/src/drivers/backends.ts',
    'It refuses a store written before the tier was renamed',
  ],
  ['packages/core/src/drivers/backends.ts', 'this store was written before the tier was'],
  ['packages/gcs/src/backend.ts', 'not `storage` (which was the old'],
];

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|gz|tgz|zip|crbm|wasm|node)$/i;
const READ = [
  /^packages\/[^/]+\/src\//,
  /^docs\//,
  /^site\//,
  /^[^/]+\.md$/,
  /^packages\/[^/]+\/[^/]+\.md$/,
];
// The changelog is the history; `CLAUDE.md` is a link to `AGENTS.md`, which is read.
const SKIP = new Set(['CHANGELOG.md', 'CLAUDE.md']);

function filesRead(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && !SKIP.has(f) && !BINARY.test(f) && READ.some((re) => re.test(f)))
    .sort();
}

/** Every phrase in `text` that tells the library's past, with the line it starts on, what kind it is and the line. */
export function pastTense(text: string): Array<{ line: number; kind: string; found: string }> {
  const out: Array<{ line: number; kind: string; found: string }> = [];
  const lines = text.split('\n');
  const { flat, at } = unwrap(text);
  for (const [kind, re] of Object.entries(PAST)) {
    for (const m of flat.matchAll(re)) {
      const line = text.slice(0, at[m.index ?? 0]).split('\n').length;
      out.push({ line, kind, found: (lines[line - 1] ?? '').trim() });
    }
  }
  return out;
}

describe('the library is described as it is', () => {
  it('in its code, docs and site', () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    for (const file of filesRead()) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (text.includes('\0')) continue;
      for (const hit of pastTense(text)) {
        const e = EXCEPTIONS.findIndex(([f, phrase]) => f === file && hit.found.includes(phrase));
        if (e >= 0) used.add(e);
        else offenders.push(`${file}:${hit.line} (${hit.kind}) ${hit.found.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    const stale = EXCEPTIONS.filter((_, i) => !used.has(i)).map(([f, phrase]) => `${f}: ${phrase}`);
    expect(stale).toEqual([]);
  });

  it('reads the shipped source, the docs and the site', () => {
    const files = filesRead();
    for (const f of [
      'packages/roaring/src/index.ts',
      'docs/guide/getting-started.md',
      'site/llms.txt',
      'README.md',
    ]) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain('CHANGELOG.md');
  });

  it('refuses each kind', () => {
    for (const text of [
      'The message used to say "a newer load".',
      'what this branch used to do',
      'It sits here rather than on the base type, where it used to.',
      'this previously lived on `.trade-list strong`',
      'the formerly required option',
      'the warm tier and its knobs',
      'a live-tier write',
      'the delta tier',
      'a NoSQL registry',
      'the removed registry',
      'the old option form',
      'CloudBitmaps no longer ships one',
      'the library no longer has a flusher',
      'a table that no longer ships',
      'the option was renamed',
      "an undefined value is refused because it used ' +\n        'to be a no-op",
      'the message used\n * to say "a newer load"',
      '// kept the pointer in a table the library no\n// longer ships',
    ]) {
      expect(pastTense(text), text).toHaveLength(1);
    }
  });

  it('passes what happens at run time, and "used to" as a purpose', () => {
    for (const text of [
      'a segment the id is no longer in is not listed',
      'the bit is gone, but no run holds a receipt for it',
      'whether this generation is now the current one',
      'a segment that has never been loaded reads as empty',
      '### The storage interfaces (used to type `storage` / `registry`)',
      'Estimated retained heap for one entry, used to weight the byte bound',
      'set iff the object is encrypted — used to decrypt each chunk',
      'Used to drop one segment’s decoded chunks.',
      'the key is used to look it up',
      'it can also be used to seed a test',
      'the storage tier and the cache tier',
      'the old generation is collected once the new one is current',
      'the live row no longer says "expired"',
      'what the key is used\n   * to look up',
      'the old\n\nregistry section',
    ]) {
      expect(pastTense(text), text).toEqual([]);
    }
  });
});
