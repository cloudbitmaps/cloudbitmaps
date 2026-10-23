#!/usr/bin/env node
'use strict';

// The pull-request text check: a pull request's title, its body and its own commit messages are public text, and a
// squash merge copies the commit subjects into `main`'s history for good. Two things must not be in them:
//
//   1. Words about WHO or WHAT did the work. Public text says what was done ("the review gate: run after the PR is
//      up"), never who did it. Twice such words reached a pull request body and were caught only by eye.
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
//   BASE_SHA / HEAD_SHA   both or neither; with both, the messages of `git log --no-merges BASE..HEAD` are scanned.
//   LEAK_SCAN_EXTRA   the private needles, passed on to the leak scan (absent on a fork's pull request).
//
// Exit 0 clean; 1 a finding; 2 an input or a tool that could not be read or run. The check fails closed: a missing
// input, a git error, a scan that crashes or exits in a way this script does not know is a failure, never a pass.
//
// What it does not catch: a phrase that is not on the list below, a leak that is reworded (a path written with a
// space in it, an id described in other words), and anything in a pull request comment or review, which this
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
//   * `builder` is only a phrase about the work (`this builder`, `a builder`, `the builder's`, `the builder ran`,
//     `by the builder`): an image builder, a query builder or `docker buildx` builder is legitimate, and so is a
//     sentence about the build tool ("the builder inlines error classes"), so the word alone, and `the builder`
//     before any other verb, are not listed. `a builder pattern` is a known false positive of `a builder`.
//   * `coordinator` is not matched inside a compound (`coordinator-free` is a protocol property).
//   * A trailer a bot's own commit carries (`Signed-off-by: dependabot[bot] <...>`, `Co-authored-by: ...[bot]`) is
//     removed from a commit message before it is scanned: GitHub writes it, and its address is not ours to leak.
//   * `Claude` is a case-sensitive whole word, so `CLAUDE.md` and a lower-case path do not match.
//
// Fix a hit by stating what was done, not who did it. Never widen a phrase to excuse one text: name the look-alike
// narrower, or reword the text.
const PHRASES = [
  { name: 'subagent', re: /\bsub-?agents?\b/i },
  { name: 'coordinator', re: /(?<![\w-])coordinators?(?![\w-])/i },
  { name: 'this session', re: /\bthis session\b/i },
  { name: 'cannot spawn', re: /\b(?:could|can) ?(?:not|n['’]t) spawn/i },
  { name: 'Generated with', re: /\bGenerated with\b/i },
  { name: 'Co-Authored-By', re: /\bCo-Authored-By\b/i },
  { name: 'Claude', re: /\bClaude\b/ },
  {
    name: 'builder (the one who did the work)',
    re: new RegExp(
      [
        String.raw`\b(?:this|a) builder\b`,
        String.raw`\bthe builder(?:['\u2019]s\b| (?:ran|read|killed|re-?checked|wrote|added|found|did|made|had|was|has|reran|restored|caught|first|before|again)\b)`,
        String.raw`\b(?:by|from|and|with|then|which|where) the builder\b`,
      ].join('|'),
      'i',
    ),
  },
];

const FIX =
  'fix: say what was done, not who or what did it (public text names the change, never its author)';

/** Phrase findings in one text: `{ phrase, source, line, text }`. */
function phraseFindings(source, text) {
  const out = [];
  text.split(/\r?\n/).forEach((t, i) => {
    for (const p of PHRASES) {
      if (p.re.test(t))
        out.push({ phrase: p.name, source, line: i + 1, text: t.trim().slice(0, 160) });
    }
  });
  return out;
}

class InputError extends Error {}

/** The messages of the pull request's own commits, `[{ sha, message }]`. */
function commitMessages(base, head) {
  const SHA = /^[0-9a-f]{7,40}$/i;
  if (!SHA.test(base) || !SHA.test(head))
    throw new InputError('BASE_SHA and HEAD_SHA must be commit ids');
  let raw;
  try {
    raw = execFileSync('git', ['log', '--no-merges', '--format=%x1e%H%n%B', `${base}..${head}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new InputError(
      `git log ${base}..${head} failed: ${String(err.stderr || err.message).trim()}`,
    );
  }
  return raw
    .split('\x1e')
    .filter((c) => c.trim() !== '')
    .map((c) => {
      const nl = c.indexOf('\n');
      const message = c
        .slice(nl + 1)
        .split('\n')
        .filter((l) => !/^(?:Signed-off-by|Co-authored-by):.*\[bot\]/i.test(l))
        .join('\n');
      return { sha: c.slice(0, nl).trim(), message };
    });
}

/**
 * The leak scan over the texts. Returns `{ ok, notes }`. With the private needles it runs as a snapshot (private
 * repo and private-doc references fail too); without them (a fork's pull request gets no secrets) it runs without
 * `--snapshot`, so the hard rules still apply, and says the needles were not applied.
 */
function leakScan(texts) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-text-'));
  try {
    for (const t of texts) writeFileSync(join(dir, t.file), t.text);
    const run = (flags) =>
      spawnSync(process.execPath, [join(__dirname, 'leak-scan.cjs'), ...flags, '--dir', dir], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
      });
    let r = run(['--snapshot']);
    const notes = [];
    if (r.error === undefined && r.status === 2 && /no extra needles configured/.test(r.stderr)) {
      notes.push(
        'pr-text-scan: the private needles were not applied (none configured, as on a fork); the credential, ' +
          'local-path and account-id rules ran, the private-repo and private-doc rules are informational.',
      );
      r = run([]);
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
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
    return { ok: r.status === 0, notes, out };
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
  if (hasBase) {
    for (const c of commitMessages(env.BASE_SHA, env.HEAD_SHA)) {
      texts.push({ file: `commit-${c.sha}.txt`, source: `commit ${c.sha}`, text: c.message });
    }
  } else {
    console.log('pr-text-scan: no BASE_SHA / HEAD_SHA, so commit messages were not scanned.');
  }

  const findings = texts.flatMap((t) => phraseFindings(t.source, t.text));
  for (const f of findings) {
    console.error(`pr-text-scan: "${f.phrase}" in the ${f.source}, line ${f.line}: ${f.text}`);
  }
  if (findings.length > 0) console.error(`pr-text-scan: ${FIX}`);

  const leak = leakScan(texts);
  for (const n of leak.notes) console.log(n);
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
