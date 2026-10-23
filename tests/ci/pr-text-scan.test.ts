import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Holds the pull-request text check in place and fires it at planted texts.
//
// A pull request's title, body and commit messages are public text, and a squash merge copies the commit subjects
// into `main`'s history. The check fails text that says who or what did the work, and text the leak scan would
// refuse in a tracked file. Each "must catch" case below plants the text in a title, a body or a commit message of
// a throwaway repository and runs the real script; each look-alike must stay quiet, because a check that fires on
// ordinary English only teaches people to route around it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/pr-text-scan.cjs');
const LEAK = join(ROOT, 'scripts/leak-scan.cjs');
// A needle made up for the test: never a real one.
const FAKE_NEEDLE = 'zz-test-needle-[0-9]+';

interface Run {
  status: number | null;
  out: string;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

/** A throwaway repository holding copies of the two scripts, so the real ones run against a place the test owns. */
function repo(leakScan: string = LEAK): { dir: string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'pr-text-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts/pr-text-scan.cjs'));
  copyFileSync(leakScan, join(dir, 'scripts/leak-scan.cjs'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@users.noreply.github.com');
  git(dir, 'config', 'user.name', 'a');
  git(dir, 'config', 'commit.gpgsign', 'false');
  let n = 0;
  const commit = (msg: string): string => {
    n += 1;
    writeFileSync(join(dir, `f${n}.txt`), String(n));
    git(dir, 'add', '-A');
    const r = git(dir, 'commit', '-q', '--no-verify', '-m', msg);
    if (r.status !== 0) throw new Error(r.stderr);
    return git(dir, 'rev-parse', 'HEAD').stdout.trim();
  };
  return { dir, commit };
}

function run(dir: string, env: Record<string, string | undefined>): Run {
  const clean: Record<string, string | undefined> = { ...process.env, LEAK_SCAN_EXTRA: undefined };
  const r = spawnSync(process.execPath, [join(dir, 'scripts/pr-text-scan.cjs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Run the check on a title, a body and one commit message, the way the workflow does. */
function scan(
  { title = 'Add a thing', body = 'Adds a thing.', commit = 'Add a thing' },
  extraEnv: Record<string, string | undefined> = {},
): Run {
  const { dir, commit: c } = repo();
  const base = c('base');
  const head = c(commit);
  return run(dir, { PR_TITLE: title, PR_BODY: body, BASE_SHA: base, HEAD_SHA: head, ...extraEnv });
}

// Each phrase as it would really be written, and the look-alikes beside them.
const PHRASES: [string, string][] = [
  ['subagent', 'one per lens, run by subagents'],
  ['subagent', 'a sub-agent did it'],
  ['coordinator', 'run by the coordinator'],
  ['this session', 'done in this session'],
  ['cannot spawn', 'this builder cannot spawn more'],
  ['cannot spawn', 'it could not spawn them'],
  ['Generated with', 'Generated with a tool'],
  ['Co-Authored-By', 'Co-Authored-By: someone'],
  ['Claude', 'written by Claude'],
  ['builder (the one who did the work)', 'the builder added a test'],
  ['builder (the one who did the work)', 'not run by the builder'],
  ['builder (the one who did the work)', "the builder's 12 mutants"],
  ['builder (the one who did the work)', 'this builder ran them'],
];
const LOOK_ALIKES = [
  'the user agent header is sent',
  "the scrubber removes the SDK's agent",
  'see CLAUDE.md for the conventions',
  'build with docker buildx builder default',
  'a query builder for filters',
  'an image builder step',
  'the builder inlines error classes into each subpath',
  'a protocol with one coordinator-free path',
  'reviewers, one per lens, against the whole component end to end',
];

describe('process phrases fire in a title, a body and a commit message', () => {
  for (const [phrase, text] of PHRASES) {
    it(`"${phrase}": ${text}`, () => {
      const inTitle = scan({ title: text });
      expect(inTitle.status).toBe(1);
      expect(inTitle.out).toContain(`"${phrase}" in the title, line 1`);
      expect(inTitle.out).toContain('say what was done, not who or what did it');

      const inBody = scan({ body: `Fine first line.\n${text}\n` });
      expect(inBody.status).toBe(1);
      expect(inBody.out).toContain(`"${phrase}" in the body, line 2`);

      const inCommit = scan({ commit: `Subject\n\n${text}` });
      expect(inCommit.status).toBe(1);
      expect(inCommit.out).toMatch(
        new RegExp(`"${phrase.replace(/[()]/g, '\\$&')}" in the commit [0-9a-f]{40}, line 3`),
      );
    });
  }
});

describe('look-alikes stay quiet', () => {
  for (const text of LOOK_ALIKES) {
    it(text, () => {
      const r = scan({ title: text, body: text, commit: `Subject\n\n${text}` });
      expect(r.out).not.toContain('FAILED');
      expect(r.status).toBe(0);
    });
  }

  it("a bot's own trailers are not scanned, a person's are", () => {
    const trailers =
      'Subject\n\nBody.\n\nSigned-off-by: dependabot[bot] <support@' +
      'github.com>\n' +
      'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>';
    expect(scan({ commit: trailers }).status).toBe(0);
    expect(scan({ commit: 'Subject\n\nCo-authored-by: Some Person <p@example.com>' }).status).toBe(
      1,
    );
  });

  it('the pull request template, as reworded', () => {
    const template = readFileSync(join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
    const r = scan({ body: template });
    expect(r.out).not.toContain('FAILED');
    expect(r.status).toBe(0);
  });

  it('a merge commit in the range is not scanned, and a commit before the base is not either', () => {
    const { dir, commit } = repo();
    commit('an old subagent commit');
    const base = commit('base');
    const head = commit('Add a thing');
    const r = run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head });
    expect(r.status).toBe(0);
  });
});

describe('the leak-scan half', () => {
  // Built at run time, so this file holds no local path or private-repo reference itself (the leak scan reads it).
  const localPath = `see ${'/Users'}/someone/project/file.ts`;
  const privateRepo = `see github.com/${'sharvil'}k/private-thing`;

  it('fires on a local absolute path, in a title, a body and a commit message', () => {
    for (const r of [
      scan({ title: localPath }),
      scan({ body: localPath }),
      scan({ commit: `Subject\n\n${localPath}` }),
    ]) {
      expect(r.status).toBe(1);
      expect(r.out).toContain('absolute local machine path');
    }
  });

  it('fires on a private-repo reference when the needles are configured', () => {
    const r = scan({ body: privateRepo }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE });
    expect(r.status).toBe(1);
    expect(r.out).toContain('repo under the maintainer account');
  });

  it('fires on a configured needle and redacts it', () => {
    const r = scan({ body: 'mentions zz-test-needle-42 here' }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE });
    expect(r.status).toBe(1);
    expect(r.out).toContain('extra needle #1');
    expect(r.out).not.toContain('zz-test-needle-42');
  });

  it('a link to a CI run and job is not an account id; a bare 12-digit run still is', () => {
    const link = 'see https://github.com/o/r/actions/runs/1/job/' + '1234'.repeat(3);
    expect(scan({ body: link }).status).toBe(0);
    const bare = scan({ body: `account ${'1234'.repeat(3)}` });
    expect(bare.status).toBe(1);
    expect(bare.out).toContain('AWS account id');
  });

  it('passes clean text, with and without needles', () => {
    expect(scan({}).status).toBe(0);
    expect(scan({}, { LEAK_SCAN_EXTRA: FAKE_NEEDLE }).status).toBe(0);
  });

  it('with no needles (a fork) still runs the hard rules, and says the needles were not applied', () => {
    const clean = scan({});
    expect(clean.status).toBe(0);
    expect(clean.out).toContain('private needles were not applied');
    const dirty = scan({ body: localPath });
    expect(dirty.status).toBe(1);
    expect(dirty.out).toContain('absolute local machine path');
    expect(dirty.out).toContain('private needles were not applied');
  });

  it('with no needles, a private-repo reference alone is not a failure', () => {
    const r = scan({ body: privateRepo });
    expect(r.status).toBe(0);
  });
});

describe('fails closed', () => {
  it('on a scan that crashes', () => {
    const stub = mkdtempSync(join(tmpdir(), 'pr-text-stub-'));
    dirs.push(stub);
    writeFileSync(join(stub, 'leak-scan.cjs'), "throw new Error('boom');\n");
    const { dir } = repo(join(stub, 'leak-scan.cjs'));
    const r = run(dir, { PR_TITLE: 't', PR_BODY: '' });
    expect(r.status).toBe(2);
    expect(r.out).toContain('did not run to a verdict');
  });

  it('on a bad commit id', () => {
    const { dir, commit } = repo();
    const head = commit('x');
    for (const base of ['0'.repeat(40), 'not-a-sha', '--all']) {
      const r = run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head });
      expect(r.status).toBe(2);
    }
  });

  it('on a missing title, a missing body, or one commit id without the other', () => {
    const { dir, commit } = repo();
    const sha = commit('x');
    expect(run(dir, { PR_BODY: '' }).status).toBe(2);
    expect(run(dir, { PR_TITLE: '  ', PR_BODY: '' }).status).toBe(2);
    expect(run(dir, { PR_TITLE: 't' }).status).toBe(2);
    expect(run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: sha }).status).toBe(2);
    expect(run(dir, { PR_TITLE: 't', PR_BODY: '', HEAD_SHA: sha }).status).toBe(2);
  });
});

