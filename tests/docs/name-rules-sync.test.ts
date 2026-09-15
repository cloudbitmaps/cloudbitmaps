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

describe('documented name rules match the code', () => {
  // There is no name grammar any more — a name is any non-empty string, and each storage layer escapes what it
  // cannot take. So the first half of this gate inverts: rather than checking that a published regex matches
  // the live one, it checks that NO doc publishes a regex at all, because any such regex is now a false claim
  // about a rule that was deleted.
  const GRAMMAR_SHAPED = /\/\^\[A-Za-z0-9\]\[[^/\n]*\{0,255\}\$\//g;

  it('no doc or site page still publishes a name grammar', () => {
    const stale: string[] = [];
    for (const file of docFiles()) {
      if (HISTORICAL.has(file)) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const [found] of text.matchAll(GRAMMAR_SHAPED)) stale.push(`${file}: ${found}`);
    }
    expect(
      stale,
      'a published name grammar — names are unrestricted now, so any regex here is a rule that no longer exists',
    ).toEqual([]);
  });

  // The original sin was an unrunnable EXAMPLE, not a wrong regex, and that half is MORE valuable now: with
  // validation relaxed, a doc example fails only if it is genuinely malformed, which is exactly the case a
  // reader would never guess.
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

  it('is not vacuous — it really reads the doc tree', () => {
    expect(docFiles().length).toBeGreaterThan(5);
  });
});
