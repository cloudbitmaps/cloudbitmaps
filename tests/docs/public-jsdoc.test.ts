import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Every public method on the facade must carry its own JSDoc — and this gate exists because the way it gets
// lost is invisible.
//
// Inserting a new method's doc block between an EXISTING doc block and the member it documents silently
// reassigns it: TypeScript binds a doc comment to the declaration that follows it, so the old member ends up
// with none. Nothing catches that. Lint does not, prettier does not, `tsc` does not, and no test does — the
// code is still correct, so the only symptom is a shipped verb that lost its hover text and its entry in the
// published `.d.ts`.
//
// Adding a method above an existing one is an ordinary edit, so this is the likely accident rather than an
// exotic one, and it earns a check instead of more care.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FACADE = join(ROOT, 'packages/roaring/src/index.ts');

/** Members that are deliberately self-explanatory, or documented on the interface they implement. */
const EXEMPT = new Set(['constructor', Symbol.asyncIterator.toString(), '[Symbol.asyncIterator]']);

interface Undocumented {
  readonly cls: string;
  readonly member: string;
}

function undocumentedPublicMembers(): Undocumented[] {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(FACADE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: Undocumented[] = [];

  const isPublic = (node: ts.MethodDeclaration): boolean => {
    const mods = ts.getModifiers(node) ?? [];
    return !mods.some(
      (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  };

  const walk = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const cls = node.name.getText();
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
        if (!isPublic(member)) continue;
        const name = member.name.getText();
        if (EXEMPT.has(name) || name.startsWith('#')) continue;
        if ((ts.getJSDocCommentsAndTags(member) ?? []).length === 0)
          out.push({ cls, member: name });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

describe('the public facade keeps its documentation', () => {
  it('every public method has a JSDoc block bound to it', () => {
    const missing = undocumentedPublicMembers().map((m) => `${m.cls}.${m.member}`);
    expect(
      missing,
      'public method(s) with no JSDoc — most likely a new doc block was inserted between an existing ' +
        'comment and the member it documented, which silently reassigns it',
    ).toEqual([]);
  });

  it('is not vacuous — it actually finds the facade methods it is checking', () => {
    const source = ts.createSourceFile(
      'index.ts',
      readFileSync(FACADE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let documented = 0;
    const walk = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && (ts.getJSDocCommentsAndTags(node) ?? []).length > 0) {
        documented++;
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    // If a refactor ever makes this parser stop seeing methods, the first test would pass trivially.
    expect(documented).toBeGreaterThan(20);
  });
});

// The same accident anywhere in the packages: a doc block left above another one documents nothing. TypeScript hands
// every doc block before a declaration to that declaration and reads only the last, so the first is lost, and when it
// was the declaration's own (an export's `@deprecated` included) the published `.d.ts` loses it too. A file's opening
// comment followed by its first declaration's is the one legitimate pair.

/** Every `.ts` file under `packages/<name>/src`. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    const src = join(ROOT, 'packages', pkg.name, 'src');
    if (pkg.isDirectory() && existsSync(src)) walkDir(src);
  }
  return out;
}

/**
 * `file:line` of every doc block that stands directly above another, and how many doc blocks there are in all. Read
 * from each node's leading comments: `getJSDocCommentsAndTags` reports only the block TypeScript keeps, the last.
 */
function doubleDocumented(): { found: string[]; documented: number } {
  const found: string[] = [];
  let documented = 0;
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const seen = new Set<number>();
    const walk = (node: ts.Node): void => {
      const at = node.getFullStart();
      if (!seen.has(at)) {
        seen.add(at);
        const blocks = (ts.getLeadingCommentRanges(text, at) ?? []).filter(
          (c) => c.kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**', c.pos),
        );
        documented += blocks.length;
        // The file's opening comment stands before its first declaration's; it is the one block that may.
        const opening =
          blocks[0] !== undefined && text.slice(0, blocks[0].pos).trim() === '' ? 1 : 0;
        if (blocks.length - opening > 1) {
          const { line } = source.getLineAndCharacterOfPosition(blocks[opening]!.pos);
          found.push(`${relative(ROOT, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { found, documented };
}

describe('no doc block is left above another', () => {
  it('every declaration in the packages carries one doc block, its own', () => {
    expect(
      doubleDocumented().found,
      'a doc block followed by another one: the first documents nothing. Move it to the declaration it describes, ' +
        'or delete it if that declaration has its own',
    ).toEqual([]);
  });

  it('is not vacuous — it reads the documented declarations of every package', () => {
    expect(doubleDocumented().documented).toBeGreaterThan(1000);
  });
});
