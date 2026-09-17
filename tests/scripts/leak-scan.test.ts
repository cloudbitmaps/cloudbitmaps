import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards `scripts/leak-scan.cjs` — the script that decides whether a tree is safe to make public. Nothing else
// in the gate protects it, which is exactly why two real defects survived in it until the Stage-3 tarball audit:
//
//   1. FALSE POSITIVE — `const token = crypto.randomUUID();` was reported as a "hardcoded secret literal",
//      because the callee happens to be 17 characters of otherwise-legal literal characters. It fired on five
//      shipped driver bundles (the random-UUID OCC tokens) and would have failed the `--snapshot` gate outright.
//      That is not cosmetic: a scanner that cries wolf gets bypassed with `--force`, and then it protects nothing.
//   2. FALSE NEGATIVE — any env-var name with a SUFFIX slipped through, because the keyword had to sit
//      *immediately* before the `=`/`:`. `DJANGO_SECRET_KEY=…` and `MY_API_TOKEN_VALUE=…` were both unflagged,
//      and the `SECRET_KEY` convention is near-universal (Django, Flask, Rails). Verified against the pre-fix
//      script rather than assumed — `AWS_SECRET_ACCESS_KEY=…` is NOT an example of this gap, since it has its own
//      dedicated rule, and reaching for it as the example is the mistake to avoid here.
//
// Both directions are pinned here. A scanner is only as trustworthy as its worst false positive and its worst
// false negative, so neither list is allowed to shrink.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'leak-scan.cjs');

