'use strict';
/*
 * The one reader behind the specifier detectors (`sdk-specifiers.cjs`, `builtin-free.cjs`) and the module-graph walk
 * (`dts-specifiers.cjs`), so they cannot disagree about where a string or a comment begins.
 *
 * Pairing quotes with a regular expression goes wrong at a regular expression literal that holds a quote
 * (`/(sig=["']?)[^&"']*\/g`): the quote pairs with a later one, and every string after it is missed, which turns a
 * detector of `require('...')` in a function body green. Telling a regular expression from a division by the token
 * before a `/` goes wrong too, after any keyword-shaped name (`opts.type / 2`). So this reads the TypeScript parser's
 * tree: a string is a string-literal node, a comment is trivia the parser attached to a token, and nothing is guessed.
 * A 460 KB bundle parses in about 70 ms.
 */
const ts = require('typescript');

/** The parsed tree of `source`. `kind` is the script kind: `.js` for built files, `.ts` for declarations. */
function parse(source, kind = ts.ScriptKind.JS) {
  return ts.createSourceFile('input', source, ts.ScriptTarget.Latest, false, kind);
}

function visitNodes(root, visit) {
  const walk = (node) => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

/** The value of every string literal and substitution-free template literal in `source`, comments skipped. */
function stringLiterals(source) {
  const values = [];
  visitNodes(parse(source), (node) => {
    if (
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      values.push(node.text);
    }
  });
  return values;
}

/** The leading text of every template literal that has a substitution: `` `@aws-sdk/client-${svc}` `` gives `@aws-sdk/client-`. */
function templateHeads(source) {
  const values = [];
  visitNodes(parse(source), (node) => {
    if (node.kind === ts.SyntaxKind.TemplateExpression) values.push(node.head.text);
  });
  return values;
}

/** The `[pos, end)` of every comment in `source`: the trivia attached to each token, the end-of-file token included. */
function commentRanges(source, kind = ts.ScriptKind.TS) {
  const file = ts.createSourceFile('input', source, ts.ScriptTarget.Latest, false, kind);
  const ranges = new Map();
  const addAt = (pos) => {
    for (const r of [
      ...(ts.getLeadingCommentRanges(source, pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, pos) ?? []),
    ]) {
      ranges.set(r.pos, r.end);
    }
  };
  const walk = (node) => {
    // A JSDoc node lies inside a comment already found as trivia, and scanning from inside one would invent comments.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(file);
    if (children.length === 0) addAt(node.pos);
    else for (const child of children) walk(child);
  };
  walk(file);
  return [...ranges].map(([pos, end]) => ({ pos, end }));
}

/**
 * `source` with every comment replaced by spaces of the same length, newlines kept, so an offset found in the result
 * is an offset in the original and line numbers survive. Strings, templates and regular expressions are untouched.
 */
function blankComments(source, kind = ts.ScriptKind.TS) {
  let out = '';
  let at = 0;
  for (const { pos, end } of commentRanges(source, kind).sort((a, b) => a.pos - b.pos)) {
    if (pos < at) continue;
    out += source.slice(at, pos) + source.slice(pos, end).replace(/[^\n]/g, ' ');
    at = end;
  }
  return out + source.slice(at);
}

module.exports = { parse, stringLiterals, templateHeads, commentRanges, blankComments };
