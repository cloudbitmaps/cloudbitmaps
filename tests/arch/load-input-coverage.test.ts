import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../vitest.config';
import {
  IDS_ONLY,
  LOAD_CALL,
  ROUTED,
  ROUTED_PROJECT,
  ROUTING_SETUP,
} from '../helpers/load-input-routes';

/**
 * Every test that loads runs twice: once with the ids it passes, and once with each of its id loads handed to
 * core's load as `{ serialized }` instead (the `serialized` project in `vitest.config.ts`). That second run is
 * what proves a load from portable Roaring bytes keeps every guarantee an id load has, without a copy of any test.
 *
 * The run only covers the files on its list, so the list is the thing that rots: a new load test that nobody adds
 * to it is never run through the bytes path, and nothing would say so. This gate holds the list to the tree, in
 * both directions:
 *
 *   FORWARD   every test file that calls a load entry point is listed, either as routed or as ids-only with the
 *             reason it cannot be routed;
 *   BACKWARD  every listed file exists, calls a load entry point, and is listed once.
 *
 * "Calls a load entry point" is a textual match, which is the point: it is cheap, it is written down, and a file
 * whose loads all go through the fixture loader (which does not go through core's load) matches too and is simply
 * routed, at the cost of running it twice.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (entry.name.endsWith('.test.ts')) out.push(relative(ROOT, path));
  }
  return out;
}

const ALL = testFiles(join(ROOT, 'tests')).filter((f) => !f.startsWith('tests/integration/'));
const LOADING = ALL.filter((f) => LOAD_CALL.test(readFileSync(join(ROOT, f), 'utf8')));

describe('every load test runs under the serialized input as well as ids', () => {
  it('the pattern finds the load tests it exists for (a control that must hit)', () => {
    expect(LOADING).toContain('tests/core/load.test.ts');
    expect(LOADING).toContain('tests/core/materialize-load-guard.test.ts');
    expect(LOADING.length).toBeGreaterThan(30);
  });

  it('FORWARD: each test file that loads is listed, routed or ids-only', () => {
    const listed = new Set([...ROUTED, ...Object.keys(IDS_ONLY)]);
    expect(LOADING.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('BACKWARD: each listed file exists and loads, and is listed once', () => {
    const loading = new Set(LOADING);
    const listed = [...ROUTED, ...Object.keys(IDS_ONLY)];
    expect(listed.filter((f) => !loading.has(f))).toEqual([]);
    expect(listed.filter((f, i) => listed.indexOf(f) !== i)).toEqual([]);
  });

  it('an ids-only file says why it cannot be routed', () => {
    const vague = Object.entries(IDS_ONLY).filter(([, why]) => why.trim().length < 40);
    expect(vague).toEqual([]);
  });

  it('the routed project runs exactly the routed files, through the routing setup', () => {
    const projects = (config.test?.projects ?? []) as Array<{
      test?: { name?: string; include?: string[]; setupFiles?: string[] };
    }>;
    const routed = projects.find((p) => p.test?.name === ROUTED_PROJECT);
    expect(routed).toBeDefined();
    expect([...(routed?.test?.include ?? [])].sort()).toEqual([...ROUTED].sort());
    expect(routed?.test?.setupFiles).toContain(ROUTING_SETUP);
    // And the default project still runs everything, so a routed file runs twice rather than once.
    const ids = projects.find((p) => p.test?.name === 'ids');
    expect(ids?.test?.include ?? config.test?.include).toEqual(['tests/**/*.test.ts']);
  });
});
