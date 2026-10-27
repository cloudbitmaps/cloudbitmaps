import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/*
 * Architectural lint, part 4: no error message under packages/<pkg>/src names a chunk key, a remainder, a stored
 * value or an id.
 *
 * SECURITY.md promises that errors never carry ids or bitmap contents. A chunk key is the high 16 bits of every id
 * the chunk holds and a remainder is the low 16 bits, so a message that interpolates either, or a value read out
 * of a bitmap, or an id, reaches logs and error trackers carrying part of what the bitmap holds. A message says
 * what is wrong and where by position or object instead (the n-th chunk of the object, the generation, the
 * segment's name), never the key, the value or the id.
 *
 * What it reads. Every `new XError(...)`, `XError(...)` or `new Error(...)` call whose name ends in `Error`, or is one of the HELPERS that build an error from a message: the
 * pieces of its first argument that are interpolated into the text (a template literal's spans, the operands of a
 * `+` chain). Each piece is reduced to its last name (`a.b.key` to `key`; `keys[i]` and `ids.at(-1)` to
 * `keys` and `ids`; `String(x)`, `Number(x)`, `x.toString()` and `x!` to `x`; a call of `minimum`, `maximum` or
 * `select` to `value`) and refused when that name is one of SENSITIVE below. It matches by NAME, so a variable named
 * for what it holds is what the gate sees: name an id `id`, a chunk key `chunkKey`, a stored value `value`.
 *
 * Known limits. It does not follow a message built in a variable first (`const m = ...; throw new E(m)`), a
 * message from a helper function, a value reached through a differently named
 * variable (`const n = chunkKey; ... ${n}`), a number formatted through a call it does not know (`fmt(k)`), a value held in a differently named variable
 * (`const max = bitmap.maximum(); ... ${max}`), or a
 * message passed through an `options.cause` object. It reads `.ts` files only, tests excluded. A sensitive name
 * that is not what it says (a storage object's `key`, a `value` that is a count) is renamed at the site, so the
 * gate keeps its pattern; a message that carries one on purpose is listed in ALLOWED with the reason, and the gate
 * fails when a listed entry no longer matches anything.
 *
 * The detector is a pure function so the test can plant a violation and watch it fire, and plant the look-alikes
 * that must not: sizes, counts, byte lengths, generation numbers, option names and limits.
 */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The bare names for a chunk key. They mean a chunk key only inside the engine (`packages/core/src/core/`); in a
 * driver, `key` is the storage object's or registry row's key, which names the segment and generation, so the
 * drivers are not held to them.
 */
const BARE_KEYS = new Set(['k', 'key', 'keys']);

const SENSITIVE = new Set([
  'chunkKey',
  'chunkKeys',
  'remainder',
  'remainders',
  'value',
  'values',
  'v',
  'id',
  'ids',
  'memberId',
  'last',
  'previous',
  'member',
  'members',
]);

/** Sites that carry one of the names on purpose: `file:snippet` -> why it is not an id or a bitmap's content. */
const ALLOWED: Record<string, string> = {
  'packages/core/src/drivers/crypto.ts|KEK':
    'the id is the operator-chosen name of a key-encryption key in the keystore, not an id from a bitmap',
};

export interface Finding {
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

/** The last name an interpolated expression reads, or undefined for a literal or a shape with none. */
function leafName(e: ts.Expression): string | undefined {
  let x: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)) {
      x = x.expression;
    } else if (
      ts.isCallExpression(x) &&
      ts.isIdentifier(x.expression) &&
      ['String', 'Number', 'BigInt'].includes(x.expression.text) &&
      x.arguments.length === 1
    ) {
      x = x.arguments[0]!;
    } else if (ts.isElementAccessExpression(x)) {
      x = x.expression;
    } else if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(x.expression) &&
      ['minimum', 'maximum', 'select'].includes(x.expression.name.text)
    ) {
      // A value read out of a bitmap.
      return 'value';
    } else if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(x.expression) &&
      ['toString', 'toFixed', 'toLocaleString', 'at'].includes(x.expression.name.text)
    ) {
      x = x.expression.expression;
    } else break;
  }
  if (ts.isIdentifier(x)) return x.text;
  if (ts.isPropertyAccessExpression(x)) return x.name.text;
  return undefined;
}

/** The expressions a message argument interpolates: template spans and the operands of a `+` chain. */
function pieces(arg: ts.Expression): ts.Expression[] {
  if (ts.isTemplateExpression(arg)) return arg.templateSpans.map((s) => s.expression);
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...pieces(arg.left), ...pieces(arg.right)];
  }
  if (ts.isStringLiteralLike(arg)) return [];
  return [arg];
}

/** Functions that build or throw an error from a message without `Error` in their name. */
const HELPERS = new Set(['crbmIntegrity', 'refuse', 'fail', 'unsettledConflict']);

const isErrorName = (e: ts.Expression): boolean => {
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
  return /Error$/.test(name) || HELPERS.has(name);
};

