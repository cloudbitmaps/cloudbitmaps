'use strict';
/*
 * The detector behind the "every relative specifier in an emitted .d.ts carries an extension" gate, kept
 * separate from `scripts/build.mjs` and `scripts/smoke.cjs` so BOTH import the one copy and so it can be
 * fired at planted inputs from `tests/arch`.
 *
 * Two files consume it and they must never disagree. The build REWRITES (`rewriteSpecifiers`) and the smoke
 * test DETECTS (`findSpecifiers`); a second hand-maintained regex in the other file would be a gate that
 * stops matching what the build stops fixing, with nothing to notice. Both are therefore one scanner.
 *
 * WHY THE GATE EXISTS. `tsc` emits `from './core/engine'`. Under `moduleResolution: node16`/`nodenext` that
 * is TS2834, and the failure is silent: the near-universal `skipLibCheck: true` suppresses it, TypeScript
 * cannot resolve the module, and every type reached through that specifier degrades to `any` — no
 * diagnostic, no autocomplete, and none of the compile-time guards meant to refuse a bad wiring. Since an
 * entry re-exports nearly everything, that is nearly the whole published surface.
 *
 * The convention of extracting a detector is this repo's own: `tests/arch/import-boundaries.test.ts` says a
 * rule mistranslated during a move "would be a silent gap — `pnpm lint` passing proves nothing about a rule
 * that never matched", and `scripts/sdk-specifiers.cjs` / `no-circular.test.ts` are extracted for the same
 * reason. An adversarial review of THIS matcher's first draft — a bare regex inlined in both files — found
 * one false positive and four false negatives, none of which any suite would have caught, because the gate
 * was green either way.
 */

/**
 * Blank comments to same-length whitespace, KEEPING string and template literals.
 *
 * Two jobs at once. Comments must not be scanned: tsc preserves JSDoc into the `.d.ts` (70 of core's 71
 * declaration files carry a `/**`), so a doc-comment showing `import { X } from './my-app/wiring'` would
 * both trip the gate with an error asserting something false AND get silently rewritten by the build,
 * editing published documentation. That is the identical false positive the SDK gate hit and documented —
 * and the remedy a contributor reaches for is to water the comment down, which is the erosion these gates
 * exist to prevent.
 *
 * Same-LENGTH (rather than `sdk-specifiers.cjs`'s single space) because this scanner's callers rewrite the
 * ORIGINAL source at the offsets found here; collapsing a comment would shift every offset after it.
 * Newlines are kept so line numbers survive too.
 *
 * Strings are kept because a real specifier IS a string literal; comments are the only place prose lives.
 *
 * That last clause is a generalisation, and here is its one hole: a string literal TYPE whose value happens
 * to be prose about an import — `export type Doc = "import { X } from './wiring'"` — is scanned like code,
 * so the build would edit inside the string and the gate would flag it. No such declaration exists, and the
 * alternative (a full parse) is not worth it for a contrived case, but the assumption is not absolute.
 */
function blankComments(source) {
  return source.replace(
    /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) =>
      match[0] === '"' || match[0] === "'" || match[0] === '`'
        ? match
        : match.replace(/[^\n]/g, ' '),
  );
}

/**
 * Every syntactic position a `.d.ts` can name a relative module from.
 *
 * `from` alone covers `import … from`, `export … from`, `export * from` and `export * as ns from`; `import`
 * covers the side-effect form, the dynamic/type form `import('./x').Foo`, and the leading half of
 * `import X = require('./x')`; `require` covers that form's tail, which the first draft missed entirely
 * (legal in a `.d.ts`, needs the extension exactly like `from`, and appears the moment anyone writes an
 * `export =` interop shim); `declare module` covers augmenting a relative module.
 *
 * `\b` before `require` is what keeps `createRequire` out. The optional `\(?` is shared by the call forms.
 *
 * Deliberately NOT covered: `/// <reference path="./x" />`. That is not a module specifier — TypeScript
 * resolves a reference path as a FILE path and appends the extension itself, so it works extensionless
 * under nodenext (verified) and adding it here would only create false positives.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire|\bdeclare\s+module)\s*\(?\s*(['"])(\.[^'"]*)\1/g;

/** A specifier that already names a module file. `.json` is extensioned, so out of this gate's scope. */
const EXTENSIONED = /\.[cm]?js$|\.json$/;

/**
 * Scan `source` for relative specifiers, skipping comments. Yields the specifier plus the offsets of the
 * quoted text inside the ORIGINAL source, so a caller can rewrite in place.
 */
function* scanSpecifiers(source) {
  const code = blankComments(source);
  for (const m of code.matchAll(SPECIFIER)) {
    const start = m.index + m[0].length - m[2].length - 1; // just past the opening quote
    yield { specifier: m[2], start, end: start + m[2].length };
  }
}

/** The relative specifiers in `source` that carry no extension — i.e. the gate's failures. */
function findSpecifiers(source) {
  const out = [];
  for (const { specifier } of scanSpecifiers(source)) {
    if (!EXTENSIONED.test(specifier)) out.push(specifier);
  }
  return out;
}

/** Every relative specifier in `source`, extensioned or not — for checking that each one resolves. */
function allSpecifiers(source) {
  return [...scanSpecifiers(source)].map((s) => s.specifier);
}

/**
 * Rewrite each extensionless relative specifier through `fix`, which returns the replacement or `null` to
 * leave it alone. Applied back-to-front so earlier offsets stay valid.
 */
function rewriteSpecifiers(source, fix) {
  const edits = [];
  for (const hit of scanSpecifiers(source)) {
    if (EXTENSIONED.test(hit.specifier)) continue;
    const fixed = fix(hit.specifier);
    if (fixed != null) edits.push({ ...hit, fixed });
  }
  let text = source;
  for (const e of edits.reverse()) text = text.slice(0, e.start) + e.fixed + text.slice(e.end);
  return { text, count: edits.length };
}

module.exports = {
  blankComments,
  scanSpecifiers,
  findSpecifiers,
  allSpecifiers,
  rewriteSpecifiers,
  SPECIFIER,
  EXTENSIONED,
};
