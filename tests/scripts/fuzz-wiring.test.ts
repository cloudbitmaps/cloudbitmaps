import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fuzz campaign runs only nightly, with a fuzzer this repo does not install for its tests, so a broken wire in it
 * would surface a night later at best, or never: a matrix that leaves a target out simply stops fuzzing it. This
 * holds the wiring to itself on every run: each `fuzz:<name>` script runs a target file that exists, over the corpus
 * the seed generator writes for it, each target has a script and a nightly matrix entry, the seed generator seeds
 * every target, and every name a target imports from the fuzz build is one its source exports.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
/** `fuzz:<name>` scripts that run a campaign: `<name>` → the target it runs and the corpus it seeds. */
const campaigns = Object.entries(scripts)
  .filter(([name]) => name.startsWith('fuzz:') && !['fuzz:seed', 'fuzz:install'].includes(name))
  .map(([name, command]) => {
    const target = /jazzer (fuzz\/targets\/[\w-]+\.mjs) fuzz\/corpus\/([\w-]+)/.exec(command);
    const seeded = /seed-corpus\.cjs ([\w-]+)/.exec(command);
    return {
      name: name.slice('fuzz:'.length),
      targetFile: target?.[1],
      corpus: target?.[2],
      seeded: seeded?.[1],
    };
  });
const targets = readdirSync(join(ROOT, 'fuzz/targets')).filter((f) => f.endsWith('.mjs'));

/** The names a module exports, by `export { … }` and by `export function|const|class`. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const decl of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g,
  )) {
    if (decl[1]) names.add(decl[1]);
  }
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of (block[1] ?? '').split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe('the fuzz campaign is wired end to end', () => {
  it('finds the four campaigns', () => {
    expect(campaigns.map((c) => c.name).sort()).toEqual(['crbm', 'deser', 'ext', 'index']);
  });

  it.each(campaigns.map((c) => [c.name, c] as const))(
    'fuzz:%s runs a target that exists, over the corpus it seeds',
    (_name, c) => {
      expect(c.targetFile).toBeDefined();
      expect(existsSync(join(ROOT, c.targetFile!))).toBe(true);
      expect(c.seeded).toBe(c.corpus);
      // The seed generator writes that corpus, and seeds it when run with no argument.
      const seed = read('fuzz/seed-corpus.cjs');
      expect(seed).toContain(`'${c.corpus}'`);
    },
  );

  it('every target file has a script, and every script a nightly matrix entry', () => {
    expect(targets.map((t) => `fuzz/targets/${t}`).sort()).toEqual(
      campaigns.map((c) => c.targetFile).sort(),
    );
    const matrix = /target:\s*\[([^\]]*)\]/.exec(read('.github/workflows/fuzz-nightly.yml'))?.[1];
    expect(
      matrix
        ?.split(',')
        .map((t) => t.trim())
        .sort(),
    ).toEqual(campaigns.map((c) => c.name).sort());
  });

  it.each(targets)('%s imports only names the fuzz build exports', (target) => {
    const builds: Record<string, string> = {
      'fuzz-core.js': 'packages/core/src/testing/fuzz-core.ts',
      'fuzz-codec.js': 'packages/roaring/src/testing/fuzz-codec.ts',
    };
    const source = read(`fuzz/targets/${target}`);
    const imports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/build\/([\w-]+\.js)'/g),
    ];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, names, build] of imports) {
      const exported = exportedNames(read(builds[build!]!));
      for (const name of names!
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)) {
        expect(exported, `${target} imports ${name} from ${build}`).toContain(name);
      }
    }
  });
});
