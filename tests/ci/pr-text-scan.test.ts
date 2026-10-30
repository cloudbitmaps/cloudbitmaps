import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Budget 10 s for every test in the file (the default is 5 s): each test starts the real script in a throwaway git
// repository, and about a dozen of them take 1 s to 3.3 s, so one file-wide figure is simpler than one per test.
// Measured: the slowest test at this budget takes 3.3 s on a developer machine and 2.1 s on the release job's runner in
// a single full run. Rule: the slowest measured time (release runner or developer machine) times three, rounded up to
// the next whole second.
vi.setConfig({ testTimeout: 10_000 });

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
function repo(leakScan: string = LEAK): {
  dir: string;
  commit: (
    msg: string,
    identity?: { author?: string; committer?: string; committerEmail?: string },
  ) => string;
  merge: (msg?: string) => string;
} {
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
  const commit = (
    msg: string,
    identity: { author?: string; committer?: string; committerEmail?: string } = {},
  ): string => {
    n += 1;
    writeFileSync(join(dir, `f${n}.txt`), String(n));
    git(dir, 'add', '-A');
    const args = ['commit', '-q', '--no-verify', '-m', msg];
    if (identity.author !== undefined) args.push('--author', identity.author);
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        ...(identity.committer === undefined && identity.committerEmail === undefined
          ? {}
          : {
              GIT_COMMITTER_NAME: identity.committer ?? 'c',
              GIT_COMMITTER_EMAIL: identity.committerEmail ?? 'c@users.noreply.github.com',
            }),
      },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return git(dir, 'rev-parse', 'HEAD').stdout.trim();
  };
  /** Merge the other line of history (the branch `side`) into the current one, with a real merge commit. */
  const merge = (msg?: string): string => {
    const r = git(
      dir,
      'merge',
      '-q',
      '--no-ff',
      '--no-verify',
      ...(msg ? ['-m', msg] : ['--no-edit']),
      'side',
    );
    if (r.status !== 0) throw new Error(r.stderr + r.stdout);
    return git(dir, 'rev-parse', 'HEAD').stdout.trim();
  };
  return { dir, commit, merge };
}

