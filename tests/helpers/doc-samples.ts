/**
 * Finding the TypeScript samples in the docs that are marked as checkable, and compiling them.
 *
 * A sample is marked by an HTML comment on the line above its fence, which a reader of the rendered page never sees:
 *
 *     <!-- typecheck -->
 *     <!-- typecheck: store -->
 *     <!-- typecheck-skip: a fragment, it uses names the page above declares -->
 *
 * A marker applies to the next fence, past blank lines and other one-line HTML comments (a generated region's own
 * start marker sits between them, and the generator would rewrite a marker placed inside the region).
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
  backend:
    "import { LocalFsStorage as DocsBackend } from '@cloudbitmaps/roaring'; const backend = new DocsBackend('./docs-backend');",
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

/** The folder whose pages are runnable programs: each page's samples are one module, in page order. */
export const PLAYBOOK_DIR = 'docs/playbooks/';

/**
 * The markdown a sample may be marked in: the guides, the playbooks, the root README and each package's README.
 */
export function sampleFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', 'README.md', 'docs/guide/*.md', 'docs/playbooks/*.md', 'packages/*/README.md'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
}

const MARKER = /^[ \t]*<!--[ \t]*typecheck(-skip)?[ \t]*(?::[ \t]*([^>]*?))?[ \t]*-->[ \t]*$/;
const FENCE = /^([ \t]*)```(?:ts|typescript)(?:[ \t]+[^\n]*)?[ \t]*$/;

/**
 * Every marked TypeScript fence of `text`. A marker applies to the next fence when only blank lines and one-line HTML comments lie between; a
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
    while (j < lines.length && /^(?:[ \t]*|[ \t]*<!--.*-->[ \t]*)$/.test(lines[j] as string))
      j += 1;
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

/**
 * The module names the packages publish: each package's name, and `name/sub` for each subpath its `exports` lists. The
 * root `tsconfig.json` maps every source file of core, and the `@/` aliases too, because the sources import through
 * them, so the compiler would resolve a sample's import of an unexported subpath. The compile step checks each
 * sample's specifiers against this list instead.
 */
function publishedModules(): Set<string> {
  const out = new Set<string>();
  const files = execFileSync('git', ['ls-files', 'packages/*/package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  for (const file of files) {
    const pkg = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as {
      name: string;
      exports?: Record<string, unknown>;
    };
    for (const sub of Object.keys(pkg.exports ?? {})) {
      out.add(sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`);
    }
  }
  return out;
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

  // A sample is its own module, except on a playbook page: its samples run as one program, so they are one module,
  // in page order, and a name one declares the next may use. `segments` maps a line of the module back to the sample
  // (and the line of the page) it came from.
  interface Segment {
    readonly from: number;
    readonly sample: DocSample;
  }
  interface Virtual {
    readonly text: string;
    readonly offset: number;
    readonly segments: readonly Segment[];
  }
  const preludeLines = (s: DocSample): string[] =>
    s.preludes.map((p) => {
      const line = PRELUDES[p];
      if (line === undefined) throw new Error(`${s.file}:${s.line} — unknown prelude "${p}"`);
      return line;
    });
  const groups: DocSample[][] = [];
  const byPage = new Map<string, DocSample[]>();
  for (const s of samples) {
    if (!s.file.startsWith(PLAYBOOK_DIR)) {
      groups.push([s]);
      continue;
    }
    const page = byPage.get(s.file);
    if (page === undefined) {
      const created = [s];
      byPage.set(s.file, created);
      groups.push(created);
    } else {
      page.push(s);
    }
  }
  const virtual = new Map<string, Virtual>();
  groups.forEach((group, n) => {
    const head = [...new Set(group.flatMap(preludeLines))];
    const segments: Segment[] = [];
    const bodies: string[] = [];
    let at = 1;
    for (const s of group) {
      segments.push({ from: at, sample: s });
      bodies.push(s.code);
      at += s.code.split('\n').length;
    }
    virtual.set(join(ROOT, '.doc-samples', `sample-${n}.mts`), {
      text: `${head.join('\n')}${head.length === 0 ? '' : '\n'}${bodies.join('\n')}\nexport {};\n`,
      offset: head.length,
      segments,
    });
  });
  /** `file:line` of the page for a 1-based `line` of the module text. */
  const where = (v: Virtual, line: number): string => {
    const at = line - v.offset;
    let seg = v.segments[0] as Segment;
    for (const s of v.segments) if (s.from <= at) seg = s;
    return `${seg.sample.file}:${seg.sample.line + at - seg.from}`;
  };

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
      problems.push({
        where: where(v, f.getLineAndCharacterOfPosition(d.start).line + 1),
        message: `TS${d.code}: ${flatten(d)}`,
      });
    } else if (f === undefined || f.isDeclarationFile) {
      // Global and declaration-file problems are the program's own: with `skipLibCheck: false` they are real.
      problems.push({ where: f?.fileName ?? '(program)', message: `TS${d.code}: ${flatten(d)}` });
    }
  }
  const published = publishedModules();
  for (const [name, v] of virtual) {
    const source = program.getSourceFile(name);
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              node.arguments[0] !== undefined
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if ((name.startsWith('@cloudbitmaps/') || name.startsWith('@/')) && !published.has(name)) {
          problems.push({
            where: where(
              v,
              source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1,
            ),
            message: `\`${name}\` is not a module the packages publish`,
          });
        }
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        problems.push({
          where: where(v, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1),
          message: 'an explicit `any`: write the type a reader should use',
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

/**
 * The TypeScript fences of `text` that no marker guards: `marked` holds `file:line` of the first code line of each
 * marked fence (what `markedSamples` returns), and a fence not in it is reported.
 */
export function bareFences(file: string, text: string, marked: ReadonlySet<string>): string[] {
  const bare: string[] = [];
  text.split('\n').forEach((l, i) => {
    if (FENCE.test(l) && !marked.has(`${file}:${i + 2}`)) {
      bare.push(`${file}:${i + 1} — a TypeScript fence with no typecheck marker above it`);
    }
  });
  return bare;
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
