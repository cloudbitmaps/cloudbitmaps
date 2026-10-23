import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Holds the consumer install in place, and fires its detectors at planted trees.
//
// The workflow half: a pull request job that packs the six packages and installs the tarballs into a clean
// project, with the third-party half inside a container and nothing the container's code could steal or poison.
// Neither can be seen to be missing or loosened. Every other check passes without it, because none of the others
// reads a tarball, and a job that gains a cache, a secret or a step run on the host leaves CI green while giving
// registry code a way into every later run. The release workflow must not run it at all: the release pull
// request's own CI has already run it on the commit that is released.
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
  environment?: unknown;
  env?: Record<string, unknown>;
  if?: string;
  permissions?: Record<string, string>;
  container?: unknown;
  services?: unknown;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean | string;
  strategy?: { matrix?: { node?: number[] }; 'fail-fast'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const load = (file: string) =>
  parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Workflow;
const ci = load('ci.yml');
const SCRIPT = 'node scripts/consumer-install.cjs';
const RUN = [
  SCRIPT,
  '--image mirror.gcr.io/library/node:${{ matrix.node }}-bookworm',
  '--image public.ecr.aws/docker/library/node:${{ matrix.node }}-bookworm',
  '--image docker.io/library/node:${{ matrix.node }}-bookworm',
].join(' ');

/** A job by name, failing loudly when it is gone: a missing job is the regression this file exists for. */
function jobOf(wf: Workflow, name: string): Job {
  const found = wf.jobs[name];
  if (!found) throw new Error(`no "${name}" job`);
  return found;
}
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
  const script = job.steps.find((s) => (s.run ?? '').startsWith(SCRIPT));

  it('is a job of the workflow that runs on pull requests', () => {
    expect(Object.keys(ci.on)).toContain('pull_request');
    expect(job.if).toBeUndefined();
  });

  it('runs the script on Linux, with nothing that can make it advisory or skip it', () => {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['continue-on-error']).toBeUndefined();
    expect(loosened(script)).toEqual([]);
  });

  it('runs the install through the container, never on the runner', () => {
    expect(script?.run).toBe(RUN);
    expect(script?.run).not.toContain('--no-container');
  });

  it('runs on Node 22 and 24, and each leg really uses its own Node', () => {
    expect(job.strategy?.matrix?.node).toEqual([22, 24]);
    const setup = job.steps.find((s) => (s.uses ?? '').startsWith('actions/setup-node@'));
    expect(setup?.with?.['node-version']).toBe('${{ matrix.node }}');
    expect(job.steps.indexOf(setup as Step)).toBeLessThan(job.steps.indexOf(script as Step));
  });

  it('uses no cache of any kind, so nothing it ran can be restored by a job that holds a secret', () => {
    for (const step of job.steps) {
      const what = step.name ?? step.uses ?? step.run ?? '';
      expect(step.with?.['cache'], `${what} sets a cache`).toBeUndefined();
      expect(step.with?.['cache-dependency-path'], `${what} sets a cache path`).toBeUndefined();
      expect(step.uses ?? '', `${what} is a cache action`).not.toMatch(/(^|\/)cache(\/|@)/);
      expect(step.uses ?? '', `${what} restores or saves a cache`).not.toMatch(
        /\/(restore|save)@|docker-images-/,
      );
    }
  });

  it('holds no secret, no token beyond the read-only default, no environment and no container service', () => {
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|id-token/);
    expect(job.env).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toBeUndefined(); // the workflow's `contents: read`
    expect(job.container).toBeUndefined();
    expect(job.services).toBeUndefined();
  });

  it('installs pnpm and the dependencies before it, and stays inside a time bound', () => {
    const names = job.steps.map((s) => s.uses ?? s.run ?? '');
    const iScript = names.indexOf(RUN);
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

describe('the release workflow does not run the consumer install', () => {
  // The check runs third-party install scripts. In the release workflow it would sit beside the job that holds
  // `id-token: write`, and a cache or an artifact is a way from one to the other. The release pull request's
  // own CI runs it on the exact commit that is tagged, which is enough.
  it('never names the script, the job or its artifact', () => {
    const text = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(text).not.toMatch(/consumer-install|consumer install|verified-tarball-digests/i);
  });
});

// The detectors, fired at planted trees. A good tree passes; each defect fails with its message; and a look-alike
// that is not the defect does not trip it.
const lib = createRequire(import.meta.url)('../../scripts/consumer-install.cjs') as {
  checkInstalled: (project: string, pkgs: { name: string }[]) => string[];
  childEnv: (extra: Record<string, string>) => Record<string, string>;
  dockerRunArgs: (o: {
    image: string;
    name: string;
    tarballDir: string;
    scriptFile: string;
  }) => string[];
  refuseLocalModeInCi: (env: Record<string, string | undefined>) => void;
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

describe('the container the third-party half runs in', () => {
  const args = lib.dockerRunArgs({
    image: 'node:22',
    name: 'ci-1',
    tarballDir: '/work/tarballs',
    scriptFile: '/work/scripts/consumer-install.cjs',
  });

  it('is started with no environment, no privileges and nothing writable from the host', () => {
    const joined = args.join(' ');
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('--env-file');
    expect(args).not.toContain('--privileged');
    expect(joined).not.toMatch(/docker\.sock|--network[= ]host|--pid[= ]host|--volumes-from/);
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--user') + 1]).toBe('node');
  });

  it('mounts exactly the tarballs and the script, both read-only', () => {
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    expect(mounts).toEqual([
      '/work/tarballs:/w/tarballs:ro',
      '/work/scripts/consumer-install.cjs:/w/consumer-install.cjs:ro',
    ]);
  });

  it('refuses the no-container mode where CI is set, and allows it where it is not', () => {
    expect(() => lib.refuseLocalModeInCi({ CI: 'true' })).toThrow(/local use only/);
    expect(() => lib.refuseLocalModeInCi({ CI: '1' })).toThrow(/local use only/);
    expect(() => lib.refuseLocalModeInCi({})).not.toThrow();
    expect(() => lib.refuseLocalModeInCi({ CI: 'false' })).not.toThrow();
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
