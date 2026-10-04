import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A run's modelled depth is the depth of the engine that ran it. Releases through 0.12.0 held a combine's window at a
// fixed 8 keys; a later one opens at the engine source's start and widens to its default `concurrency`. The version a
// run reports picks which, so a wrong reading here moves every committed run's expected depth.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const { windowOfRun } = require_(join(ROOT, 'bench', 'lib', 'calibration-figures.cjs')) as {
  windowOfRun: (
    packageVersion: unknown,
    src: { intersectConcurrency: number; combineWindowStart: number },
  ) => { limit: number; start: number };
};

// Stand-in values, deliberately unlike the engine's, so a case read against the source cannot pass as a fixed one.
const SRC = { intersectConcurrency: 48, combineWindowStart: 6 };
const FIXED = { limit: 8, start: 8 };
const CURRENT = { limit: 48, start: 6 };

describe('windowOfRun: the window of the engine a run reports', () => {
  it.each([
    ['0.10.0', FIXED],
    ['0.11.9', FIXED],
    ['0.12.0', FIXED],
    ['0.12.0-rc.1', FIXED], // a pre-release ran the engine of the release it precedes
    ['0.12.1', CURRENT],
    ['0.13.0', CURRENT],
    ['0.13.0-rc.1', CURRENT],
    ['1.0.0', CURRENT],
  ])('%s', (version, expected) => {
    expect(windowOfRun(version, SRC)).toEqual(expected);
  });

  it.each([['not-a-version'], [''], [undefined], [null], ['0.12'], ['v0.12.0']])(
    'reads %p, which names no release, as the current engine',
    (version) => {
      expect(windowOfRun(version, SRC)).toEqual(CURRENT);
    },
  );
});
