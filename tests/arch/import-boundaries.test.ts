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
        "import { LocalFsColdDriver } from '../drivers/localfs/cold';\nLocalFsColdDriver;",
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

  it('the main entries of both packages stay free of cloud SDKs and cloud drivers', async () => {
    expect(
      await boundaryErrors(CORE_ROOT, "export { S3ColdDriver } from './drivers/s3/cold';"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE_ROOT, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(ROARING_ROOT, "export * from '@cloudbitmaps/core/dynamodb';"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(
        ROARING_ROOT,
        "import { BlobServiceClient } from '@azure/storage-blob';\nBlobServiceClient;",
      ),
    ).toHaveLength(1);
  });

  it('the cloud subpaths themselves are allowed to do exactly that', async () => {
    expect(
      await boundaryErrors(
        'packages/core/src/s3/index.ts',
        "export { S3ColdDriver } from '../drivers/s3/cold';",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        'packages/core/src/drivers/dynamodb/registry.ts',
        "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nDynamoDBClient;",
      ),
    ).toEqual([]);
    expect(
      await boundaryErrors(
        'packages/roaring/src/gcs/index.ts',
        "export * from '@cloudbitmaps/core/gcs';",
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
        "export { LocalFsColdDriver } from './drivers/localfs/cold';",
      ),
    ).toEqual([]);
  });
});
