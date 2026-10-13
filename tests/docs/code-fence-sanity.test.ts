import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { AZURE_BLOB_STORAGE_OPTION_KEYS } from '@/azure-blob/backend';
import { GCS_STORAGE_OPTION_KEYS } from '@/gcs/backend';
import { S3_STORAGE_OPTION_KEYS } from '@/s3/backend';

import { codeOnly, unknownConstructorKeys, unknownStoreKeys } from '../helpers/option-literals';
import { removeAll } from '../helpers/prose';

/**
 * The TypeScript samples in the docs must not make the mistakes that stop a copied sample running: a name declared
 * twice, an option key the store or a cloud backend does not take, and a sample that declares one half of its wiring
 * and uses a name it never declared. Nothing here runs a sample.
 *
 * WHY THIS EXISTS. Doc samples are copy-pasted; a sample that cannot run is worse than no sample, because the
 * reader assumes their own environment is at fault. Two of them are easy to write:
 *
 *   - A GCS sample that names its backend `storage`, below the `storage` it made for the client
 *     `@google-cloud/storage` exports: `Identifier 'storage' has already been declared`.
 *   - A sample that wires an option key the store, or the backend it builds, refuses.
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
  /** The line of `file` that the sample's first line of code is on, so line `i` of `code` (from 0) is `line + i`. */
  readonly line: number;
  readonly code: string;
}

/**
 * The site writes its samples as `<pre><code>` with a `<span>` per token, not as ``` fences — so the markdown
 * scanner below finds **zero** samples in the site's pages while the file glob makes them look covered. That
 * is worse than not scanning them: it reads as coverage. This strips the markup and hands back the code.
 */
function htmlSamplesOf(file: string, text = readFileSync(join(ROOT, file), 'utf8')): Fence[] {
  const out: Fence[] = [];
  for (const m of text.matchAll(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/dg)) {
    // `&amp;` last, so an escaped entity (`&amp;quot;`) reads as the entity it shows, not as the character.
    const code = removeAll(m[1] as string, /<[^>]+>/g)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    // Only the samples that are actually code we ship — skip shell blocks and prose-in-a-box.
    if (!/\b(new CloudRoaring|import\s|const\s|await\s)/.test(code)) continue;
    // The code starts right after `<code …>`, which may be on the `<pre>` line or the one below it.
    const codeAt = m.indices?.[1]?.[0] ?? m.index;
    out.push({ file, line: text.slice(0, codeAt).split('\n').length, code });
  }
  return out;
}

/**
 * Fenced ```ts / ```js blocks, each with the line its code starts on.
 *
 * Leading indentation is matched and then stripped, because a fence nested inside a list item, as in
 * `docs/guide/getting-started.md`, is indented. A pattern anchored at column 0 silently skips it, which is the
 * failure mode a gate must not have.
 */
function fencesOf(file: string, text = readFileSync(join(ROOT, file), 'utf8')): Fence[] {
  const out: Fence[] = [];
  // An INFO STRING after the language is allowed. `\`\`\`ts title="wiring.ts"` and `\`\`\`ts twoslash` are
  // ordinary Markdown that many renderers act on, and requiring end-of-line after the language would drop such
  // a fence from this gate altogether — not "checked more loosely", but unscanned, with every check in the file
  // silent on it. The language must still be the FIRST word, so a ```text block is not dragged in.
  const re =
    /^([ \t]*)```(?:ts|tsx|js|javascript|typescript)(?:[ \t]+[^\n]*)?[ \t]*$\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (const m of text.matchAll(re)) {
    const indent = (m[1] as string).length;
    const code = (m[2] as string)
      .split('\n')
      .map((l) => l.slice(indent))
      .join('\n');
    // The code starts on the line below the opening fence.
    out.push({ file, line: text.slice(0, m.index).split('\n').length + 1, code });
  }
  return out;
}

const allFences = [
  ...docs.flatMap((f) => fencesOf(f)),
  ...docs.filter((f) => f.endsWith('.html')).flatMap((f) => htmlSamplesOf(f)),
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
            `${fence.file}:${fence.line + i} — \`${name}\` is already declared on line ` +
              `${fence.line + first}, in the same sample (SyntaxError when pasted)`,
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
  // routinely elide the construction shown in an earlier fence, so a plain free-identifier check fires on
  // passages that are correct. The defect is the contradiction, not the elision.
  it('does not declare `storage` or `registry` and use an undeclared `backend`, or declare `backend` and use an undeclared `registry`', () => {
    // Comments, strings and template literals are blanked before anything is matched: half these names appear
    // in prose ("the wrapped DEKs live in the backend's registry") and in paths ("pointers under ./x/registry"),
    // and matching those would report correct samples. What is left is code.

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

  // The three cloud backends refuse a key they do not take, as the store does, so a sample that passes one throws
  // on its first line. The keys come from each backend's own table, which its constructor checks against.
  const BACKEND_KEYS = {
    S3Storage: S3_STORAGE_OPTION_KEYS,
    GcsStorage: GCS_STORAGE_OPTION_KEYS,
    AzureBlobStorage: AZURE_BLOB_STORAGE_OPTION_KEYS,
  } as const;

  it('passes each cloud backend only the option keys it takes', () => {
    const offenders: string[] = [];
    for (const fence of allFences) {
      for (const [name, keys] of Object.entries(BACKEND_KEYS)) {
        for (const { line, key } of unknownConstructorKeys(fence.code, name, keys)) {
          offenders.push(
            `${fence.file}:${fence.line + line - 1} — passes \`${key}\` to ${name}, which does not take it`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads a backend sample the way the backend does, and not a driver class', () => {
    const keys = (code: string): string[] =>
      unknownConstructorKeys(code, 'S3Storage', S3_STORAGE_OPTION_KEYS).map((k) => k.key);
    expect(keys("new S3Storage({ bucket: 'b', prefix: 'p', client, now })")).toEqual([]);
    expect(keys("new S3Storage({ bucket: 'b', partBytes: 1 << 26 })")).toEqual([]);
    expect(keys("new S3Storage({ bucket: 'b', forcePathStyle: true })")).toEqual([
      'forcePathStyle',
    ]);
    expect(keys("new S3Driver({ client, bucket: 'b', forcePathStyle: true })")).toEqual([]);
    expect(keys("new S3Storage({ ...where, bucket: 'b' }) // a comment naming storage: x")).toEqual(
      [],
    );
  });

  it("reports the line of the file that each sample's code starts on", () => {
    const md = 'Wire it:\n\n```ts\nconst a = 1;\n```\n';
    expect(fencesOf('x.md', md).map((f) => f.line)).toEqual([4]);
    const html =
      '<p>Wire it:</p>\n<pre><code>const a = 1;</code></pre>\n<pre>\n<code>const b = 2;</code></pre>\n' +
      '<pre><code>\nconst c = 3;</code></pre>';
    expect(htmlSamplesOf('x.html', html).map((f) => f.line)).toEqual([2, 4, 5]);
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
