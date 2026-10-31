import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PRELUDES,
  ROOT,
  bareFences,
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
 * THE PLAYBOOKS. The fences of one page of `docs/playbooks/` are one program, so they are compiled as one module in page
 * order, and a name one declares the next may use; every other file compiles each sample alone. `playbooks.test.ts`
 * runs the same fences and holds the output the page shows.
 *
 * WHAT IT DOES NOT CLAIM. A fence with no marker is neither compiled nor said to compile. A sample is compiled, not
 * run, so what it prints is not held here (but see the playbooks). The sample is a module compiled alone: a name it uses and does not declare
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
    const bare = sampleFiles().flatMap((file) =>
      bareFences(file, readFileSync(join(ROOT, file), 'utf8'), marked),
    );
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

describe('the bare-fence scan', () => {
  it('reports a TypeScript fence no marker guards, and not a marked one or one of another language', () => {
    const text = [
      '<!-- typecheck -->',
      '```ts',
      'void 1;',
      '```',
      '',
      '```ts',
      'void 2;',
      '```',
      '```json',
      '{}',
      '```',
    ].join('\n');
    const { samples: s } = markedSamples('x.md', text);
    const marked = new Set(s.map((x) => `${x.file}:${x.line}`));
    expect(bareFences('x.md', text, marked)).toEqual([
      'x.md:6 — a TypeScript fence with no typecheck marker above it',
    ]);
  });
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

// Budget 14 s for each test of this block (the default is 5 s): the first one to read the problems compiles the probes,
// which took 4.4 s on a CI runner (Node 22). Rule: the slowest measured time times three, rounded up to the next whole
// second. The compile runs in that first test, not in a `beforeAll`, because the budget check judges a hook against the
// configured hook timeout and cannot see a hook's own.
describe('the compile step', { timeout: 14_000 }, () => {
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
    // Two fences of one playbook page are one module; the same two on a guide page are two modules.
    probe('docs/playbooks/shared.md', 'const shared = 1;\nvoid shared;'),
    { ...probe('docs/playbooks/shared.md', 'void shared;\nconst n: number = "text";'), line: 40 },
    probe('docs/guide/not-shared.md', 'const shared = 1;\nvoid shared;'),
    { ...probe('docs/guide/not-shared.md', 'void shared;'), line: 40 },
    probe(
      'own-store.md',
      "import { CloudRoaring, MemoryStorage } from '@cloudbitmaps/roaring';\nconst store = new CloudRoaring({ storage: new MemoryStorage() });\nvoid store;",
    ),
  ];
  let compiled: ReturnType<typeof compileSamples> | undefined;
  const of = (file: string): string[] =>
    (compiled ??= compileSamples(probes))
      .filter((p) => p.where.startsWith(`${file}:`))
      .map((p) => `${p.where} ${p.message}`);

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

  it('compiles the fences of a playbook page as one module, and names the page line of an error in a later one', () => {
    expect(of('docs/playbooks/shared.md')).toEqual([
      expect.stringMatching(/^docs\/playbooks\/shared\.md:41 TS2322/),
    ]);
  });

  it("keeps the samples of any other page apart: a name one declares is not the next one's", () => {
    expect(of('docs/guide/not-shared.md')).toEqual([
      expect.stringMatching(/^docs\/guide\/not-shared\.md:40 TS2304/),
    ]);
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
    expect(files).toContain('docs/playbooks/roaring-bitmap.md');
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
