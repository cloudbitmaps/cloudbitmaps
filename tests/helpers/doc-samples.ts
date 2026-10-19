/**
 * Finding the TypeScript samples in the docs that are marked as checkable, and compiling them.
 *
 * A sample is marked by an HTML comment on the line above its fence, which a reader of the rendered page never sees:
 *
 *     <!-- typecheck -->
 *     <!-- typecheck: store -->
 *     <!-- typecheck-skip: a fragment, it uses names the page above declares -->
 *
 * `typecheck` marks a sample the gate compiles. After the colon it may name a prelude, a declaration the docs elide by
 * convention and the sample relies on (see {@link PRELUDES}). `typecheck-skip` marks a sample that is deliberately
 * partial and says why; the reason is required, so a skip is a decision and not a gap. A fence with neither is not
 * compiled and not claimed to compile.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

export const ROOT = join(__dirname, '..', '..');

/** The names a marked sample may ask to have declared for it, each a line of ambient declaration. */
export const PRELUDES: Readonly<Record<string, string>> = {
  store:
    "import type { CloudRoaring as DocsCloudRoaring } from '@cloudbitmaps/roaring'; declare const store: DocsCloudRoaring;",
};

export interface DocSample {
  readonly file: string;
  /** The line of `file` that the sample's first line of code is on. */
  readonly line: number;
  readonly code: string;
  /** The marker's verdict: compile it, or skip it for the reason given. */
  readonly mark: 'check' | 'skip';
  /** The preludes it asked for. */
  readonly preludes: readonly string[];
  /** The skip's reason, or `''` for a sample to compile. */
  readonly reason: string;
}

/** The markdown a sample may be marked in: the guides, the root README and each package's README. */
export function sampleFiles(): string[] {
  return execFileSync('git', ['ls-files', 'README.md', 'docs/guide/*.md', 'packages/*/README.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

const MARKER = /^[ \t]*<!--[ \t]*typecheck(-skip)?[ \t]*(?::[ \t]*([^>]*?))?[ \t]*-->[ \t]*$/;
const FENCE = /^([ \t]*)```(?:ts|typescript)(?:[ \t]+[^\n]*)?[ \t]*$/;

/**
 * Every marked TypeScript fence of `text`. A marker applies to the next fence when only blank lines lie between; a
 * marker with no fence after it, or on a fence that is not TypeScript, is returned in `orphans`, so a marker that
 * guards nothing fails the gate instead of passing silently.
 */
export function markedSamples(
  file: string,
  text: string,
): { samples: DocSample[]; orphans: string[] } {
  const lines = text.split('\n');
  const samples: DocSample[] = [];
  const orphans: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = MARKER.exec(lines[i] as string);
    if (m === null) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] as string).trim() === '') j += 1;
    const fence = FENCE.exec(lines[j] ?? '');
    if (fence === null) {
      orphans.push(`${file}:${i + 1} — a typecheck marker with no TypeScript fence after it`);
      continue;
    }
    const indent = (fence[1] as string).length;
    const body: string[] = [];
    let k = j + 1;
    while (k < lines.length && !/^[ \t]*```[ \t]*$/.test(lines[k] as string)) {
      body.push((lines[k] as string).slice(indent));
      k += 1;
    }
    const isSkip = m[1] !== undefined;
    const arg = (m[2] ?? '').trim();
    samples.push({
      file,
      line: j + 2,
      code: body.join('\n'),
      mark: isSkip ? 'skip' : 'check',
      preludes: isSkip || arg === '' ? [] : arg.split(/[ \t]*,[ \t]*/),
      reason: isSkip ? arg : '',
    });
    i = k;
  }
  return { samples, orphans };
}

/** One compiler complaint about one sample, or about a declaration file the program reads. */
export interface SampleProblem {
  readonly where: string;
  readonly message: string;
}

/**
 * Compile `samples` together against the package sources, under `strict` with `skipLibCheck: false`. Each sample is
 * its own module (an `export {}` is appended, so a sample with no import still scopes its names and may await at the
 * top level). An explicit `any` is a problem of its own, so the samples show the types a reader should write.
 */
export function compileSamples(samples: readonly DocSample[]): SampleProblem[] {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config as object;
  const parsed = ts.parseJsonConfigFileContent({ ...config, include: [], files: [] }, ts.sys, ROOT);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    verbatimModuleSyntax: false,
    isolatedModules: false,
    declaration: false,
    sourceMap: false,
    noUncheckedIndexedAccess: false,
    types: ['node'],
    lib: ['lib.es2022.d.ts'],
  };

  const virtual = new Map<string, { sample: DocSample; text: string; offset: number }>();
  samples.forEach((s, n) => {
    const prelude = s.preludes.map((p) => {
      const line = PRELUDES[p];
      if (line === undefined) throw new Error(`${s.file}:${s.line} — unknown prelude "${p}"`);
      return line;
    });
    const head = prelude.join('\n');
    const text = `${head}${head === '' ? '' : '\n'}${s.code}\nexport {};\n`;
    virtual.set(join(ROOT, '.doc-samples', `sample-${n}.mts`), {
      sample: s,
      text,
      offset: prelude.length,
    });
  });

  const host = ts.createCompilerHost(options);
  const realRead = host.readFile.bind(host);
  const realExists = host.fileExists.bind(host);
  host.fileExists = (f) => virtual.has(f) || realExists(f);
  host.readFile = (f) => virtual.get(f)?.text ?? realRead(f);
  host.getSourceFile = (
    (orig) =>
    (f: string, lang: ts.ScriptTarget | ts.CreateSourceFileOptions, ...rest: unknown[]) => {
      const v = virtual.get(f);
      if (v !== undefined) return ts.createSourceFile(f, v.text, lang, true);
      return (orig as (...a: unknown[]) => ts.SourceFile | undefined)(f, lang, ...rest);
    }
  )(host.getSourceFile.bind(host)) as ts.CompilerHost['getSourceFile'];

  const program = ts.createProgram([...virtual.keys()], options, host);
  const problems: SampleProblem[] = [];
  const flatten = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, ' ');
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  for (const d of diagnostics) {
    const f = d.file;
    const v = f === undefined ? undefined : virtual.get(f.fileName);
    if (f !== undefined && v !== undefined && d.start !== undefined) {
      const line = f.getLineAndCharacterOfPosition(d.start).line + 1 - v.offset;
      problems.push({
        where: `${v.sample.file}:${v.sample.line + line - 1}`,
        message: `TS${d.code}: ${flatten(d)}`,
      });
    } else if (f === undefined || f.isDeclarationFile) {
      // Global and declaration-file problems are the program's own: with `skipLibCheck: false` they are real.
      problems.push({ where: f?.fileName ?? '(program)', message: `TS${d.code}: ${flatten(d)}` });
    }
  }
  for (const [name, v] of virtual) {
    const source = program.getSourceFile(name);
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 - v.offset;
        problems.push({
          where: `${v.sample.file}:${v.sample.line + line - 1}`,
          message: 'an explicit `any`: write the type a reader should use',
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

export function readSamples(): { samples: DocSample[]; orphans: string[] } {
  const samples: DocSample[] = [];
  const orphans: string[] = [];
  for (const f of sampleFiles()) {
    const r = markedSamples(f, readFileSync(join(ROOT, f), 'utf8'));
    samples.push(...r.samples);
    orphans.push(...r.orphans);
  }
  return { samples, orphans };
}
