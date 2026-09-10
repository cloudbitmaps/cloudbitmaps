import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Build output now lives per-package (`packages/*/dist`) after the workspace split, plus the
  // git-ignored fuzz bundle — none of it is source, so keep the linter off it.
  {
    ignores: [
      'dist',
      'packages/*/dist',
      'fuzz/build',
      'coverage',
      'node_modules',
      '.stryker-tmp',
      'reports',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Determinism seam: core/ must take time and
    // randomness via injected Clock/Rng, and stay storage-agnostic.
    files: ['packages/core/src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'core/ must take time via an injected Clock.',
        },
        {
          name: 'performance',
          message: 'core/ must take time via an injected Clock.',
        },
        {
          name: 'process',
          message: 'core/ must stay free of ambient process/time access.',
        },
        // Timers are not just import-banned — the globals must be too, or `setTimeout(...)` slips through
        // (the determinism seam routes all waiting through an injected Clock.sleep).
        {
          name: 'setTimeout',
          message: 'core/ must wait via an injected Clock.sleep, never a timer.',
        },
        {
          name: 'setInterval',
          message: 'core/ must wait via an injected Clock.sleep, never a timer.',
        },
        {
          name: 'setImmediate',
          message: 'core/ must wait via an injected Clock.sleep, never a timer.',
        },
        {
          name: 'queueMicrotask',
          message: 'core/ must stay free of ambient scheduling.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'core/ must take randomness via an injected Rng.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'core/ must take time via an injected Clock.',
        },
      ],
      // The import-boundary rules (they used to live in dependency-cruiser). ESLint REPLACES a rule's options
      // when a later block sets the same rule for the same file — it does not merge them — so each block below
      // owns a DISJOINT set of files and carries the complete list that applies there.
      // `tests/arch/import-boundaries.test.ts` proves each rule fires (a check that cannot fail is not a check).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // core-no-node-builtins: core/ is runtime-agnostic, not just storage-agnostic — it must run
              // unchanged in a V8 isolate where no node builtin exists. Randomness, time and I/O reach it
              // through injected seams (Clock, Rng, BlobReader, the driver ports).
              regex:
                '^(?:node:.*|(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:/.*)?)$',
              message:
                'core/ imports no node builtin — time via an injected Clock, randomness via Rng, I/O via a driver port. Anything needing a builtin belongs under src/drivers.',
            },
            {
              // core-no-cloud-sdk
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                'core/ is storage-agnostic — depend on driver interfaces (src/core/ports), not cloud SDKs.',
            },
            {
              // core-no-driver-impls: core/ depends only on driver *interfaces*, never a concrete driver.
              regex: '(^|/)drivers(/|$)',
              message:
                'core/ depends on driver interfaces (src/core/ports) only — never a concrete driver under src/drivers (invariant #7).',
            },
            {
              // core-never-imports-a-flavor
              regex: '^(?:@cloudbitmaps/.*|(?:\\.\\./)+roaring(?:/.*)?)$',
              message:
                'core never imports a flavor package — the dependency arrow is core → flavor only.',
            },
          ],
        },
      ],
    },
  },
  {
    // The rest of @cloudbitmaps/core outside core/ and outside the cloud subpaths: the main entry, the local
    // and memory drivers, export, testing. core-never-imports-a-flavor + core-bundle-no-cloud-sdk +
    // core-bundle-no-cloud-driver: everything reachable from the `.` entry stays SDK-free, so
    // `npm i @cloudbitmaps/roaring` pulls only `roaring`.
    files: ['packages/core/src/**/*.ts'],
    ignores: [
      'packages/core/src/core/**',
      'packages/core/src/drivers/{s3,dynamodb,gcs,azure}/**',
      'packages/core/src/{s3,dynamodb,gcs,azure}/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:@cloudbitmaps/.*|(?:\\.\\./)+roaring(?:/.*)?)$',
              message:
                'core never imports a flavor package — the dependency arrow is core → flavor only.',
            },
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                'A cloud SDK may be imported only from its own subpath (src/drivers/<cloud>, src/<cloud>) — the main entry must stay SDK-free.',
            },
            {
              regex: '(^|/)drivers/(s3|dynamodb|gcs|azure)(/|$)',
              message:
                'A cloud driver is reached only through its own subpath entry — importing it here would pull its SDK into the main bundle.',
            },
          ],
        },
      ],
    },
  },
  {
    // The cloud subpaths of core may import their SDK and their driver — but still never a flavor.
    files: [
      'packages/core/src/drivers/{s3,dynamodb,gcs,azure}/**/*.ts',
      'packages/core/src/{s3,dynamodb,gcs,azure}/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:@cloudbitmaps/.*|(?:\\.\\./)+roaring(?:/.*)?)$',
              message:
                'core never imports a flavor package — the dependency arrow is core → flavor only.',
            },
          ],
        },
      ],
    },
  },
  {
    // @cloudbitmaps/roaring outside its cloud subpath barrels: SDK-free, and a cloud driver is reached only
    // through its own `@cloudbitmaps/roaring/<cloud>` entry.
    files: ['packages/roaring/src/**/*.ts'],
    ignores: ['packages/roaring/src/{s3,dynamodb,gcs,azure}/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                'A cloud SDK may be imported only from its own subpath barrel (src/<cloud>) — the main entry must stay SDK-free.',
            },
            {
              regex: '^@cloudbitmaps/core/(s3|dynamodb|gcs|azure)(/|$)',
              message:
                'A cloud driver is reached only through its own subpath entry — importing it here would pull its SDK into the main bundle.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    // CommonJS tooling scripts (the offline bench generator + the package smoke test) use require() by design.
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // ESM tooling scripts (the Lambda deployability smoke, the site screenshotter) run on Node with its
    // globals. Timers and `fetch`/`WebSocket` are listed because these are *tooling*, outside the timer-free
    // rule that governs `core/` — a screenshotter that cannot wait for a page to paint is not a screenshotter.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // The site's scripts. Browser globals, not Node — `site/` is hand-written static HTML, so this is plain
    // ES5-compatible JS rather than anything that goes through the build.
    files: ['site/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
      },
    },
    rules: { 'no-empty': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
