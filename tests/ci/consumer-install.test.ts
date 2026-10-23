import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Holds the consumer install in place, and fires its detectors at planted trees.
//
// The workflow half: a pull request job that packs the six packages and installs the tarballs into a clean
// project, and a release job that does the same before anything is published, with nothing a dependency's install
// script could steal. Neither can be seen to be missing. Every other check passes without them, because none of the
// others reads a tarball: the workspace links packages in place, so a file missing from `files` or a `workspace:*`
// left in a manifest breaks nothing until a user installs. A job deleted, a step made advisory with
// `continue-on-error`, or a matrix that runs one Node twice leaves CI green.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  shell?: string;
  'working-directory'?: string;
  'continue-on-error'?: boolean | string;
}
interface Job {
  needs?: string | string[];
  environment?: unknown;
  env?: Record<string, unknown>;
  if?: string;
  permissions?: Record<string, string>;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean | string;
  strategy?: { matrix?: { node?: number[] }; 'fail-fast'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const load = (file: string) =>
  parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Workflow;
const ci = load('ci.yml');
const release = load('release.yml');
const SCRIPT = 'node scripts/consumer-install.cjs';

/** A job by name, failing loudly when it is gone: a missing job is the regression this file exists for. */
function jobOf(wf: Workflow, name: string): Job {
  const found = wf.jobs[name];
  if (!found) throw new Error(`no "${name}" job`);
  return found;
}
const label = (s: Step) => s.name ?? s.uses ?? s.run ?? '';
/** What would let a step run differently from how it reads, or let its failure pass. */
function loosened(step: Step | undefined): string[] {
  if (!step) return ['the step is missing'];
  const found: string[] = [];
  for (const key of ['if', 'continue-on-error', 'shell', 'working-directory', 'env'] as const) {
    if (step[key] !== undefined) found.push(key);
  }
  return found;
}

describe('the consumer install runs in CI', () => {
  const job = jobOf(ci, 'consumer-install');
  const script = job.steps.find((s) => s.run === SCRIPT);

  it('is a job of the workflow that runs on pull requests', () => {
    expect(Object.keys(ci.on)).toContain('pull_request');
    expect(job.if).toBeUndefined();
  });

  it('runs the script on Linux, with nothing that can make it advisory or skip it', () => {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['continue-on-error']).toBeUndefined();
    expect(loosened(script)).toEqual([]);
  });

  it('runs on Node 22 and 24, and each leg really uses its own Node', () => {
    expect(job.strategy?.matrix?.node).toEqual([22, 24]);
    const setup = job.steps.find((s) => (s.uses ?? '').startsWith('actions/setup-node@'));
    expect(setup?.with?.['node-version']).toBe('${{ matrix.node }}');
    expect(job.steps.indexOf(setup as Step)).toBeLessThan(job.steps.indexOf(script as Step));
  });

  it('installs pnpm and the dependencies before it, and stays inside a time bound', () => {
    const names = job.steps.map((s) => s.uses ?? s.run ?? '');
    const iScript = names.indexOf(SCRIPT);
    expect(iScript).toBeGreaterThan(-1);
    const iPnpm = names.findIndex((n) => n.startsWith('pnpm/action-setup'));
    expect(iPnpm).toBeGreaterThan(-1);
    expect(iPnpm).toBeLessThan(iScript);
    expect(names.indexOf('pnpm install --frozen-lockfile')).toBeGreaterThan(-1);
    expect(names.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(iScript);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(20);
  });
});

describe('the consumer install runs before a release publishes, with nothing to steal', () => {
  const job = jobOf(release, 'consumer-install');
  const publish = jobOf(release, 'publish');
  const NAME = 'Install the packed packages as a consumer';
  const step = job.steps.find((s) => s.name === NAME);

  it('is a job of its own that the publish job needs, so a failure stops the release', () => {
    expect([publish.needs].flat()).toContain('consumer-install');
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.environment).toBeUndefined();
  });

  it('holds no token a dependency could use: read-only, no id-token, no secret, no environment', () => {
    // A job-level block replaces the workflow's, so this is the whole of what the job holds.
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|id-token|NODE_AUTH_TOKEN|NPM_TOKEN/);
    expect(job.env).toBeUndefined();
    // Registry auth would be written into an npmrc that npm reads: no `registry-url`, no `token`.
    for (const s of job.steps) {
      expect(s.with?.['registry-url'], `${label(s)} sets a registry`).toBeUndefined();
      expect(s.with?.['token'], `${label(s)} passes a token`).toBeUndefined();
    }
  });

  it('runs the script and writes the digests, with nothing that can skip it or let it fail quietly', () => {
    expect(step?.run).toBe(`${SCRIPT} --write-digests digests.json`);
    expect(loosened(step)).toEqual([]);
  });

  it('runs under the npm the release publishes with, after pnpm is installed', () => {
    const names = job.steps.map(label);
    const i = names.indexOf(NAME);
    expect(names.indexOf('Upgrade npm for Trusted Publishing')).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(names.indexOf('Upgrade npm for Trusted Publishing'));
    expect(i).toBeGreaterThan(names.indexOf('pnpm install --frozen-lockfile'));
  });

  it('hands the digests to the publish job, which checks what it will publish against them', () => {
    const upload = job.steps.find((s) => (s.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(upload?.with?.['name']).toBe('verified-tarball-digests');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const steps = publish.steps;
    const names = steps.map(label);
    const download = steps.find((s) => (s.uses ?? '').startsWith('actions/download-artifact@'));
    expect(download?.with?.['name']).toBe('verified-tarball-digests');
    const check = steps.find((s) => s.run === `${SCRIPT} --verify-digests verified/digests.json`);
    expect(loosened(check)).toEqual([]);
    const iCheck = names.indexOf(check ? label(check) : '');
    expect(iCheck).toBeGreaterThan(names.indexOf('pnpm build'));
    expect(iCheck).toBeGreaterThan(steps.indexOf(download as Step));
    expect(iCheck).toBeLessThan(names.indexOf('Publish (dry-run)'));
    expect(iCheck).toBeLessThan(names.indexOf('Publish (real)'));
  });
});

// The detectors, fired at planted trees. A good tree passes; each defect fails with its message; and a look-alike
// that is not the defect does not trip it.
const lib = createRequire(import.meta.url)('../../scripts/consumer-install.cjs') as {
  checkInstalled: (project: string, pkgs: { name: string }[]) => string[];
  compareDigests: (
    expected: Record<string, Record<string, string>>,
    actual: Record<string, Record<string, string>>,
  ) => string[];
  childEnv: (extra: Record<string, string>) => Record<string, string>;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Manifest = Record<string, unknown>;
const PKG = { name: '@cloudbitmaps/demo' };
const GOOD: Manifest = {
  name: PKG.name,
  version: '1.0.0',
  description: 'mentions workspace:* in prose only',
  files: ['dist', 'README.md'],
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './package.json': './package.json',
  },
  bin: { demo: './dist/bin.js' },
  typesVersions: { '*': { sub: ['./dist/sub.d.ts'] } },
  dependencies: { other: '^1.0.0' },
};
const GOOD_FILES = [
  'package.json',
  'README.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/bin.js',
  'dist/sub.d.ts',
];

/** A project whose node_modules holds the demo package, optionally changed, and optionally a second copy. */
function plant(
  change: { manifest?: Manifest; drop?: string[]; secondCopy?: boolean } = {},
): string {
  const project = mkdtempSync(join(tmpdir(), 'consumer-detect-'));
  temps.push(project);
  const put = (root: string) => {
    const manifest = { ...GOOD, ...change.manifest };
    for (const file of GOOD_FILES) {
      if (change.drop?.includes(file)) continue;
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file === 'package.json' ? JSON.stringify(manifest) : 'x');
    }
  };
  put(join(project, 'node_modules', '@cloudbitmaps', 'demo'));
  if (change.secondCopy)
    put(join(project, 'node_modules', 'other', 'node_modules', '@cloudbitmaps', 'demo'));
  return project;
}

describe('the install checks', () => {
  it('pass a good tree, including a manifest that only mentions workspace: in prose', () => {
    expect(lib.checkInstalled(plant(), [PKG])).toEqual([]);
  });

  it('fail a workspace: range left in a dependency field', () => {
    const problems = lib.checkInstalled(
      plant({ manifest: { dependencies: { core: 'workspace:*' } } }),
      [PKG],
    );
    expect(problems).toEqual([
      '@cloudbitmaps/demo: dependencies.core is "workspace:*" in the packed manifest',
    ]);
  });

  it('fail an exports target that is not in the tarball', () => {
    const problems = lib.checkInstalled(plant({ drop: ['dist/index.js'] }), [PKG]);
    expect(problems).toEqual([
      '@cloudbitmaps/demo: exports target ./dist/index.js is not in the tarball',
    ]);
  });

  it('fail a bin target that is not in the tarball', () => {
    const problems = lib.checkInstalled(plant({ drop: ['dist/bin.js'] }), [PKG]);
    expect(problems).toEqual(['@cloudbitmaps/demo: bin ./dist/bin.js is not in the tarball']);
  });

  it('fail a typesVersions target that is not in the tarball', () => {
    const problems = lib.checkInstalled(plant({ drop: ['dist/sub.d.ts'] }), [PKG]);
    expect(problems).toEqual([
      '@cloudbitmaps/demo: typesVersions target ./dist/sub.d.ts is not in the tarball',
    ]);
  });

  it('fail a files entry that is not in the tarball, such as a licence', () => {
    const problems = lib.checkInstalled(
      plant({ manifest: { files: ['dist', 'README.md', 'LICENSE'] } }),
      [PKG],
    );
    expect(problems).toEqual(['@cloudbitmaps/demo: files entry LICENSE is not in the tarball']);
  });

  it('fail a package installed twice, and one not installed at all', () => {
    expect(lib.checkInstalled(plant({ secondCopy: true }), [PKG])).toEqual([
      '@cloudbitmaps/demo: 2 installed copies, expected exactly 1',
    ]);
    expect(lib.checkInstalled(plant(), [{ name: '@cloudbitmaps/absent' }])).toEqual([
      '@cloudbitmaps/absent: 0 installed copies, expected exactly 1',
    ]);
  });
});

describe('the comparison of verified and packed files', () => {
  const verified = { a: { 'package/x.js': '1', 'package/y.js': '2' } };

  it('passes the same files with the same hashes', () => {
    expect(lib.compareDigests(verified, structuredClone(verified))).toEqual([]);
  });

  it('fails a changed, a new and a vanished file, and a package on one side only', () => {
    expect(
      lib.compareDigests(verified, { a: { 'package/x.js': 'changed', 'package/z.js': '3' } }),
    ).toEqual([
      'a: package/x.js differs from the verified tarball',
      'a: package/y.js is gone since the verified tarball',
      'a: package/z.js is new since the verified tarball',
    ]);
    expect(lib.compareDigests(verified, {})).toEqual(['a: verified, but not packed now']);
    expect(lib.compareDigests({}, verified)).toEqual([
      'a: packed now, but not among the verified tarballs',
    ]);
  });
});

describe('the environment a dependency script runs in', () => {
  it('keeps the path and drops a token, a registry setting and node options', () => {
    const before = { ...process.env };
    Object.assign(process.env, {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
      NODE_AUTH_TOKEN: 'secret',
      NPM_CONFIG_USERCONFIG: '/somewhere',
      NODE_OPTIONS: '--require /x',
      NODE_PATH: '/y',
    });
    try {
      const env = lib.childEnv({ npm_config_update_notifier: 'false' });
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['npm_config_update_notifier']).toBe('false');
      expect(Object.keys(env).filter((k) => /TOKEN|NPM_CONFIG|NODE_/.test(k))).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });
});
