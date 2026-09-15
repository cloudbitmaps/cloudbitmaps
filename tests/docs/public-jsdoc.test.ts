import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
// It has now happened twice in this repo: once to `dropSegment` when `load`'s doc was added above it, and once
// to `generations` when `exists`/`segments` were added above it. The second time is the one that earns a check
// instead of more care.
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
