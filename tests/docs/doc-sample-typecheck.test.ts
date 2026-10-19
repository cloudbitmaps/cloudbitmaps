import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PRELUDES,
  ROOT,
  compileSamples,
  markedSamples,
  readSamples,
  sampleFiles,
  type DocSample,
} from '../helpers/doc-samples';

/**
 * A TypeScript sample the docs mark as checkable compiles under `strict`, with `skipLibCheck: false` and no `any`.
 *
 * WHY THIS EXISTS. A reader copies a sample into a file and runs it. Samples that did not compile when pasted shipped
 * in the guides because nothing compiled them: the other checks on the docs read their prose, their option keys and
 * their names, and none of them asks the compiler. A sample is marked by an HTML comment above its fence
 * (`<!-- typecheck -->`, invisible when rendered, see `tests/helpers/doc-samples.ts`), compiled here against the
 * package sources, and fails this test when it stops compiling. A sample that is deliberately partial carries
 * `<!-- typecheck-skip: why -->`, so leaving one out is a decision with a reason.
 *
 * WHAT IT DOES NOT CLAIM. A fence with no marker is neither compiled nor said to compile. A sample is compiled, not
 * run, so what it prints is not held here. The sample is a module compiled alone: a name it uses and does not declare
 * is an error, except `store`, which the docs elide by convention and a marker may ask for
 * (`<!-- typecheck: store -->`).
 */

const { samples, orphans } = readSamples();
const checked = samples.filter((s) => s.mark === 'check');

describe('type-checked documentation samples', () => {
  it('finds marked samples (the scan itself must not silently match nothing)', () => {
    expect(checked.length).toBeGreaterThan(30);
    expect(samples.filter((s) => s.mark === 'skip').length).toBeGreaterThan(10);
  });

  it('has no marker that guards nothing', () => {
    expect(orphans).toEqual([]);
  });

  it('gives every skipped sample a reason', () => {
    const bare = samples
      .filter((s) => s.mark === 'skip' && s.reason.length < 8)
      .map((s) => `${s.file}:${s.line} — typecheck-skip with no reason`);
    expect(bare).toEqual([]);
  });

  it('asks only for preludes that exist', () => {
    const unknown = samples.flatMap((s) =>
      s.preludes
        .filter((p) => PRELUDES[p] === undefined)
        .map((p) => `${s.file}:${s.line} — unknown prelude "${p}"`),
    );
    expect(unknown).toEqual([]);
  });

  it('compiles every marked sample under strict, with skipLibCheck off and no any', () => {
    const problems = compileSamples(checked);
    expect(problems.map((p) => `${p.where} — ${p.message}`)).toEqual([]);
  }, 300_000);
});

describe('the marker scan', () => {
  const scan = (text: string): ReturnType<typeof markedSamples> => markedSamples('x.md', text);

  it('reads a marker above a fence, with its prelude or its reason', () => {
    const { samples: s, orphans: o } = scan(
      [
        '<!-- typecheck: store -->',
        '```ts',
        'await store.count();',
        '```',
        '',
        '<!-- typecheck-skip: a fragment of a loop -->',
        '',
        '```ts',
        'continue;',
        '```',
      ].join('\n'),
    );
    expect(o).toEqual([]);
    expect(s.map((x) => [x.mark, x.preludes, x.reason, x.line, x.code])).toEqual([
      ['check', ['store'], '', 3, 'await store.count();'],
      ['skip', [], 'a fragment of a loop', 9, 'continue;'],
    ]);
  });

  it('does not take a prose code span, an unmarked fence or a fence of another language for a marker', () => {
    const { samples: s, orphans: o } = scan(
      [
        'Write `<!-- typecheck -->` above a fence.',
        '',
        '```ts',
        'const a: number = "no";',
        '```',
        '',
        '```json',
        '{}',
        '```',
      ].join('\n'),
    );
    expect(s).toEqual([]);
    expect(o).toEqual([]);
  });

  it('reports a marker with no TypeScript fence after it', () => {
    expect(scan('<!-- typecheck -->\n\n```json\n{}\n```').orphans).toHaveLength(1);
    expect(scan('<!-- typecheck -->\n\nprose').orphans).toHaveLength(1);
  });
});

describe('the compile step', () => {
  const sample = (code: string, preludes: string[] = []): DocSample => ({
    file: 'probe.md',
    line: 10,
    code,
    mark: 'check',
    preludes,
    reason: '',
  });

  it('accepts a sample that compiles, and names the line of one that does not', () => {
    expect(
      compileSamples([
        sample("import { CloudRoaring } from '@cloudbitmaps/roaring';\nvoid CloudRoaring;"),
      ]),
    ).toEqual([]);
    const bad = compileSamples([sample('const ok = 1;\nconst n: number = "text";\nvoid ok;')]);
    expect(bad.map((p) => p.where)).toEqual(['probe.md:11']);
    expect(bad[0]?.message).toContain('TS2322');
  });

  it('refuses a name the sample never declared, an explicit any, and a missing option', () => {
    expect(compileSamples([sample('void undeclaredName;')]).map((p) => p.message)[0]).toContain(
      'TS2304',
    );
    expect(
      compileSamples([sample('const v: any = 1;\nvoid v;')]).map((p) => p.message)[0],
    ).toContain('any');
    const noKeys = compileSamples([
      sample("import { CloudRoaring } from '@cloudbitmaps/roaring';\nnew CloudRoaring({});"),
    ]);
    expect(noKeys.length).toBeGreaterThan(0);
  });

  it('gives a sample the elided store only when it asks, and lets a sample with its own `store` stand', () => {
    expect(compileSamples([sample('await store.segment("a").count();')]).length).toBeGreaterThan(0);
    expect(compileSamples([sample('await store.segment("a").count();', ['store'])])).toEqual([]);
    expect(
      compileSamples([
        sample(
          "import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';\nconst store = new CloudRoaring({ storage: new MemoryStorage() });\nvoid store;",
        ),
      ]),
    ).toEqual([]);
  });
});

describe('the documents it reads', () => {
  it('scans the guides, the README and each package README', () => {
    const files = sampleFiles();
    expect(files).toContain('README.md');
    expect(files).toContain('docs/guide/loading.md');
    expect(files).toContain('packages/roaring/README.md');
    for (const f of files) expect(readFileSync(join(ROOT, f), 'utf8').length).toBeGreaterThan(0);
  });
});
