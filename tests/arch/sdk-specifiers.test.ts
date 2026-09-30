import { createRequire } from 'node:module';

/**
 * The SDK-specifier detector, fired at planted inputs in BOTH directions.
 *
 * This repo's rule, from `import-boundaries.test.ts`: a rule that never matched would be a silent gap, and
 * `pnpm lint` passing proves nothing about it. The detector behind the SDK-free gate earns the same
 * treatment — an adversarial review of its first draft found one false positive and three false negatives,
 * and no suite would have noticed any of them, because the gate was green either way.
 *
 * The false positive is the one worth naming: esbuild preserves JSDoc on class members, and this repo
 * documents invariant 7 *in prose, in the files it governs* — so a comment reading `takes its client from
 * "@aws-sdk/client-s3"` shipped in `dist/` and failed CI with a message asserting something false. The
 * remedy a contributor reaches for is to water the comment down, which is the erosion the gate exists to
 * prevent.
 */
const { findSdkSpecifiers } = createRequire(import.meta.url)(
  '../../scripts/sdk-specifiers.cjs',
) as { findSdkSpecifiers: (source: string) => string[] };

describe('the SDK-free gate detects a specifier', () => {
  it.each([
    ['cjs require', 'require("@aws-sdk/client-s3")'],
    ['static import', 'import { S3Client } from "@aws-sdk/client-s3";'],
    ['re-export', 'export * from "@aws-sdk/client-s3";'],
    ['minified re-export', 'export*from"@aws-sdk/client-s3";'],
    [
      'dynamic import — invisible to eslint, which is why this gate exists',
      'import("@aws-sdk/client-s3")',
    ],
    [
      'ESM side-effect import — a driver self-registration emits this',
      'import "@aws-sdk/client-s3";',
    ],
    ['a template specifier', 'import(`@aws-sdk/client-s3`)'],
    [
      'createRequire, whose result may be named anything',
      'const req = cr(u); req("@aws-sdk/client-s3")',
    ],
    ['an aws-sdk v2 deep path', 'require("aws-sdk/clients/s3")'],
    ['google cloud', 'require("@google-cloud/storage")'],
    ['azure', 'require("@azure/storage-blob")'],
    [
      'a type-only import, invisible to eslint as a TSImportType',
      'type C = import("@aws-sdk/client-s3").S3Client;',
    ],
    [
      'a driver name as a subpath of our own package — stays external, but a bundler follows it',
      'await import("@cloudbitmaps/core/s3")',
    ],
    // The live package names. Naming a driver package IS reaching its SDK — a consumer's bundler follows
    // the specifier into the driver entry and finds `@aws-sdk/client-s3` there.
    ['a driver package', 'require("@cloudbitmaps/s3")'],
    ['a driver package, dynamic', 'import("@cloudbitmaps/azure-blob")'],
    ['a driver package deep path', 'require("@cloudbitmaps/gcs/whatever")'],
    // A driver name as a subpath of the flavor is matched too: it would reach an SDK the same way.
    ['a driver name as a subpath of the flavor', 'require("@cloudbitmaps/roaring/azure")'],
    ['a driver package name as a subpath of core', 'require("@cloudbitmaps/core/azure-blob")'],
  ])('%s', (_label, source) => {
    expect(findSdkSpecifiers(source).length).toBeGreaterThan(0);
  });
});

describe('the SDK-free gate does NOT fire on', () => {
  it.each([
    [
      'JSDoc prose — the false positive that redded CI',
      '/** takes its client from "@aws-sdk/client-s3" */',
    ],
    ['a URL in a comment', '// see https://npmjs.com/package/@aws-sdk/client-s3'],
    ['backticked prose', '/** the `@aws-sdk/client-s3` optional peer */'],
    ['a line comment naming the peer', '// requires @aws-sdk/client-s3 to be installed'],
    [
      'an error message telling a user what to install',
      'throw new Error("install @aws-sdk/client-s3 first")',
    ],
    ['a package we do not guard', 'require("@smithy/node-http-handler")'],
    ['an unrelated scoped package', 'require("@cloudbitmaps/core")'],
    ['the flavor main entry, which is not a driver', 'require("@cloudbitmaps/roaring")'],
    ['the driver contract, which carries no SDK', 'import("@cloudbitmaps/core/driver-kit")'],
    ['a subpath that only starts with a driver name', 'require("@cloudbitmaps/core/azure-blobs")'],
  ])('%s', (_label, source) => {
    expect(findSdkSpecifiers(source)).toEqual([]);
  });
});

it('reports every distinct specifier it found, deduplicated', () => {
  const source = `
    require("@aws-sdk/client-s3");
    import "@azure/storage-blob";
    const again = require("@aws-sdk/client-s3");
  `;
  expect(findSdkSpecifiers(source).sort()).toEqual(['@aws-sdk/client-s3', '@azure/storage-blob']);
});
