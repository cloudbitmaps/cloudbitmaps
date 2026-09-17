import { createRequire } from 'node:module';

/**
 * The runtime-floor detectors, fired at planted inputs in BOTH directions.
 *
 * The policy gate they serve had both patterns inlined in its own test file with nothing firing them at
 * planted inputs — the exact shape `import-boundaries.test.ts` warns about ("a rule that never matched"),
 * and `sdk-specifiers.cjs` / `dts-specifiers.cjs` already fixed twice. An adversarial review found what that
 * costs: `node-version: 22.11` — below the declared floor, and a defect class the floor's own move to a
 * minor CREATED — passed green, as did a quoted pin, a pin with a trailing comment, and nine realistic
 * phrasings of a prose floor. `Node.js >= 20`, the single most likely thing a contributor writes, was
 * invisible because of the `.js`.
 */
const { findNodeFloorClaims, findPinnedNodeVersions, satisfiesFloor, compareVersions } =
  createRequire(import.meta.url)('../../scripts/runtime-floor.cjs') as {
    findNodeFloorClaims: (text: string) => { raw: string; version: string }[];
    findPinnedNodeVersions: (yaml: string) => { raw: string; version: string }[];
    satisfiesFloor: (pin: string, floor: string) => boolean;
    compareVersions: (a: string, b: string) => number;
  };

describe('a prose Node floor is detected however it is phrased', () => {
  it.each([
    ['the shape the README uses', 'You need **Node ≥ 22.12** and pnpm 9.'],
    ['ascii operator', 'Requires Node >= 22.12.'],
    ['no space', 'Requires Node ≥22.12.'],
    ['greater-than', 'Requires Node >22.12.'],
    ['the `.js` spelling — the one the first draft missed', 'Requires Node.js >= 22.12.'],
    ['dotless js', 'Requires Nodejs >= 22.12.'],
    ['lowercase', 'requires node >= 22.12.'],
    ['a v prefix', 'Requires Node v22.12+.'],
    ['a trailing plus', 'Requires Node 22.12+.'],
    ['words — or later', 'Requires Node 22.12 or later.'],
    ['words — or newer', 'Requires Node.js 22.12 or newer.'],
    ['words — or above', 'Requires Node 22.12 or above.'],
    ['a minimum sentence', 'Minimum Node: 22.12'],
    ['a minimum sentence, no colon', 'Minimum Node.js 22.12'],
    ['an HTML entity for the space — plausible in Markdown', 'Requires Node&nbsp;>= 22.12.'],
  ])('%s', (_label, text) => {
    expect(findNodeFloorClaims(text).map((c) => c.version)).toEqual(['22.12']);
  });
});

describe('a prose scan stays silent on things that name a version without declaring a floor', () => {
  it.each([
    // All three of these are live in this repo and must never trip the gate.
    ['a Docker tag', 'use a glibc image (`node:22-slim`)'],
    ['an AWS runtime id', "Lambda's `nodejs22.x` runtime runs 22.23"],
    ['history, not a requirement', 'Node 20 reached EOL on 2026-04-30'],
    ['a bare mention', 'We test on Node 22 and Node 24.'],
    ['a directory name', 'delete the node_modules dir'],
    ['an unrelated tool', 'pnpm 9 is required'],
    ['a version of something else', 'dependency-cruiser 18 declares ^22 || ^24'],
  ])('%s', (_label, text) => {
    expect(findNodeFloorClaims(text)).toEqual([]);
  });
});

describe('a CI node-version pin is found however it is written', () => {
  it.each([
    ['plain', 'node-version: 22', '22'],
    ['sub-major — the class the floor move created', 'node-version: 22.11', '22.11'],
    ['double-quoted', 'node-version: "20"', '20'],
    ['single-quoted', "node-version: '20'", '20'],
    ['with a trailing comment', 'node-version: 20 # pinned for a repro', '20'],
    ['full patch', 'node-version: 22.12.0', '22.12.0'],
  ])('%s', (_label, yaml, version) => {
    expect(findPinnedNodeVersions(`      with:\n        ${yaml}\n`).map((p) => p.version)).toEqual([
      version,
    ]);
  });

  it('skips an expression pin, which carries no literal to judge', () => {
    expect(findPinnedNodeVersions('        node-version: ${{ matrix.node }}\n')).toEqual([]);
  });
});

describe('satisfiesFloor treats a pin as a PREFIX, not an exact version', () => {
  it.each([
    // `22` resolves to the latest 22.x, which is above a 22.12 floor — so it must pass even though
    // 22 < 22.12 numerically. Getting this wrong in either direction breaks the gate.
    ['a bare major at the floor', '22', true],
    ['a higher major', '24', true],
    ['a lower major', '20', false],
    ['the floor exactly', '22.12', true],
    ['one minor below the floor', '22.11', false],
    ['well above the floor', '22.23', true],
    ['the floor with an explicit patch', '22.12.0', true],
    ['a patch below the floor minor', '22.11.9', false],
  ])('%s', (_label, pin, ok) => {
    expect(satisfiesFloor(pin, '22.12')).toBe(ok);
  });
});

describe('compareVersions zero-pads, so the same floor spelled longer is equal', () => {
  it.each([
    ['22.12 vs 22.12.0', '22.12', '22.12.0', 0],
    ['22.12 vs 22.12', '22.12', '22.12', 0],
    ['22.11 below 22.12', '22.11', '22.12', -1],
    ['22.13 above 22.12', '22.13', '22.12', 1],
    ['22 below 22.12', '22', '22.12', -1],
  ])('%s', (_label, a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
