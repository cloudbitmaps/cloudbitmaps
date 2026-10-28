#!/usr/bin/env node
'use strict';

// The pull-request text check: a pull request's title, its body, the name of its head branch and its own commit
// messages are public text, and a squash merge copies the commit subjects into `main`'s history for good. Two
// things must not be in them:
//
//   1. Words about WHO or WHAT did the work. Public text says what was done ("the review gate: run after the PR is
//      up"), never who did it.
//   2. What the leak scan refuses in a tracked file: a credential, a local absolute path, a private-repo or
//      private-doc reference, and the private needles. The texts are written into a temporary directory and
//      `scripts/leak-scan.cjs` is run over it, so PR text gets the same rules as the repository.
//
// Usage (CI passes everything through the environment; locally, give the title and body, the two commit ids to
// include the commit messages, and the branch name):
//
//     PR_TITLE='…' PR_BODY='…' node scripts/pr-text-scan.cjs
//     PR_TITLE='…' PR_BODY='…' PR_BRANCH='…' BASE_SHA=<sha> HEAD_SHA=<sha> node scripts/pr-text-scan.cjs
//
//   PR_TITLE   required, non-empty            PR_BODY   required (may be empty: a PR can have no body)
//              (neither is read in push mode, below)
//   PR_BRANCH  the head branch's name, scanned with the same phrase list and leak rules as the other texts, and
//              also with `-`, `_`, `/` and `.` read as spaces (`this-session` is `this session`; the `coordinator`
//              rule skips that reading), and refused when it starts with a coding tool's own branch prefix
//              (`claude/`, `codex/`, `copilot/`, `cursor/`, `devin/`, in any case). A name that holds a twelve-digit run (a
//              `yyyymmddhhmm` stamp) fails the leak scan's account-id rule. A branch cannot be renamed on a pull
//              request, so a finding says to push the work to a branch with another name and open the pull request
//              from it. Unset locally: the check says so and skips it.
//   BASE_SHA / HEAD_SHA   both or neither; with both, the messages, the author and the committer of every commit of
//                         `git log BASE..HEAD` are scanned: the pull request's own commits, those that reached its
//                         branch through a merge's second parent, and its merges. BASE_SHA is the base branch's tip
//                         when the branch was last pushed, so the commits a merge of the base branch brought in are
//                         already behind it and are not read. Locally, use `git merge-base origin/main HEAD`.
//   LEAK_SCAN_EXTRA   the private needles, passed on to the leak scan (absent on a fork's pull request). Without it
//                     the leak scan reads a `.leak-needles` file when the checkout has one (a linked worktree with none
//                     of its own reads the main checkout's), so a local run applies needles only where that file exists.
//   REQUIRE_NEEDLES   `true` when the needles must be there (the workflow sets it for a pull request from this
//                     repository): the check then fails with exit 2 instead of running without them.
//
// Push mode (`--push`, used by `.husky/pre-push`): checks what one `git push` of one branch carries, before it leaves
// the machine. PR_TITLE and PR_BODY are not read (a pull request's title and body are written after the push, so CI
// keeps checking them); BASE_SHA and HEAD_SHA are required (the remote's old tip, or the merge-base with `origin/main`
// for a new branch, and the commit being pushed) and PR_BRANCH is the branch's name, left unset for a tag. It scans
// the same things as the CI mode over `git log BASE..HEAD` (every message, author and committer) and the branch name,
// with the same findings, the same redaction and the same exit codes, and it fails closed the same way. The hook
// runs it once per pushed ref, only on `git push`, never on a commit; a run takes about 0.15 s.
//
//     BASE_SHA=<sha> HEAD_SHA=<sha> PR_BRANCH='…' node scripts/pr-text-scan.cjs --push
//
// Exit 0 clean; 1 a finding; 2 an input or a tool that could not be read or run. The check fails closed: a missing
// input, a git error, a scan that crashes or exits in a way this script does not know is a failure, never a pass.
// When GITHUB_ACTIONS is `true`, a missing or empty PR_BRANCH, BASE_SHA or HEAD_SHA is exit 2 too (a local run only notes it).
//
// A finding names the phrase, the source and the line number, never the text of the line: the log of a public run is
// a second copy of the text, and a line that holds a listed phrase can hold anything else. The leak scan's report is
// printed the same way, with each finding's text withheld.
//
// A pull request from a branch of this repository runs its own copy of this script, with the secret: the check
// guards against a slip, not against a hostile author.
//
// Text that quotes the leak scan's own examples (a sample connection string with a password, an ARN prefix, a
// property read of a credentials option) is refused by the rule it quotes: reword it.
//
// An author's and committer's name and email are run through the private needles alone: one file per field goes to
// the leak scan, and only the findings of its `extra needle` rules are kept, so the scan's email rule never fires on
// an ordinary address. A needle finding names the commit and the field, never the value; the leak scan names ten
// files per rule, so the fields beyond that are counted, not named. A bot, `(aider)` or vendor-address finding
// names the commit and whether it is the author or the committer. The commit records are read with `git log -z`, so
// no text of a message can end a record, and a record that does not parse is exit 2.
//
// What it does not catch: a phrase that is not on the list below, a leak that is reworded (a path written with a
// space in it, an id described in other words), a phrase in a branch name that no `-`, `_`, `/` or `.` reading
// exposes (a phrase written with underscores where the phrase has hyphens, such as `co_authored_by` or
// `ai_generated`; a line-start `Generated with` that does not begin the name; a branch of another tool than the
// five named), an author whose identity names no tool, a phrase inside an author's or committer's name (only a bot, an
// `(aider)` or a vendor address is checked there), a NUL in a commit message (git stops reading the message at
// it, and only a hand-built commit holds one), and anything in a pull request comment or review, which this
// script never reads.

