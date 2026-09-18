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
      '.worktrees',
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
              // `driver-kit` too, not just `drivers/`: it is a barrel that re-exports `drivers/_shared/*`,
              // so without it `core/` could reach every driver impl — and transitively a `node:*` builtin,
              // which `src/drivers/**` is allowed to use and `core/` must never see — through a lint-clean
              // import. Invariant 7 says the seam loads where no builtin exists; this is the path to it.
              regex: '(^|/)driver(s|-kit)(/|$)',
              message:
                'core/ depends on driver interfaces (src/core/ports) only — never a concrete driver under src/drivers, and not the driver-kit barrel that re-exports them (invariant #7).',
            },
            {
              // core-never-imports-a-flavor
              regex: '^(?:@cloudbitmaps/.*|(?:\\.\\./)+roaring(?:/.*)?)$',
              message:
                'core imports nothing else of ours — not a flavor, not a driver package. Every arrow in the workspace points AT core (flavor → core, driver → core); one pointing out of it is a cycle.',
            },
          ],
        },
      ],
    },
  },
  {
    // The rest of @cloudbitmaps/core outside core/: the main entry, the driver-kit subpath, the local and
    // memory drivers, export, testing. core-never-imports-a-flavor + no cloud SDK anywhere.
    //
    // There is no longer an exception for cloud subpaths, because core has none: the cloud drivers are their
    // own packages. That makes this the stronger statement — core contains no cloud SDK reference at all,
    // rather than none outside three directories — and it is why core has no optional peer dependencies left.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:@cloudbitmaps/.*|(?:\\.\\./)+roaring(?:/.*)?)$',
              message:
                'core imports nothing else of ours — not a flavor, not a driver package. Every arrow in the workspace points AT core (flavor → core, driver → core); one pointing out of it is a cycle.',
            },
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                'core contains no cloud SDK — the cloud drivers are separate packages (@cloudbitmaps/s3, /gcs, /azure-blob) which depend on their SDK for real.',
            },
          ],
        },
      ],
    },
  },
  {
    // The driver packages may import their own SDK — that is what they are for — but still never a flavor.
    // The arrow runs flavor → driver → core, and a driver that reached back into a codec would make the
    // codec-agnostic claim false and force every flavor to carry every driver's dependencies.
    // EVERY package that is not core or a flavor, so a fourth service package is guarded the day it is
    // added rather than the day someone notices. Naming the three meant `packages/r2/src/**` matched no
    // block at all and silently had no boundary rules — and the split's whole point is that adding a
    // service package is cheap.
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/core/src/**', 'packages/roaring/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Any `@cloudbitmaps/*` EXCEPT core. A driver package must import core — that is where the
              // ports and the driver-kit live — so the blanket "no @cloudbitmaps/*" rule that applies inside
              // core would forbid the one dependency these packages are required to have.
              regex: '^@cloudbitmaps/(?!core(?:/|$))',
              message:
                'a driver package depends on @cloudbitmaps/core and nothing else of ours — never a flavor, and never a sibling driver.',
            },
            {
              regex: '^(?:\\.\\./)+(?:roaring|core)(?:/.*)?$',
              message:
                'reach core by its package name (@cloudbitmaps/core, or /driver-kit), not by a relative path out of this package.',
            },
            {
              // A driver package may import ITS OWN SDK and no other. Importing a sibling's would resolve
              // during development (it is in the workspace) and then be ERR_MODULE_NOT_FOUND for every
              // consumer, because it is not in this package's `dependencies`. The per-package allowance is
              // the `ignores` on the three blocks below.
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                "a driver package imports only its own cloud SDK — a sibling's is not in its dependencies and would be missing for every consumer.",
            },
          ],
        },
      ],
    },
  },
  {
    // @cloudbitmaps/roaring: SDK-free, and it does not name a driver package either.
    //
    // The `ignores` for its cloud barrels is gone with the barrels themselves. A user installs the driver
    // package they want alongside the flavor, so the flavor re-exporting one would put that SDK back into
    // every install — which is the whole thing the split removes.
    files: ['packages/roaring/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                'a flavor names no cloud SDK anywhere — the driver packages (@cloudbitmaps/s3, /gcs, /azure-blob) own them, and a user installs the one they have.',
            },
            {
              regex: '^@cloudbitmaps/(s3|gcs|azure-blob)(/|$)',
              message:
                'A flavor does not name a driver package — the user installs the one they want, so re-exporting it here would pull that SDK into every install.',
            },
          ],
        },
      ],
    },
  },
  {
    // s3: its own SDK, and only its own. The block above forbids all four groups for every driver package;
    // this re-states the complete list for this one package with its own SDK removed, because eslint
    // REPLACES a rule's options rather than merging them.
    files: ['packages/s3/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@cloudbitmaps/(?!core(?:/|$))',
              message:
                'a driver package depends on @cloudbitmaps/core and nothing else of ours — never a flavor, and never a sibling driver.',
            },
            {
              regex: '^(?:\\.\\./)+(?:roaring|core)(?:/.*)?$',
              message:
                'reach core by its package name (@cloudbitmaps/core, or /driver-kit), not by a relative path out of this package.',
            },
            {
              // `aws-sdk` is the LEGACY v2 SDK and is nobody's dependency — including this package's, which
              // takes `@aws-sdk/client-s3` (v3). It belongs in this list for the same reason the siblings
              // keep it: importing it resolves from the hoisted workspace root during development and is
              // ERR_MODULE_NOT_FOUND for every published consumer.
              group: ['aws-sdk', '@google-cloud/*', '@azure/*'],
              message:
                "this package imports only its own cloud SDK — a sibling's is not in its dependencies and would be missing for every consumer.",
            },
          ],
        },
      ],
    },
  },
  {
    // gcs: its own SDK, and only its own. The block above forbids all four groups for every driver package;
    // this re-states the complete list for this one package with its own SDK removed, because eslint
    // REPLACES a rule's options rather than merging them.
    files: ['packages/gcs/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@cloudbitmaps/(?!core(?:/|$))',
              message:
                'a driver package depends on @cloudbitmaps/core and nothing else of ours — never a flavor, and never a sibling driver.',
            },
            {
              regex: '^(?:\\.\\./)+(?:roaring|core)(?:/.*)?$',
              message:
                'reach core by its package name (@cloudbitmaps/core, or /driver-kit), not by a relative path out of this package.',
            },
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@azure/*'],
              message:
                "this package imports only its own cloud SDK — a sibling's is not in its dependencies and would be missing for every consumer.",
            },
          ],
        },
      ],
    },
  },
  {
    // azure-blob: its own SDK, and only its own. The block above forbids all four groups for every driver package;
    // this re-states the complete list for this one package with its own SDK removed, because eslint
    // REPLACES a rule's options rather than merging them.
    files: ['packages/azure-blob/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@cloudbitmaps/(?!core(?:/|$))',
              message:
                'a driver package depends on @cloudbitmaps/core and nothing else of ours — never a flavor, and never a sibling driver.',
            },
            {
              regex: '^(?:\\.\\./)+(?:roaring|core)(?:/.*)?$',
              message:
                'reach core by its package name (@cloudbitmaps/core, or /driver-kit), not by a relative path out of this package.',
            },
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*'],
              message:
                "this package imports only its own cloud SDK — a sibling's is not in its dependencies and would be missing for every consumer.",
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
