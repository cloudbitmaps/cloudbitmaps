#!/usr/bin/env node
'use strict';

// The pull-request text check: a pull request's title, its body and its own commit messages are public text, and a
// squash merge copies the commit subjects into `main`'s history for good. Two things must not be in them:
//
//   1. Words about WHO or WHAT did the work. Public text says what was done ("the review gate: run after the PR is
//      up"), never who did it.
//   2. What the leak scan refuses in a tracked file: a credential, a local absolute path, a private-repo or
//      private-doc reference, and the private needles. The texts are written into a temporary directory and
//      `scripts/leak-scan.cjs` is run over it, so PR text gets the same rules as the repository.
//
// Usage (CI passes everything through the environment; locally, give the title and body, and the two commit ids
// to include the commit messages):
//
//     PR_TITLE='…' PR_BODY='…' node scripts/pr-text-scan.cjs
//     PR_TITLE='…' PR_BODY='…' BASE_SHA=<sha> HEAD_SHA=<sha> node scripts/pr-text-scan.cjs
//
//   PR_TITLE   required, non-empty            PR_BODY   required (may be empty: a PR can have no body)
//   BASE_SHA / HEAD_SHA   both or neither; with both, the messages, the author and the committer of every commit of
//                         `git log --first-parent BASE..HEAD` are scanned: the pull request's own commits and its
//                         merges, never the commits a merge of the base branch brought in (those are already public).
//   LEAK_SCAN_EXTRA   the private needles, passed on to the leak scan (absent on a fork's pull request).
//   REQUIRE_NEEDLES   `true` when the needles must be there (the workflow sets it for a pull request from this
//                     repository): the check then fails with exit 2 instead of running without them.
//
// Exit 0 clean; 1 a finding; 2 an input or a tool that could not be read or run. The check fails closed: a missing
// input, a git error, a scan that crashes or exits in a way this script does not know is a failure, never a pass.
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
// What it does not catch: a phrase that is not on the list below, a leak that is reworded (a path written with a
// space in it, an id described in other words), the name of the branch, an author whose identity names no tool, and
// anything in a pull request comment or review, which this script never reads.

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
//   * `Claude` is a case-sensitive whole word, so `CLAUDE.md` and a lower-case path do not match.
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
  { name: 'Claude', test: (t) => /\bClaude\b/.test(t) },
  { name: 'aider', test: (t) => /\(aider\)/i.test(t) },
  { name: 'anthropic address', test: (t) => /noreply@anthropic\.com/i.test(t) },
];

const FIX =
  'fix: say what was done, not who or what did it (public text names the change, never its author)';

