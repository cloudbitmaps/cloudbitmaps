'use strict';
/*
 * The detector behind the "main entry stays SDK-free" gate (hard invariant 7), kept separate from
 * `scripts/smoke.cjs` so it can be fired at planted inputs from `tests/arch`.
 *
 * That separation is this repo's own convention, and it exists because a detector nothing tests is a check
 * that cannot be trusted: `tests/arch/import-boundaries.test.ts` says a rule mistranslated during a move
 * "would be a silent gap — `pnpm lint` passing proves nothing about a rule that never matched", and
 * `no-circular.test.ts` extracts its detector for the same reason. An adversarial review of the first draft
 * of this matcher found one false positive and two false negatives in twenty minutes, none of which any
 * suite would have noticed.
 */

/** The package roots a main entry must never name. `aws-sdk` is v2, which we do not peer on but do refuse. */
const SDK_ROOTS = ['@aws-sdk/', '@google-cloud/', '@azure/', 'aws-sdk'];

/**
 * Our OWN driver subpaths are forbidden from a main entry too, and for the same reason one hop removed.
 *
 * `@cloudbitmaps/core/s3` is left external by the bundler when imported from core's own entry, so no SDK
 * string ever appears — the first version of this detector passed it cleanly. It is still a leak: a
 * consumer's bundler follows that specifier into the driver entry and hits `@aws-sdk/client-s3` there, which
 * is exactly the failure this gate exists to prevent. Naming a driver IS reaching an SDK.
 */
const DRIVER_SUBPATH = /^@cloudbitmaps\/[^/]+\/(s3|gcs|azure)(\/|$)/;

/**
 * Blank out comments while KEEPING string and template literals.
 *
 * This is the fix for the one false positive that mattered. esbuild preserves JSDoc on class members, and
 * this repo deliberately documents invariant 7 *in prose, in the files it governs* — so a comment reading
 * `a driver takes its client from "@aws-sdk/client-s3"` shipped in `dist/` and tripped the gate, with an
 * error asserting something false. The remedy a contributor reaches for is to water down the comment, which
 * is precisely the documentation erosion the gate exists to protect.
 *
 * Strings are kept because a real specifier IS a string literal; comments are the only place prose lives.
 */
function stripComments(source) {
  return source.replace(
    /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match[0] === '"' || match[0] === "'" || match[0] === '`' ? match : ' '),
  );
}

/**
 * A string literal whose value BEGINS with one of those roots.
 *
 * Matching the specifier itself rather than the syntax around it is both simpler and safer. The first draft
 * matched positions — `require(`, `import(`, `from` — and an adversarial review walked past it twice: the
 * ESM side-effect form `import "@aws-sdk/client-s3";` has none of those tokens, and `createRequire` hands
 * back a function the caller may name anything (`req(...)`), so no list of call shapes can be complete.
 *
 * "Begins with" is what keeps it honest in the other direction: a *specifier* starts with the package name,
 * while prose that merely mentions one ("install @aws-sdk/client-s3 to use S3") does not — so an error
 * message naming the package a user must install does not trip the gate, and a real import cannot avoid it.
 *
 * Deliberately out of scope: a specifier built by concatenation. A bundler cannot resolve that either, so it
 * breaks a consumer's build for a different reason and is not the leak this guards.
 */
function findSdkSpecifiers(source) {
  const code = stripComments(source);
  const literals = code.match(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g) ?? [];
  const found = literals
    .map((lit) => lit.slice(1, -1))
    .filter(
      (value) =>
        SDK_ROOTS.some((root) => value === root || value.startsWith(root)) ||
        DRIVER_SUBPATH.test(value),
    );
  return [...new Set(found)];
}

module.exports = { findSdkSpecifiers, stripComments, SDK_ROOTS, DRIVER_SUBPATH };
