import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('fails when a baselined function grows by one line', () => {
    const { problems } = compare(new Map([['f.ts::big', 151]]), baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('grew from 150 to 151');
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
