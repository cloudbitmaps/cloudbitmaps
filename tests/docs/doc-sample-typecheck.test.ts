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
 * The two samples inside generated regions of the sizing and cost guides get their marker from `bench/sizing.cjs`,
 * which writes them; a marker typed into a region is rewritten on the next generation.
 *
 * EVERY TYPESCRIPT FENCE DECIDES. A `ts` fence in the scanned files with neither marker fails the test, so a sample added
 * later is compiled or skipped on purpose, never by omission. `js` fences are out of this gate's scope: it compiles
 * TypeScript only.
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

  it('has a marker on every TypeScript fence', () => {
    const marked = new Set(samples.map((s) => `${s.file}:${s.line}`));
    const bare: string[] = [];
    for (const file of sampleFiles()) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (
          /^[ \t]*```(?:ts|typescript)(?:[ \t]+[^\n]*)?[ \t]*$/.test(l) &&
          !marked.has(`${file}:${i + 2}`)
        ) {
          bare.push(`${file}:${i + 1} — a TypeScript fence with no typecheck marker above it`);
        }
      });
    }
    expect(bare).toEqual([]);
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
  // Compiling takes seconds, so every probe is compiled once, together, each under its own file name, and the
  // problems are read back by file.
  const probe = (name: string, code: string, preludes: string[] = []): DocSample => ({
    file: name,
    line: 10,
    code,
    mark: 'check',
    preludes,
    reason: '',
  });
  const probes = [
    probe('good.md', "import { CloudRoaring } from '@cloudbitmaps/roaring';\nvoid CloudRoaring;"),
    probe('wrong-type.md', 'const ok = 1;\nconst n: number = "text";\nvoid ok;'),
    probe('undeclared.md', 'void undeclaredName;'),
    probe(
      'unexported.md',
      "import { BoundedLru } from '@cloudbitmaps/core/core/lru';\nvoid BoundedLru;",
    ),
    probe('any.md', 'const v: any = 1;\nvoid v;'),
    probe(
      'missing-key.md',
      "import { CloudRoaring } from '@cloudbitmaps/roaring';\nnew CloudRoaring({});",
    ),
    probe('store-not-asked.md', 'await store.segment("a").count();'),
    probe('store-asked.md', 'await store.segment("a").count();', ['store']),
    probe(
      'pin-at-nullable.md',
      [
        "const first = await store.segment('a').pin();",
        'const { generation, fingerprint } = first.pinnedAt!;',
        "await store.segment('a').pinAt({ generation, fingerprint });",
      ].join('\n'),
      ['store'],
    ),
    probe(
      'own-store.md',
      "import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';\nconst store = new CloudRoaring({ storage: new MemoryStorage() });\nvoid store;",
    ),
  ];
  let problems: ReturnType<typeof compileSamples> = [];
  beforeAll(() => {
    problems = compileSamples(probes);
  }, 300_000);
  const of = (file: string): string[] =>
    problems.filter((p) => p.where.startsWith(`${file}:`)).map((p) => `${p.where} ${p.message}`);

  it('accepts a sample that compiles, and names the line of one that does not', () => {
    expect(of('good.md')).toEqual([]);
    expect(of('wrong-type.md')).toEqual([expect.stringMatching(/^wrong-type\.md:11 TS2322/)]);
  });

  it('refuses a name the sample never declared, an explicit any, and a missing option', () => {
    expect(of('undeclared.md')).toEqual([expect.stringContaining('TS2304')]);
    expect(of('any.md')).toEqual([expect.stringContaining('explicit `any`')]);
    expect(of('missing-key.md').length).toBeGreaterThan(0);
    expect(of('unexported.md')).toEqual([
      expect.stringContaining('is not a module the packages publish'),
    ]);
  });

  it('gives a sample the elided store only when it asks, and lets a sample with its own `store` stand', () => {
    expect(of('store-not-asked.md').length).toBeGreaterThan(0);
    expect(of('store-asked.md')).toEqual([]);
    expect(of('own-store.md')).toEqual([]);
  });

  it('refuses the nullable fields of a pin passed whole to pinAt, which the narrowing on generation avoids', () => {
    const errors = of('pin-at-nullable.md');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e).toContain('TS2322');
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

describe('a marker beside a generated region', () => {
  it('reaches the fence past the region start comment', () => {
    const { samples: s, orphans: o } = markedSamples(
      'x.md',
      '<!-- typecheck -->\n<!-- SIZING:SAMPLE:START -->\n```ts\nvoid 1;\n```\n<!-- SIZING:SAMPLE:END -->',
    );
    expect(o).toEqual([]);
    expect(s.map((x) => x.code)).toEqual(['void 1;']);
  });
});
