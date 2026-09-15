import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSegmentRef } from '@/index';

// The name grammar is written down in prose in several places, and prose does not compile. This gate makes
// every restatement of it agree with the code.
//
// It exists because the surface drifted TWICE. First the retention docs published dated-bucket examples —
// `store.segment('active:2026-08-01')`, `sent:daily:${day}` — across the guide, PRIVACY.md and the website,
// and every one of them THREW: they were written, reviewed, formatted, gate-passed and merged without once
// being executed, because prose in a fenced block is not run by anything. Then widening the grammar to allow
// the colon fixed the guide and left the website still publishing the old regex and the old prohibition,
// found only by a reviewer reading every file by hand. The second drift is the one that earns a gate.
//
// Two independent claims are checked, because the first sin was an example and the second was a regex:
//   1. every regex literal that LOOKS like the name grammar equals the real one, and
//   2. every segment/namespace name that documentation shows in a fenced example actually validates.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// `String(NAME)` is not reachable from outside `validate.ts` on purpose — an exported regex is a compatibility
// surface for zero benefit. So the gate derives the source of truth the way a reader would: from the error
// message, which interpolates the live pattern and is therefore the one statement that cannot drift.
function liveGrammar(): string {
  try {
    validateSegmentRef({ segment: '!' });
  } catch (err) {
    const m = /(\/\^\[A-Za-z0-9\]\[[^/]*\/)/.exec((err as Error).message);
    if (m?.[1] !== undefined) return m[1];
  }
  throw new Error('could not recover the live name grammar from the validator');
}

const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', 'build', '.worktrees', 'golden']);
const DOC_EXTS = ['.md', '.html'];

function docFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      if (SKIP.has(entry)) continue;
      const child = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (DOC_EXTS.some((e) => entry.endsWith(e))) out.push(child);
    }
  };
  walk('.');
  return out;
}

// `CHANGELOG.md` is a historical record: an entry describing what the grammar was in 0.4.0 is correct
// precisely because it does NOT track the current one.
const HISTORICAL = new Set(['CHANGELOG.md']);

describe('documented name grammar matches the code', () => {
  const GRAMMAR_SHAPED = /\/\^\[A-Za-z0-9\]\[[^/\n]*\{0,255\}\$\//g;

  it('every restatement of the grammar in docs and on the site is the live one', () => {
    const live = liveGrammar();
    const drifted: string[] = [];
    for (const file of docFiles()) {
      if (HISTORICAL.has(file)) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const [found] of text.matchAll(GRAMMAR_SHAPED)) {
        if (found !== live) drifted.push(`${file}: ${found}`);
      }
    }
    expect(drifted, `stale name-grammar statements (live is ${live})`).toEqual([]);
  });

  it('finds the restatements it is supposed to be guarding (the gate is not vacuous)', () => {
    const hits = docFiles().filter((f) =>
      GRAMMAR_SHAPED.test(readFileSync(join(ROOT, f), 'utf8')),
    ).length;
    expect(hits).toBeGreaterThan(0);
  });

  // The original sin was an unrunnable EXAMPLE, not a wrong regex, so the regex check alone would not have
  // caught it. Every name a doc shows a reader typing goes through the real validator.
  it('every segment/namespace name shown in a documented example actually validates', () => {
    const CALL = /\b(?:store\.)?segment\(\s*'([^']+)'/g;
    const NS = /\bnamespace:\s*'([^']+)'/g;
    const bad: string[] = [];
    for (const file of docFiles()) {
      if (HISTORICAL.has(file)) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const [, name] of text.matchAll(CALL)) {
        if (name === undefined) continue;
        try {
          validateSegmentRef({ segment: name });
        } catch {
          bad.push(`${file}: segment('${name}')`);
        }
      }
      for (const [, ns] of text.matchAll(NS)) {
        if (ns === undefined) continue;
        try {
          validateSegmentRef({ segment: 'x', namespace: ns });
        } catch {
          bad.push(`${file}: namespace: '${ns}'`);
        }
      }
    }
    expect(bad, 'documented names that would throw if executed').toEqual([]);
  });
});
