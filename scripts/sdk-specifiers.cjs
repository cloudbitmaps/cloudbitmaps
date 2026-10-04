'use strict';
/*
 * The detector behind the "main entry stays SDK-free" gate (hard invariant 7), kept separate from
 * `scripts/smoke.cjs` so it can be fired at planted inputs from `tests/arch`.
 *
 * That separation is this repo's own convention, and it exists because a detector nothing tests is a check
 * that cannot be trusted: as `tests/arch/import-boundaries.test.ts` puts it, a rule written wrong is a silent
 * gap, and `pnpm lint` passing proves nothing about a rule that never matched; `no-circular.test.ts` extracts
 * its detector for the same reason. A matcher that reads comments and looks for call positions has one false
 * positive and two false negatives, each described below beside the code that avoids it, and no suite would
 * notice any of them.
 */

/** The package roots a main entry must never name. `aws-sdk` is v2, which we do not peer on but do refuse. */
const SDK_ROOTS = ['@aws-sdk/', '@google-cloud/', '@azure/', 'aws-sdk'];

/**
 * Our OWN driver packages are forbidden from a main entry too, and for the same reason one hop removed.
 *
 * `@cloudbitmaps/s3` is left external by the bundler when imported from another package's entry, so no SDK
 * string ever appears, and a detector that looks only for SDK roots passes it cleanly. It is still a leak: a
 * consumer's bundler follows that specifier into the driver entry and hits `@aws-sdk/client-s3` there, which
 * is exactly the failure this gate exists to prevent. Naming a driver IS reaching an SDK.
 *
 * Two spellings are matched: a driver package (`@cloudbitmaps/s3`), and a driver's name as a subpath of one of
 * our packages (`@cloudbitmaps/core/s3`, `…/azure-blob`, or `…/azure`). The second costs nothing, and such an
 * import would reach an SDK the same way, so it is caught rather than left to pass as an unknown specifier.
 */
const DRIVER_SUBPATH =
  /^@cloudbitmaps\/(?:(s3|gcs|azure-blob)(\/|$)|[^/]+\/(s3|gcs|azure(?:-blob)?)(\/|$))/;

/**
 * Blank out comments while KEEPING string and template literals.
 *
 * This is what keeps out the false positive that matters. esbuild preserves JSDoc on class members, and
 * this repo deliberately documents invariant 7 *in prose, in the files it governs* — so without it a comment
 * reading `a driver takes its client from "@aws-sdk/client-s3"` in `dist/` trips the gate, with an error
 * asserting something false. The remedy a contributor reaches for is to water down the comment, which is
 * precisely the documentation erosion the gate exists to protect.
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
 * Matching the specifier itself rather than the syntax around it is both simpler and safer. A matcher of
 * positions — `require(`, `import(`, `from` — has two false negatives: the ESM side-effect form
 * `import "@aws-sdk/client-s3";` has none of those tokens, and `createRequire` hands back a function the
 * caller may name anything (`req(...)`), so no list of call shapes can be complete.
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
