#!/usr/bin/env node
'use strict';

// Pre-publish leak scan — a launch gate, not a nicety.
//
// Before pushing any public-bound snapshot (and before flipping visibility), every public-bound byte gets
// scanned for things that must not leave the private world. Two classes of finding:
//
//   HARD   — always a failure, in any repo, at any time: credentials, private keys, non-noreply email
//            addresses, and absolute local machine paths. None of these are ever correct to ship.
//   MIGRATION — expected in the pre-launch repo, forbidden in the curated snapshot: stale references to the
//            old repo owner/URL, and dangling references to private docs (both the private path prefix AND
//            bare numbered doc-names, which dangle just as hard without the directory).
//            Informational by default; pass `--snapshot` to make them failures.
//
// Usage
//   node scripts/leak-scan.cjs                  # tracked working-tree files; migration findings informational
//   node scripts/leak-scan.cjs --snapshot       # the Stage-4 gate: migration findings are failures
//   node scripts/leak-scan.cjs --history        # every blob reachable from every ref (see below)
//   node scripts/leak-scan.cjs --dir <path>     # an arbitrary tree — use it on an UNPACKED npm tarball
//
// Scan the tarball, not just the source. `dist/` and the sourcemaps are gitignored, so neither the tracked-file
// nor the history enumeration can see what actually ships — and preserved JSDoc plus `sourcesContent` carry
// every comment from `src` into the published artifact. An npm tarball is immutable outside the 72-hour
// unpublish window, so it is the one thing that cannot be quietly fixed later:
//
//     pnpm pack --pack-destination /tmp/tb   # in each packages/* dir
//     tar -xzf /tmp/tb/cloudbitmaps-roaring-*.tgz -C /tmp/tb
//     node scripts/leak-scan.cjs --snapshot --dir /tmp/tb/package
//
// Two things the file enumeration gets deliberately right, because the naive versions both leak:
//
//   * Working-tree mode lists **tracked** files (`git ls-files`), not the filesystem. Untracked/ignored files
//     are not public-bound, and walking the filesystem instead would scan `.leak-needles` — the one file whose
//     entire purpose is to hold strings that must never be committed — turning the gate permanently red and
//     echoing those strings into the log.
//   * History mode enumerates **every blob reachable from every ref** (`git rev-list --objects --all`), not
//     `git log -p`. `git log -p` walks HEAD only and emits no diff for merge commits, so a secret introduced
//     as a merge-conflict resolution, or sitting on an unmerged branch, is invisible to it — while
//     `git push --mirror` (the migration mechanic in the launch runbook) pushes every one of those
//     refs. Scanning the reachable object set is the only enumeration that matches what a push carries.
//
// Extra needles that must NOT be committed (an employer name, a real address, a former handle) go in a
// gitignored `.leak-needles` file — one case-insensitive regex per line, `#` comments allowed — or in
// `LEAK_SCAN_EXTRA` as a newline-separated list. Putting them in this file would itself be the leak, and their
// matches are reported REDACTED for the same reason.

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const USAGE = 'usage: leak-scan.cjs [--snapshot] [--history] [--dir <path>]';
const KNOWN_FLAGS = new Set(['--snapshot', '--history', '--dir']);
const unknown = argv.filter(
  (a) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !a.startsWith('--dir='),
);
if (unknown.length > 0) {
  // A typo in the one flag that turns this into a gate must not silently turn it back into a report.
  console.error(`leak-scan: unknown flag(s): ${unknown.join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}
const SNAPSHOT = argv.includes('--snapshot');
const HISTORY = argv.includes('--history');
const dirAt = argv.indexOf('--dir');
const dirEq = argv.find((a) => a.startsWith('--dir='));
const DIR =
  dirEq !== undefined ? dirEq.slice('--dir='.length) : dirAt >= 0 ? argv[dirAt + 1] : undefined;
if ((dirAt >= 0 || dirEq !== undefined) && (DIR === undefined || DIR === '')) {
  console.error('leak-scan: --dir needs a path');
  console.error(USAGE);
  process.exit(2);
}
if (DIR !== undefined && HISTORY) {
  console.error(
    'leak-scan: --dir and --history are mutually exclusive (a plain directory has no history)',
  );
  process.exit(2);
}

/** Never scanned: lockfiles (noise, no secrets we author) and binaries. */
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
/**
 * Paths (repo-relative) skipped wholesale. This scanner's own test file exists ONLY to hold secret-shaped
 * fixtures — `DJANGO_SECRET_KEY=…`, a fake `ghp_` token, a private-key header — so scanning it means the gate is
 * permanently red on strings that are the point. Same reasoning as `.leak-needles` being gitignored, and the same
 * risk if forgotten: a red gate gets bypassed with `--force`, and then it protects nothing.
 *
 * Deliberately an exact-path allowlist, not a `tests/` glob: a real credential committed under `tests/` is still
 * a real credential, and this is the one file whose contents are auditable by reading the assertions.
 */
const SKIP_PATHS = new Set(['tests/scripts/leak-scan.test.ts']);
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|tgz|gz|node|wasm|woff2?|ttf|eot|mp4|crbm|p12|pfx|jks|keystore)$/i;
/** Blobs bigger than this are almost certainly data, and reading them all would dominate the runtime. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

// --- patterns -------------------------------------------------------------------------------------------

// Hosts where inline credentials are throwaway container credentials, not a leak — our own integration lane
// hands these to docker-compose. Defined ONCE and shared by the URL rule and the email allowlist: they used to
// disagree, so `mysql://root:pw@host.docker.internal` was exempted by the URL rule and then flagged by the email
// rule as `pw@host.docker.internal`.
const LOCAL_HOSTS = String.raw`localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal`;

const HARD = [
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /aws_secret_access_key\s*[=:]/i },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b|\bxapp-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  // A URL carrying inline credentials — but not against a loopback or docker-compose host, where they are
  // the throwaway ones our own integration lane hands to a container. Shared with `EMAIL_OK` below, because
  // keeping two copies is what caused the bug: this rule correctly exempted
  // `mysql://root:pw@host.docker.internal`, and then the *email* rule flagged `pw@host.docker.internal` anyway,
  // so the exemption was defeated by a different rule and a compose DSN still failed the gate.
  {
    name: 'credentials in a URL',
    re: new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@(?!${LOCAL_HOSTS})`, 'i'),
  },
  { name: 'bearer/authorization literal', re: /authorization\s*[=:]\s*['"]?bearer\s+\S/i },
  // A secret assigned a real-looking literal. Quotes are OPTIONAL on purpose: the quoted form is the JS/TS
  // shape, but secrets leak in `.env` / YAML / shell / CI-variable shapes, which are unquoted. Placeholder and
  // env-indirection values are excluded so a config template doesn't trip it.
  //
  // Three refinements, each from a defect this pattern actually had (see tests/scripts/leak-scan.test.ts):
  //
  //   1. `[A-Za-z0-9_]*` after the keyword. The keyword used to have to sit *immediately* before the `=`/`:`, so
  //      any env-var name with a SUFFIX slipped through: `DJANGO_SECRET_KEY=…` (the `SECRET_KEY` convention is
  //      near-universal — Django, Flask, Rails) and `MY_API_TOKEN_VALUE=…` were both unflagged. Verified against
  //      the pre-fix script, not assumed. (The AWS secret-key env var was never in this gap — it has its own
  //      dedicated rule above. Worth stating, because it is the example one reaches for first and it is wrong.)
  //   2. `(?![A-Za-z_$][\w$.]*\s*\()` — reject a value that is a CALL EXPRESSION. `const token =
  //      crypto.randomUUID();` was reported as a hardcoded secret (the callee is 17 chars of otherwise-legal
  //      literal characters), which fired on five shipped driver files and would have failed the `--snapshot`
  //      gate outright. A scanner that cries wolf gets bypassed, so a false positive here is not cosmetic.
  //   3. `(?!\d+\b)` — reject an all-numeric value, so widening (1) can't newly trip on `tokenExpiryNanos =
  //      1730000000000000000`. A real secret is essentially never pure digits.
  {
    name: 'hardcoded secret literal',
    re: /(?:api[_-]?key|secret|password|passwd|passphrase|token|credential)s?[A-Za-z0-9_]*\s*[=:]\s*['"]?(?![A-Za-z_$][\w$.]*\s*\()(?!\d+\b)(?!.*(?:process\.env|\$\{|<|xxx|placeholder|your[_-]|example|redacted|changeme|\.\.\.))[A-Za-z0-9/+_=.-]{16,}/i,
  },
  { name: 'absolute local machine path', re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\// },
];

// Any email address that is not a GitHub noreply, an SSH git remote, or an obvious doc placeholder.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_OK = new RegExp(
  '(?:' +
    [
      String.raw`^[A-Za-z0-9._%+-]*@users\.noreply\.github\.com$`,
      String.raw`^git@(?:github|gitlab|bitbucket)\.`,
      String.raw`@example\.(?:com|org|net)$`,
      String.raw`@your-?domain`,
      String.raw`@company\.example`,
      String.raw`@acme\.example`,
      // Not an email at all — the host half of a compose/loopback DSN (`root:pw@host.docker.internal`).
      `@(?:${LOCAL_HOSTS})$`,
    ].join('|') +
    ')',
  'i',
);

const MIGRATION = [
  { name: 'stale old-owner repo URL', re: /github\.com\/sharvilk\/cloud-roaring/ },
  // Both the full path and the `docs/`-relative form a doc inside `docs/` would use.
  { name: 'private-doc path', re: /(?:docs\/)?internal\/[0-9A-Za-z]/ },
  // Bare doc-names: the internal docs are numbered `NN-NAME.md`, so a citation that dropped the directory
  // still dangles. Matches the `NN-SCREAMING-CASE.md` shape every internal design doc uses.
  { name: 'bare private-doc name', re: /\b\d{2}-[A-Z][A-Z0-9-]*\.md\b/ },
  { name: 'private handbook repo', re: /sharvilk\/meta-standards/ },
];

/** Operator-supplied needles. Reported by index and with the match REDACTED — they are secrets themselves. */
function extraNeedles() {
  const raw = [];
  const file = join(ROOT, '.leak-needles');
  if (existsSync(file)) raw.push(...readFileSync(file, 'utf8').split('\n'));
  raw.push(...(process.env.LEAK_SCAN_EXTRA ?? '').split('\n'));

  const out = [];
  for (const line of raw) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    try {
      out.push({ name: `extra needle #${out.length + 1}`, re: new RegExp(t, 'i'), redact: true });
    } catch (err) {
      // Don't echo the needle itself in the error — that is the string we are protecting.
      console.error(
        `leak-scan: extra needle #${out.length + 1} is not a valid regex: ${(err && err.message) || err}`,
      );
      console.error(
        '           (note: needles are separated by NEWLINES, so `|` is safe inside one)',
      );
      process.exit(2);
    }
  }
  return out;
}

// --- enumeration ----------------------------------------------------------------------------------------

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, ...opts });

/**
 * Every file under an arbitrary directory (the `--dir` mode, for an unpacked tarball). Uses `withFileTypes`
 * and never follows symlinks, so a dangling link cannot crash the scan.
 */
function dirFiles(root) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const rel = relative(root, child);
        if (!SKIP_FILES.has(entry.name) && !SKIP_PATHS.has(rel) && !BINARY_EXT.test(entry.name))
          out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

/** Tracked files in the working tree — the public-bound set. */
function trackedFiles() {
  return git(['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && !SKIP_FILES.has(f) && !SKIP_PATHS.has(f) && !BINARY_EXT.test(f));
}

/**
 * Every blob reachable from every ref, as `{ label, text }`. `label` is the last path git saw that blob at,
 * which is enough to find it; the same content at several paths is scanned once.
 */
function reachableBlobs() {
  const named = new Map(); // sha -> a path git associated with it
  for (const line of git(['rev-list', '--objects', '--all'], { encoding: 'utf8' }).split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    if (sp > 0) named.set(line.slice(0, sp), line.slice(sp + 1));
  }
  if (named.size === 0) return [];

  // One `--batch-check` pass to keep only blobs of a sane size and a non-binary path.
  const check = git(['cat-file', '--batch-check'], {
    input: [...named.keys()].join('\n') + '\n',
    encoding: 'utf8',
  });
  const wanted = [];
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (type !== 'blob' || sha === undefined) continue;
    const path = named.get(sha) ?? sha;
    if (SKIP_FILES.has(path) || SKIP_PATHS.has(path) || BINARY_EXT.test(path)) continue;
    if (Number(size) > MAX_BLOB_BYTES) continue;
    wanted.push({ sha, path });
  }
  if (wanted.length === 0) return [];

  // One `--batch` pass to read them. Buffer, not string: sizes in the header are byte counts.
  const buf = git(['cat-file', '--batch'], { input: wanted.map((w) => w.sha).join('\n') + '\n' });
  const byPath = new Map(wanted.map((w) => [w.sha, w.path]));
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const [sha, type, size] = buf.toString('utf8', off, nl).split(' ');
    off = nl + 1;
    const n = Number(size);
    if (type !== 'blob' || !Number.isFinite(n)) break; // malformed / missing — stop rather than mis-slice
    out.push({ label: byPath.get(sha) ?? sha, text: buf.toString('utf8', off, off + n) });
    off += n + 1; // trailing newline git appends after the content
  }
  return out;
}

/** `{ file, line, text }` for every line to scan, in whichever mode. */
function* lines() {
  if (HISTORY) {
    for (const { label, text } of reachableBlobs()) {
      let n = 0;
      for (const t of text.split('\n')) {
        n += 1;
        yield { file: label, line: n, text: t };
      }
    }
    return;
  }
  const base = DIR === undefined ? ROOT : resolve(DIR);
  for (const file of DIR === undefined ? trackedFiles() : dirFiles(base)) {
    let src;
    try {
      src = readFileSync(join(base, file), 'utf8');
    } catch {
      continue; // deleted-but-tracked, or not text
    }
    let n = 0;
    for (const t of src.split('\n')) {
      n += 1;
      yield { file, line: n, text: t };
    }
  }
}

// --- scanning -------------------------------------------------------------------------------------------

const hard = [];
const migration = [];
const extra = extraNeedles();

for (const { file, line, text } of lines()) {
  for (const p of [...HARD, ...extra]) {
    if (p.re.test(text)) {
      hard.push({
        p: p.name,
        file,
        line,
        text:
          p.redact === true ? '<redacted — matched a private needle>' : text.trim().slice(0, 160),
      });
    }
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!EMAIL_OK.test(m[0])) hard.push({ p: 'email address', file, line, text: m[0] });
  }
  // `docs/internal/` is dropped wholesale from the public snapshot, so a private-doc reference *inside* it is
  // not a leak — only references from public-bound files matter. (HARD findings still apply everywhere: a
  // committed credential is a problem regardless of which tree it sits in.)
  if (file.startsWith('docs/internal/')) continue;
  for (const p of MIGRATION) {
    // A line that already matched the full path shouldn't also report as a bare doc-name — same defect, and
    // the double count hides how many *genuinely* bare citations exist.
    if (p.name === 'bare private-doc name' && /(?:docs\/)?internal\//.test(text)) continue;
    if (p.re.test(text)) migration.push({ p: p.name, file, line, text: text.trim().slice(0, 160) });
  }
}

// --- report ---------------------------------------------------------------------------------------------

const byPattern = (findings) => {
  const m = new Map();
  for (const f of findings) m.set(f.p, [...(m.get(f.p) ?? []), f]);
  return m;
};

const show = (label, findings, limit) => {
  console.log(`\n${label} — ${findings.length} finding(s)`);
  for (const [pattern, hits] of byPattern(findings)) {
    console.log(`  ${pattern}: ${hits.length}`);
    for (const h of hits.slice(0, limit)) console.log(`    ${h.file}:${h.line}  ${h.text}`);
    if (hits.length > limit) console.log(`    … ${hits.length - limit} more`);
  }
};

const mode = HISTORY
  ? 'history (every blob reachable from every ref)'
  : DIR === undefined
    ? 'tracked working-tree files'
    : `directory ${resolve(DIR)}`;
console.log(
  `leak-scan: ${mode}${SNAPSHOT ? ' · SNAPSHOT MODE (migration findings are failures)' : ''}`,
);
if (extra.length === 0) {
  // Under `--snapshot` this is FATAL, not a warning. `.leak-needles` is gitignored, so a snapshot built with
  // `git archive` never contains it — meaning the employer-name check the gate advertises would silently be
  // off in exactly the tree it exists to protect. Export `LEAK_SCAN_EXTRA` or copy the file in first.
  const msg =
    'no extra needles configured (.leak-needles / LEAK_SCAN_EXTRA) — employer names and other\n' +
    '           project-specific strings are NOT being checked.';
  if (SNAPSHOT) {
    console.error(`leak-scan: ${msg}`);
    console.error(
      '           Refusing to certify a snapshot with this check disabled. `.leak-needles` is gitignored, so\n' +
        '           a `git archive` snapshot will not carry it — pass the needles via LEAK_SCAN_EXTRA instead.',
    );
    process.exit(2);
  }
  console.log(`leak-scan: ${msg} Add them before the Stage-4 gate.`);
} else {
  console.log(`leak-scan: ${extra.length} extra needle(s) configured`);
}

if (hard.length > 0) show('HARD (always a failure)', hard, 10);
if (migration.length > 0) {
  show(
    SNAPSHOT ? 'MIGRATION (failure in snapshot mode)' : 'MIGRATION (informational)',
    migration,
    5,
  );
}
if (hard.length === 0 && migration.length === 0) console.log('leak-scan: clean');

const failed = hard.length > 0 || (SNAPSHOT && migration.length > 0);
if (failed) {
  console.error(
    `\nleak-scan: FAILED — ${hard.length} hard finding(s)` +
      (SNAPSHOT ? ` + ${migration.length} migration finding(s)` : ''),
  );
}
process.exit(failed ? 1 : 0);
