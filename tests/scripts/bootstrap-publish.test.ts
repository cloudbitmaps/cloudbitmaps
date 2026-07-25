import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards `scripts/bootstrap-publish.cjs` — the one-time, irreversible first publish. Its dry-run path is easy
// to exercise and was; its LIVE path is not, because the last thing it does is publish to npm for real. That
// asymmetry shipped a crash:
//
//   `execFileSync` returns NULL — not a string — whenever stdout is inherited rather than piped, and the build
//   and publish steps inherit deliberately so pnpm's progress and npm's 2FA prompt reach the terminal. The
//   `run()` helper called `.trim()` on that result unconditionally, so the script threw `Cannot read properties
//   of null` the moment it got past the preconditions. Every precondition had passed; the operator had already
//   typed `--confirm`.
//
// So the live path gets covered here by putting fake `pnpm`, `npm`, `git` and `gh` executables ahead of the
// real ones on PATH. Nothing is published, and the script cannot tell the difference — which is the point: a
// publish script that is only ever tested up to the publish is untested where it matters most.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'bootstrap-publish.cjs');
const VERSION = '0.1.0-rc.0';

interface Shims {
  /** stdout for `npm view <pkg> versions --json`. Exit 1 (a 404) means "name is free". */
  npmViewVersionsExitCode?: number;
  /** stdout for `npm view <pkg> dist-tags --json`. */
  distTags?: Record<string, string>;
}

/**
 * Build a throwaway workspace whose preconditions all pass, then run the script in it with `argv`.
 * `bin/` shadows the real toolchain, so "publishing" appends to a call log instead of hitting the registry.
 * Returns that log as `calls` so assertions can check what was actually invoked, not merely what was printed.
 */
function runScript(
  argv: string[],
  shims: Shims = {},
): { status: number; out: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-publish-test-'));
  try {
    // The script resolves ROOT from its own location, so a copy in <dir>/scripts/ treats <dir> as the repo.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'scripts', 'bootstrap-publish.cjs'));

    for (const name of ['core', 'roaring']) {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(
        join(dir, 'packages', name, 'package.json'),
        JSON.stringify(
          { name: `@cloudbitmaps/${name}`, version: VERSION, publishConfig: { access: 'public' } },
          null,
          2,
        ),
      );
    }

    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };

    // A clean tree, without needing a real git repo (and without git's identity config).
    shim('git', 'exit 0');
    shim('gh', `echo '{"visibility":"PUBLIC","nameWithOwner":"cloudbitmaps/cloudbitmaps"}'`);

    const viewExit = shims.npmViewVersionsExitCode ?? 1;
    const tags = JSON.stringify(shims.distTags ?? { rc: VERSION });
    shim(
      'npm',
      [
        'case "$1 $3" in',
        '  "whoami ") echo tester; exit 0;;',
        'esac',
        'case "$1" in',
        '  whoami) echo tester; exit 0;;',
        '  view)',
        '    case "$3" in',
        `      versions) exit ${viewExit};;`,
        `      dist-tags) echo '${tags}'; exit 0;;`,
        '    esac;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    // Records what it was asked to do, so a test can assert on the real argv rather than the printed plan.
    const callLog = join(dir, 'pnpm-calls.log');
    shim('pnpm', `echo "pnpm $*" >> "${callLog}"\nexit 0`);
    const readCalls = () => {
      try {
        return readFileSync(callLog, 'utf8');
      } catch {
        return '';
      }
    };

    try {
      const out = execFileSync(
        process.execPath,
        [join(dir, 'scripts', 'bootstrap-publish.cjs'), ...argv],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        },
      );
      return { status: 0, out, calls: readCalls() };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? 1,
        out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
        calls: readCalls(),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-publish', () => {
  it('completes the LIVE path without throwing — the null-stdout regression', () => {
    const { status, out } = runScript(['--confirm']);
    // The specific crash: `.trim()` on execFileSync's null return under inherited stdio.
    expect(out).not.toMatch(/Cannot read properties of null/);
    expect(out).not.toMatch(/TypeError/);
    expect(status).toBe(0);
    expect(out).toMatch(/bootstrap-publish: done/);
  });

  it('publishes under the prerelease dist-tag, never latest', () => {
    const { out, calls } = runScript(['--confirm']);
    // Derived from the version (0.1.0-rc.0 -> rc), because npm's default tag is `latest` unconditionally and
    // a first publish under `latest` would make the throwaway the default install.
    expect(out).toMatch(/dist-tag: rc/);
    expect(out).toMatch(/latest unset/);
    // Assert the argv actually handed to pnpm, not just the plan the script printed — the printed line and
    // the executed command are two different things, and only one of them reaches the registry.
    expect(calls).toMatch(/^pnpm .*\bpublish\b.*--tag rc\b/m);
    expect(calls).toMatch(/--access public/);
  });

  it('fails if the prerelease ended up holding the latest tag', () => {
    const { status, out } = runScript(['--confirm'], {
      distTags: { rc: VERSION, latest: VERSION },
    });
    expect(out).toMatch(/must not hold latest/);
    expect(status).toBe(1);
  });

  it('refuses when a package name already exists on the registry', () => {
    const { status, out } = runScript([], { npmViewVersionsExitCode: 0 });
    expect(out).toMatch(/already exists on the registry/);
    expect(status).toBe(1);
  });

  it('publishes nothing without --confirm', () => {
    const { status, out } = runScript([]);
    expect(status).toBe(0);
    expect(out).toMatch(/dry run/);
    expect(out).toMatch(/nothing was sent/);
    expect(out).not.toMatch(/bootstrap-publish: done/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const { status, out } = runScript(['--yolo']);
    expect(out).toMatch(/unknown argument\(s\): --yolo/);
    expect(status).toBe(2);
  });
});
