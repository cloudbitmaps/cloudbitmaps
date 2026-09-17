import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Every TypeScript sample in the docs must at least be *parseable*, and must not name a removed option key.
 *
 * WHY THIS EXISTS. Doc samples are copy-pasted; a sample that cannot run is worse than no sample, because the
 * reader assumes their own environment is at fault. Two of them shipped broken in one release, and neither
 * was visible to any existing gate:
 *
 *   - The GCS wiring sample declared `const storage` twice — `Identifier 'storage' has already been declared`.
 *     The `cold` → `storage` rename walked straight into the name `@google-cloud/storage` already uses for
 *     its own client class, which the sample declares one line above.
 *   - A `CHANGELOG.md` entry in the *pending* release wired `cold:`, the very key that release removes.
 *
 * Both render fine, lint fine, and are invisible to the link and export-sync checks, which look at prose and
 * symbol names rather than at whether the code would run.
 *
 * WHAT IT CHECKS, and why only these two things. A full typecheck of every fence would need each sample to be
 * self-contained, which they deliberately are not (they elide imports and setup to stay readable). These two
 * checks need no such assumption: a duplicate binding is a `SyntaxError` in any context, and a removed option
 * key is wrong no matter what surrounds it.
 */

const ROOT = join(__dirname, '..', '..');

