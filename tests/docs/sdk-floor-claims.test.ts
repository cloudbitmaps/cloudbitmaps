import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A driver package's cloud-SDK range is a CORRECTNESS claim, and it is stated in three places that can drift.
 *
 * `@cloudbitmaps/s3` requires `@aws-sdk/client-s3 >= 3.645.0` because below that the SDK does not model the
 * conditional write this library's write-once guarantee is built on. That is measured, not inferred: against
 * MinIO, 3.640.0 drops the unmodeled `IfNoneMatch: "*"` and a second PUT to the same key SUCCEEDS — hard
 * invariant 2 silently lost — while 3.641.0 rejects it. The pinned floor sits a small margin above.
 *
 * Nothing checked it. The manifest range, the README's statement of it and the CHANGELOG's rationale were
 * three independent strings; lowering the manifest floor (a careless `pnpm up`, a merge, a "widen it for
 * compatibility") left the whole suite green while reintroducing silent data loss. `version-claims` cannot
 * help — it EXEMPTS `3.645.0` as a foreign version so the site check does not trip on it.
 *
 * So this derives the floor from each driver manifest and asserts the package's own README states the same
 * range. Deriving means a sixth driver package is covered the day it is added.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLOUD_SDK = /^(?:@aws-sdk\/|aws-sdk$|@google-cloud\/|@azure\/)/;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

/** Every `(package, sdk, range)` triple in the workspace, derived. */
function sdkRanges(): { pkg: string; name: string; sdk: string; range: string }[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'package.json')))
    .flatMap((e) => {
      const m = JSON.parse(
        readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8'),
      ) as Manifest;
      return Object.entries(m.dependencies ?? {})
        .filter(([d]) => CLOUD_SDK.test(d))
        .map(([sdk, range]) => ({ pkg: e.name, name: m.name, sdk, range }));
    });
}

const RANGES = sdkRanges();

describe('a driver package states its SDK range identically in the manifest and its README', () => {
  it('found the driver packages at all — a zero-row sweep would prove nothing', () => {
    expect(RANGES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(RANGES)('$name pins $sdk and its README says so', ({ pkg, sdk, range }) => {
    const readme = readFileSync(join(ROOT, 'packages', pkg, 'README.md'), 'utf8');
    expect(readme, `packages/${pkg}/README.md never names ${sdk}`).toContain(sdk);
    // The README may wrap the range in backticks or prose, so compare on the range's own text.
    expect(
      readme.includes(range),
      `packages/${pkg}/README.md does not state the range "${range}" that its manifest declares`,
    ).toBe(true);
  });

  it('the S3 write-once floor has not been lowered', () => {
    // Named explicitly, and separately from the derived check above, because this one number is the
    // difference between refusing a colliding write and silently overwriting a published generation. A
    // derived "manifest agrees with README" check would stay green if BOTH were lowered together.
    const s3 = RANGES.find((r) => r.sdk === '@aws-sdk/client-s3');
    expect(s3, 'no package depends on @aws-sdk/client-s3 any more').toBeDefined();
    const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(s3?.range ?? '');
    expect(floor, `expected a >=x.y.z floor, got "${s3?.range}"`).not.toBeNull();
    const [major, minor, patch] = (floor ?? []).slice(1).map(Number) as [number, number, number];
    // 3.641.0 is the first version that rejects a colliding conditional write; anything below it silently
    // overwrites. Raising the floor is fine; lowering it past the measured boundary is not.
    const asNumber = major * 1_000_000 + minor * 1_000 + patch;
    expect(
      asNumber,
      `${s3?.range} is below the measured write-once boundary (3.641.0)`,
    ).toBeGreaterThanOrEqual(3 * 1_000_000 + 641 * 1_000 + 0);
    expect(s3?.range, 'the range must stay inside AWS SDK v3').toContain('<4');
  });
});