describe('the workflow', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/pr-text.yml'), 'utf8');
  const wf = parse(text) as {
    on: { pull_request: { types: string[] } } & Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<
      string,
      {
        'timeout-minutes': number;
        permissions?: unknown;
        steps: {
          uses?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
        }[];
      }
    >;
  };
  const job = wf.jobs['pr-text'];
  if (job === undefined) throw new Error('no "pr-text" job');

  it('runs on a pull request, including an edit of the title or body, and nothing else', () => {
    expect(Object.keys(wf.on)).toEqual(['pull_request']);
    expect([...wf.on.pull_request.types].sort()).toEqual([
      'edited',
      'opened',
      'reopened',
      'synchronize',
    ]);
  });

  it('reads the repository only, cancels a superseded run, and is time-bounded', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(wf.concurrency.group).toContain('github.event.pull_request.number');
    expect(job['timeout-minutes']).toBeLessThanOrEqual(5);
  });

  it('checks out the whole history without credentials, and has no cache and no install', () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
    const node = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with?.cache).toBeUndefined();
    expect(node?.with?.['package-manager-cache']).toBe(false);
    expect(text).not.toMatch(/actions\/cache|pnpm\/action-setup/);
    expect(text).not.toMatch(/\b(?:pnpm|npm|yarn)\s+(?:install|ci|i)\b/);
  });

  it('passes the text through env and never into a run script', () => {
    const scan = job.steps.find((s) => s.run?.includes('pr-text-scan.cjs'));
    expect(scan?.run?.trim()).toBe('node scripts/pr-text-scan.cjs');
    expect(scan?.run).not.toContain('${{');
    expect(scan?.env).toEqual({
      PR_TITLE: '${{ github.event.pull_request.title }}',
      PR_BODY: '${{ github.event.pull_request.body }}',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      LEAK_SCAN_EXTRA: '${{ secrets.LEAK_SCAN_EXTRA }}',
    });
    for (const s of job.steps) expect(s.run ?? '').not.toContain('github.event');
  });
});
