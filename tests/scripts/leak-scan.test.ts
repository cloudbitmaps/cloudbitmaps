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

    // Guards the widening that fixed defect 2 — it must not newly trip on long numbers.
    it.each(['tokenExpiryNanos = 1730000000000000000', 'const tokenCount = 1234567890123456789;'])(
      'an all-numeric value: %s',
      (line) => {
        expect(scan(`${line}\n`).status).toBe(0);
      },
    );
  });

  describe('DOES flag real secrets', () => {
    it.each([
      ['a bare quoted literal', 'const token = "aB3xY9zQ1mN7pL2kR5tV8w";'],
      ['an unquoted .env shape', 'api_key=AKIAJ7Q2M4N5P6R8S9T0'],
      ['a YAML shape', '  DB_PASSWORD: sup3rS3cretDatabasePw99'],
      ['a suffixed env-var name', 'DJANGO_SECRET_KEY=aB3xY9zQ1mN7pL2kR5tV8w'],
      ['another suffixed shape', 'MY_API_TOKEN_VALUE=aB3xY9zQ1mN7pL2kR5tV8w'],
      ['a passphrase', 'passphrase:"correct-horse-battery-staple-99"'],
    ])('%s', (_label, line) => {
      const { status, out } = scan(`${line}\n`);
      expect(status).toBe(1);
      expect(out).toMatch(/hardcoded secret literal/);
    });

    it.each([
      ['a GitHub token', 'const t = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";'],
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

  it('warns that no extra needles are configured — the Stage-4 employer-name check', () => {
    // `.leak-needles` is gitignored on purpose (committing it would BE the leak), so the scanner has to say
    // loudly when it is running without them rather than reporting a reassuring all-clear.
    const { out } = scan('export const x = 1;\n');
    expect(out).toMatch(/no extra needles configured/);
  });
});
