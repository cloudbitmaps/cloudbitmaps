import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The `pinAt` sample in `docs/guide/reading.md` type-checks under `strict`, as written, against the package's source:
 * a pin's `pinnedAt` narrowed on `generation` passes to `pinAt` whole. The doc gate that reads every sample looks for
 * a name declared twice and a refused option key; it does not compile a sample, and a sample that does not compile
 * under the default of a new TypeScript project fails the reader who copies it.
 *
 * The check runs the compiler over the sample with a two-line header that declares `store`, and holds a control: the
 * sample's old form, which destructured the nullable fields of `pinnedAt` and passed them on, fails with the errors a
 * reader met.
 */

const ROOT = join(__dirname, '..', '..');
const SAMPLE_FILE = join(ROOT, 'tests', 'docs', 'pin-at-sample.virtual.ts');

/** The first `ts` fence under the heading that introduces `pinAt`. */
function pinAtSample(): string {
  const doc = readFileSync(join(ROOT, 'docs', 'guide', 'reading.md'), 'utf8');
  const heading = doc.indexOf('### Reopen a pinned generation: `pinAt`');
  expect(heading, 'the pinAt heading is in reading.md').toBeGreaterThan(-1);
  const fence = /```ts\n([\s\S]*?)```/.exec(doc.slice(heading));
  expect(fence, 'a ts sample follows it').not.toBeNull();
  return (fence as RegExpExecArray)[1] as string;
}

/** The compiler's complaints about `body` under the repository's own settings (strict, source paths). */
function diagnosticsOf(body: string): string[] {
  const text =
    `import type { CloudRoaring } from '@cloudbitmaps/roaring';\n` +
    `declare const store: CloudRoaring;\n${body}`;
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, strict: true };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === SAMPLE_FILE
      ? ts.createSourceFile(name, text, options.target ?? ts.ScriptTarget.ES2022, true)
      : read(name, ...rest);
  const original = host.fileExists.bind(host);
  host.fileExists = (name) => name === SAMPLE_FILE || original(name);
  const program = ts.createProgram([SAMPLE_FILE], options, host);
  const file = program.getSourceFile(SAMPLE_FILE)!;
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
  );
}

describe('the pinAt sample in the reading guide', () => {
  it('type-checks under strict, as written', () => {
    expect(diagnosticsOf(pinAtSample())).toEqual([]);
  }, 120_000);

  it('is held by a checker that refuses the nullable fields of pinnedAt', () => {
    const old = [
      `const first = await store.segment('active-30d').pin();`,
      `const { generation, fingerprint } = first.pinnedAt!;`,
      `await store.segment('active-30d').pinAt({ generation, fingerprint });`,
    ].join('\n');
    const errors = diagnosticsOf(old);
    expect(errors.some((e) => e.startsWith('TS2322'))).toBe(true);
  }, 120_000);
});