/** Every error message in `source` that interpolates a name in SENSITIVE. */
export function findValueInMessages(source: string, fileName = 'x.ts', bareKeys = true): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && isErrorName(n.expression)) {
      for (const first of n.arguments ?? []) {
        // A concatenation's string pieces are literals; only a bare operand is an interpolation.
        const parts =
          ts.isBinaryExpression(first) || ts.isTemplateExpression(first) ? pieces(first) : [];
        for (const p of parts) {
          const name = leafName(p);
          if (name !== undefined && (SENSITIVE.has(name) || (bareKeys && BARE_KEYS.has(name)))) {
            out.push({
              line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
              name,
              text: first.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('the error-message detector', () => {
  const caught: Array<[string, string]> = [
    ['template, chunk key', 'throw new IntegrityError(`chunk ${chunkKey} is corrupt`);'],
    ['template, short key', 'throw new IntegrityError(`chunk key is out of range: ${k}`);'],
    ['template, property', 'throw new IntegrityError(`answered chunk ${step.value.key}`);'],
    ['template, value', 'throw new ValidationError(`bad ${value}`);'],
    ['template, id', 'throw new ValidationError(`no such id ${id}`);'],
    ['template, ids', 'throw new ValidationError(`ids ${ids}`);'],
    ['template, remainder', 'throw new IntegrityError(`remainder ${remainder} is out of range`);'],
    ['template, wrapped in String', 'throw new IntegrityError(`chunk ${String(chunkKey)}`);'],
    ['template, toString', 'throw new IntegrityError(`chunk ${k.toString()}`);'],
    ['concatenation', "throw new IntegrityError('chunk ' + chunkKey + ' is corrupt');"],
    ['plain call', 'throw IntegrityError(`chunk ${chunkKey}`);'],
    ['plain Error', 'throw new Error(`value ${value}`);'],
    [
      'the listed-twice message as it was before it was reworded',
      'throw new IntegrityError(`chunk key from a tier is listed twice: ${keys[i]}`);',
    ],
    ['element access, by index', 'throw new IntegrityError(`bad ${ids[0]}`);'],
    ['element access, by variable', 'throw new IntegrityError(`bad ${values[slot]}`);'],
    ['.at() on a values list', 'throw new IntegrityError(`bad ${values.at(-1)}`);'],
    ['a bitmap extreme', 'throw new Error(`maximum ${bitmap.maximum()}`);'],
    ['a bitmap minimum', 'throw new Error(`minimum ${bitmap.minimum()}`);'],
    ['a bitmap select', 'throw new Error(`rank ${bitmap.select(3)}`);'],
    ['helper that builds an integrity error', 'throw crbmIntegrity(`chunk ${chunkKey} is bad`);'],
    ['method helper', 'throw this.refuse(needed, `chunk ${key}`);'],
    ['namespaced class', 'throw new errors.IntegrityError(`chunk ${chunkKey}`);'],
  ];

  it.each(caught)('catches %s', (_n, src) => {
    expect(findValueInMessages(src)).not.toEqual([]);
  });

  const quiet: Array<[string, string]> = [
    ['byte length', 'throw new IntegrityError(`bytes ${bytes.length}B exceeds cap ${maxBytes}B`);'],
    ['generation', 'throw new IntegrityError(`generation ${generation} is gone`);'],
    ['count', 'throw new ValidationError(`${count} chunks, at most ${limit}`);'],
    [
      'size and cardinality',
      'throw new IntegrityError(`holds ${size}, index says ${cardinality}`);',
    ],
    ['option name', 'throw new ValidationError(`${name} must be a boolean; got ${kindOf(v)}`);'],
    ['element of a count list', 'throw new IntegrityError(`${counts[i]} chunks`);'],
    ['element of a length list', 'throw new IntegrityError(`length ${lengths[slot]} invalid`);'],
    ['.at() on a count list', 'throw new IntegrityError(`${counts.at(-1)} chunks`);'],
    ['position', 'throw new IntegrityError(`the chunk at position ${index} is corrupt`);'],
    ['segment name', 'throw new NotFoundError(`segment ${ref.segment} has no row`);'],
    ['no interpolation', 'throw new IntegrityError("chunk key is out of range");'],
    ['not an error constructor', 'log(`chunk ${chunkKey}`);'],
    ['a message built elsewhere (a known limit)', 'throw new IntegrityError(message);'],
    [
      'a name that only contains a sensitive one',
      'throw new ValidationError(`${keyCount} ${valueBytes}`);',
    ],
  ];

  it.each(quiet)('stays quiet on %s', (_n, src) => {
    expect(findValueInMessages(src)).toEqual([]);
  });

  it('does not hold a driver to the bare key names, which there are storage keys', () => {
    expect(
      findValueInMessages(
        'throw new IntegrityError(`registry read failed: ${key}`);',
        'x.ts',
        false,
      ),
    ).toEqual([]);
    expect(
      findValueInMessages(
        'throw new IntegrityError(`registry read failed: ${key}`);',
        'x.ts',
        true,
      ),
    ).not.toEqual([]);
    expect(
      findValueInMessages('throw new IntegrityError(`chunk ${chunkKey}`);', 'x.ts', false),
    ).not.toEqual([]);
  });

  it('reports the line and the name', () => {
    const f = findValueInMessages('\n\nthrow new IntegrityError(`chunk ${chunkKey}`);');
    expect(f.map((x) => [x.line, x.name])).toEqual([[3, 'chunkKey']]);
  });
});

describe('error messages under packages/*/src', () => {
  const files = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      try {
        return sourceFiles(path.join(ROOT, 'packages', d.name, 'src'));
      } catch {
        return [];
      }
    });

  const found = files.flatMap((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    return findValueInMessages(
      readFileSync(file, 'utf8'),
      rel,
      rel.startsWith('packages/core/src/core/'),
    ).map((f) => `${rel}:${f.line} ${f.name}: ${f.text}`);
  });

  it('scans the source', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('carries no chunk key, remainder, stored value or id in any message', () => {
    const unlisted = found.filter(
      (f) =>
        !Object.keys(ALLOWED).some(
          (a) => f.startsWith(a.split('|')[0]!) && f.includes(a.split('|')[1] ?? ''),
        ),
    );
    expect(unlisted).toEqual([]);
  });

  it('lists no allowance that matches nothing', () => {
    const stale = Object.keys(ALLOWED).filter(
      (a) =>
        !found.some((f) => f.startsWith(a.split('|')[0]!) && f.includes(a.split('|')[1] ?? '')),
    );
    expect(stale).toEqual([]);
  });
});
