'use strict';
/*
 * The detectors behind the "core's entries import no Node builtin" gate (hard invariant 7), kept separate from
 * `scripts/smoke.cjs` so `tests/arch` can fire them at planted inputs, as it does `sdk-specifiers.cjs`.
 *
 * Two layers, because each catches what the other cannot:
 *
 *   planted form                                   specifier scan   neutral bundle   vm load
 *   static `import ... from 'node:fs'`             fails            fails
 *   `export * from 'node:path'`                    fails            fails
 *   lazy `import('node:crypto')`, never called     fails            fails
 *   bare `import p from 'path'`                    passes           fails
 *   `require('node:fs')` inside try/catch          fails            passes           passes
 *   `process.getBuiltinModule('node:fs')`          fails            passes           passes
 *   top-level `Buffer.from('x')` / `process.env`   passes           passes           fails
 *   top-level `new TextEncoder()` (control)        passes           passes           passes
 *
 * `findBuiltinSpecifiers` reads the built files, `loadWithoutNode` bundles an entry for a platform with no builtins
 * and evaluates the bundle in a context holding only the globals a V8 isolate has.
 *
 * Known limits. A builtin reached through `process.getBuiltinModule('fs')` (a bare name) inside a function is caught
 * by no layer: that is deliberate evasion, out of scope. The `.d.ts` tree is not checked for Node types. A load is
 * not a run: the check loads the entry, it does not execute the engine in an isolate.
 */
const vm = require('node:vm');
const { stripComments } = require('./sdk-specifiers.cjs');

/** A whole string value that is a `node:` specifier, with an optional subpath (`node:fs/promises`). */
const NODE_SPECIFIER = /^node:[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;

/**
 * Every string or template literal in `source` (comments stripped first) whose WHOLE value is a `node:` specifier.
 * Whole value, not prefix: an error message that starts with `node:` or names `node:crypto` mid-sentence does not
 * trip it, and a specifier cannot dodge it. Deduplicated.
 */
function findBuiltinSpecifiers(source) {
  const code = stripComments(source);
  const literals = code.match(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g) ?? [];
  const found = literals
    .map((lit) => lit.slice(1, -1))
    .filter((value) => NODE_SPECIFIER.test(value));
  return [...new Set(found)];
}

/** The web-platform globals every V8 isolate runtime has. */
const WEB_GLOBALS = [
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'structuredClone',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'atob',
  'btoa',
  'console',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'performance',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'Blob',
  'Event',
  'EventTarget',
  'DOMException',
];

/** What an isolate does not have; each must be `undefined` in the context this module builds. */
const NODE_ONLY_GLOBALS = [
  'process',
  'Buffer',
  'require',
  'module',
  'global',
  '__dirname',
  '__filename',
  'setImmediate',
  'clearImmediate',
];

/** The globals object of a context holding only {@link WEB_GLOBALS}, copied from the host. */
function webGlobals() {
  const globals = {};
  for (const name of WEB_GLOBALS) if (name in globalThis) globals[name] = globalThis[name];
  return globals;
}

/**
 * Bundle `entryFile` for `platform: 'neutral'` (no builtin resolves) and evaluate it in a context with web globals
 * only. Resolves `{ exports }`, the entry's export names, or rejects with an error naming the entry and the cause.
 */
async function loadWithoutNode(entryFile, { tsconfig } = {}) {
  const esbuild = require('esbuild');
  let code;
  try {
    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'iife',
      globalName: '__entry',
      logLevel: 'silent',
      // Without one, ignore the tsconfig esbuild would find: its path aliases would bundle a package's source in
      // place of the built files this check is about.
      ...(tsconfig ? { tsconfig } : { tsconfigRaw: '{}' }),
    });
    code = result.outputFiles[0].text;
  } catch (e) {
    const errors = e && e.errors ? e.errors.map((x) => x.text).join('; ') : String(e);
    throw new Error(`${entryFile} does not bundle for a platform with no Node builtin: ${errors}`, {
      cause: e,
    });
  }
  const ctx = vm.createContext(webGlobals());
  for (const name of NODE_ONLY_GLOBALS) {
    if (vm.runInContext(`typeof ${name}`, ctx) !== 'undefined') {
      throw new Error(
        `the load context exposes ${name}: the control cannot detect a Node-only global`,
      );
    }
  }
  try {
    vm.runInContext(code, ctx);
  } catch (e) {
    throw new Error(
      `${entryFile} does not load with web globals only: ${e && e.message ? e.message : e}`,
      {
        cause: e,
      },
    );
  }
  return { exports: Object.keys(ctx.__entry) };
}

module.exports = {
  findBuiltinSpecifiers,
  loadWithoutNode,
  webGlobals,
  WEB_GLOBALS,
  NODE_ONLY_GLOBALS,
  NODE_SPECIFIER,
};
