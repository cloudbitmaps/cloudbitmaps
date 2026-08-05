import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudRoaring, MemoryColdChunkSource, MemoryWarmDriver } from '@/index';

/**
 * The **published** README of the flavor package must not lag the API it ships.
 *
 * WHY THIS EXISTS. `packages/roaring/README.md` is a separate file from the repo-root `README.md`, and it is the
 * one npm renders — so it is simultaneously the most-read surface and the easiest to forget. It has now drifted
 * twice:
 *
 *   - `0.7.0` shipped the Redis mapping and I reported it as being on the npm README. It was not; only the root
 *     README had it.
 *   - `0.8.0` shipped `claimMany` and `dropSegment` — the two headline features — and the npm page mentioned
 *     **neither**, while still claiming operations "carry over one-for-one" from Redis with no boundary. The npm
 *     page was briefly the least honest surface in the project.
 *
 * Both slipped because every gate we had looked at the root README, the guide and the api-reference. Nothing looked
 * at the file that actually gets published.
 *
 * WHY IT IS DERIVED RATHER THAN A LIST. A hand-maintained "methods the README must mention" array is a check that
 * cannot fire: you would have to remember to update it in the same breath you forgot to update the README. So both
 * halves come from something that moves on its own — the live `SegmentHandle` prototype, and the guide's own Redis
 * mapping section.
 */

const ROOT = join(__dirname, '..', '..');
const flavorReadme = readFileSync(join(ROOT, 'packages/roaring/README.md'), 'utf8');
const guide = readFileSync(join(ROOT, 'docs/guide/getting-started.md'), 'utf8');

/** Every public method on a real `SegmentHandle`, from the prototype — not from a list someone maintains. */
function segmentHandleMethods(): string[] {
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new MemoryColdChunkSource(),
  });
  const handle = store.segment('probe');
  return Object.getOwnPropertyNames(Object.getPrototypeOf(handle))
    .filter((n) => n !== 'constructor' && !n.startsWith('_'))
    .filter((n) => typeof (handle as unknown as Record<string, unknown>)[n] === 'function');
}

/** The guide's "Coming from Redis bitmaps?" section — the authored mapping this README summarises. */
function guideRedisSection(): string {
  const start = guide.indexOf('### Coming from Redis bitmaps?');
  expect(start).toBeGreaterThan(-1);
  const rest = guide.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('published flavor README stays in sync with the shipped API', () => {
  it('mentions every SegmentHandle method the guide maps a Redis command onto', async () => {
    // The intersection is the point. The flavor README is deliberately an OVERVIEW, so requiring it to name every
    // method would fight its purpose — but any method the guide presents as *the answer to a Redis command* is, by
    // construction, something a reader arriving from Redis is looking for, and npm is where they arrive first.
    const methods = segmentHandleMethods();
    const redisSection = guideRedisSection();
    const mappedInGuide = methods.filter((m) => new RegExp(`\\b${m}\\b`).test(redisSection));

    // Guard the guard: if this comes back empty the test proves nothing, which is exactly the failure mode this
    // file's header is about.
    expect(mappedInGuide.length).toBeGreaterThan(5);

    // `xInto` counts as covered by `x`: the `*Into` forms are the materializing variant of the same operation, so
    // an overview that names `intersect` has told a Redis reader what replaces `BITOP AND`. Requiring both spellings
    // would be asking the README to be exhaustive, which is the api-reference's job, not this file's.
    const covered = (m: string): boolean =>
      new RegExp(`\\b${m}\\b`).test(flavorReadme) ||
      (m.endsWith('Into') && new RegExp(`\\b${m.slice(0, -'Into'.length)}\\b`).test(flavorReadme));
    const missing = mappedInGuide.filter((m) => !covered(m));
    expect(
      missing,
      `packages/roaring/README.md — the file npm renders — does not mention ${missing.join(', ')}, ` +
        `which docs/guide/getting-started.md presents as the CloudBitmaps answer to a Redis command. ` +
        `That README is published, so a gap here is a gap on the package page. Add them, or drop the mapping ` +
        `from the guide if it is no longer the answer.`,
    ).toEqual([]);
  });

  it('does not claim Redis parity without stating a boundary', async () => {
    // The honesty half, and the one that actually misled: the README claimed operations "carry over one-for-one"
    // long after the guide had qualified that with two hard limits. A parity claim is fine; an unbounded one is
    // falsifiable by the first reader who ports a SETBIT loop, so the qualifier has to travel with it.
    if (!/redis/i.test(flavorReadme)) return; // no claim, nothing to bound

    const hasBoundary =
      /not a drop-in replacement/i.test(flavorReadme) ||
      /no equivalent/i.test(flavorReadme) ||
      /does not carry over/i.test(flavorReadme);
    expect(
      hasBoundary,
      'packages/roaring/README.md compares itself to Redis but states no limit. An unqualified parity claim is ' +
        'falsifiable by the first reader who ports a per-id SETBIT loop — say what does not carry over.',
    ).toBe(true);
  });

  it('states the write-shape warning, since that is the expensive mistake', async () => {
    // Not a style preference. This is the single most costly way to misuse the library (~3,000x the bytes), it is
    // the NATURAL shape for someone arriving from Redis, and the package page is where they arrive.
    expect(
      /per-id|one at a time|one op per/i.test(flavorReadme),
      'packages/roaring/README.md does not warn against a per-id write loop. It is the natural Redis shape and ' +
        'the worst shape here — see docs/benchmarks.md "Write shape".',
    ).toBe(true);
  });
});
