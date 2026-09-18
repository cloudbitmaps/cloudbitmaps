import path from 'node:path';
import { ESLint } from 'eslint';

/*
 * Architectural lint, part 2: the import-boundary rules that used to be dependency-cruiser's are eslint
 * `no-restricted-imports` rules in eslint.config.js. This test lints planted violations at the paths the rules
 * are scoped to and asserts each one fires — and that the legitimate shapes do not. It exists because a rule
 * mistranslated during the move would be a silent gap: `pnpm lint` passing proves nothing about a rule that
 * never matched.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function boundaryErrors(relPath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, relPath) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const CORE = 'packages/core/src/core/some-module.ts';
const CORE_ROOT = 'packages/core/src/some-barrel.ts';
const ROARING_ROOT = 'packages/roaring/src/some-file.ts';
const S3_PKG = 'packages/s3/src/storage.ts';

describe('architecture: import boundaries (eslint no-restricted-imports)', () => {
  it('core/ imports no node builtin', async () => {
    expect(
      await boundaryErrors(CORE, "import { readFile } from 'node:fs/promises';\nreadFile;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE, "import { createHash } from 'crypto';\ncreateHash;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE, "import { setTimeout } from 'timers/promises';\nsetTimeout;"),
    ).toHaveLength(1);
  });

  it('core/ imports no cloud SDK', async () => {
    expect(
      await boundaryErrors(CORE, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE, "import { Storage } from '@google-cloud/storage';\nStorage;"),
    ).toHaveLength(1);
  });

  it('core/ imports no concrete driver', async () => {
    expect(
      await boundaryErrors(
        CORE,
        "import { LocalFsStorageDriver } from '../drivers/localfs/storage';\nLocalFsColdDriver;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(
        CORE,
        "import { MemoryWarmDriver } from '@/drivers/memory';\nMemoryWarmDriver;",
      ),
    ).toHaveLength(1);
  });

  it('core never imports a flavor', async () => {
    expect(
      await boundaryErrors(
        CORE_ROOT,
        "import { CloudRoaring } from '@cloudbitmaps/roaring';\nCloudRoaring;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(
        CORE_ROOT,
        "import { roaringCodec } from '../../roaring/src/roaring-codec';\nroaringCodec;",
      ),
    ).toHaveLength(1);
  });

  it('neither published package names a cloud SDK or a driver package', async () => {
    // Core is now SDK-free UNCONDITIONALLY, not merely outside three directories: the cloud drivers are
    // their own packages, so there is nowhere in core an SDK is allowed. That is why core carries no
    // optional peer dependencies any more.
    expect(
      await boundaryErrors(CORE_ROOT, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toHaveLength(1);
    // A flavor does not re-export a driver package. It used to, through one barrel per service; re-exporting
    // one now would put that SDK back into every install, which is the thing the split removes.
    expect(
      await boundaryErrors(ROARING_ROOT, "export * from '@cloudbitmaps/azure-blob';"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(
        ROARING_ROOT,
        "import { BlobServiceClient } from '@azure/storage-blob';\nBlobServiceClient;",
      ),
    ).toHaveLength(1);
  });

  it('a driver package may take its own SDK, but not a flavor or a sibling', async () => {
    expect(
      await boundaryErrors(S3_PKG, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toEqual([]);
    // The one dependency it is required to have — the blanket "no @cloudbitmaps/*" rule that applies inside
    // core would forbid exactly this, which is why the driver packages carry their own pattern.
    expect(
      await boundaryErrors(
        S3_PKG,
        "import { IStorageDriver } from '@cloudbitmaps/core/driver-kit';",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        S3_PKG,
        "import { CloudRoaring } from '@cloudbitmaps/roaring';\nCloudRoaring;",
      ),
    ).toHaveLength(1);
    // Nor a sibling driver: three packages, three SDKs, no shared surface between them.
    expect(
      await boundaryErrors(S3_PKG, "import { GcsStorage } from '@cloudbitmaps/gcs';\nGcsStorage;"),
    ).toHaveLength(1);
    // And core is reached by package name, never by climbing out of the package.
    expect(
      await boundaryErrors(S3_PKG, "import { x } from '../../core/src/core/ports';\nx;"),
    ).toHaveLength(1);
  });

  it('the driver packages are where an SDK belongs', async () => {
    expect(
      await boundaryErrors(
        'packages/azure-blob/src/registry.ts',
        "import { ContainerClient } from '@azure/storage-blob';\nContainerClient;",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        'packages/gcs/src/storage.ts',
        "import { Storage } from '@google-cloud/storage';\nStorage;",
      ),
    ).toEqual([]);
  });

  it('ordinary core imports are untouched', async () => {
    expect(
      await boundaryErrors(
        CORE,
        "import type { ChunkRef } from './ports';\nexport type R = ChunkRef;",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        CORE,
        "import { ValidationError } from '@/core/errors';\nValidationError;",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        CORE_ROOT,
        "export { LocalFsStorageDriver } from './drivers/localfs/storage';",
      ),
    ).toEqual([]);
  });
});
