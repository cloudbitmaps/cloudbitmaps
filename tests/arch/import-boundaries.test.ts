import path from 'node:path';
import { ESLint } from 'eslint';

/*
 * Architectural lint, part 2: the import-boundary rules are eslint `no-restricted-imports` rules in
 * eslint.config.js. This test lints planted violations at the paths the rules are scoped to and asserts each
 * one fires — and that the legitimate shapes do not. It exists because a rule written wrong would be a silent
 * gap: `pnpm lint` passing proves nothing about a rule that never matched.
 *
 * The same holds for the `no-restricted-globals` entries that keep `core/` free of ambient I/O and randomness
 * which needs no import at all, so the last block below plants those too.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function ruleErrors(ruleId: string, relPath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, relPath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === ruleId).map((m) => m.message);
}

const boundaryErrors = (relPath: string, code: string): Promise<string[]> =>
  ruleErrors('no-restricted-imports', relPath, code);
const globalErrors = (relPath: string, code: string): Promise<string[]> =>
  ruleErrors('no-restricted-globals', relPath, code);

const CORE = 'packages/core/src/core/some-module.ts';
const CORE_ROOT = 'packages/core/src/some-barrel.ts';
const ROARING_ROOT = 'packages/roaring/src/some-file.ts';
const S3_PKG = 'packages/s3/src/storage.ts';
// A service package that does NOT exist yet. The generic driver block is scoped `packages/*/src/**` for
// exactly this reason: a block naming the three packages matches nothing under `packages/r2/src/**`, which
// then has no boundary rules at all. A case planted inside one of the three per-package blocks that override
// it cannot tell the glob from the three names, and narrowing the glob would leave such a suite green.
const FUTURE_PKG = 'packages/r2/src/storage.ts';

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
        "import { LocalFsStorageDriver } from '../drivers/localfs/storage';\nLocalFsStorageDriver;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(
        CORE,
        "import { MemoryStorageDriver } from '@/drivers/memory';\nMemoryStorageDriver;",
      ),
    ).toHaveLength(1);
    // Nor the driver-kit barrel, which re-exports the drivers' shared implementations: through it, `core/`
    // would reach every driver impl, and a `node:*` builtin behind them, with a lint-clean import.
    expect(
      await boundaryErrors(
        CORE,
        "import { brandAsBackend } from '../driver-kit';\nbrandAsBackend;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE, "import { brandAsBackend } from '@/driver-kit';\nbrandAsBackend;"),
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

  it('core/ never imports a flavor either — the rule is restated there, so it needs its own proof', async () => {
    // `packages/core/src/core/**` has its own config block, and eslint REPLACES a rule's options rather than
    // merging them: the flavor pattern in the outer block does not reach files the inner block matches. So
    // the inner block carries a copy, and a copy with no planted violation is a rule nobody has watched fire.
    // Delete it and `pnpm lint` stays green while the purest part of the codebase gains the widest boundary.
    expect(
      await boundaryErrors(
        CORE,
        "import { CloudRoaring } from '@cloudbitmaps/roaring';\nCloudRoaring;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(CORE, "import { S3Storage } from '@cloudbitmaps/s3';\nS3Storage;"),
    ).toHaveLength(1);
  });

  it('neither published package names a cloud SDK or a driver package', async () => {
    // Core is SDK-free UNCONDITIONALLY, not merely outside some directories: the cloud drivers are their own
    // packages, so there is nowhere in core an SDK is allowed, and core carries no optional peer dependencies.
    expect(
      await boundaryErrors(CORE_ROOT, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toHaveLength(1);
    // A flavor does not re-export a driver package: re-exporting one would put that SDK into every install,
    // which is what separate driver packages exist to prevent.
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

  it('a package that does not exist yet already has boundaries — the generic block, not a named one', async () => {
    // Everything here is about `packages/r2`, which is not in the workspace. If the generic block were
    // narrowed back to the three named packages, all four of these would report zero errors.
    expect(
      await boundaryErrors(
        FUTURE_PKG,
        "import { CloudRoaring } from '@cloudbitmaps/roaring';\nCloudRoaring;",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(FUTURE_PKG, "import { S3Storage } from '@cloudbitmaps/s3';\nS3Storage;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(FUTURE_PKG, "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;"),
    ).toHaveLength(1);
    expect(
      await boundaryErrors(FUTURE_PKG, "import { x } from '../../core/src/core/ports';\nx;"),
    ).toHaveLength(1);
    // …and the one dependency it is meant to have is still allowed.
    expect(
      await boundaryErrors(
        FUTURE_PKG,
        "import { IStorageDriver } from '@cloudbitmaps/core/driver-kit';",
      ),
    ).toEqual([]);
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
    // The LEGACY v2 SDK, which is nobody's dependency — including this package's, which takes v3. The s3
    // block restates its group with its own SDK removed, and a restated group that drops `aws-sdk` too lets
    // this import lint clean, though it is ERR_MODULE_NOT_FOUND for every published consumer.
    expect(await boundaryErrors(S3_PKG, "import AWS from 'aws-sdk';\nAWS;")).toHaveLength(1);
    // And core is reached by package name, never by climbing out of the package.
    expect(
      await boundaryErrors(S3_PKG, "import { x } from '../../core/src/core/ports';\nx;"),
    ).toHaveLength(1);
  });

  // The gcs and azure-blob blocks each restate the whole list with their own SDK removed, as the s3 block does,
  // and eslint REPLACES a rule's options rather than merging them — so the generic block's patterns do not reach
  // these files, and each restated copy needs a planted violation of its own. Empty either block's patterns and
  // only these go red: the own-SDK case below still passes.
  it.each([
    {
      pkg: 'gcs',
      sibling: "import { S3Storage } from '@cloudbitmaps/s3';\nS3Storage;",
      sdks: [
        "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;",
        "import AWS from 'aws-sdk';\nAWS;",
        "import { BlobServiceClient } from '@azure/storage-blob';\nBlobServiceClient;",
      ],
    },
    {
      pkg: 'azure-blob',
      sibling: "import { GcsStorage } from '@cloudbitmaps/gcs';\nGcsStorage;",
      sdks: [
        "import { S3Client } from '@aws-sdk/client-s3';\nS3Client;",
        "import AWS from 'aws-sdk';\nAWS;",
        "import { Storage } from '@google-cloud/storage';\nStorage;",
      ],
    },
  ])(
    'the $pkg package takes no flavor, no sibling and no other SDK',
    async ({ pkg, sibling, sdks }) => {
      const file = `packages/${pkg}/src/storage.ts`;
      expect(
        await boundaryErrors(
          file,
          "import { CloudRoaring } from '@cloudbitmaps/roaring';\nCloudRoaring;",
        ),
      ).toHaveLength(1);
      expect(await boundaryErrors(file, sibling)).toHaveLength(1);
      for (const sdk of sdks) expect(await boundaryErrors(file, sdk), sdk).toHaveLength(1);
      expect(
        await boundaryErrors(file, "import { x } from '../../core/src/core/ports';\nx;"),
      ).toHaveLength(1);
      expect(
        await boundaryErrors(
          file,
          "import { IStorageDriver } from '@cloudbitmaps/core/driver-kit';",
        ),
      ).toEqual([]);
    },
  );

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

describe('architecture: core/ reaches no ambient I/O or randomness (eslint no-restricted-globals)', () => {
  // `fetch` and `crypto` are globals in Node and in a V8 isolate alike, so neither needs an import, and the
  // node-builtin ban above cannot see them. Each would give `core/` I/O or randomness of its own, around the
  // driver ports and the injected `Rng` the determinism seam routes them through.
  it('core/ calls no global fetch', async () => {
    expect(
      await globalErrors(
        CORE,
        "export function probe(): Promise<unknown> {\n  return fetch('https://example.com/');\n}",
      ),
    ).toHaveLength(1);
  });

  it('core/ reads no global crypto', async () => {
    expect(
      await globalErrors(CORE, 'export const nonce = crypto.getRandomValues(new Uint8Array(12));'),
    ).toHaveLength(1);
    expect(await globalErrors(CORE, 'export const id = crypto.randomUUID();')).toHaveLength(1);
  });

  it('the look-alikes core/ really writes are untouched', async () => {
    // The writers take a `CrbmCrypto` and bind it to a local named `crypto`: a local is not the global.
    expect(
      await globalErrors(
        CORE,
        "import type { CrbmCrypto } from './crypto';\n" +
          'export function aeadOf(crypto: CrbmCrypto): unknown {\n  return crypto.aead;\n}',
      ),
    ).toEqual([]);
    // A property or a method that shares the name is not the global either.
    expect(await globalErrors(CORE, 'export const deps = { crypto: 1, fetch: 2 };')).toEqual([]);
    expect(
      await globalErrors(
        CORE,
        'export function pull(source: { fetch(): void }): void {\n  source.fetch();\n}',
      ),
    ).toEqual([]);
  });

  it('outside core/ the globals are allowed — a driver is where a builtin belongs', async () => {
    expect(
      await globalErrors(
        'packages/core/src/drivers/some-driver.ts',
        'export const nonce = crypto.getRandomValues(new Uint8Array(12));',
      ),
    ).toEqual([]);
  });
});