/** Run the scanner over a throwaway dir containing exactly `content`, and return `{ status, out }`. */
function scan(content: string, filename = 'sample.ts'): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-test-'));
  try {
    const target = join(dir, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    try {
      const out = execFileSync(process.execPath, [SCRIPT, '--dir', dir], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('leak-scan', () => {
  it('scans a directory and exits 0 on a clean tree', () => {
    const { status, out } = scan('export const answer = 42;\n');
    expect(status).toBe(0);
    expect(out).not.toMatch(/HARD/);
  });

  describe('does NOT flag benign code (a false positive here gets the scanner bypassed)', () => {
    // The exact five lines the real tarball audit tripped on.
    it.each([
      'const token = crypto.randomUUID();',
      'const token = randomUUID();',
      'const tok = generateSecureToken();',
      'password: getSecretFromVault(),',
      'const secret = await loadCredentialFromDisk();',
    ])('a call expression: %s', (line) => {
      expect(scan(`${line}\n`).status).toBe(0);
    });

    it.each([
      'apiKey: process.env.MY_API_KEY,',
      'const token = `${prefix}-suffix`;',
      "password: 'your-password-here',",
      "secret: 'changeme',",
    ])('env indirection / placeholder: %s', (line) => {
      expect(scan(`${line}\n`).status).toBe(0);
    });

    // Defect 3, found by the ESM-only review: a value that READS A PROPERTY is not a literal. The S3
    // backend's `...(options.credentials === undefined ? {} : { credentials: options.credentials })` was
    // reported as a hardcoded secret and failed the RELEASE workflow's tarball scan — a step no other job
    // runs, so `pnpm test` and 14 CI checks were green while releases were blocked. `credentials` is the AWS
    // SDK's own option name, so this collision cannot be renamed away; the rule had to learn the difference.
    // These four each go from flagged to clean purely because of the property-read lookahead — verified by
    // removing it and watching them fail. (`config.applicationSecret;` and `fn(opts.apiKeyMaterial, …)` are
    // NOT in this list: the older call-expression lookahead already excused them, so they would look like
    // regression tests for this fix while pinning nothing.)
    it.each([
      'const c = { credentials: options.credentials };',
      '...(options.credentials === undefined ? {} : { credentials: options.credentials }),',
      'return { token: this.session.accessToken };',
      'const p = { password: creds.databasePassword, port: 5432 };',
    ])('a property read in a .ts file: %s', (line) => {
      expect(scan(`${line}\n`).status).toBe(0);
    });

    it.each(['sample.mts', 'sample.cts', 'sample.js', 'sample.mjs', 'sample.jsx', 'sample.tsx'])(
      'the same exemption applies in %s',
      (filename) => {
        expect(scan('const c = { credentials: options.credentials };\n', filename).status).toBe(0);
      },
    );

    // Guards the widening that fixed defect 2 — it must not newly trip on long numbers.
    it.each(['tokenExpiryNanos = 1730000000000000000', 'const tokenCount = 1234567890123456789;'])(
      'an all-numeric value: %s',
      (line) => {
        expect(scan(`${line}\n`).status).toBe(0);
      },
    );
  });

  // THE EXEMPTION IS SCOPED TO JS/TS, and this block is why. The first version of the property-read fix
  // applied everywhere, and an adversarial review found 24 real secret shapes it stopped catching: outside a
  // JS-like language the closer set `[),;}\]]` is wrong, because `,` and `;` SEPARATE VALUES in shell,
  // Makefiles, Dockerfiles, .env, .ini, .toml, SQL, CSV and connection strings, while `)` and `}` turn up in
  // ordinary prose. Each line below was caught before that fix, missed after it, and is caught again now.
  describe('still flags an unquoted dotted secret outside JS/TS (the scoping of the exemption)', () => {
    it.each([
      // `Password=…;` is the canonical spelling of an ADO.NET connection-string secret; `;` is mandatory.
      [
        'an ADO.NET connection string',
        'appsettings.json',
        'Server=db;Password=Hunter2.Winter.Season2024;',
      ],
      ['a shell export', 'deploy.sh', 'export DB_PASSWORD=_secret_part.another_part.third_part9;'],
      [
        'a Dockerfile RUN',
        'Dockerfile',
        'RUN export DB_PASSWORD=Hunter2.Winter.SeasonTwentyFour; ./go.sh',
      ],
      ['a .env with a trailing comma', 'vars.env', 'API_TOKEN=Hunter2.Winter.SeasonTwentyFour,'],
      ['an ini file', 'config.ini', 'password=Str0ng.Passw0rd.Value99;'],
      ['a toml inline table', 'config.toml', 'creds = { password = Str0ng.Passw0rd.Value99 }'],
      ['a SQL seed', 'seed.sql', 'INSERT INTO cfg VALUES (password=Hunter2.WinterSeasonFour);'],
      // The most likely route by which a real credential reaches a public README.
      [
        'a token pasted in a markdown link',
        'RUNBOOK.md',
        'See [board](https://g.internal/d?api_key=eyJhbGciOiJIUzI1NiIsInR.eyJzdWIiOiIxMjMONDU2Nzg5.SflKxwRJSMeKKFQTjc)',
      ],
      ['a single dot is enough', 'prod.env', 'SECRET_KEY=Winter2024.ProductionKeyValue;'],
    ])('%s (%s)', (_label, filename, line) => {
      const { status, out } = scan(`${line}\n`, filename);
      expect(status).toBe(1);
      expect(out).toMatch(/hardcoded secret literal/);
    });
  });

  describe('DOES flag real secrets', () => {
    it.each([
      ['a bare quoted literal', 'const token = "aB3xY9zQ1mN7pL2kR5tV8w";'],
      ['an unquoted .env shape', 'api_key=AKIAJ7Q2M4N5P6R8S9T0'],
      ['a YAML shape', '  DB_PASSWORD: sup3rS3cretDatabasePw99'],
      ['a suffixed env-var name', 'DJANGO_SECRET_KEY=aB3xY9zQ1mN7pL2kR5tV8w'],
      ['another suffixed shape', 'MY_API_TOKEN_VALUE=aB3xY9zQ1mN7pL2kR5tV8w'],
      ['a passphrase', 'passphrase:"correct-horse-battery-staple-99"'],
      // The boundary of defect 3's fix, from both sides. Narrowing a secret rule is the direction that
      // blinds a scanner, so every shape the new lookahead could have swallowed is pinned here.
      // A DOT is required, so a bare word is still a secret even though it is identifier-shaped:
      ['a bare word ending a line', 'API_KEY=aB3xY9zQ1mN7pL2k'],
      ['a bare word before a closing brace', '{api_key: aB3xY9zQ1mN7pL2k}'],
      // A CLOSING TOKEN must follow, so a dotted value that merely ends the line is still a secret —
      // an unquoted JWT in a .env is three identifier-shaped segments and must not be excused:
      [
        'an unquoted JWT at end of line',
        'TOKEN=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
      ],
      // Letter-leading second segment on purpose: with a digit there the identifier shape fails and the
      // line would flag for a reason other than the missing closing token, isolating nothing.
      ['a dotted value ending a line', 'secret=aB3xY9zQ1mN.bL2kR5tV8w'],
      // Quoted always wins: a literal with dots is a literal, wherever it sits.
      [
        'a quoted dotted literal in an object',
        'const o = { token: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJ" };',
      ],
      // The exemption must not reach INSIDE a string. With the quote optional it did: the lookahead ran from
      // the first character of the literal, so a closing token WITHIN the quotes excused the whole value.
      ['a quoted literal containing a closing token', 'const token = "aaaaaaaa.bbbbbbbb};";'],
      [
        'a quoted JWT ending in a paren',
        'const token = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJ)";',
      ],
    ])('%s', (_label, line) => {
      const { status, out } = scan(`${line}\n`);
      expect(status).toBe(1);
      expect(out).toMatch(/hardcoded secret literal/);
    });

    it.each([
      ['a GitHub token', 'const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";'],
      ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n'],
      ['credentials in a URL', 'const dsn = "postgres://user:hunter2@db.internal:5432/x";'],
      ['an absolute local path', '// see /Users/somebody/projects/thing/file.ts'],
    ])('%s', (_label, line) => {
      expect(scan(`${line}\n`).status).toBe(1);
    });

    // Loopback credentials are the throwaway ones our own integration lane hands to containers.
    it('exempts credentials against a loopback/compose host', () => {
      expect(scan('const dsn = "postgres://user:pw@localhost:5432/x";\n').status).toBe(0);
      expect(scan('const dsn = "mysql://root:pw@host.docker.internal:3306/x";\n').status).toBe(0);
    });
  });

  it('always DISCLOSES its needle state, configured or not', () => {
    // `.leak-needles` is gitignored on purpose (committing it would BE the leak), so the scanner has to say
    // which mode it is in rather than reporting a reassuring all-clear either way.
    //
    // Asserting only the "no needles" warning made this test depend on whether a developer happens to have a
    // local `.leak-needles` — green in CI, red on the machine of anyone actually using the feature. The real
    // invariant is disclosure, and it holds in both states. The stronger guarantee (that `--snapshot` REFUSES
    // to certify without needles) is enforced by the script itself and exercised at the Stage-4 gate.
    const { out } = scan('export const x = 1;\n');
    expect(out).toMatch(/no extra needles configured|\d+ extra needle\(s\) configured/);
  });
});