function run(dir: string, env: Record<string, string | undefined>): Run {
  // CI sets GITHUB_ACTIONS itself, which would make a missing input a failure in every run below that leaves one out.
  const clean: Record<string, string | undefined> = {
    ...process.env,
    LEAK_SCAN_EXTRA: undefined,
    GITHUB_ACTIONS: undefined,
  };
  const r = spawnSync(process.execPath, [join(dir, 'scripts/pr-text-scan.cjs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Run the check on a title, a body and one commit message, the way the workflow does. */
function scan(
  {
    title = 'Add a thing',
    body = 'Adds a thing.',
    commit = 'Add a thing',
    branch = undefined as string | undefined,
  },
  extraEnv: Record<string, string | undefined> = {},
): Run {
  const { dir, commit: c } = repo();
  const base = c('base');
  const head = c(commit);
  return run(dir, {
    PR_TITLE: title,
    PR_BODY: body,
    PR_BRANCH: branch,
    BASE_SHA: base,
    HEAD_SHA: head,
    ...extraEnv,
  });
}

// Each phrase as it would really be written, and the look-alikes beside them.
const PHRASES: [string, string][] = [
  ['subagent', 'one per lens, run by subagents'],
  ['subagent', 'a sub-agent did it'],
  ['subagent', 'run by sub agents'],
  ['AI-generated', 'an AI-generated summary'],
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
  ['builder (the one who did the work)', 'written by a builder that ran the tests'],
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
  'the builder was removed in v2',
  'run docker buildx with the builder named ci',
  'adds a builder for bitmap options',
  'this builder validates the namespace',
  'a builder that drops the namespace',
  'the API pages are generated with typedoc',
  'a sub-second delay',
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

  it("a named dependency bot's trailers are not scanned; a person's and an AI app's are", () => {
    const trailers =
      'Subject\n\nBody.\n\nSigned-off-by: dependabot[bot] <support@' +
      'github.com>\n' +
      'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>\n' +
      'Co-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\n' +
      'Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
    expect(scan({ commit: trailers }).status).toBe(0);
    expect(scan({ commit: 'Subject\n\nCo-authored-by: Some Person <p@example.com>' }).status).toBe(
      1,
    );
    for (const bot of ['claude[bot]', 'copilot-swe-agent[bot]', 'evil-dependabot[bot]']) {
      const r = scan({
        commit: `Subject\n\nCo-authored-by: ${bot} <1+${bot}@users.noreply.github.com>`,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain('"Co-Authored-By" in the commit');
    }
  });

  it('a phrase wrapped over two lines is found, at the line it starts on, once', () => {
    const wrapped = scan({ commit: 'Subject\n\nevery case was re-run in this\nsession, again' });
    expect(wrapped.status).toBe(1);
    expect(wrapped.out).toMatch(/"this session" in the commit [0-9a-f]{40}, line 3\n/);
    expect(wrapped.out.match(/"this session"/g)).toHaveLength(1);
    const builder = scan({ body: 'text written by a\nbuilder that ran the tests' });
    expect(builder.status).toBe(1);
    expect(builder.out).toContain('in the body, line 1');
    const footer = scan({ body: 'ok\nGenerated\nwith a tool' });
    expect(footer.status).toBe(1);
    expect(footer.out).toContain('"Generated with" in the body, line 2');
    // Two adjacent lines that merely sit side by side are not a phrase.
    expect(scan({ body: 'the builder\nvalidates it' }).status).toBe(0);
  });

  it('the footer shape is caught after an emoji, and plain prose with the words is not', () => {
    const r = scan({ body: 'Done.\n\n\u{1F916} Generated with a tool' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('"Generated with" in the body, line 3');
    expect(scan({ body: 'the docs are generated with typedoc' }).status).toBe(0);
  });

  it('a merge commit of the pull request is scanned; a default merge message is not a finding', () => {
    const { dir, commit, merge } = repo();
    const base = commit('base');
    git(dir, 'branch', 'side');
    commit('Add a thing');
    git(dir, 'checkout', '-q', 'side');
    commit('Side work');
    git(dir, 'checkout', '-q', '-');
    const clean = merge();
    expect(run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: clean }).status).toBe(
      0,
    );

    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    const dirty = merge('Merge side\n\nCo-Authored-By: Someone <s@example.com>');
    const r = run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: dirty });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"Co-Authored-By" in the commit ${dirty}, line 3`);
  });

  it("a commit that arrives through a merge's second parent is scanned", () => {
    // A side branch holding a listed trailer, merged into the pull request's branch: the base is the base branch's
    // tip when the branch was last pushed, which is where the side branch forked.
    const { dir, commit, merge } = repo();
    const base = commit('base');
    git(dir, 'branch', 'side');
    git(dir, 'checkout', '-q', '-b', 'pr');
    commit('Add a thing');
    git(dir, 'checkout', '-q', 'side');
    const side = commit(
      'Side work\n\nCo-authored-by: claude[bot] <1+claude[bot]@users.noreply.github.com>',
    );
    git(dir, 'checkout', '-q', 'pr');
    const head = merge();
    const r = run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"Co-Authored-By" in the commit ${side}, line 3`);
  });

  it("commits a merge of the base branch brought in are not scanned, with the base at that branch's tip", () => {
    const { dir, commit, merge } = repo();
    commit('base');
    git(dir, 'branch', 'side');
    git(dir, 'checkout', '-q', '-b', 'pr');
    commit('Add a thing');
    // The base branch ("side" here) moves on with a commit this pull request does not own, then is merged in.
    git(dir, 'checkout', '-q', 'side');
    commit('an old subagent commit');
    const baseTip = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    git(dir, 'checkout', '-q', 'pr');
    const head = merge();
    expect(git(dir, 'log', '--format=%s', `${baseTip}..${head}`).stdout).not.toContain('subagent');
    expect(run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: baseTip, HEAD_SHA: head }).status).toBe(
      0,
    );
  });

  it('a commit authored or committed by an AI identity fails; a person and the named bots pass', () => {
    const asIdentity = (identity: { author?: string; committer?: string }) => {
      const { dir, commit } = repo();
      const base = commit('base');
      const head = commit('Add a thing', identity);
      return run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head });
    };
    for (const author of [
      'claude[bot] <1+claude[bot]@users.noreply.github.com>',
      `Claude <noreply@${'anthropic'}.com>`,
      `Alex Smith <noreply@${'anthropic'}.com>`,
      'Alex Smith (aider) <alex@example.com>',
      `Some Tool <noreply@${'anthropic'}.com>`,
    ]) {
      const r = asIdentity({ author });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/in the author of commit [0-9a-f]{40}\n/);
      expect(r.out).not.toContain('Smith');
    }
    const committer = asIdentity({ committer: 'copilot-swe-agent[bot]' });
    expect(committer.status).toBe(1);
    expect(committer.out).toContain('"bot identity" in the committer of commit');
    expect(asIdentity({ author: 'Alex Smith <alex@example.com>' }).status).toBe(0);
    // A person whose name is Claude has no honest rewording: only the tools' own identities fail.
    expect(asIdentity({ author: 'Claude Dupont <claude@example.com>' }).status).toBe(0);
    expect(asIdentity({ author: 'Claude <claude@example.com>', committer: 'Claude' }).status).toBe(
      0,
    );
    expect(
      asIdentity({
        author: 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
        committer: `GitHub <noreply@${'github'}.com>`,
      }).status,
    ).toBe(0);
  });

  it('a message that holds a control character, even the old record separator, is parsed and scanned', () => {
    for (const sep of ['\x1e', '\x1f', '\x1e\x1e', '\n\x1e\n']) {
      const { dir, commit } = repo();
      const base = commit('base');
      const head = commit(`Subject\n\nbefore${sep}after\nwritten by Claude`);
      const r = run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(new RegExp(`"Claude" in the commit ${head}, line \\d+`));
      expect(r.out).not.toContain('FAILED to run');
      const other = repo();
      const otherBase = other.commit('base');
      const clean = other.commit(`Subject\n\nbefore${sep}after`);
      expect(
        run(other.dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: otherBase, HEAD_SHA: clean }).status,
      ).toBe(0);
    }
  });

  it('the pull request template, as reworded', () => {
    const template = readFileSync(join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
    const r = scan({ body: template });
    expect(r.out).not.toContain('FAILED');
    expect(r.status).toBe(0);
  });
});