/** Every doc that carries code samples, from git rather than a hand-kept list. */
const docs = execFileSync('git', ['ls-files', '*.md', '*.html'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

interface Fence {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

/**
 * The site writes its samples as `<pre><code>` with a `<span>` per token, not as ``` fences — so the markdown
 * scanner below found **zero** samples in all seven site pages while the file glob made it look covered.
 * That is worse than not scanning them: it reads as coverage. This strips the markup and hands back the code.
 */
function htmlSamplesOf(file: string): Fence[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const out: Fence[] = [];
  for (const m of text.matchAll(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g)) {
    const code = (m[1] as string)
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // Only the samples that are actually code we ship — skip shell blocks and prose-in-a-box.
    if (!/\b(new CloudRoaring|import\s|const\s|await\s)/.test(code)) continue;
    out.push({ file, line: text.slice(0, m.index).split('\n').length, code });
  }
  return out;
}

/**
 * Fenced ```ts / ```js blocks, with the 1-based line the fence opens on.
 *
 * Leading indentation is matched and then stripped, because a fence nested inside a list item — which is how
 * every `CHANGELOG.md` sample is written — is indented. An earlier version of this anchored the fence at
 * column 0 and silently scanned none of them, which is the failure mode a gate must not have.
 */
function fencesOf(file: string): Fence[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const out: Fence[] = [];
  const re =
    /^([ \t]*)```(?:ts|tsx|js|javascript|typescript)[ \t]*$\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (const m of text.matchAll(re)) {
    const indent = (m[1] as string).length;
    const code = (m[2] as string)
      .split('\n')
      .map((l) => l.slice(indent))
      .join('\n');
    out.push({ file, line: text.slice(0, m.index).split('\n').length, code });
  }
  return out;
}

const allFences = [
  ...docs.flatMap(fencesOf),
  ...docs.filter((f) => f.endsWith('.html')).flatMap(htmlSamplesOf),
];

describe('documentation code samples', () => {
  it('finds samples to check (the scan itself must not silently match nothing)', () => {
    expect(allFences.length).toBeGreaterThan(30);
    // …and specifically in the site, which the markdown scanner cannot see at all.
    expect(allFences.filter((f) => f.file.endsWith('.html')).length).toBeGreaterThan(0);
  });

  // A binding declared twice at the same level of a sample is a SyntaxError wherever it is pasted. Only
  // column-0 declarations are compared: a sample may legitimately reuse a name inside a nested scope.
  it('declares no name twice at the top level of one sample', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      const seen = new Map<string, number>();
      fence.code.split('\n').forEach((raw, i) => {
        const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[=:]/.exec(raw);
        if (m === null) return;
        const name = m[1] as string;
        const first = seen.get(name);
        if (first !== undefined) {
          offenders.push(
            `${fence.file}:${fence.line + i + 1} — \`${name}\` is already declared on line ` +
              `${fence.line + first + 1} of the same sample (SyntaxError when pasted)`,
          );
        } else {
          seen.set(name, i);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // A sample whose wiring vocabulary contradicts ITSELF is a half-applied rename. The rename from a
  // `storage` + `registry` pair to a single `backend` was applied fence by fence, and three fences ended up
  // holding both halves of it: declaring `const storage = …` / `const registry = …` and then passing
  // `storage: backend`, or declaring `const backend = …` and then passing `{ registry }`. Each throws
  // `ReferenceError` on the first line a reader runs.
  //
  // What this deliberately does NOT flag is a fence that only *references* `backend` — samples on a page
  // routinely elide the construction shown in an earlier fence, which is why a plain free-identifier check
  // reported eight passages, every one of them correct. The defect is the contradiction, not the elision.
  it('does not mix the old `storage`/`registry` wiring with the new `backend` wiring in one sample', () => {
    // Comments, strings and template literals are stripped before anything is matched: half these names appear
    // in prose ("the wrapped DEKs live in the backend's registry") and in paths ("pointers under ./x/registry"),
    // and matching those reported ten correct samples. What is left is code.
    const codeOnly = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, ' ')
        .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');

    const offenders: string[] = [];
    for (const fence of allFences) {
      const code = codeOnly(fence.code);
      const declares = (name: string): boolean =>
        new RegExp(`\\b(?:const|let)\\s+${name}\\b`).test(code);
      /** A bare reference — not `x.name` (a property) and not `name:` (an option key naming its own value). */
      const referencesBare = (name: string): boolean =>
        new RegExp(`(?<![.\\w])${name}\\b(?!\\s*:)`).test(code);

      // Declaring either old-style half and then reaching for `backend` — the rename stopped halfway.
      if (
        referencesBare('backend') &&
        !declares('backend') &&
        (declares('storage') || declares('registry'))
      ) {
        offenders.push(
          `${fence.file}:${fence.line} — sample declares the old \`storage\`/\`registry\` wiring but uses \`backend\``,
        );
      }
      // Declaring `backend` and then passing a bare `registry` that the rename should have absorbed into it.
      if (declares('backend') && referencesBare('registry') && !declares('registry')) {
        offenders.push(
          `${fence.file}:${fence.line} — sample builds a \`backend\` but still references an undeclared \`registry\``,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  // Option keys this release removed. A sample naming one throws at runtime rather than misbehaving, so the
  // reader's first experience of the library would be an error in code we gave them.
  const REMOVED_KEYS = [
    'cold',
    'coldGenTtlMs',
    'coldReaderCacheMax',
    'coldReaderCacheMaxBytes',
    // The 14 flat options became six groups. Each of these is now a member of a group, and a sample still
    // passing the flat spelling is not merely out of date: the store REFUSES it, so the sample throws on its
    // first line. They are listed here rather than left to review because the previous regrouping-adjacent
    // change shipped three broken samples.
    'cacheMaxChunks',
    'cacheTtlMs',
    'storageGenTtlMs',
    'storageReaderCacheMax',
    'storageReaderCacheMaxBytes',
    'requireEncryption',
    // `onRetry`, `keystore`, `clock` and `rng` are deliberately NOT listed: each still exists as a key, just
    // one level down (`retry.onRetry`, `encryption.keystore`, `seams.clock`/`seams.rng`), and several are also
    // valid on the free-function deps objects. Listing them made this gate fire on the correct new spelling.
    // Only spellings that vanished outright belong here.
  ] as const;

  // A migration note has to show the old spelling — that is its whole job. So the rule is not "never write
  // the removed key", it is "label it when you do": the line, or the one above it, must carry a `// before`
  // marker. That is a tightening rather than an exemption, since an unlabelled before/after block is exactly
  // as copy-pasteable, and exactly as broken, as an ordinary sample.
  // A line is historical when the NEAREST preceding marker is `// before`. A before/after block writes the
  // marker once at the top of each half, so scanning the whole prefix is too permissive — it would excuse the
  // *after* half as well, which is the half that must be correct. Checking only the previous line is too
  // strict, because the marker sits above the whole block. The nearest marker is the one that applies.
  const isMarkedAsHistorical = (lines: string[], i: number): boolean => {
    for (let k = i; k >= 0; k--) {
      const line = lines[k] ?? '';
      if (/\/\/\s*after\b/i.test(line)) return false;
      if (/\/\/\s*before\b/i.test(line)) return true;
    }
    return false;
  };

  // `registry` is a special case: it is gone from `CloudRoaringOptions`, but it is still a perfectly good
  // option on `bulkLoadCrbmGeneration` and the lifecycle free functions. Listing it above would flag every
  // correct load example, so the check is scoped to the one literal it was removed from — which means
  // brace-matching, because `new CloudRoaring({ … })` spans lines and nests.
  /**
   * Keys that are illegal at the TOP LEVEL of a `new CloudRoaring({…})` literal, and where each one went.
   *
   * These cannot go in `REMOVED_KEYS`, which matches a key anywhere in a fence: `keystore`, `clock` and
   * `registry` are all still correct on the free-function deps objects (`bulkLoadCrbmGeneration`,
   * `loadSegment`, `eraseIdFromSegment`) and on `CrbmStorageChunkSourceOptions`, and `onRetry` is still
   * correct one level down inside `retry`. Listing them there made this suite fire on the correct new
   * spelling. But at the top level of the store's own options every one of them now THROWS — so the
   * position is what decides, which is exactly what the top-level scan below can see and a flat match cannot.
   *
   * Two samples shipped in this state — the repo's front-door README options summary and the only worked
   * encryption example in the guide — with all eleven doc gates green, because the machinery existed and was
   * pointed at one key instead of five.
   */
  const ILLEGAL_AT_TOP_LEVEL: ReadonlyArray<readonly [string, string]> = [
    ['registry', 'a backend carries it'],
    ['keystore', 'it moved to `encryption.keystore`'],
    ['requireEncryption', 'it moved to `encryption.required`'],
    ['onRetry', 'it moved inside `retry`'],
    ['clock', 'it moved to `seams.clock`'],
    ['rng', 'it moved to `seams.rng`'],
  ];

  it('no sample passes a moved key at the top level of CloudRoaring options', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      const code = fence.code;
      for (const m of code.matchAll(/new CloudRoaring\(\{/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let end = open;
        for (; end < code.length; end++) {
          const ch = code[end];
          if (ch === '{' || ch === '(' || ch === '[') depth++;
          else if (ch === '}' || ch === ')' || ch === ']') {
            depth--;
            if (depth === 0) break;
          }
        }
        const body = code.slice(open + 1, end);
        const line = fence.line + code.slice(0, open).split('\n').length - 1;
        if (isMarkedAsHistorical(code.split('\n'), code.slice(0, open).split('\n').length - 1))
          continue;
        // Top-level `registry` only. Everything nested is blanked out FIRST, because a legitimate backend
        // literal — `storage: { storage: driver, registry: myRegistry }` — carries a perfectly correct
        // `registry` one level down, and on a single line a per-line depth counter still reads it as top
        // level. Blanking makes the depth question positional rather than line-ordered.
        const topLevelOnly = ((): string => {
          let out = '';
          let d = 0;
          for (const ch of body) {
            const opening = ch === '{' || ch === '(' || ch === '[';
            const closing = ch === '}' || ch === ')' || ch === ']';
            if (closing) d--;
            out += d === 0 && !opening && !closing ? ch : ' ';
            if (opening) d++;
          }
          return out;
        })();
        // `key:` (a value), `key,` and `key }` (shorthand) — the shorthand form is how these were usually
        // written, and an earlier pattern that required a trailing `:` missed all of it.
        const scannable = topLevelOnly.replace(/\/\/.*$/gm, '');
        for (const [key, moved] of ILLEGAL_AT_TOP_LEVEL) {
          if (new RegExp(`(^|[{,\\s])${key}\\s*([:,}]|$)`, 'm').test(scannable)) {
            offenders.push(`${fence.file}:${line} — passes \`${key}\` to CloudRoaring; ${moved}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no option key that was removed, unless the sample marks it `// before`', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      const lines = fence.code.split('\n');
      lines.forEach((raw, i) => {
        if (isMarkedAsHistorical(lines, i)) return;
        for (const key of REMOVED_KEYS) {
          // `key:` as an object property — not `key.foo`, not a string, not a word in a comment.
          if (new RegExp(`(^|[{,(\\s])${key}\\s*:`).test(raw.replace(/\/\/.*$/, ''))) {
            offenders.push(
              `${fence.file}:${fence.line + i + 1} — sample uses the removed \`${key}:\` option ` +
                '(mark it `// before` if it is deliberately showing the old API)',
            );
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