const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

// --- the process phrases --------------------------------------------------------------------------------
//
// Each entry says who or what did the work, which public text never does. The list is deliberately narrow:
//
//   * `agent` is NOT here: the docs say a scrubber removes an SDK's `agent`, and "user agent" is ordinary English.
//   * `builder` is only a phrase about the work: a work verb beside it (`the builder ran`, `added by the builder`)
//     or its possessive before a number or a work noun (`the builder's 12 mutants`). An image builder, a query
//     builder, a `docker buildx` builder, the library's own key or report builders and a sentence about the build tool
//     ("the builder inlines error classes") are legitimate, so the word alone is not listed.
//   * `coordinator` is not matched inside a compound (`coordinator-free` is a protocol property). The word in the
//     distributed-systems sense is a known false positive: reword it ("the transaction manager").
//   * `Generated with` is only the footer's shape, at the start of a line (after an optional emoji): "the pages are
//     generated with typedoc" is ordinary prose.
//   * `this session` has a legitimate benchmark sense ("its latencies are this session's"): reword it ("this run's").
//   * A trailer a named dependency bot's own commit carries (`Signed-off-by: dependabot[bot] <...>`,
//     `Co-authored-by: renovate[bot] <...>`, the same for `github-actions[bot]`) is removed from a commit message
//     before it is scanned: GitHub writes it, and its address is not ours to leak. Any other `[bot]` trailer is
//     scanned, and an AI app's co-author trailer is caught by the `Co-Authored-By` entry.
//   * `Claude` is a case-sensitive whole word, so `CLAUDE.md` and a lower-case path do not match. In an author or
//     committer it is not a finding by itself (a person can be named Claude): only a `[bot]` login outside the
//     allowlist, `(aider)` and a vendor no-reply address are.
//
// A phrase wrapped across two lines is found too: each pair of adjacent lines is also tested, joined with a space.
//
// Fix a hit by stating what was done, not who did it. Never widen a phrase to excuse one text: name the look-alike
// narrower, or reword the text.
const WORK_VERBS = 'ran|wrote|added|found|did|made|reran|restored|caught|killed|re-?checked|read';
const WORK_NOUNS = 'mutants?|runs?|reviews?|findings?|fixes|commits?|tests?|\\d+';
const PHRASES = [
  { name: 'subagent', re: /\bsub[- ]?agents?\b/i },
  { name: 'coordinator', re: /(?<![\w-])coordinators?(?![\w-])/i },
  { name: 'this session', re: /\bthis session\b/i },
  { name: 'cannot spawn', re: /\b(?:could|can) ?(?:not|n['\u2019]t) spawn/i },
  { name: 'Generated with', re: /^\W*Generated with\b/i },
  { name: 'Co-Authored-By', re: /\bCo-Authored-By\b/i },
  { name: 'Claude', re: /\bClaude\b/ },
  { name: 'AI-generated', re: /\bAI-(?:generated|assisted|written)\b/i },
  {
    name: 'builder (the one who did the work)',
    re: new RegExp(
      [
        String.raw`\b(?:the|this|a) builder (?:${WORK_VERBS})\b`,
        String.raw`\b(?:written|run|done|added|found|caught|fixed|reviewed|re-?run|checked) by (?:the|this|a) builder\b`,
        String.raw`\bthe builder['\u2019]s (?:${WORK_NOUNS})\b`,
      ].join('|'),
      'i',
    ),
  },
];

// An identity (a commit's author or committer) names a tool when it holds one of these.
const BOT_ALLOWED = /^(?:dependabot|renovate|github-actions)$/i;
const IDENTITY_RULES = [
  {
    name: 'bot identity',
    test: (t) => [...t.matchAll(/([\w.-]+)\[bot\]/gi)].some((m) => !BOT_ALLOWED.test(m[1])),
  },
  { name: 'aider', test: (t) => /\(aider\)/i.test(t) },
  { name: 'anthropic address', test: (t) => /noreply@anthropic\.com/i.test(t) },
];

const FIX =
  'fix: say what was done, not who or what did it (public text names the change, never its author)';

// A branch that starts with the prefix a coding tool gives the branches it makes (matched at the start of the name,
// in any case, and only at the start: `docs/claude-md-notes`, `feat/codex-parser` and `x/claude/y` are not tool branches).
const TOOL_BRANCH = /^(?:claude|codex|copilot|cursor|devin)\//i;

/** Phrase findings in one text: `{ phrase, source, line }`. Never the text of the line. `skip` names phrases to leave out. */
function phraseFindings(source, text, skip = []) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((t, i) => {
    for (const p of PHRASES) {
      if (skip.includes(p.name)) continue;
      if (p.re.test(t)) {
        out.push({ phrase: p.name, source, line: i + 1 });
      } else if (
        i + 1 < lines.length &&
        p.re.test(`${t} ${lines[i + 1]}`) &&
        !p.re.test(lines[i + 1])
      ) {
        // A phrase wrapped over the end of this line: reported once, at the line it starts on.
        out.push({ phrase: p.name, source, line: i + 1 });
      }
    }
  });
  return out;
}

/** Findings in a commit's author or committer: `{ phrase, source, line }`, line 0 being the identity itself. */
function identityFindings(source, { name, email }) {
  const identity = `${name} <${email}>`;
  const out = IDENTITY_RULES.filter((r) => r.test(identity)).map((r) => ({
    phrase: r.name,
    source,
    line: 0,
  }));
  return out;
}

/**
 * Findings in the head branch's name: the phrase list on the name as written, the phrase list again on a copy with `-`,
 * `_`, `/` and `.` turned into spaces (`this-session` is the phrase `this session`), and the prefix of a coding tool's
 * own branches. The `coordinator` rule is skipped on the copy: it treats a hyphenated compound as a property
 * (`coordinator-free`), and the copy would undo that. Each phrase is reported once.
 */
function branchFindings(name) {
  const source = 'branch name';
  const seen = new Set();
  const out = [];
  for (const f of [
    ...phraseFindings(source, name),
    ...phraseFindings(source, name.replace(/[-_/.]/g, ' '), ['coordinator']),
  ]) {
    if (!seen.has(f.phrase)) out.push(f);
    seen.add(f.phrase);
  }
  if (TOOL_BRANCH.test(name)) out.push({ phrase: 'coding tool branch prefix', source, line: 1 });
  return out;
}

class InputError extends Error {}

/** A trailer a named dependency bot's commit carries: GitHub writes it, so it is not scanned. */
const BOT_TRAILER =
  /^(?:Signed-off-by|Co-authored-by):\s*(?:dependabot|renovate|github-actions)\[bot\]\s*</i;

/**
 * The pull request's own commits, `[{ sha, author, committer, message }]`: every commit reachable from the head and
 * not from the base, merges included, so a commit that reached the branch through a merge's second parent is read.
 * The base is the base branch's tip, so what a merge of that branch brought in is behind it and is not listed.
 */
function commits(base, head) {
  const SHA = /^[0-9a-f]{7,40}$/i;
  if (!SHA.test(base) || !SHA.test(head))
    throw new InputError('BASE_SHA and HEAD_SHA must be commit ids');
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['log', '-z', '--format=%H%n%an%n%ae%n%cn%n%ce%n%B', `${base}..${head}`],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    throw new InputError(
      `git log ${base}..${head} failed: ${String(err.stderr || err.message).trim()}`,
    );
  }
  // `-z` ends each record with a NUL, which a commit message cannot hold, so no text of a message can be taken for
  // the end of a record. A record that does not parse stops the check.
  const records = raw.split('\0');
  if (records.pop() !== '') throw new InputError('git log gave a record with no terminator');
  return records.map((record) => {
    const lines = record.split('\n');
    if (lines.length < 6 || !SHA.test(lines[0]))
      throw new InputError('git log gave a commit record this check cannot parse');
    return {
      sha: lines[0],
      author: { name: lines[1], email: lines[2] },
      committer: { name: lines[3], email: lines[4] },
      message: lines
        .slice(5)
        .filter((l) => !BOT_TRAILER.test(l))
        .join('\n'),
    };
  });
}

/** The leak scan's report with each finding's text withheld (the location stays), and the needle's index dropped. */
function redact(report) {
  return report
    .replace(/^(\s{4}\S+:\d+)\s{2}[^\n]*$/gm, '$1  <text withheld>')
    .replace(/extra needle #\d+/g, 'extra needle');
}

const ID_FIELDS = ['author name', 'author email', 'committer name', 'committer email'];

/**
 * The private needles alone over every commit's author and committer, name and email: one file per field, scanned by
 * the leak scan, and only the findings of an `extra needle` rule are kept (a second pass, so the scan's email rule
 * never fires on an ordinary address). Returns `{ hits, unnamed }`: `hits` are `{ phrase, source, line: 0 }`, the commit and the field, never the
 * value; the scan's report names at most ten files per rule, so `unnamed` counts the fields it did not name.
 */
function identityNeedleHits(identities, idDir, run) {
  if (identities.length === 0) return { hits: [], unnamed: 0 };
  const files = new Map();
  for (const c of identities) {
    const values = [c.author.name, c.author.email, c.committer.name, c.committer.email];
    ID_FIELDS.forEach((field, i) => {
      const file = `id-${files.size}.txt`;
      files.set(file, `${field} of commit ${c.sha}`);
      writeFileSync(join(idDir, file), values[i]);
    });
  }
  const r = run(['--snapshot'], idDir);
  const verdict =
    (r.status === 0 && /^leak-scan: directory /m.test(r.stdout || '')) ||
    (r.status === 1 && /leak-scan: FAILED/.test(r.stderr || ''));
  if (r.error !== undefined || !verdict)
    throw new InputError(
      `the leak scan did not run to a verdict over the identities (${r.error ? r.error.message : `exit ${r.status}`})`,
    );
  const hits = [];
  let extra = 0;
  let inNeedle = false;
  for (const line of (r.stdout || '').split('\n')) {
    const heading = /^ {2}(\S.*?): (\d+)$/.exec(line);
    if (heading) {
      inNeedle = heading[1].startsWith('extra needle');
      continue;
    }
    const hit = /^ {4}(id-\d+\.txt):\d+ /.exec(line);
    if (inNeedle && hit && files.has(hit[1])) hits.push(files.get(hit[1]));
    const more = /^ {4}… (\d+) more$/.exec(line);
    if (inNeedle && more) extra += Number(more[1]);
  }
  return {
    hits: [...new Set(hits)].map((source) => ({ phrase: 'private needle', source, line: 0 })),
    unnamed: extra,
  };
}

/**
 * The leak scan over the texts. Returns `{ ok, notes }`. With the private needles it runs as a snapshot (private
 * repo and private-doc references fail too); without them (a fork's pull request gets no secrets) it runs without
 * `--snapshot`, so the hard rules still apply, and says the needles were not applied. When the needles are required
 * (a pull request from this repository) their absence is an error, not a pass.
 */
function leakScan(texts, requireNeedles, identities = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-text-'));
  const idDir = mkdtempSync(join(tmpdir(), 'pr-text-id-'));
  try {
    // A GitHub Actions run or job id in a link is a 12-digit run the account-id rule would refuse, and a link to a
    // failing job is ordinary pull request text, so the ids in that one URL shape are replaced before the scan.
    for (const t of texts) {
      writeFileSync(
        join(dir, t.file),
        t.text.replace(/\/actions\/runs\/\d+(?:\/job\/\d+)?/g, '/actions/runs/ID'),
      );
    }
    const run = (flags, target = dir) =>
      spawnSync(process.execPath, [join(__dirname, 'leak-scan.cjs'), ...flags, '--dir', target], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
      });
    let r = run(['--snapshot']);
    const notes = [];
    let degraded = false;
    if (r.error === undefined && r.status === 2 && /no extra needles configured/.test(r.stderr)) {
      if (requireNeedles)
        throw new InputError(
          'the private needles are required for this pull request and none are configured (LEAK_SCAN_EXTRA is empty)',
        );
      degraded = true;
      notes.push(
        'pr-text-scan: the private needles were not applied (none configured, as on a fork); the credential, ' +
          'local-path and account-id rules ran, the private-repo and private-doc rules are informational.',
      );
      r = run([]);
    }
    const out = redact(`${r.stdout || ''}${r.stderr || ''}`);
    // A node crash also exits 1, so a verdict is an exit code together with the scan's own report: its header line
    // on a pass, its closing "FAILED" line on a refusal.
    const verdict =
      (r.status === 0 && /^leak-scan: directory /m.test(r.stdout || '')) ||
      (r.status === 1 && /leak-scan: FAILED/.test(r.stderr || ''));
    if (r.error !== undefined || !verdict) {
      throw new InputError(
        `the leak scan did not run to a verdict (${r.error ? r.error.message : `exit ${r.status}`})\n${out}`,
      );
    }
    // Without needles the migration findings are informational and no failure carries them: show them.
    const migration = degraded ? /^MIGRATION[^\n]*\n(?:[ ]+.*(?:\n|$))*/m.exec(out) : null;
    return {
      ok: r.status === 0,
      notes,
      out,
      migration: migration ? migration[0] : '',
      identity: degraded ? { hits: [], unnamed: 0 } : identityNeedleHits(identities, idDir, run),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(idDir, { recursive: true, force: true });
  }
}

function main(env, push = false) {
  const title = env.PR_TITLE;
  const body = env.PR_BODY;
  const inCi = env.GITHUB_ACTIONS === 'true';
  if (!push && (title === undefined || title.trim() === ''))
    throw new InputError('PR_TITLE is missing or empty');
  if (!push && body === undefined)
    throw new InputError('PR_BODY is not set (set it to an empty string for no body)');
  // A push has no title or body, and its range is the whole point: both ends must be there.
  if (push)
    for (const name of ['BASE_SHA', 'HEAD_SHA'])
      if (env[name] === undefined || env[name] === '')
        throw new InputError(`${name} is not set (a push is checked over a range of commits)`);
  // In CI the workflow always sets all three of these: one that is gone is a broken workflow, not a pass.
  if (inCi && !push)
    for (const name of ['PR_BRANCH', 'BASE_SHA', 'HEAD_SHA'])
      if (env[name] === undefined || env[name] === '')
        throw new InputError(`${name} is not set (the workflow always sets it)`);
  const hasBase = env.BASE_SHA !== undefined && env.BASE_SHA !== '';
  const hasHead = env.HEAD_SHA !== undefined && env.HEAD_SHA !== '';
  if (hasBase !== hasHead)
    throw new InputError(
      `${hasBase ? 'HEAD_SHA' : 'BASE_SHA'} is not set: BASE_SHA and HEAD_SHA go together`,
    );

  const texts = push
    ? []
    : [
        { file: 'title.txt', source: 'title', text: title },
        { file: 'body.txt', source: 'body', text: body },
      ];
  if (env.PR_BRANCH !== undefined)
    texts.push({ file: 'branch.txt', source: 'branch name', text: env.PR_BRANCH });
  else console.log('pr-text-scan: no PR_BRANCH, so the branch name was not scanned.');
  const identities = [];
  const people = [];
  if (hasBase) {
    for (const c of commits(env.BASE_SHA, env.HEAD_SHA)) {
      texts.push({ file: `commit-${c.sha}.txt`, source: `commit ${c.sha}`, text: c.message });
      people.push(c);
      identities.push(
        ...identityFindings(`author of commit ${c.sha}`, c.author),
        ...identityFindings(`committer of commit ${c.sha}`, c.committer),
      );
    }
  } else {
    console.log('pr-text-scan: no BASE_SHA / HEAD_SHA, so commit messages were not scanned.');
  }

  const leak = leakScan(texts, env.REQUIRE_NEEDLES === 'true', people);
  const findings = [
    ...texts.flatMap((t) =>
      t.source === 'branch name' ? branchFindings(t.text) : phraseFindings(t.source, t.text),
    ),
    ...identities,
    ...leak.identity.hits,
  ];
  for (const f of findings) {
    console.error(
      f.line === 0
        ? `pr-text-scan: "${f.phrase}" in the ${f.source}`
        : `pr-text-scan: "${f.phrase}" in the ${f.source}, line ${f.line}`,
    );
  }
  if (leak.identity.unnamed > 0)
    console.error(
      `pr-text-scan: and ${leak.identity.unnamed} more identity fields hold a private needle (the leak scan names ten per rule)`,
    );
  const count = findings.length + leak.identity.unnamed;
  const branchLeak = !leak.ok && /^ {4}branch\.txt:\d+/m.test(leak.out);
  const branchDigits = /AWS account id[^\n]*\n(?: {4}\S+:\d+[^\n]*\n)*? {4}branch\.txt:/.test(
    leak.out,
  );
  if (count > 0) {
    if (findings.some((f) => f.phrase !== 'private needle')) console.error(`pr-text-scan: ${FIX}`);
    if (findings.some((f) => f.source.includes('commit ') && f.line > 0))
      console.error(
        "pr-text-scan: to fix a commit message: reword it with `git rebase -i origin/main`, then `git push --force-with-lease --force-if-includes` on the pull request's own branch; the text of a title or a body is edited on the pull request",
      );
    if (leak.identity.hits.length + leak.identity.unnamed > 0)
      console.error(
        'pr-text-scan: a private needle in an author or committer is handled as a leak: a force-push does not unpublish what was already pushed; ask the maintainer before rewriting the history',
      );
    if (findings.some((f) => f.line === 0 && f.phrase !== 'private needle'))
      console.error(
        'pr-text-scan: to fix an author or committer of the last commit: `git commit --amend --no-edit --reset-author` with the right identity configured (an earlier commit: mark it `edit` in `git rebase -i origin/main`, amend it the same way, then `git rebase --continue`)',
      );
  }
  if (findings.some((f) => f.source === 'branch name') || branchLeak)
    console.error(
      "pr-text-scan: to fix the branch name: a pull request's branch cannot be renamed, so push the work to a branch with another name and open the pull request from it" +
        (branchDigits
          ? ' (a branch name holding a twelve-digit run, such as a yyyymmddhhmm stamp, fails the account-id rule)'
          : ''),
    );

  for (const n of leak.notes) console.log(n);
  if (leak.migration !== '') console.log(leak.migration);
  if (!leak.ok) {
    console.error(
      '\npr-text-scan: the leak scan refused this text (file names: title.txt, body.txt, branch.txt, commit-<sha>.txt):',
    );
    console.error(leak.out);
    console.error(
      'pr-text-scan: a leak (a secret or private text) is handled apart from a phrase: a force-push does not unpublish what was already pushed. Rotate a credential first; for other private text, open a new pull request from a clean branch and ask the maintainer about removing the old one.',
    );
  }

  if (count > 0 || !leak.ok) {
    console.error(
      `pr-text-scan: FAILED: ${count} finding(s)${leak.ok ? '' : ', and the leak scan'} (scanned ${texts.length} text(s))`,
    );
    return 1;
  }
  console.log(
    `pr-text-scan: clean (${texts.length} text(s), ${people.length} commit(s) with their authors and committers)`,
  );
  return 0;
}

try {
  process.exitCode = main(process.env, process.argv.slice(2).includes('--push'));
} catch (err) {
  console.error(
    `pr-text-scan: FAILED to run: ${err instanceof InputError ? err.message : err && err.stack}`,
  );
  process.exitCode = 2;
}
