#!/usr/bin/env node
'use strict';
/*
 * Function-length gate: no function in `packages/*` `/src` is longer than 100 code lines, and the functions that
 * already are can only get shorter.
 *
 * WHAT IS COUNTED
 *   The lines a function spans, first to last, minus blank lines and lines that hold only a comment. This is the
 *   count ESLint's `max-lines-per-function` makes with `skipBlankLines` and `skipComments`. A nested function's
 *   lines count toward every function around it, and each function is measured on its own as well, so a long
 *   `describe` callback and the function that registers it are both over the limit when both are.
 *
 * THE RATCHET
 *   `scripts/function-length-baseline.json` records every function over the limit today, with its size. The gate
 *   fails when
 *     1. a function that is not in the baseline is over the limit;
 *     2. a baselined function is longer than its recorded size;
 *     3. a baselined function is shorter than its recorded size (including one now at or under the limit), so
 *        the baseline has to follow it down, or lose the entry once the function is at or under the limit;
 *     4. a baseline entry names a function that no longer exists, so a rename or a delete is recorded too.
 *   `--update` rewrites the baseline for case 3 and 4 only. It never records a growth or a new offender: those
 *   are fixed in the code, not in the baseline.
 *
 * HOW A FUNCTION IS IDENTIFIED
 *   `<file>::<outer> > <inner> > ...`, each part naming one enclosing function or class: a declaration's name, a
 *   method's or property's name, the variable an arrow is assigned to, or, for a callback, the call it is passed
 *   to with that call's leading string argument (`describe('reads') callback`). The line number is not part of
 *   the identity, so moving a function, or adding code above it, changes nothing. Two functions with the same
 *   identity under the same parent get `#2`, `#3`, ... in source order.
 *
 * KNOWN LIMITS
 *   - Renaming a baselined function (or the string a callback's call is given, or its enclosing function) changes
 *     its identity: the gate then reports a missing baseline entry and a new offender, and the fix is to rename
 *     the entry too (`--update` removes the stale one; the renamed function must be shrunk or re-added by hand).
 *   - Adding or removing an earlier anonymous callback with the same identity under the same parent renumbers the
 *     later ones (`#2` becomes `#1`).
 *   - Only `packages/*` `/src` is checked: not `tests/`, `scripts/`, `bench/` or `fuzz/`.
 *   - Lines are counted, not complexity: a 100-line function of one long expression passes, and 100 lines
 *     packed into a few very long ones pass too. A long object literal or table that is not inside a function
 *     is not a function and is never counted.
 *   - A file that does not parse fails the gate with the parser's message.
 *
 * Usage:
 *   node scripts/function-length.cjs             check (what `pnpm lint` runs)
 *   node scripts/function-length.cjs --update    lower or drop baseline entries that went down or away
 *   node scripts/function-length.cjs --list      print every function over the limit, as the baseline records it
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { ESLint } = require('eslint');
const tsParser = require('@typescript-eslint/parser');

const ROOT = resolve(__dirname, '..');
const LIMIT = 100;
const BASELINE_PATH = resolve(__dirname, 'function-length-baseline.json');
const GLOBS = ['packages/*/src/**/*.{ts,mts,cts,tsx}'];
const RULE_NAME = 'function-length/measure';

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
const CLASS_NODES = new Set(['ClassDeclaration', 'ClassExpression']);

function dottedName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const object = dottedName(node.object);
    return object === null ? null : `${object}.${node.property.name}`;
  }
  return null;
}

function propertyName(key, computed) {
  if (computed) return '[computed]';
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return '[computed]';
}

function truncate(text) {
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** The name one function or class goes by inside its parent, before any `#n` suffix. */
function ownLabel(node) {
  if (node.type === 'FunctionDeclaration') return node.id ? node.id.name : '<default>';
  if (CLASS_NODES.has(node.type)) return `class ${node.id ? node.id.name : '<anonymous>'}`;
  if (node.type === 'FunctionExpression' && node.id) return node.id.name;
  const parent = node.parent;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name;
  if (
    parent.type === 'Property' ||
    parent.type === 'MethodDefinition' ||
    parent.type === 'PropertyDefinition'
  ) {
    if (parent.value === node) return propertyName(parent.key, parent.computed);
  }
  if (parent.type === 'AssignmentExpression' && parent.right === node)
    return dottedName(parent.left) ?? '<assigned>';
  if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
    const callee = dottedName(parent.callee) ?? '<call>';
    const first = parent.arguments[0];
    const label =
      first !== node && first.type === 'Literal' && typeof first.value === 'string'
        ? `${callee}(${JSON.stringify(truncate(first.value))})`
        : callee;
    return `${label} callback`;
  }
  return '<anonymous>';
}

