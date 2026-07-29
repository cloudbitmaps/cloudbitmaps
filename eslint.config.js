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
      // The superseded site, kept only to diff against until it is deleted.
      'site-old',
      // The delivery's own support.js — vendor code we diff against, never lint.
      'site2',
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
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'crypto',
              message: 'core/ must take randomness via an injected Rng.',
            },
            {
              name: 'node:crypto',
              message: 'core/ must take randomness via an injected Rng.',
            },
            {
              name: 'fs',
              message: 'core/ does no I/O — reach storage via an injected driver.',
            },
            {
              name: 'node:fs',
              message: 'core/ does no I/O — reach storage via an injected driver.',
            },
            {
              name: 'node:fs/promises',
              message: 'core/ does no I/O — reach storage via an injected driver.',
            },
            {
              name: 'timers',
              message: 'core/ must take time via an injected Clock.',
            },
            {
              name: 'node:timers',
              message: 'core/ must take time via an injected Clock.',
            },
          ],
          patterns: [
            {
              group: ['@aws-sdk/*', 'aws-sdk', '@google-cloud/*', '@azure/*'],
              message: 'core/ is storage-agnostic — depend on driver interfaces, not cloud SDKs.',
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