describe('identities are run through the private needles', () => {
  const asIdentity = (
    identity: { author?: string; committer?: string; committerEmail?: string },
    extraEnv: Record<string, string | undefined> = { LEAK_SCAN_EXTRA: FAKE_NEEDLE },
  ) => {
    const { dir, commit } = repo();
    const base = commit('base');
    const head = commit('Add a thing', identity);
    return {
      head,
      r: run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head, ...extraEnv }),
    };
  };

  it('a needle in an author email fails, naming the commit and the field and nothing else', () => {
    const { head, r } = asIdentity({ author: 'Alex Smith <zz-test-needle-5@example.com>' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"private needle" in the author email of commit ${head}`);
    expect(r.out).not.toContain('zz-test-needle');
    expect(r.out).not.toContain('Smith');
    expect(r.out).not.toContain('say what was done');
  });

  it('a needle in a committer name, a committer email and an author name fails', () => {
    const name = asIdentity({ committer: 'Zed zz-test-needle-9' });
    expect(name.r.status).toBe(1);
    expect(name.r.out).toContain(`"private needle" in the committer name of commit ${name.head}`);
    expect(name.r.out).not.toContain('Zed');
    const email = asIdentity({ committerEmail: 'zz-test-needle-1@example.com' });
    expect(email.r.status).toBe(1);
    expect(email.r.out).toContain(`in the committer email of commit ${email.head}`);
    const author = asIdentity({ author: 'zz-test-needle-3 <a@example.com>' });
    expect(author.r.status).toBe(1);
    expect(author.r.out).toContain(`in the author name of commit ${author.head}`);
    for (const x of [name, email, author]) expect(x.r.out).not.toContain('zz-test-needle');
  });

  it('a field that two needles match is named and counted once', () => {
    const { head, r } = asIdentity(
      { author: 'Alex <zz-test-needle-5-xq9zvk-7@example.com>' },
      { LEAK_SCAN_EXTRA: `${FAKE_NEEDLE}\nxq9zvk-[0-9]+` },
    );
    expect(r.status).toBe(1);
    expect(r.out.match(/"private needle" in the author email of commit/g)).toHaveLength(1);
    expect(r.out).toContain(`"private needle" in the author email of commit ${head}`);
    expect(r.out).toContain('FAILED: 1 finding(s)');
    expect(r.out).not.toContain('xq9zvk');
  });

  it('an ordinary address with no needle passes, and the email rule never fires on it', () => {
    // A domain the leak scan does not allow-list, so the scan's own email rule would fire on it if its findings were kept.
    for (const author of [
      `Alex Smith <alex.smith@${'mail'}.test>`,
      `Alex Smith <alex@${'corp'}.test>`,
    ]) {
      const { r } = asIdentity({ author });
      expect(r.status).toBe(0);
      expect(r.out).not.toContain('email address');
      expect(r.out).not.toContain('private needle');
    }
  });

  it('names at most ten fields, then counts the rest, and counts every one as a finding', () => {
    const { dir, commit } = repo();
    const base = commit('base');
    let head = base;
    for (let i = 0; i < 7; i += 1)
      head = commit(`Add thing ${i}`, {
        author: 'Alex <zz-test-needle-1@example.com>',
        committerEmail: 'zz-test-needle-2@example.com',
      });
    const r = run(dir, {
      PR_TITLE: 't',
      PR_BODY: '',
      BASE_SHA: base,
      HEAD_SHA: head,
      LEAK_SCAN_EXTRA: FAKE_NEEDLE,
    });
    expect(r.status).toBe(1);
    expect(
      r.out.match(/"private needle" in the (?:author|committer) email of commit/g),
    ).toHaveLength(10);
    expect(r.out).toContain('4 more identity fields hold a private needle');
    expect(r.out).not.toContain('"private needle" in the 4 more');
    expect(r.out).toContain('FAILED: 14 finding(s)');
    expect(r.out).not.toContain('zz-test-needle');
  });

  it('an identity pass that crashes or prints no verdict ends in exit 2, not a pass', () => {
    const stub = mkdtempSync(join(tmpdir(), 'pr-text-stub-'));
    dirs.push(stub);
    for (const body of [
      "console.error('boom'); process.exit(1);",
      "console.log('nothing to see'); process.exit(0);",
    ]) {
      // The text pass runs the real scan; the pass over the identities (its own directory) gets the stub's answer.
      writeFileSync(
        join(stub, 'leak-scan.cjs'),
        `const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = process.argv[process.argv.indexOf('--dir') + 1];
if (basename(dir).startsWith('pr-text-id-')) { ${body} }
const r = spawnSync(process.execPath, [${JSON.stringify(LEAK)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status);
`,
      );
      const { dir: d, commit } = repo(join(stub, 'leak-scan.cjs'));
      const base = commit('base');
      const head = commit('Add a thing');
      const r = run(d, {
        PR_TITLE: 't',
        PR_BODY: '',
        BASE_SHA: base,
        HEAD_SHA: head,
        LEAK_SCAN_EXTRA: FAKE_NEEDLE,
      });
      expect(r.status).toBe(2);
      expect(r.out).toContain('did not run to a verdict over the identities');
    }
  });

  it('a needle in an identity is advised as a leak, not as a rewording', () => {
    const { r } = asIdentity({ author: 'Alex <zz-test-needle-5@example.com>' });
    expect(r.out).toContain('handled as a leak');
    expect(r.out).toContain('ask the maintainer before rewriting the history');
    expect(r.out).not.toContain('--reset-author');
  });

  it('without needles it passes on a fork and fails closed when they are required', () => {
    const who = { author: 'Alex Smith <zz-test-needle-5@example.com>' };
    expect(asIdentity(who, {}).r.status).toBe(0);
    expect(asIdentity(who, { REQUIRE_NEEDLES: 'true' }).r.status).toBe(2);
    expect(
      asIdentity(who, { REQUIRE_NEEDLES: 'true', LEAK_SCAN_EXTRA: FAKE_NEEDLE }).r.status,
    ).toBe(1);
  });
});

/** The output of a run whose last commit has an AI author. */
function asIdentityOut(): string {
  const { dir, commit } = repo();
  const base = commit('base');
  const head = commit('Add a thing', {
    author: 'claude[bot] <1+claude[bot]@users.noreply.github.com>',
  });
  return run(dir, { PR_TITLE: 't', PR_BODY: '', BASE_SHA: base, HEAD_SHA: head }).out;
}

describe('the head branch name', () => {
  it('a phrase in it fails, at line 1 of the branch name', () => {
    for (const [phrase, branch] of [
      ['subagent', 'feature/subagent-cleanup'],
      ['Claude', 'Claude/tidy-up'],
      ['coordinator', 'fix/coordinator.rewrite'],
      ['AI-generated', 'docs/AI-generated-notes'],
    ]) {
      const r = scan({ branch });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`"${phrase}" in the branch name, line 1`);
      expect(r.out).not.toContain(branch);
    }
  });

  it('a needle in it fails, redacted, and so does a local path', () => {
    const r = scan({ branch: 'feat/zz-test-needle-7-thing' }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE });
    expect(r.status).toBe(1);
    expect(r.out).toContain('extra needle');
    expect(r.out).toContain('branch.txt:1');
    expect(r.out).not.toContain('zz-test-needle');
    expect(scan({ branch: `${'/Users'}/someone/x` }).status).toBe(1);
  });

  it('a phrase joined by hyphens, underscores, dots or slashes fails too', () => {
    const cases: [string, string][] = [
      ['this session', 'docs/this-session-cookie'],
      ['this session', 'fix/this.session'],
      ['cannot spawn', 'chore/cannot-spawn'],
      ['cannot spawn', 'chore/could_not_spawn'],
      ['builder (the one who did the work)', 'fix/the-builder-ran'],
      ['builder (the one who did the work)', 'fix/added-by-the-builder'],
      ['subagent', 'fix/Sub_Agent'],
      ['Generated with', 'generated-with-a-tool'],
    ];
    for (const [phrase, branch] of cases) {
      const r = scan({ branch });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`"${phrase}" in the branch name, line 1`);
      expect(
        r.out.match(new RegExp(`"${phrase.replace(/[()]/g, '\\$&')}" in the branch name`, 'g')),
      ).toHaveLength(1);
      expect(r.out).not.toContain(branch);
    }
  });

  it('a phrase that a name holds through both readings is reported once', () => {
    for (const [branch, phrase] of [
      ['feature/subagent-cleanup', 'subagent'],
      ['Claude/x', 'Claude'],
    ]) {
      const r = scan({ branch });
      expect(r.status).toBe(1);
      expect(r.out.match(new RegExp(`"${phrase}" in the branch name`, 'g'))).toHaveLength(1);
    }
  });

  it("a branch that starts with a coding tool's own prefix fails, in any case", () => {
    for (const branch of [
      'claude/fix-bug-AbC12',
      'Claude/tidy-up',
      'copilot/fix-1',
      'cursor/add-feature-1a2b',
      'devin/1700000000-add-thing',
      'codex/fix-thing',
      'Codex/Fix-Thing',
    ]) {
      const r = scan({ branch });
      expect(r.status).toBe(1);
      expect(r.out).toContain('"coding tool branch prefix" in the branch name, line 1');
      expect(r.out).not.toContain(branch);
    }
  });

  it('a branch name holding a twelve-digit run fails the account-id rule, and says how to fix it', () => {
    const stamp = ['2024', '1022', '1530'].join('');
    const r = scan({ branch: `hotfix-${stamp}` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('AWS account id');
    expect(r.out).toContain('branch.txt:1');
    expect(r.out).not.toContain(stamp);
    expect(r.out).toContain('twelve-digit run');
    expect(r.out).toContain('push the work to a branch with another name');
  });

  it('a phrase finding in a branch says how to fix it', () => {
    const r = scan({ branch: 'fix/this-session' });
    expect(r.out).toContain('push the work to a branch with another name');
    expect(r.out).not.toContain('twelve-digit run');
    expect(scan({ title: 'written by Claude' }).out).not.toContain('another name');
  });

  it('an ordinary name passes, and so do the look-alikes of the phrase list and the prefixes', () => {
    for (const branch of [
      'ci/pr-text-follow-ups',
      'feature/add-thing',
      'dependabot/npm_and_yarn/vitest-4.1.0',
      'dependabot/github_actions/actions/checkout-5',
      'release-please--branches--main',
      'changeset-release/main',
      'coordinator-free',
      'fix/coordinator-free-path',
      'docs/claude-md-notes',
      'chore/sub-second-timers',
      'feature/user-agent-header',
      'fix/query-builder-keys',
      'fix/query-builder-read-path',
      'chore/a-builder-pattern-doc',
      'fix/session-this',
      'docs/generated-with-typedoc',
      'fix/cursor-pagination',
      'feat/codex-parser',
      'feat/devin-the-dog',
      'x/claude/y',
      'feat/cursor/x',
      'fix/copilot/x',
      'chore/devin/x',
      'docs/codex/x',
    ]) {
      const r = scan({ branch }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE });
      expect(r.out).not.toContain('FAILED');
      expect(r.status).toBe(0);
    }
  }, 60000);

  it('is optional on a local run, which says so; an empty name is scanned as nothing', () => {
    expect(scan({}).out).toContain('no PR_BRANCH, so the branch name was not scanned');
    expect(scan({ branch: '' }).status).toBe(0);
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
    expect(r.out).toContain('extra needle');
    expect(r.out).not.toContain('zz-test-needle-42');
    expect(r.out).not.toMatch(/extra needle #/);
  });

  it('a needle that is not a valid regular expression fails closed without printing its pattern', () => {
    const broken = 'q~v7#kz!w(';
    for (const args of [{}, { REQUIRE_NEEDLES: 'true' }]) {
      const r = scan({}, { LEAK_SCAN_EXTRA: `${FAKE_NEEDLE}\n${broken}`, ...args });
      expect(r.status).toBe(2);
      expect(r.out).toContain('is not a valid regular expression');
      for (let i = 0; i + 3 <= broken.length; i += 1)
        expect(r.out).not.toContain(broken.slice(i, i + 3));
    }
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

  it('with no needles, a private-repo reference alone is not a failure, and is still shown', () => {
    const r = scan({ body: privateRepo });
    expect(r.status).toBe(0);
    expect(r.out).toContain('MIGRATION (informational)');
    expect(r.out).toContain('repo under the maintainer account');
    expect(r.out).not.toContain('private-thing');
  });

  it('when the needles are required and absent, the check fails closed (exit 2)', () => {
    const r = scan({}, { REQUIRE_NEEDLES: 'true' });
    expect(r.status).toBe(2);
    expect(r.out).toContain('private needles are required');
    expect(scan({}, { REQUIRE_NEEDLES: 'true', LEAK_SCAN_EXTRA: FAKE_NEEDLE }).status).toBe(0);
    expect(scan({}, { REQUIRE_NEEDLES: 'false' }).status).toBe(0);
  });

  it('a finding never prints the text of its line, so a needle on a phrase line stays out of the log', () => {
    const line = 'Generated with a tool at zz-test-needle-77 corp';
    for (const r of [
      scan({ body: `first\n${line}` }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE }),
      scan({ title: line }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE }),
      scan({ commit: `Subject\n\n${line}` }, { LEAK_SCAN_EXTRA: FAKE_NEEDLE }),
    ]) {
      expect(r.status).toBe(1);
      expect(r.out).toContain('"Generated with" in the');
      expect(r.out).not.toContain('zz-test-needle');
      expect(r.out).not.toContain('a tool at');
    }
  });

  it("the leak scan's own report is printed without the text of the lines it refused", () => {
    const r = scan({ body: `${localPath}\nacct ${'1234'.repeat(3)}` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('body.txt:1');
    expect(r.out).toContain('<text withheld>');
    expect(r.out).not.toContain('someone/project');
    expect(r.out).not.toContain('1234'.repeat(3));
  });

  it('the redaction holds across every line-break form inside a refused line', () => {
    for (const brk of ['\u2028', '\u2029', '\r', '\v', '\f', '\u0085']) {
      const r = scan({ body: `${localPath}${brk}tail-after-break more` });
      expect(r.status).toBe(1);
      expect(r.out).toContain('<text withheld>');
      expect(r.out).not.toContain('tail-after-break');
    }
  });

  it('the advice for a leak is apart from the advice for a phrase', () => {
    const phrase = scan({ commit: 'Subject\n\nwritten by Claude' });
    expect(phrase.out).toContain('git rebase -i origin/main');
    expect(phrase.out).toContain('--force-with-lease --force-if-includes');
    const leak = scan({ commit: `Subject\n\n${localPath}` });
    expect(leak.out).toContain('does not unpublish');
    const who = asIdentityOut();
    expect(who).toContain('--reset-author');
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

  it('on a commit record it cannot parse', () => {
    const stub = mkdtempSync(join(tmpdir(), 'pr-text-git-'));
    dirs.push(stub);
    const { dir, commit } = repo();
    const base = commit('base');
    const head = commit('x');
    const records = [
      // text, then whether git ends the record with a NUL
      ['not a record', true],
      [`${head}\\nname\\nemail`, true],
      // five lines: one short of a record
      [`${head}\\na\\ne\\nc\\ne`, true],
      // six lines whose first is not a commit id
      ['junk\\na\\ne\\nc\\ne\\nmessage', true],
      // a whole record with no terminator
      [`${head}\\na\\ne\\nc\\ne\\nmessage`, false],
      ['', true],
    ] as const;
    for (const [record, terminated] of records) {
      writeFileSync(
        join(stub, 'git'),
        `#!/bin/sh\nprintf '${record}${terminated ? '\\0' : ''}'\n`,
        { mode: 0o755 },
      );
      const r = run(dir, {
        PR_TITLE: 't',
        PR_BODY: '',
        BASE_SHA: base,
        HEAD_SHA: head,
        PATH: `${stub}:${process.env.PATH}`,
      });
      expect(r.status).toBe(2);
      expect(r.out).toContain('FAILED to run');
    }
  });

  it('in CI, on a missing branch name, base or head; a local run only notes it', () => {
    const { dir, commit } = repo();
    const base = commit('base');
    const head = commit('x');
    const inCi = (env: Record<string, string | undefined>) =>
      run(dir, { PR_TITLE: 't', PR_BODY: '', GITHUB_ACTIONS: 'true', ...env });
    const all = { PR_BRANCH: 'feat/x', BASE_SHA: base, HEAD_SHA: head };
    expect(inCi(all).status).toBe(0);
    for (const missing of ['PR_BRANCH', 'BASE_SHA', 'HEAD_SHA'] as const) {
      const r = inCi({ ...all, [missing]: undefined });
      expect(r.status).toBe(2);
      expect(r.out).toContain(`${missing} is not set`);
    }
    for (const empty of ['PR_BRANCH', 'BASE_SHA', 'HEAD_SHA'] as const) {
      const r = inCi({ ...all, [empty]: '' });
      expect(r.status).toBe(2);
      expect(r.out).toContain(`${empty} is not set`);
    }
    expect(inCi({ ...all, BASE_SHA: '', HEAD_SHA: '' }).out).toContain('BASE_SHA is not set');
    expect(inCi({ PR_BRANCH: 'feat/x' }).status).toBe(2);
    expect(run(dir, { PR_TITLE: 't', PR_BODY: '' }).status).toBe(0);
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

/**
 * Push mode and the hook around it: git's lines (`<local ref> <local sha> <remote ref> <remote sha>`) on stdin and the
 * remote's name as the argument, one run for the whole push, no title and no body.
 */
const ZERO = '0'.repeat(40);

/** A throwaway repository with `origin/main` at its first commit, and the hook beside the scripts. */
function hookRepo() {
  const r = repo();
  mkdirSync(join(r.dir, '.husky'));
  copyFileSync(join(ROOT, '.husky/pre-push'), join(r.dir, '.husky/pre-push'));
  const main = r.commit('base');
  git(r.dir, 'update-ref', 'refs/remotes/origin/main', main);
  return { ...r, main };
}

/** Run the hook the way git does: one line per ref on stdin, the remote's name as its argument. */
function hook(
  dir: string,
  lines: string[],
  { remote = 'origin', path = process.env.PATH }: { remote?: string; path?: string } = {},
): Run {
  const x = spawnSync('/bin/sh', [join(dir, '.husky/pre-push'), remote], {
    cwd: dir,
    encoding: 'utf8',
    input: lines.length === 0 ? '' : lines.join('\n') + '\n',
    env: { ...process.env, LEAK_SCAN_EXTRA: undefined, GITHUB_ACTIONS: undefined, PATH: path },
  });
  return { status: x.status, out: `${x.stdout}${x.stderr}` };
}

const line = (ref: string, sha: string, remoteRef = ref, remoteSha = ZERO) =>
  `${ref} ${sha} ${remoteRef} ${remoteSha}`;

describe('push mode', () => {
  const push = (dir: string, input: string, env: Record<string, string | undefined> = {}): Run => {
    const r = spawnSync(
      process.execPath,
      [join(dir, 'scripts/pr-text-scan.cjs'), '--push', 'origin'],
      {
        cwd: dir,
        encoding: 'utf8',
        input,
        env: { ...process.env, LEAK_SCAN_EXTRA: undefined, GITHUB_ACTIONS: undefined, ...env },
      },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('a clean range passes without a title or a body, and counts its commits', () => {
    const { dir, commit } = hookRepo();
    commit('Add a thing');
    const head = commit('Add another thing');
    const r = push(dir, line('refs/heads/feature/add-a-thing', head) + '\n');
    expect(r.status).toBe(0);
    expect(r.out).toContain('2 commit(s)');
  });

  it('does not read a title, a body or a branch from the environment', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    const r = push(dir, line('refs/heads/feature/x', head) + '\n', {
      PR_TITLE: 'written by Claude',
      PR_BODY: 'a subagent did it',
      PR_BRANCH: 'claude/x',
    });
    expect(r.status).toBe(0);
  });

  it('fails closed (exit 2) on a line it cannot read, a bad sha, and a sha git does not have', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    expect(push(dir, 'refs/heads/x only three\n').status).toBe(2);
    expect(push(dir, line('refs/heads/x', 'not-a-sha') + '\n').status).toBe(2);
    expect(push(dir, line('refs/heads/x', '1'.repeat(40)) + '\n').status).toBe(2);
    expect(push(dir, line('refs/heads/x', head, 'refs/heads/x', 'zz') + '\n').status).toBe(2);
  });

  it('without --push the title is still required', () => {
    const { dir, commit } = hookRepo();
    const base = commit('base');
    const head = commit('x');
    expect(run(dir, { BASE_SHA: base, HEAD_SHA: head }).status).toBe(2);
  });
});

describe('the pre-push hook', () => {
  it('is executable, like the pre-commit hook beside it', () => {
    expect(statSync(join(ROOT, '.husky/pre-push')).mode & 0o111).not.toBe(0);
  });

  it('a new branch is read from the commits the remote lacks, and a clean one passes', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    const r = hook(dir, [line('refs/heads/feature/add-a-thing', head)]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('1 commit(s)');
  });

  it('a refused phrase in a new branch refuses the push (exit 1), naming the commit and never the text', () => {
    const { dir, commit } = hookRepo();
    const bad = commit('done by the coordinator');
    const head = commit('Add a thing');
    const r = hook(dir, [line('refs/heads/feature/add-a-thing', head)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"coordinator" in the commit ${bad}, line 1`);
    expect(r.out).not.toContain('done by');
  });

  it('an existing remote tip: a finding between the tip and the head refuses; one behind the tip is not read again', () => {
    const { dir, commit } = hookRepo();
    commit('done by the coordinator');
    const tip = commit('Add a thing');
    const bad = commit('written by Claude');
    const head = commit('Add another thing');
    const refused = hook(dir, [line('refs/heads/feature/x', head, 'refs/heads/feature/x', tip)]);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`"Claude" in the commit ${bad}`);
    expect(refused.out).not.toContain('coordinator');
    const behind = hook(dir, [line('refs/heads/feature/x', tip, 'refs/heads/feature/x', tip)]);
    expect(behind.status).toBe(0);
    expect(behind.out).toContain('0 commit(s)');
  });

  it('a remote tip this clone does not have: the commits no remote ref holds are read', () => {
    const { dir, commit } = hookRepo();
    const bad = commit('done by the coordinator');
    const head = commit('Add a thing');
    const r = hook(dir, [
      line('refs/heads/feature/x', head, 'refs/heads/feature/x', '1'.repeat(40)),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"coordinator" in the commit ${bad}`);
  });

  it('a diverged force-push reads the new commits, not the old tip it replaces', () => {
    const { dir, commit, main } = hookRepo();
    const oldTip = commit('written by Claude');
    git(dir, 'checkout', '-q', '-b', 'redo', main);
    const clean = commit('Add a thing');
    const ok = hook(dir, [line('refs/heads/feature/x', clean, 'refs/heads/feature/x', oldTip)]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('1 commit(s)');
    const bad = commit('the subagent ran it');
    const no = hook(dir, [line('refs/heads/feature/x', bad, 'refs/heads/feature/x', oldTip)]);
    expect(no.status).toBe(1);
    expect(no.out).toContain(`"subagent" in the commit ${bad}`);
    expect(no.out).not.toContain('Claude');
  });

  it('a rebase onto new main commits the remote already has does not read them again', () => {
    const { dir, commit, main } = hookRepo();
    const oldTip = commit('Add a thing');
    git(dir, 'checkout', '-q', '-b', 'main2', main);
    const moved = commit('done by the coordinator');
    git(dir, 'update-ref', 'refs/remotes/origin/main', moved);
    git(dir, 'checkout', '-q', '-b', 'rebased', moved);
    const head = commit('Add a thing');
    const r = hook(dir, [line('refs/heads/feature/x', head, 'refs/heads/feature/x', oldTip)]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('1 commit(s)');
    // a branch the remote has never seen is bounded by the remote's refs too
    const fresh = hook(dir, [line('refs/heads/feature/y', head)]);
    expect(fresh.status).toBe(0);
    expect(fresh.out).toContain('1 commit(s)');
  });

  it('a first push to a remote with no tracking refs here is measured from origin/main; with none the push is refused', () => {
    const { dir, commit } = hookRepo();
    const bad = commit('done by the coordinator');
    const head = commit('Add a thing');
    const r = hook(dir, [line('refs/heads/feature/x', head)], { remote: 'upstream' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"coordinator" in the commit ${bad}`);
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const none = hook(dir, [line('refs/heads/feature/x', head)], { remote: 'upstream' });
    expect(none.status).toBe(2);
    expect(none.out).toContain('no remote-tracking refs');
  });

  it('a deleted ref is skipped, and so is an empty stdin', () => {
    const { dir, commit } = hookRepo();
    const r = hook(dir, [line('(delete)', ZERO, 'refs/heads/feature/x', '1'.repeat(40))]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('pr-text-scan');
    expect(hook(dir, []).status).toBe(0);
    const head = commit('Add a thing');
    const mixed = hook(dir, [
      line('(delete)', ZERO, 'refs/heads/feature/x', '1'.repeat(40)),
      line('refs/heads/feature/y', head),
    ]);
    expect(mixed.status).toBe(0);
    expect(mixed.out).toContain('1 commit(s)');
  });

  it('several refs in one push are read in one run: a bad one refuses the whole push, the good one is still read', () => {
    const { dir, commit, main } = hookRepo();
    const good = commit('Add a thing');
    git(dir, 'checkout', '-q', '-b', 'other', main);
    const bad = commit('written by Claude');
    const r = hook(dir, [
      line('refs/heads/feature/good', good),
      line('refs/heads/claude/other', bad),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"Claude" in the commit ${bad}`);
    expect(r.out).toContain('"coding tool branch prefix" in the branch name 2');
    expect(r.out).toContain('scanned 4 text(s)');
    expect(r.out.match(/FAILED:/g)).toHaveLength(1);
    const fine = hook(dir, [
      line('refs/heads/feature/good', good),
      line('refs/heads/feature/other', main),
    ]);
    expect(fine.status).toBe(0);
    expect(fine.out.match(/clean \(/g)).toHaveLength(1);
    expect(fine.out).toContain('1 commit(s)');
  });

  it('the name scanned is the remote ref, for every push form', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    // a detached HEAD pushed to a bad remote name
    const detached = hook(dir, [line('HEAD', head, 'refs/heads/claude/x')]);
    expect(detached.status).toBe(1);
    expect(detached.out).toContain('"coding tool branch prefix" in the branch name');
    // a good local name pushed to a bad remote name
    expect(hook(dir, [line('refs/heads/good', head, 'refs/heads/claude/x')]).status).toBe(1);
    // a bad local name pushed to a good remote name: what GitHub shows is clean
    expect(
      hook(dir, [line('refs/heads/claude/local-only', head, 'refs/heads/feature/x')]).status,
    ).toBe(0);
    // a detached HEAD pushed to a good remote name
    expect(hook(dir, [line('HEAD', head, 'refs/heads/feature/x')]).status).toBe(0);
  });

  it('a bad branch name refuses the push even when the commits are clean', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    const r = hook(dir, [line('refs/heads/claude/tidy', head)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('"coding tool branch prefix" in the branch name');
  });

  it('a tag is read over its commits, and its name, with the branch rules', () => {
    const { dir, commit } = hookRepo();
    const head = commit('written by Claude');
    const r = hook(dir, [line('refs/tags/v1', head)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('"Claude" in the commit');
    const clean = commit('Add a thing');
    expect(hook(dir, [line('refs/tags/v2', clean, 'refs/tags/v2', head)]).status).toBe(0);
    const named = hook(dir, [line('refs/tags/claude/v2', clean, 'refs/tags/claude/v2', head)]);
    expect(named.status).toBe(1);
    expect(named.out).toContain('"coding tool branch prefix" in the tag name');
  });

  describe('an annotated tag', () => {
    const annotate = (
      dir: string,
      name: string,
      message: string,
      tagger: { name: string; email: string } = { name: 'a', email: 'a@users.noreply.github.com' },
    ): string => {
      const r = spawnSync('git', ['tag', '-a', '-m', message, name], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_COMMITTER_NAME: tagger.name,
          GIT_COMMITTER_EMAIL: tagger.email,
        },
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return git(dir, 'rev-parse', name).stdout.trim();
    };

    it('is scanned for its message: a finding in it refuses, a clean one passes', () => {
      const { dir, commit } = hookRepo();
      commit('Add a thing');
      const bad = annotate(dir, 'v1', 'released by the coordinator');
      expect(git(dir, 'cat-file', '-t', bad).stdout.trim()).toBe('tag');
      const r = hook(dir, [line('refs/tags/v1', bad)]);
      expect(r.status).toBe(1);
      expect(r.out).toContain('"coordinator" in the tag message, line 1');
      expect(r.out).not.toContain('released by');
      const ok = annotate(dir, 'v2', 'release 2');
      const clean = hook(dir, [line('refs/tags/v2', ok)]);
      expect(clean.status).toBe(0);
      expect(clean.out).toContain('1 commit(s)');
    });

    it('is scanned for its tagger', () => {
      const { dir, commit } = hookRepo();
      commit('Add a thing');
      const sha = annotate(dir, 'v1', 'release 1', {
        name: 'tool',
        email: `noreply@${'anthropic'}.com`,
      });
      const r = hook(dir, [line('refs/tags/v1', sha)]);
      expect(r.status).toBe(1);
      expect(r.out).toContain('"anthropic address" in the tagger of tag');
      expect(r.out).not.toContain(`noreply@${'anthropic'}.com`);
    });
  });

  it('refuses with exit 2 when node is not on the PATH', () => {
    const { dir, commit } = hookRepo();
    const head = commit('Add a thing');
    const bin = mkdtempSync(join(tmpdir(), 'no-node-bin-'));
    dirs.push(bin);
    const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(gitPath, join(bin, 'git'));
    const r = hook(dir, [line('refs/heads/feature/x', head)], { path: bin });
    expect(r.status).toBe(2);
    expect(r.out).toContain('node is not on the PATH');
  });

  it('works in a linked worktree', () => {
    const { dir, commit } = hookRepo();
    commit('Add a thing');
    const wt = `${dir}-wt`;
    expect(git(dir, 'worktree', 'add', '-q', '-b', 'side', wt).status).toBe(0);
    dirs.push(wt);
    writeFileSync(join(wt, 'w.txt'), 'w');
    git(wt, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'written by Claude'], {
      cwd: wt,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(c.status).toBe(0);
    const head = git(wt, 'rev-parse', 'HEAD').stdout.trim();
    const r = hook(wt, [line('refs/heads/side', head)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`"Claude" in the commit ${head}`);
  });

  it('a line it cannot read refuses the push with exit 2', () => {
    const { dir } = hookRepo();
    expect(hook(dir, ['refs/heads/x not four fields']).status).toBe(2);
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
      PR_BRANCH: '${{ github.head_ref }}',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      LEAK_SCAN_EXTRA: '${{ secrets.LEAK_SCAN_EXTRA }}',
      REQUIRE_NEEDLES:
        "${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' }}",
    });
    for (const s of job.steps) expect(s.run ?? '').not.toContain('github.event');
  });
});
