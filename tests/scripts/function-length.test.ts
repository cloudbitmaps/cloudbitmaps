import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards `scripts/function-length.cjs`, the gate that keeps functions at or under 100 code lines and lets the
// existing long ones only shrink. Both directions are planted: what must be counted and what must not, and each
// way the baseline comparison must fail and the ones where it must stay quiet.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { scan, compare } = createRequire(import.meta.url)(
  join(ROOT, 'scripts', 'function-length.cjs'),
) as {
  scan: (options: { root: string }) => Promise<Map<string, number>>;
  compare: (
    found: Map<string, number>,
    baseline: Record<string, number>,
  ) => { problems: string[]; fixable: string[]; lowered: Record<string, number> };
};

/** `function name() { ... }` spanning exactly `lines` code lines. */
function fn(name: string, lines: number, indent = ''): string {
  const body = Array.from({ length: lines - 2 }, (_, i) => `${indent}  step(${i});`);
  return [`${indent}function ${name}() {`, ...body, `${indent}}`].join('\n');
}

async function scanSource(source: string): Promise<Map<string, number>> {
  const root = mkdtempSync(join(tmpdir(), 'function-length-test-'));
  try {
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'p', 'src', 'a.ts'), source);
    return await scan({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const KEY = 'packages/p/src/a.ts::';

describe('function-length scan', () => {
  it('flags a function of 101 code lines and not one of 100', async () => {
    const found = await scanSource(`${fn('hundred', 100)}\n${fn('over', 101)}\n`);
    expect([...found]).toEqual([[`${KEY}over`, 101]]);
  });

  it('does not count blank lines or comment-only lines', async () => {
    const lines = [`function padded() {`, ...Array.from({ length: 98 }, (_, i) => `  step(${i});`)];
    const padding = ['', '  // a comment', '  /* a', '     block */', '', '  // another'];
    const source = [...lines, ...padding, '}'].join('\n');
    expect([...(await scanSource(source))]).toEqual([]);
  });

  it('counts a line that has code and a trailing comment', async () => {
    const body = Array.from({ length: 99 }, (_, i) => `  step(${i}); // note`);
    expect(await scanSource(['function f() {', ...body, '}'].join('\n'))).toEqual(
      new Map([[`${KEY}f`, 101]]),
    );
  });

  it('does not count a long object literal or table that is not a function', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `  { id: ${i}, name: 'row ${i}' },`);
    const source = `export const TABLE = [\n${rows.join('\n')}\n];\nexport const OBJ = {\n${rows
      .map((_, i) => `  k${i}: ${i},`)
      .join('\n')}\n};\n`;
    expect(await scanSource(source)).toEqual(new Map());
  });

  it('gives a function the same identity wherever it sits in the file', async () => {
    const before = await scanSource(`${fn('target', 120)}\n`);
    const after = await scanSource(
      `const unrelated = 1;\n${fn('other', 30)}\n\n${fn('target', 120)}\n`,
    );
    expect(after).toEqual(before);
  });

  it('identifies nested, method and callback functions by their enclosing names', async () => {
    const source = [
      'class Box {',
      '  async open() {',
      ...Array.from({ length: 101 }, (_, i) => `    step(${i});`),
      '  }',
      '}',
      'export function suite() {',
      "  describe('reads', () => {",
      ...Array.from({ length: 101 }, (_, i) => `    step(${i});`),
      '  });',
      '}',
      'const arrow = () => {',
      ...Array.from({ length: 101 }, (_, i) => `  step(${i});`),
      '};',
    ].join('\n');
    const keys = [...(await scanSource(source)).keys()];
    expect(keys).toEqual([
      `${KEY}class Box > open`,
      `${KEY}suite`,
      `${KEY}suite > describe("reads") callback`,
      `${KEY}arrow`,
    ]);
  });

  it('numbers anonymous siblings with the same identity in source order', async () => {
    const callback = (): string[] => [
      'run(() => {',
      ...Array.from({ length: 101 }, (_, i) => `  step(${i});`),
      '});',
    ];
    const keys = [...(await scanSource([...callback(), ...callback()].join('\n'))).keys()];
    expect(keys).toEqual([`${KEY}run callback`, `${KEY}run callback #2`]);
  });

  it('reports a file that does not parse instead of skipping it', async () => {
    await expect(scanSource('function (')).rejects.toThrow(/a\.ts/);
  });
});

