import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The executable harnesses — `scripts/`, `bench/` — must not construct a store with an option that moved.
 *
 * WHY THIS EXISTS. Three of these shipped broken in a row, each found by something other than a gate:
 *
 *   - `scripts/smoke.cjs` passed `registry` after the backend class removed it. Found only when the new
 *     constructor guard turned a silent ignore into a throw.
 *   - `bench/soak.cjs` (x2) and `bench/scale.cjs`, same key. Found by an adversarial review, after the sweep
 *     that fixed `scripts/` stopped short of `bench/`. `docs/benchmarks.md` cites `pnpm bench:scale` as the
 *     provenance of the published at-scale table, so the command a reader is told to run to check our numbers
 *     no longer started.
 *   - `scripts/lambda-smoke.mjs`, same key again. Found by CI, on a job that builds a container — the slowest
 *     and most expensive place to learn it.
 *
 * These files are the one corner nothing covers. They are plain JS, so `tsc` never sees their option bags;
 * they are not Markdown, so the doc-fence gate does not read them; and only one of the three runs in the
 * ordinary unit suite. Every one of them kept *passing* while the option did nothing, because a store with a
 * single generation resolves by list-scan to the same answer a registry would have given — the failure was
 * invisible right up until the guard made it loud.
 *
 * WHY IT MATCHES `new <anything>.CloudRoaring`. All three write `new m.CloudRoaring({…})` against a namespace
 * import. A pattern anchored on `new CloudRoaring(` — the obvious one, and the one the doc-fence gate uses
 * because samples always destructure — matches none of them. That is most of why hand searches kept missing
 * these: the grep looked right and returned nothing.
 */

const ROOT = join(__dirname, '..', '..');

/** Option keys that no longer exist at the top level of a store config, and where each one went. */
const MOVED: ReadonlyArray<readonly [string, string]> = [
  ['registry', 'the backend passed as `storage`'],
  ['cold', '`storage`'],
  ['keystore', '`encryption.keystore`'],
  ['requireEncryption', '`encryption.required`'],
  ['cacheMaxChunks', '`cache.maxChunks`'],
  ['cacheTtlMs', '`cache.ttlMs`'],
  ['storageGenTtlMs', '`cache.genTtlMs`'],
  ['storageReaderCacheMax', '`cache.readerMax`'],
  ['storageReaderCacheMaxBytes', '`cache.readerMaxBytes`'],
  ['onRetry', 'inside `retry`'],
  ['clock', '`seams.clock`'],
  ['rng', '`seams.rng`'],
];

const files = execFileSync('git', ['ls-files', 'scripts/*', 'bench/*'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => /\.(c|m)?js$/.test(f));

/** The argument of each `new [ns.]CloudRoaring({ … })`, with everything nested blanked out. */
function topLevelOptionBodies(src: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = [];
  for (const m of src.matchAll(/new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?CloudRoaring\(\s*\{/g)) {
    const open = src.indexOf('{', m.index ?? 0);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    // Blank nested groups so a legitimate `storage: { storage, registry }` backend literal — which is how
    // these harnesses now pass their two halves — is not read as a top-level `registry`.
    let flat = '';
    let d = 0;
    for (const ch of src.slice(open + 1, end)) {
      const opening = ch === '{' || ch === '(' || ch === '[';
      const closing = ch === '}' || ch === ')' || ch === ']';
      if (closing) d--;
      flat += d === 0 && !opening && !closing ? ch : ' ';
      if (opening) d++;
    }
    out.push({ body: flat.replace(/\/\/.*$/gm, ''), line: src.slice(0, open).split('\n').length });
  }
  return out;
}

describe('the executable harnesses build a store the way the docs say', () => {
  it('finds the harnesses at all (a zero-file sweep is a green light that proves nothing)', () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it.each(files)('%s', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const offenders: string[] = [];
    for (const { body, line } of topLevelOptionBodies(src)) {
      for (const [key, moved] of MOVED) {
        if (new RegExp(`(^|[{,\\s])${key}\\s*([:,}]|$)`, 'm').test(body)) {
          offenders.push(`${file}:${line} — passes \`${key}\` to CloudRoaring; it is now ${moved}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