/** Phrase findings in one text: `{ phrase, source, line }`. Never the text of the line. */
function phraseFindings(source, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((t, i) => {
    for (const p of PHRASES) {
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
function identityFindings(source, identity) {
  const out = IDENTITY_RULES.filter((r) => r.test(identity)).map((r) => ({
    phrase: r.name,
    source,
    line: 0,
  }));
  for (const p of PHRASES) {
    if (p.re.test(identity) && !out.some((f) => f.phrase === p.name)) {
      out.push({ phrase: p.name, source, line: 0 });
    }
  }
  return out;
}

class InputError extends Error {}

/** A trailer a named dependency bot's commit carries: GitHub writes it, so it is not scanned. */
const BOT_TRAILER =
  /^(?:Signed-off-by|Co-authored-by):\s*(?:dependabot|renovate|github-actions)\[bot\]\s*</i;

/**
 * The pull request's own commits, `[{ sha, author, committer, message }]`: the first-parent line from the base, so a
 * merge commit of the PR is read and the base branch's commits a merge brought in are not.
 */
function commits(base, head) {
  const SHA = /^[0-9a-f]{7,40}$/i;
  if (!SHA.test(base) || !SHA.test(head))
    throw new InputError('BASE_SHA and HEAD_SHA must be commit ids');
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['log', '--first-parent', '--format=%x1e%H%n%an <%ae>%n%cn <%ce>%n%B', `${base}..${head}`],
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
  return raw
    .split('\x1e')
    .filter((c) => c.trim() !== '')
    .map((c) => {
      const lines = c.split('\n');
      if (lines.length < 4) throw new InputError('git log gave a commit with no identity lines');
      return {
        sha: lines[0].trim(),
        author: lines[1],
        committer: lines[2],
        message: lines
          .slice(3)
          .filter((l) => !BOT_TRAILER.test(l))
          .join('\n'),
      };
    });
}

/** The leak scan's report with each finding's text withheld (the location stays), and the needle's index dropped. */
function redact(report) {
  return report
    .replace(/^(\s{4}\S+:\d+)\s{2}.*$/gm, '$1  <text withheld>')
    .replace(/extra needle #\d+/g, 'extra needle');
}

/**
 * The leak scan over the texts. Returns `{ ok, notes }`. With the private needles it runs as a snapshot (private
 * repo and private-doc references fail too); without them (a fork's pull request gets no secrets) it runs without
 * `--snapshot`, so the hard rules still apply, and says the needles were not applied. When the needles are required
 * (a pull request from this repository) their absence is an error, not a pass.
 */
function leakScan(texts, requireNeedles) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-text-'));
  try {
    // A GitHub Actions run or job id in a link is a 12-digit run the account-id rule would refuse, and a link to a
    // failing job is ordinary pull request text, so the ids in that one URL shape are replaced before the scan.
    for (const t of texts) {
      writeFileSync(
        join(dir, t.file),
        t.text.replace(/\/actions\/runs\/\d+(?:\/job\/\d+)?/g, '/actions/runs/ID'),
      );
    }
    const run = (flags) =>
      spawnSync(process.execPath, [join(__dirname, 'leak-scan.cjs'), ...flags, '--dir', dir], {
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
    return { ok: r.status === 0, notes, out, migration: migration ? migration[0] : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(env) {
  const title = env.PR_TITLE;
  const body = env.PR_BODY;
  if (title === undefined || title.trim() === '')
    throw new InputError('PR_TITLE is missing or empty');
  if (body === undefined)
    throw new InputError('PR_BODY is not set (set it to an empty string for no body)');
  const hasBase = env.BASE_SHA !== undefined && env.BASE_SHA !== '';
  const hasHead = env.HEAD_SHA !== undefined && env.HEAD_SHA !== '';
  if (hasBase !== hasHead)
    throw new InputError('BASE_SHA and HEAD_SHA go together: one is missing');

  const texts = [
    { file: 'title.txt', source: 'title', text: title },
    { file: 'body.txt', source: 'body', text: body },
  ];
  const identities = [];
  if (hasBase) {
    for (const c of commits(env.BASE_SHA, env.HEAD_SHA)) {
      texts.push({ file: `commit-${c.sha}.txt`, source: `commit ${c.sha}`, text: c.message });
      identities.push(
        ...identityFindings(`author of commit ${c.sha}`, c.author),
        ...identityFindings(`committer of commit ${c.sha}`, c.committer),
      );
    }
  } else {
    console.log('pr-text-scan: no BASE_SHA / HEAD_SHA, so commit messages were not scanned.');
  }

  const findings = [...texts.flatMap((t) => phraseFindings(t.source, t.text)), ...identities];
  for (const f of findings) {
    console.error(
      f.line === 0
        ? `pr-text-scan: "${f.phrase}" in the ${f.source}`
        : `pr-text-scan: "${f.phrase}" in the ${f.source}, line ${f.line}`,
    );
  }
  if (findings.length > 0) {
    console.error(`pr-text-scan: ${FIX}`);
    if (findings.some((f) => f.source.includes('commit ')))
      console.error(
        'pr-text-scan: to fix a commit: reword it (`git rebase -i`) and push with `--force-with-lease`; the text of a title or a body is edited on the pull request',
      );
  }

  const leak = leakScan(texts, env.REQUIRE_NEEDLES === 'true');
  for (const n of leak.notes) console.log(n);
  if (leak.migration !== '') console.log(leak.migration);
  if (!leak.ok) {
    console.error(
      '\npr-text-scan: the leak scan refused this text (file names: title.txt, body.txt, commit-<sha>.txt):',
    );
    console.error(leak.out);
  }

  if (findings.length > 0 || !leak.ok) {
    console.error(
      `pr-text-scan: FAILED: ${findings.length} process phrase(s)${leak.ok ? '' : ', and the leak scan'} (scanned ${texts.length} text(s))`,
    );
    return 1;
  }
  console.log(
    `pr-text-scan: clean (${texts.length} text(s): title, body, ${texts.length - 2} commit message(s))`,
  );
  return 0;
}

try {
  process.exitCode = main(process.env);
} catch (err) {
  console.error(
    `pr-text-scan: FAILED to run: ${err instanceof InputError ? err.message : err && err.stack}`,
  );
  process.exitCode = 2;
}
