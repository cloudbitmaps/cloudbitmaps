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
 * and random values, timers and `fetch` throw at global scope (a call inside a function is fine).
 *
 * Known limits. The tokenizer decides whether a `/` divides or opens a regular expression from the token before it;
 * a form it reads wrongly (an `if (x)` header followed by a regex literal) can hide a specifier after it. The set of
 * web globals is deliberately the common core of Workers, Deno and Vercel Edge; add one to `WEB_GLOBALS` when all
 * three have it. A builtin reached through `process.getBuiltinModule('fs')` (a bare name) inside a function is caught
 * by no layer: that is deliberate evasion, out of scope. The `.d.ts` tree is not checked for Node types. A load is
 * not a run: the check loads the entry, it does not execute the engine in an isolate.
 */
const vm = require('node:vm');
const ts = require('typescript');

/** A whole string value that is a `node:` specifier, with an optional subpath (`node:fs/promises`). */
const NODE_SPECIFIER = /^node:[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;

/**
 * Token kinds after which a `/` divides, so the scanner must not read a regular expression there. A `)` is taken as
 * the end of an expression (`(a + b) / c`), not of an `if (x)` header followed by a regex statement; a `}` as the
 * start of a statement, so a `/` after it opens a regex.
 */
const DIVIDES_AFTER = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

/**
 * Every string or substitution-free template literal in `source` whose WHOLE value is a `node:` specifier. Whole
 * value, not prefix: an error message that starts with `node:` or names `node:crypto` mid-sentence does not trip it,
 * and a specifier cannot dodge it. Deduplicated.
 *
 * The source is tokenized by TypeScript's scanner, which skips comments and tells a regular expression literal from
 * a division, so a quote inside a comment or a regex (`/(sig=["']?)/`) cannot pair with a later quote and hide the
 * strings after it. The one heuristic is whether a `/` divides or opens a regex (see {@link DIVIDES_AFTER}).
 */
function findBuiltinSpecifiers(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const found = new Set();
  // One entry per open `{`: true when it is a template substitution, whose `}` resumes the template.
  const braces = [];
  let previous = ts.SyntaxKind.Unknown;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
      !DIVIDES_AFTER.has(previous)
    ) {
      kind = scanner.reScanSlashToken();
    } else if (kind === ts.SyntaxKind.CloseBraceToken && braces.pop() === true) {
      kind = scanner.reScanTemplateToken(false);
    }
    if (kind === ts.SyntaxKind.TemplateHead) braces.push(true);
    else if (kind === ts.SyntaxKind.OpenBraceToken) braces.push(false);
    else if (kind === ts.SyntaxKind.TemplateMiddle) braces.push(true);
    if (
      (kind === ts.SyntaxKind.StringLiteral ||
        kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
      NODE_SPECIFIER.test(scanner.getTokenValue())
    ) {
      found.add(scanner.getTokenValue());
    }
    previous = kind;
  }
  return [...found];
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
 * module loads (global scope). `state.loading` is true during the load; the caller flips it off afterwards.
 */
function webGlobals(state = { loading: false }) {
  const globals = {};
  for (const name of WEB_GLOBALS) if (name in globalThis) globals[name] = globalThis[name];
  const guard = (name, fn) =>
    function guarded(...args) {
      if (state.loading) throw new Error(`${name} is not allowed in global scope`);
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
  try {
    vm.runInContext(code, ctx);
    state.loading = false;
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