/** An ESLint rule that reports `{key, lines}` for every function, as JSON in the message. */
const measureRule = {
  meta: { type: 'problem', schema: [], messages: { measured: '{{json}}' } },
  create(context) {
    const sourceCode = context.sourceCode;
    const lines = sourceCode.lines;
    const commentOnly = new Set();
    for (const comment of sourceCode.getAllComments()) {
      const first = comment.loc.start.line;
      const last = comment.loc.end.line;
      for (let line = first; line <= last; line += 1) {
        const text = lines[line - 1];
        const from = line === first ? comment.loc.start.column : 0;
        const to = line === last ? comment.loc.end.column : text.length;
        if (text.slice(0, from).trim() === '' && text.slice(to).trim() === '')
          commentOnly.add(line);
      }
    }
    const keys = new WeakMap();
    const seen = new Map();

    function keyOf(node) {
      let parentKey = '';
      for (let up = node.parent; up !== null && up !== undefined; up = up.parent) {
        if (keys.has(up)) {
          parentKey = keys.get(up);
          break;
        }
      }
      const label = ownLabel(node);
      const bucket = `${parentKey}\u0000${label}`;
      const ordinal = (seen.get(bucket) ?? 0) + 1;
      seen.set(bucket, ordinal);
      const own = ordinal === 1 ? label : `${label} #${ordinal}`;
      const key = parentKey === '' ? own : `${parentKey} > ${own}`;
      keys.set(node, key);
      return key;
    }

    function measure(node) {
      const key = keyOf(node);
      let count = 0;
      for (let line = node.loc.start.line; line <= node.loc.end.line; line += 1) {
        if (lines[line - 1].trim() !== '' && !commentOnly.has(line)) count += 1;
      }
      context.report({
        node,
        messageId: 'measured',
        data: { json: JSON.stringify({ key, lines: count }) },
      });
    }

    const handlers = {};
    for (const type of FUNCTION_NODES) handlers[type] = measure;
    for (const type of CLASS_NODES) handlers[type] = keyOf;
    return handlers;
  },
};

/**
 * Measure every function under `root` that matches `globs`. Returns `Map<key, lines>` for functions over `limit`
 * (default 100) only, where `key` is `<relative file>::<identity>`. Throws on a file that does not parse.
 */
async function scan({ root = ROOT, globs = GLOBS, limit = LIMIT } = {}) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ['**/*.{ts,mts,cts,tsx}'],
        languageOptions: { parser: tsParser },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        plugins: { 'function-length': { rules: { measure: measureRule } } },
        rules: { [RULE_NAME]: 'error' },
      },
    ],
  });
  const results = await eslint.lintFiles(globs);
  const over = new Map();
  for (const result of results) {
    const file = result.filePath
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    for (const message of result.messages) {
      if (message.ruleId !== RULE_NAME) throw new Error(`${file}: ${message.message}`);
      const { key, lines } = JSON.parse(message.message);
      if (lines > limit) over.set(`${file}::${key}`, lines);
    }
  }
  return over;
}

/**
 * Compare what `scan` found with the baseline (`{key: lines}`). Returns `{problems, lowered}`: `problems` are
 * the failures, each a sentence, and `lowered` is the baseline as `--update` would write it (entries that only
 * went down or away), valid to write only when every problem is a case it fixes.
 */
function compare(found, baseline, limit = LIMIT) {
  const problems = [];
  const fixable = [];
  const lowered = {};
  for (const [key, lines] of found) {
    const recorded = baseline[key];
    if (recorded === undefined) {
      problems.push(
        `${key}: ${lines} lines, over the ${limit}-line limit and not in the baseline. Split it.`,
      );
    } else if (lines > recorded) {
      problems.push(
        `${key}: grew from ${recorded} to ${lines} lines. A baselined function may only get shorter.`,
      );
    } else if (lines < recorded) {
      fixable.push(
        `${key}: shrank from ${recorded} to ${lines} lines; lower its baseline entry (pnpm lint:fn-length --update).`,
      );
      lowered[key] = lines;
    } else {
      lowered[key] = lines;
    }
  }
  for (const [key, recorded] of Object.entries(baseline)) {
    if (found.has(key)) continue;
    fixable.push(
      `${key}: baselined at ${recorded} lines but now at or under ${limit}, or renamed or gone; remove its baseline entry (pnpm lint:fn-length --update).`,
    );
  }
  return { problems, fixable, lowered };
}

function readBaseline(path = BASELINE_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.limit !== LIMIT) throw new Error(`${path}: "limit" must be ${LIMIT}`);
  return parsed.functions;
}

function render(functions) {
  const sorted = Object.fromEntries(
    Object.entries(functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ limit: LIMIT, functions: sorted }, null, 2)}\n`;
}

async function main(argv) {
  const found = await scan();
  if (argv.includes('--list')) {
    process.stdout.write(render(Object.fromEntries(found)));
    return 0;
  }
  const baseline = readBaseline();
  const { problems, fixable, lowered } = compare(found, baseline);
  if (argv.includes('--update')) {
    if (problems.length > 0) {
      process.stderr.write(
        `${problems.join('\n')}\nfunction-length: --update does not record growth or a new offender.\n`,
      );
      return 1;
    }
    writeFileSync(BASELINE_PATH, render(lowered));
    process.stdout.write(
      `function-length: baseline updated (${Object.keys(lowered).length} entries).\n`,
    );
    return 0;
  }
  const all = [...problems, ...fixable];
  if (all.length > 0) {
    process.stderr.write(
      `${all.join('\n')}\nfunction-length: ${all.length} problem(s). See the header of scripts/function-length.cjs.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `function-length: ok (${found.size} baselined over ${LIMIT} lines, none new, none grown).\n`,
  );
  return 0;
}

module.exports = { scan, compare, render, LIMIT };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`function-length: ${error.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