describe('function-length baseline comparison', () => {
  const baseline = { 'f.ts::big': 150 };

  it('passes when nothing changed', () => {
    const { problems, fixable } = compare(new Map([['f.ts::big', 150]]), baseline);
    expect([problems, fixable]).toEqual([[], []]);
  });

  it('fails on a new function over the limit', () => {
    const { problems } = compare(
      new Map([
        ['f.ts::big', 150],
        ['f.ts::new', 101],
      ]),
      baseline,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('f.ts::new');
  });

  it('fails when a baselined function grows by one line, and never offers the growth as a lowered entry', () => {
    const { problems, lowered } = compare(new Map([['f.ts::big', 151]]), baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('grew from 150 to 151');
    expect(lowered).toEqual({});
  });

  it('fails when a baselined function shrinks and the entry stays, and says the entry can be lowered', () => {
    const { problems, fixable, lowered } = compare(new Map([['f.ts::big', 149]]), baseline);
    expect(problems).toEqual([]);
    expect(fixable).toHaveLength(1);
    expect(lowered).toEqual({ 'f.ts::big': 149 });
  });

  it('passes once the baseline is lowered to the new size', () => {
    const { problems, fixable } = compare(new Map([['f.ts::big', 149]]), { 'f.ts::big': 149 });
    expect([problems, fixable]).toEqual([[], []]);
  });

  it('fails on an entry whose function is now at or under the limit, or gone', () => {
    const { problems, fixable, lowered } = compare(new Map(), baseline);
    expect(problems).toEqual([]);
    expect(fixable).toHaveLength(1);
    expect(lowered).toEqual({});
  });

  it('keeps a growth a problem even when other entries only shrank', () => {
    const two = { 'f.ts::a': 120, 'f.ts::b': 130 };
    const { problems, fixable } = compare(
      new Map([
        ['f.ts::a', 110],
        ['f.ts::b', 131],
      ]),
      two,
    );
    expect(problems).toHaveLength(1);
    expect(fixable).toHaveLength(1);
  });
});

describe('function-length identities of object-literal members', () => {
  const big = (open: string, close: string, indent = '  '): string[] => [
    open,
    ...Array.from({ length: 101 }, (_, i) => `${indent}  step(${i});`),
    close,
  ];

  it('keys a method by the object it sits in, so two objects with the same method do not swap on reorder', async () => {
    const a = ['const alpha = {', ...big('  render() {', '  },'), '};'];
    const b = ['const beta = {', ...big('  render() {', '  },'), '};'];
    const first = await scanSource([...a, ...b].join('\n'));
    const swapped = await scanSource([...b, ...a].join('\n'));
    expect([...first.keys()].sort()).toEqual([`${KEY}alpha > render`, `${KEY}beta > render`]);
    expect(swapped).toEqual(first);
  });

  it('keys a method of an object assigned to a property, or wrapped in as const, by that binding', async () => {
    const source = [
      'api.handlers = {',
      ...big('  run() {', '  },'),
      '};',
      'const typed = {',
      ...big('  go() {', '  },'),
      '} as const;',
    ].join('\n');
    expect([...(await scanSource(source)).keys()]).toEqual([
      `${KEY}api.handlers > run`,
      `${KEY}typed > go`,
    ]);
  });

  it('leaves an object literal with no binding keyed by the member name alone', async () => {
    const source = ['export default {', ...big('  main() {', '  },'), '};'].join('\n');
    expect([...(await scanSource(source)).keys()]).toEqual([`${KEY}main`]);
  });

  it('tells a private member from a public one, and a getter from a setter', async () => {
    const source = [
      'class C {',
      ...big('  #p() {', '  }'),
      ...big('  p() {', '  }'),
      ...big('  get q() {', '  }'),
      ...big('  set q(v) {', '  }'),
      '}',
    ].join('\n');
    expect([...(await scanSource(source)).keys()]).toEqual([
      `${KEY}class C > #p`,
      `${KEY}class C > p`,
      `${KEY}class C > get q`,
      `${KEY}class C > set q`,
    ]);
  });
});

describe('function-length rename pairing', () => {
  const { applyRenames } = createRequire(import.meta.url)(
    join(ROOT, 'scripts', 'function-length.cjs'),
  ) as {
    applyRenames: (
      found: Map<string, number>,
      baseline: Record<string, number>,
      pairs: [string, string][],
    ) => { baseline: Record<string, number>; errors: string[] };
  };
  const baseline = { 'f.ts::old': 150 };

  it('re-keys a stale entry to a new offender in the same file of the same or smaller size', () => {
    const { baseline: next, errors } = applyRenames(new Map([['f.ts::new', 140]]), baseline, [
      ['f.ts::old', 'f.ts::new'],
    ]);
    expect(errors).toEqual([]);
    expect(next).toEqual({ 'f.ts::new': 150 });
  });

  it.each([
    ['grew', new Map([['f.ts::new', 151]]), ['f.ts::old', 'f.ts::new']],
    ['another file', new Map([['g.ts::new', 140]]), ['f.ts::old', 'g.ts::new']],
    [
      'the old function still exists',
      new Map([
        ['f.ts::old', 150],
        ['f.ts::new', 140],
      ]),
      ['f.ts::old', 'f.ts::new'],
    ],
    ['the new one is not an offender', new Map(), ['f.ts::old', 'f.ts::new']],
    [
      'the old key is not in the baseline',
      new Map([['f.ts::new', 140]]),
      ['f.ts::nope', 'f.ts::new'],
    ],
  ] as [string, Map<string, number>, [string, string]][])('refuses when %s', (_, found, pair) => {
    const { baseline: next, errors } = applyRenames(found, baseline, [pair]);
    expect(errors).toHaveLength(1);
    expect(next).toEqual(baseline);
  });

  it('puts the exact --rename command in the message for a new offender next to a stale entry', () => {
    const { problems } = compare(new Map([['f.ts::new', 140]]), baseline);
    expect(problems[0]).toContain("--update --rename 'f.ts::old' 'f.ts::new'");
  });
});

describe('function-length CLI', () => {
  const script = join(ROOT, 'scripts', 'function-length.cjs');
  let root = '';

  /** A temp root holding a copy of the script, a baseline and `packages/p/src/a.ts` with the given functions. */
  function setup(
    functions: Record<string, number>,
    baseline: Record<string, number>,
    limit = 100,
  ): void {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    copyFileSync(script, join(root, 'scripts', 'function-length.cjs'));
    writeFileSync(
      join(root, 'scripts', 'function-length-baseline.json'),
      `${JSON.stringify({ limit, functions: baseline }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, 'packages', 'p', 'src', 'a.ts'),
      Object.entries(functions)
        .map(([name, lines]) => fn(name, lines))
        .join('\n'),
    );
  }

  const run = (...args: string[]): { code: number | null; out: string } => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'function-length.cjs'), ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
      },
    );
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const baselineOf = (): Record<string, number> =>
    (
      JSON.parse(readFileSync(join(root, 'scripts', 'function-length-baseline.json'), 'utf8')) as {
        functions: Record<string, number>;
      }
    ).functions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'function-length-cli-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when the baseline matches', () => {
    setup({ big: 120 }, { [`${KEY}big`]: 120 });
    expect(run().code).toBe(0);
  });

  it('exits non-zero on a new offender', () => {
    setup({ big: 120, extra: 105 }, { [`${KEY}big`]: 120 });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('extra');
  });

  it('exits non-zero on a baselined function that shrank, until --update lowers the entry', () => {
    setup({ big: 110 }, { [`${KEY}big`]: 120 });
    expect(run().code).toBe(1);
    expect(run('--update').code).toBe(0);
    expect(baselineOf()).toEqual({ [`${KEY}big`]: 110 });
    expect(run().code).toBe(0);
  });

  it('--update refuses a growth and leaves the baseline alone', () => {
    setup({ big: 130 }, { [`${KEY}big`]: 120 });
    expect(run('--update').code).toBe(1);
    expect(baselineOf()).toEqual({ [`${KEY}big`]: 120 });
  });

  it('--update refuses a new offender and leaves the baseline alone', () => {
    setup({ big: 120, extra: 105 }, { [`${KEY}big`]: 120 });
    expect(run('--update').code).toBe(1);
    expect(baselineOf()).toEqual({ [`${KEY}big`]: 120 });
  });

  it('--update does not turn a stale entry plus an unrelated new offender into a rename', () => {
    setup({ extra: 105 }, { [`${KEY}gone`]: 120 });
    expect(run('--update').code).toBe(1);
    expect(baselineOf()).toEqual({ [`${KEY}gone`]: 120 });
  });

  it('a renamed baselined function: the check fails, and --update --rename re-keys the entry', () => {
    setup({ renamed: 112 }, { [`${KEY}oldname`]: 120 });
    const check = run();
    expect(check.code).toBe(1);
    expect(check.out).toContain(`--update --rename '${KEY}oldname' '${KEY}renamed'`);
    expect(run('--update').code).toBe(1);
    expect(run('--update', '--rename', `${KEY}oldname`, `${KEY}renamed`).code).toBe(0);
    expect(baselineOf()).toEqual({ [`${KEY}renamed`]: 112 });
    expect(run().code).toBe(0);
  });

  it('--rename refuses a renamed function that is longer than the entry, and works only with --update', () => {
    setup({ renamed: 125 }, { [`${KEY}oldname`]: 120 });
    expect(run('--update', '--rename', `${KEY}oldname`, `${KEY}renamed`).code).toBe(1);
    expect(run('--rename', `${KEY}oldname`, `${KEY}renamed`).code).toBe(1);
    expect(baselineOf()).toEqual({ [`${KEY}oldname`]: 120 });
  });

  it('rejects a baseline whose limit is not 100', () => {
    setup({ big: 120 }, { [`${KEY}big`]: 120 }, 80);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('"limit" must be 100');
  });
});
