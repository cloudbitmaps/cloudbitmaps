'use strict';
/*
 * The one scanner behind the specifier detectors (`sdk-specifiers.cjs`, `builtin-free.cjs`), so they cannot disagree
 * about where a string or a comment begins.
 *
 * Pairing quotes with a regular expression goes wrong at a regular expression literal that holds a quote
 * (`/(sig=["']?)[^&"']*\/g`): the quote pairs with a later one, and every string after it is missed, which turns a
 * detector of `require('...')` in a function body green. TypeScript's scanner tells a regex literal from a division
 * and skips comments properly, so both detectors read tokens.
 *
 * The one heuristic is whether a `/` divides or opens a regular expression, read from the token before it (see
 * DIVIDES_AFTER). A form it reads wrongly (an `if (x)` header followed by a regex literal) can hide a specifier
 * after it.
 */
const ts = require('typescript');

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

const TRIVIA = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

/**
 * Calls `visit(kind, scanner)` for each token of `source`, regex literals and template parts resolved. With
 * `trivia` set, whitespace and comments are visited too.
 */
function walkTokens(source, visit, { trivia = false } = {}) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    !trivia,
    ts.LanguageVariant.Standard,
    source,
  );
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
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle)
      braces.push(true);
    else if (kind === ts.SyntaxKind.OpenBraceToken) braces.push(false);
    visit(kind, scanner);
    if (!TRIVIA.has(kind)) previous = kind;
  }
}

/** The value of every string literal and substitution-free template literal in `source`, comments skipped. */
function stringLiterals(source) {
  const values = [];
  walkTokens(source, (kind, scanner) => {
    if (
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      values.push(scanner.getTokenValue());
    }
  });
  return values;
}

/** `source` with each comment replaced by one space, and every string, template and regex kept as written. */
function stripComments(source) {
  let out = '';
  walkTokens(
    source,
    (kind, scanner) => {
      out +=
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
          ? ' '
          : scanner.getTokenText();
    },
    { trivia: true },
  );
  return out;
}

module.exports = { walkTokens, stringLiterals, stripComments, DIVIDES_AFTER };
