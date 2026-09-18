import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bug report's "Storage drivers in play" dropdown must list every backend that actually ships.
 *
 * WHY THIS EXISTS. The dropdown is the first thing a reporter touches, and it is the only place in the repo
 * where the driver list is written as a set of human labels rather than as code — so nothing else that gates
 * driver claims can see it. It has drifted twice in two releases:
 *
 *   - `GcsRegistryDriver` and `AzureBlobRegistryDriver` shipped, and the dropdown still offered a registry on
 *     S3 and the local filesystem only. A GCS user reporting a registry bug had nothing truthful to pick.
 *   - The DynamoDB registry was removed and its option was deleted, which fixed the stale entry while leaving
 *     the two missing ones — so the same edit that swept the file left it wrong.
 *
 * Both slipped because a `.yml` issue template does not look like documentation. It is the documentation a
 * reporter reads first.
 *
 * WHY IT IS DERIVED. A hand-maintained list of expected options is a check that cannot fire — you would have to
 * remember to update it in the same breath you forgot to update the template. The expectation comes from the
 * shipped drivers instead, which move on their own when a backend is added or removed.
 *
 * WHERE IT LOOKS, AND WHY THAT IS TWO PLACES. It used to scan `packages/core/src/drivers/*` alone. That was
 * the whole topology once; it is not any more, because the cloud drivers are their own packages. The scan
 * therefore covers core's SDK-free driver directories AND every driver package in the workspace.
 *
 * It also requires a directory to CONTAIN a `.ts` file before counting it. `git` cannot represent an empty
 * directory: when the cloud drivers moved out, `packages/core/src/drivers/{s3,gcs,azure}` stayed behind as
 * empty directories in every working tree that had them before the move, invisible to `git status`. This
 * test passed locally off those husks and failed on CI's clean checkout — the one place the tree was
 * actually right. A derivation that counts directory ENTRIES can be fooled by a leftover; one that counts
 * source files cannot.
 */

const ROOT = join(__dirname, '..', '..');
const template = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');

/** How a driver is spelled in the dropdown. In-process drivers are covered by one combined option. */
const LABELS: Readonly<Record<string, string>> = {
  s3: 'S3',
  gcs: 'GCS',
  'azure-blob': 'Azure Blob',
  localfs: 'local filesystem',
};

/** True only if the directory holds at least one `.ts` file — see the header on empty-directory husks. */
function hasSource(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isFile() && e.name.endsWith('.ts'),
  );
}

describe('the bug report template lists the drivers that actually ship', () => {
  // Core's own SDK-free driver directories…
  const inCore = readdirSync(join(ROOT, 'packages/core/src/drivers'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'retry')
    .filter((e) => hasSource(join(ROOT, 'packages/core/src/drivers', e.name)))
    .map((e) => e.name);
  // …plus every driver PACKAGE, which is where the cloud drivers live now. A package is one iff it depends
  // on a cloud SDK — derived, so a sixth service package is covered the day it is added.
  const CLOUD_SDK = /^(@aws-sdk\/|aws-sdk$|@google-cloud\/|@azure\/)/;
  const asPackages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'package.json')))
    .filter((e) => {
      const m = JSON.parse(
        readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      return Object.keys(m.dependencies ?? {}).some((d) => CLOUD_SDK.test(d));
    })
    .map((e) => e.name);
  const backends = [...inCore, ...asPackages];

  it('covers every backend directory, so the list cannot silently fall behind', () => {
    // If this fails because a backend was ADDED, add its label here and its options to the template.
    expect(backends.sort()).toEqual(Object.keys(LABELS).sort());
  });

  it.each(backends)('offers %s as both a storage and a registry option', (backend) => {
    const label = LABELS[backend] as string;
    // Both roles, because every backend on disk now implements both seams — which is exactly the fact the
    // template got wrong.
    expect(template, `no "Storage — ${label}" option`).toContain(`Storage — ${label}`);
    expect(template, `no "Registry — ${label}" option`).toContain(`Registry — ${label}`);
  });

  it('names no backend that no longer ships', () => {
    const offered = [...template.matchAll(/^\s*-\s*(?:Storage|Registry) — (.+)$/gm)].map((m) =>
      (m[1] as string).trim(),
    );
    const known = new Set(Object.values(LABELS));
    for (const label of offered) {
      // `S3 / S3-compatible` names the same backend as `S3`; compare on the leading term.
      expect(known, `the template offers "${label}", which has no driver`).toContain(
        label.split(' / ')[0] as string,
      );
    }
  });
});
