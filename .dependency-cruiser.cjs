/** Architectural lint — enforces the storage-agnostic-core rule and no cycles. */
module.exports = {
  forbidden: [
    {
      name: 'core-no-cloud-sdk',
      comment: 'core/ is storage-agnostic — it depends on driver interfaces, never a cloud SDK.',
      severity: 'error',
      from: { path: '^packages/core/src/core' },
      to: {
        path: 'node_modules/(@aws-sdk|aws-sdk|@google-cloud|@azure|pg|ioredis|mongodb|cassandra-driver|mysql2)(/|$)',
      },
    },
    {
      name: 'core-no-driver-impls',
      comment:
        'core/ depends only on driver *interfaces* (src/core/ports), never a concrete driver under src/drivers (invariant #7).',
      severity: 'error',
      from: { path: '^packages/core/src/core' },
      to: { path: '^packages/core/src/drivers' },
    },
    {
      name: 'core-bundle-no-cloud-sdk',
      comment:
        'Only the opt-in cloud-driver subpaths (src/drivers/{s3,dynamodb,gcs,azure,postgres,redis,mongodb,cassandra,mysql}, src/{s3,dynamodb,gcs,azure,postgres,redis,mongodb,cassandra,mysql}, …) may import a cloud SDK. Everything reachable from the main `.` entry stays SDK-free, so `npm i cloud-roaring` pulls only `roaring` (Phase 3c packaging).',
      severity: 'error',
      from: {
        path: '^packages/(core|roaring)/src',
        pathNot:
          '^packages/(core|roaring)/src/(drivers/(s3|dynamodb|gcs|azure|postgres|redis|mongodb|cassandra|mysql)|s3|dynamodb|gcs|azure|postgres|redis|mongodb|cassandra|mysql)(/|$)',
      },
      to: {
        path: 'node_modules/(@aws-sdk|aws-sdk|@google-cloud|@azure|pg|ioredis|mongodb|cassandra-driver|mysql2)(/|$)',
      },
    },
    {
      name: 'core-bundle-no-cloud-driver',
      comment:
        'The main entry / core / other drivers must not import a cloud driver impl — that would pull its SDK into the core bundle. Cloud drivers are reached only via their own subpath entry.',
      severity: 'error',
      from: {
        path: '^packages/(core|roaring)/src',
        pathNot:
          '^packages/(core|roaring)/src/(drivers/(s3|dynamodb|gcs|azure|postgres|redis|mongodb|cassandra|mysql)|s3|dynamodb|gcs|azure|postgres|redis|mongodb|cassandra|mysql)(/|$)',
      },
      to: {
        path: '^packages/core/src/drivers/(s3|dynamodb|gcs|azure|postgres|redis|mongodb|cassandra|mysql)',
      },
    },
    {
      name: 'core-no-node-builtins',
      severity: 'error',
      comment:
        'core/ is runtime-agnostic, not just storage-agnostic: it must run unchanged in a V8 isolate ' +
        '(Cloudflare Workers, Deno Deploy) where no node builtin exists. Randomness, time and I/O reach it ' +
        'through injected seams (Clock, Rng, BlobReader, the driver ports) precisely so this holds — see ' +
        'DECISIONS #5. Anything needing a builtin belongs in a driver under src/drivers.',
      from: { path: '^packages/core/src/core' },
      // `dependencyTypes: ['core']` is depcruise's name for a Node BUILTIN — unrelated to this project's
      // `core/` directory, which is an unfortunate collision worth flagging so nobody "fixes" it.
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-never-imports-a-flavor',
      severity: 'error',
      comment:
        'The dependency arrow is ONE-WAY: a flavor package (@cloudbitmaps/roaring, …) depends on core, never the reverse. A core→flavor import is a publish-breaking cycle.',
      from: { path: '^packages/core/src' },
      // Broad on purpose: depcruise resolves `@cloudbitmaps/roaring` through the pnpm workspace symlink to
      // the REAL path `packages/roaring/…` (dist or src), so match the whole package tree — plus the
      // node_modules spelling for good measure.
      to: { path: '(^packages/roaring/|node_modules/@cloudbitmaps/)' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'No orphan modules (excluding config/entry and the test-only conformance SDK).',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '^packages/roaring/src/testing/'],
      },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
  },
};
