import { readdirSync, readFileSync } from 'node:fs';
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
 * driver directory instead, which moves on its own when a backend is added or removed.
 */

const ROOT = join(__dirname, '..', '..');
const template = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');

/** How a driver directory is spelled in the dropdown. In-process drivers are covered by one combined option. */
const LABELS: Readonly<Record<string, string>> = {
  s3: 'S3',
  gcs: 'GCS',
  azure: 'Azure Blob',
  localfs: 'local filesystem',
};

describe('the bug report template lists the drivers that actually ship', () => {
  // Every backend with a driver on disk, minus the in-process ones the template folds into one option.
  const backends = readdirSync(join(ROOT, 'packages/core/src/drivers'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'retry')
    .map((e) => e.name);

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
