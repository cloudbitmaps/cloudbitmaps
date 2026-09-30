import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unknownStoreKeys } from '../helpers/option-literals';

/**
 * The executable harnesses — `scripts/`, `bench/` — pass `new CloudRoaring({ … })` only the option keys it takes, at
 * the top level and in each group, since the store refuses any other.
 *
 * WHY THIS EXISTS. These files are plain JS, so `tsc` never sees their option bags; they are not Markdown, so the
 * doc-fence gate does not read them; and most of them do not run in the ordinary unit suite. A harness passing a
 * key the store refuses fails only when it runs: for `scripts/lambda-smoke.mjs` that is a container build in CI, and
 * for `bench/scale.cjs` it is the command `docs/benchmarks.md` tells a reader to run to check the at-scale table.
 *
 * WHY IT MATCHES `new <anything>.CloudRoaring`. `scripts/smoke.cjs` and `scripts/lambda-smoke.mjs` write
 * `new m.CloudRoaring({…})` against a namespace import, which a pattern anchored on `new CloudRoaring(` misses, so
 * this gate reads both forms.
 */

const ROOT = join(__dirname, '..', '..');

const files = execFileSync('git', ['ls-files', 'scripts/*', 'bench/*'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => /\.(c|m)?js$/.test(f));

describe('the executable harnesses build a store the way the docs say', () => {
  it('reads a store built through a namespace import, as the harnesses build it', () => {
    const src = 'const store = new m.CloudRoaring({ storage, registry, cache: { maxChunk: 1 } });';
    expect(unknownStoreKeys(src, { namespaced: true }).map((k) => k.key)).toEqual([
      'registry',
      'cache.maxChunk',
    ]);
    expect(unknownStoreKeys(src)).toEqual([]);
  });

  it('finds the harnesses at all (a zero-file sweep is a green light that proves nothing)', () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it.each(files)('%s', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const offenders = unknownStoreKeys(src, { namespaced: true }).map(
      ({ line, key }) =>
        `${file}:${line} — passes \`${key}\` to CloudRoaring, which does not take it`,
    );
    expect(offenders).toEqual([]);
  });
});
