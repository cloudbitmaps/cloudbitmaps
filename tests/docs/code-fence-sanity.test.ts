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

const allFences = docs.flatMap(fencesOf);

describe('documentation code samples', () => {
  it('finds samples to check (the scan itself must not silently match nothing)', () => {
    expect(allFences.length).toBeGreaterThan(30);
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

  // Option keys this release removed. A sample naming one throws at runtime rather than misbehaving, so the
  // reader's first experience of the library would be an error in code we gave them.
  const REMOVED_KEYS = [
    'cold',
    'coldGenTtlMs',
    'coldReaderCacheMax',
    'coldReaderCacheMaxBytes',
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
  it('no sample passes `registry` to CloudRoaring, which no longer takes it', () => {
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
        const line = fence.line + code.slice(0, open).split('\n').length;
        if (isMarkedAsHistorical(code.split('\n'), code.slice(0, open).split('\n').length - 1))
          continue;
        // Top-level `registry` only — a nested `{ registry: … }` belongs to some other call's options.
        let d = 0;
        for (const part of body.split('\n')) {
          if (d === 0 && /(^|[{,\s])registry\s*[:,]/.test(part.replace(/\/\/.*$/, ''))) {
            offenders.push(
              `${fence.file}:${line} — passes \`registry\` to CloudRoaring; a backend carries it`,
            );
            break;
          }
          for (const ch of part) {
            if (ch === '{' || ch === '(' || ch === '[') d++;
            else if (ch === '}' || ch === ')' || ch === ']') d--;
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
