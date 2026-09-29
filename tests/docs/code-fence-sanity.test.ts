import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { codeOnly, unknownStoreKeys } from '../helpers/option-literals';

/**
 * The TypeScript samples in the docs must not make the mistakes that stop a copied sample running: a name declared
 * twice, an option key the store does not take, and a sample that declares one half of its wiring and uses a name
 * it never declared. Nothing here runs a sample.
 *
 * WHY THIS EXISTS. Doc samples are copy-pasted; a sample that cannot run is worse than no sample, because the
 * reader assumes their own environment is at fault. Two of them are easy to write:
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
 * or a sample that declares `storage` or `registry` but uses a `backend` it never declares, is wrong no matter what
 * surrounds it.
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
  it('does not declare `storage` or `registry` and use an undeclared `backend`, or declare `backend` and use an undeclared `registry`', () => {
    // Comments, strings and template literals are blanked before anything is matched: half these names appear
    // in prose ("the wrapped DEKs live in the backend's registry") and in paths ("pointers under ./x/registry").
    // What is left is code.

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

  // A key the store does not take, at the top level of `new CloudRoaring({ … })` or inside one of its groups,
  // throws when the sample runs, so the reader's first experience of the library would be an error in code we
  // gave them. The keys come from the store's own table, `@/option-keys`, which the constructor checks against.
  it('passes CloudRoaring only the option keys it takes, at the top level and in each group', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      for (const { line, key } of unknownStoreKeys(fence.code)) {
        offenders.push(
          `${fence.file}:${fence.line + line - 1} — passes \`${key}\` to CloudRoaring, which does not take it`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads a sample the way the store does: groups, shorthand, and comments and strings left out', () => {
    const keys = (code: string): string[] => unknownStoreKeys(code).map((k) => k.key);
    expect(
      keys('new CloudRoaring({ storage, cache: { maxChunks: 10 }, seams: { clock } })'),
    ).toEqual([]);
    expect(
      keys('new CloudRoaring({\n  storage, // a backend, S3Storage or GcsStorage\n  registry,\n})'),
    ).toEqual(['registry']);
    expect(
      keys("new CloudRoaring({ storage: new S3Storage({ endpoint: 'http://x:9000', registry }) })"),
    ).toEqual([]);
    expect(keys('new CloudRoaring({ storage, cache: { maxChunk: 10 }, keystore })')).toEqual([
      'cache.maxChunk',
      'keystore',
    ]);
    expect(keys('new CloudRoaring({ storage, ...shared, retry: false })')).toEqual([]);
  });
});
