import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { MOVED_OPTIONS } from '@/moved-options';

/**
 * The TypeScript samples in the docs must not make the mistakes that stop a copied sample running: a name declared
 * twice, an option key the store refuses or takes only one level down, and a sample that declares one half of its
 * wiring and uses a name it never declared. Nothing here parses a sample.
 *
 * WHY THIS EXISTS. Doc samples are copy-pasted; a sample that cannot run is worse than no sample, because the
 * reader assumes their own environment is at fault. Two are easy to write:
 *
 *   - A GCS sample that names its backend `storage`, below the `storage` it made for the client
 *     `@google-cloud/storage` exports: `Identifier 'storage' has already been declared`.
 *   - A sample that wires an option key the store refuses.
 *
 * Both render fine, lint fine, and are invisible to the link and export-sync checks, which look at prose and
 * symbol names rather than at whether the code would run.
 *
 * WHAT IT CHECKS, and why only things like these. A full typecheck of every fence would need each sample to be
 * self-contained, which they deliberately are not (they elide imports and setup to stay readable). None of these
 * checks needs that assumption: a duplicate binding is a `SyntaxError` in any context, and a refused option key,
 * or a sample that uses a name it declared the other half of, is wrong no matter what surrounds it.
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
  // An INFO STRING after the language is allowed. `\`\`\`ts title="wiring.ts"` and `\`\`\`ts twoslash` are
  // ordinary Markdown that many renderers act on, and requiring end-of-line after the language meant such a
  // fence left this gate altogether — not "checked more loosely", but unscanned, with every check in the file
  // silent on it. The language must still be the FIRST word, so a ```text block is not dragged in.
  const re =
    /^([ \t]*)```(?:ts|tsx|js|javascript|typescript)(?:[ \t]+[^\n]*)?[ \t]*$\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
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

  // A sample whose wiring contradicts ITSELF: declaring `const storage = …` / `const registry = …` and then
  // passing `storage: backend`, or declaring `const backend = …` and then passing `{ registry }`. Each throws
  // `ReferenceError` on the first line a reader runs.
  //
  // What this deliberately does NOT flag is a fence that only *references* `backend` — samples on a page
  // routinely elide the construction shown in an earlier fence, which is why a plain free-identifier check
  // reported eight passages, every one of them correct. The defect is the contradiction, not the elision.
  it('does not declare `storage` or `registry` and then use an undeclared `backend`, or the reverse', () => {
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

      // Declaring `storage` or `registry` and then reaching for a `backend` the sample never declares.
      if (
        referencesBare('backend') &&
        !declares('backend') &&
        (declares('storage') || declares('registry'))
      ) {
        offenders.push(
          `${fence.file}:${fence.line} — sample declares \`storage\` or \`registry\` but uses an undeclared \`backend\``,
        );
      }
      // Declaring `backend` and then passing a bare `registry` the sample never declares, which the backend carries.
      if (declares('backend') && referencesBare('registry') && !declares('registry')) {
        offenders.push(
          `${fence.file}:${fence.line} — sample builds a \`backend\` but still references an undeclared \`registry\``,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  // Option keys the store refuses. A sample naming one throws at runtime rather than misbehaving, so the
  // reader's first experience of the library would be an error in code we gave them.
  //
  // DERIVED from the store's own `MOVED_OPTIONS`, minus the spellings below that are correct one level down.
  //
  // `onRetry`, `keystore`, `clock`, `rng` and `registry` are deliberately excluded: each is a key one level
  // down (`retry.onRetry`, `encryption.keystore`, `seams.clock`/`seams.rng`), and several are also valid on
  // the free-function deps objects. Listing them would fire on the correct spelling. Only keys the store takes
  // nowhere belong here; the others are caught by position, by ILLEGAL_AT_TOP_LEVEL below.
  const STILL_VALID_ONE_LEVEL_DOWN = new Set(['registry', 'keystore', 'onRetry', 'clock', 'rng']);
  const REFUSED_KEYS = MOVED_OPTIONS.map(([from]) => from).filter(
    (from) => !STILL_VALID_ONE_LEVEL_DOWN.has(from),
  );

  // `registry` is a special case: it is not a `CloudRoaringOptions` key, but it is a good option on
  // `loadSegment` and the lifecycle free functions. Listing it above would flag every correct example of
  // those, so the check is scoped to the one literal that refuses it — which means brace-matching, because
  // `new CloudRoaring({ … })` spans lines and nests.
  /**
   * Keys that are refused at the TOP LEVEL of a `new CloudRoaring({…})` literal, and where each one goes.
   *
   * These cannot go in `REFUSED_KEYS`, which matches a key anywhere in a fence: `keystore`, `clock` and
   * `registry` are all correct on the free-function deps objects (`loadSegment`, `eraseIdFromSegment`) and on
   * `CrbmStorageChunkSourceOptions`, and `onRetry` is correct one level down inside `retry`. Listing them there
   * would fire on the correct spelling. But at the top level of the store's own options every one of them
   * THROWS — so the position is what decides, which is exactly what the top-level scan below can see and a flat
   * match cannot.
   */
  const ILLEGAL_AT_TOP_LEVEL: ReadonlyArray<readonly [string, string]> = MOVED_OPTIONS.filter(
    ([from]) => STILL_VALID_ONE_LEVEL_DOWN.has(from),
  ).map(([from, to]) => [from, /^[\w.]+$/.test(to) ? `it goes in \`${to}\`` : to]);

  it('no sample passes a key at the top level of CloudRoaring options that goes one level down', () => {
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
        // Top-level `registry` only. Everything nested is blanked out FIRST, because a legitimate backend
        // literal — `storage: createBackend({ storage: driver, registry: myRegistry })` — carries a perfectly correct
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
        for (const [key, where] of ILLEGAL_AT_TOP_LEVEL) {
          if (new RegExp(`(^|[{,\\s])${key}\\s*([:,}]|$)`, 'm').test(scannable)) {
            offenders.push(`${fence.file}:${line} — passes \`${key}\` to CloudRoaring; ${where}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no option key the store refuses', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      const lines = fence.code.split('\n');
      lines.forEach((raw, i) => {
        for (const key of REFUSED_KEYS) {
          // `key:` as an object property — not `key.foo`, not a string, not a word in a comment.
          if (new RegExp(`(^|[{,(\\s])${key}\\s*:`).test(raw.replace(/\/\/.*$/, ''))) {
            offenders.push(
              `${fence.file}:${fence.line + i + 1} — sample uses the \`${key}:\` option, which the store refuses`,
            );
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
