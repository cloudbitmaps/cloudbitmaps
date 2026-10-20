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
 * The load context also follows two rules Cloudflare documents for a Workers isolate: string code generation is off,
 * and random values, timers and `fetch` throw at global scope, including in a promise callback the load queues (a call
 * inside a function is fine).
 *
 * Known limits. The specifiers are read from the parser's tree (`js-tokens.cjs`), so nothing is guessed. The set of
 * web globals is deliberately the common core of Workers, Deno and Vercel Edge; add one to `WEB_GLOBALS` when all
 * three have it. A builtin reached through `process.getBuiltinModule('fs')` (a bare name) inside a function is caught
 * by no layer: that is deliberate evasion, out of scope. The `.d.ts` tree is not checked for Node types. A load is
 * not a run: the check loads the entry, it does not execute the engine in an isolate.
 */
const vm = require('node:vm');
const timers = require('node:timers');
const { stringLiterals } = require('./js-tokens.cjs');

/** A whole string value that is a `node:` specifier, with an optional subpath (`node:fs/promises`). */
const NODE_SPECIFIER = /^node:[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;

/**
 * Every string or substitution-free template literal in `source` whose WHOLE value is a `node:` specifier. Whole
 * value, not prefix: an error message that starts with `node:` or names `node:crypto` mid-sentence does not trip it,
 * and a specifier cannot dodge it. Deduplicated. Read from tokens (see `js-tokens.cjs`), so a quote in a comment or a
 * regular expression cannot pair with a later one and hide the strings after it.
 */
function findBuiltinSpecifiers(source) {
  return [...new Set(stringLiterals(source).filter((value) => NODE_SPECIFIER.test(value)))];
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
  'navigator',
  'CompressionStream',
  'DecompressionStream',
  'TextEncoderStream',
  'TextDecoderStream',
  'FormData',
  'File',
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

/**
 * The globals object of a context holding only {@link WEB_GLOBALS}, copied from the host, with the Workers rule that
 * `crypto.getRandomValues`, `crypto.randomUUID`, `setTimeout`, `setInterval` and `fetch` throw when called while the
 * module loads (global scope). `state.loading` is true during the load and the microtasks it queues; the caller flips
 * it off afterwards. A refused call is also recorded in `state.violation`, because a throw inside a promise callback
 * would otherwise reject a promise nobody reads.
 */
function webGlobals(state = { loading: false }) {
  const globals = {};
  for (const name of WEB_GLOBALS) if (name in globalThis) globals[name] = globalThis[name];
  const guard = (name, fn) =>
    function guarded(...args) {
      if (state.loading) {
        state.violation ??= `${name} is not allowed in global scope`;
        throw new Error(`${name} is not allowed in global scope`);
      }
      return fn.apply(this, args);
    };
  for (const name of ['setTimeout', 'setInterval', 'fetch']) {
    if (typeof globals[name] === 'function') globals[name] = guard(name, globals[name]);
  }
  if (globals.crypto) {
    const real = globals.crypto;
    globals.crypto = {
      subtle: real.subtle,
      getRandomValues: guard('crypto.getRandomValues', (a) => real.getRandomValues(a)),
      randomUUID: guard('crypto.randomUUID', () => real.randomUUID()),
    };
  }
  return globals;
}

/**
 * Bundle `entryFile` for `platform: 'neutral'` (no builtin resolves) and evaluate it in a context with web globals
 * only. Resolves `{ exports, entry }`, the entry's export names and its exports object (callable once the load is
 * over), or rejects with an error naming the entry and the cause.
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
  // A Workers isolate refuses string code generation (`eval`, `new Function`) and the global-scope calls guarded in
  // `webGlobals`, so the load runs under both.
  const state = { loading: true };
  const ctx = vm.createContext(webGlobals(state), { codeGeneration: { strings: false } });
  vm.runInContext('globalThis.self = globalThis', ctx);
  for (const name of NODE_ONLY_GLOBALS) {
    if (vm.runInContext(`typeof ${name}`, ctx) !== 'undefined') {
      throw new Error(
        `the load context exposes ${name}: the control cannot detect a Node-only global`,
      );
    }
  }
  // A rejection inside the context is read through `state.violation`, so keep Node from treating it as a crash.
  const ignore = () => {};
  process.on('unhandledRejection', ignore);
  try {
    vm.runInContext(code, ctx);
    // The guard stays on until the promise callbacks the load queued have run: a Workers startup runs them too.
    await new Promise((resolve) => timers.setImmediate(resolve));
    if (state.violation) throw new Error(state.violation);
    state.loading = false;
  } catch (e) {
    throw new Error(
      `${entryFile} does not load with web globals only: ${e && e.message ? e.message : e}`,
      {
        cause: e,
      },
    );
  } finally {
    process.off('unhandledRejection', ignore);
    state.loading = false;
  }
  return { exports: Object.keys(ctx.__entry), entry: ctx.__entry };
}

module.exports = {
  findBuiltinSpecifiers,
  loadWithoutNode,
  webGlobals,
  WEB_GLOBALS,
  NODE_ONLY_GLOBALS,
  NODE_SPECIFIER,
};
