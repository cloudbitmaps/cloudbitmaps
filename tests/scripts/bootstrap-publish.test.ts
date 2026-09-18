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
  /**
   * How `npm view <pkg> versions --json` fails for a name the registry does not have. The script now
   * distinguishes a 404 from every other failure, so the shim has to emit a REALISTIC one: the old shim
   * just exited 1 with no output, which is indistinguishable from a network error and encoded the very
   * bug this distinction fixes.
   */
  npmViewVersionsExitCode?: number;
  /** Emit this on stderr instead of an E404, to simulate a transient registry failure. */
  npmViewStderr?: string;
  /** Write the manifests without a space after the colon, so the version rewrite cannot match. */
  compactManifests?: boolean;
  /** Package dirs to create, and the version they carry. Defaults to core + roaring at `VERSION`. */
  packages?: readonly string[];
  version?: string;
  /** Names the registry ALREADY has — the rest are treated as free. Overrides the blanket exit code. */
  existing?: readonly string[];
  /** stdout for `npm view <pkg> dist-tags --json`. */
  distTags?: Record<string, string>;
  /** How many `view dist-tags` calls 404 before the package shows up, simulating read-replica lag. */
  distTagsLagCalls?: number;
}

/**
 * Build a throwaway workspace whose preconditions all pass, then run the script in it with `argv`.
 * `bin/` shadows the real toolchain, so "publishing" appends to a call log instead of hitting the registry.
 * Returns that log as `calls` so assertions can check what was actually invoked, not merely what was printed.
 */
function runScript(
  argv: string[],
  shims: Shims = {},
): { status: number; out: string; calls: string; manifests: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-publish-test-'));
  try {
    // The script resolves ROOT from its own location, so a copy in <dir>/scripts/ treats <dir> as the repo.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'scripts', 'bootstrap-publish.cjs'));

    const version = shims.version ?? VERSION;
    const pkgDirs = shims.packages ?? ['core', 'roaring'];
    for (const name of pkgDirs) {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      writeFileSync(
        join(dir, 'packages', name, 'package.json'),
        shims.compactManifests
          ? JSON.stringify({
              name: `@cloudbitmaps/${name}`,
              version,
              publishConfig: { access: 'public' },
            })
          : JSON.stringify(
              { name: `@cloudbitmaps/${name}`, version, publishConfig: { access: 'public' } },
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
    // npm's real wording for a name that is not on the registry.
    const viewStderr =
      shims.npmViewStderr ??
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x';
    // Per-name existence, so a MIXED family (two published, three brand new) can be exercised — which is the
    // case that matters now that packages get added to an already-published family.
    const existsCase = (shims.existing ?? []).map((n) => `      ${n}) exit 0;;`).join('\n');
    const tags = JSON.stringify(shims.distTags ?? { rc: version });
    // Simulates the read replica lagging behind the write: the first N `view dist-tags` calls 404 before the
    // package appears, which is what really happens and what used to be reported as a failed publish.
    const lag = shims.distTagsLagCalls ?? 0;
    const counter = join(dir, 'view-calls');
    shim(
      'npm',
      [
        'case "$1" in',
        '  whoami) echo tester; exit 0;;',
        '  view)',
        '    case "$3" in',
        '      versions)',
        '        case "$2" in',
        existsCase,
        `        esac`,
        `        echo "${viewStderr}" >&2`,
        `        exit ${viewExit};;`,
        '      dist-tags)',
        `        n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
        `        if [ "$n" -le ${lag} ]; then exit 1; fi`,
        `        echo '${tags}'; exit 0;;`,
        '    esac;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    // Records what it was asked to do, so a test can assert on the real argv rather than the printed plan —
    // and, on a publish, the version the manifests carried AT THAT MOMENT, which is the only way to see the
    // temporary rewrite from outside.
    const callLog = join(dir, 'pnpm-calls.log');
    shim(
      'pnpm',
      [
        `echo "pnpm $*" >> "${callLog}"`,
        'case "$*" in',
        `  *publish*) grep '"version"' ${join(dir, 'packages')}/*/package.json | sed -e 's|${join(dir, 'packages')}/||' -e 's|/package.json:| |' -e 's/^/  at-publish /' >> "${callLog}";;`,
        'esac',
        'exit 0',
      ].join('\n'),
    );
    const readCalls = () => {
      try {
        return readFileSync(callLog, 'utf8');
      } catch {
        return '';
      }
    };
    // Read before the temp dir is removed, so a test can prove the manifests were put back.
    const readManifests = (): Record<string, string> =>
      Object.fromEntries(
        pkgDirs.map((n) => [n, readFileSync(join(dir, 'packages', n, 'package.json'), 'utf8')]),
      );

    try {
      const out = execFileSync(
        process.execPath,
        [join(dir, 'scripts', 'bootstrap-publish.cjs'), ...argv],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            // Keep the propagation retry exercised but fast; the production default is 15s per attempt.
            CR_BOOTSTRAP_PROPAGATION_GAP_MS: '50',
          },
        },
      );
      return { status: 0, out, calls: readCalls(), manifests: readManifests() };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? 1,
        out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
        calls: readCalls(),
        manifests: readManifests(),
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

  it('publishes under the prerelease dist-tag', () => {
    const { out, calls } = runScript(['--confirm']);
    // Derived from the version (0.1.0-rc.0 -> rc), because npm's default tag is `latest` unconditionally and
    // is not semver-aware.
    expect(out).toMatch(/dist-tag:\s+rc/);
    expect(out).toMatch(/rc=0\.1\.0-rc\.0/);
    // Assert the argv actually handed to pnpm, not just the plan the script printed — the printed line and
    // the executed command are two different things, and only one of them reaches the registry.
    expect(calls).toMatch(/^pnpm .*\bpublish\b.*--tag rc\b/m);
    expect(calls).toMatch(/--access public/);
    // `--no-provenance` must NOT be here: pnpm silently drops it, so passing it would read as a safeguard
    // while doing nothing. Provenance is opt-in at the call site instead (the release workflow passes
    // `--provenance`), which is what let `publishConfig.provenance` come out of the manifests.
    expect(calls).not.toMatch(/--no-provenance/);
  });

  it('reports — but does not fail on — latest landing on the prerelease', () => {
    const { status, out } = runScript(['--confirm'], {
      distTags: { rc: VERSION, latest: VERSION },
    });
    // Verified against a real registry (verdaccio): a first publish gets `latest` regardless of `--tag`, and
    // `npm dist-tag rm … latest` is refused. Failing here would report a successful, irreversible publish as
    // an error and send the operator after a repair that does not exist.
    expect(out).toMatch(/NOTE — the registry also pointed `latest`/);
    expect(out).toMatch(/corrects itself the moment the real release publishes/);
    expect(out).toMatch(/bootstrap-publish: done/);
    expect(status).toBe(0);
  });

  it('waits out read-replica lag instead of calling a good publish failed', () => {
    // The real bootstrap ACKed with `PUT 200` and then 404'd on `npm view` for ~7 minutes. Reporting that as
    // "not found after publish" is the worst wrong answer available directly after an irreversible step.
    const { status, out } = runScript(['--confirm'], { distTagsLagCalls: 1 });
    expect(out).toMatch(/not on the read path yet — waiting for propagation/);
    expect(out).toMatch(/rc=0\.1\.0-rc\.0/);
    expect(out).not.toMatch(/not found after publish/);
    expect(status).toBe(0);
  });

  it('still fails when the requested dist-tag did not land', () => {
    const { status, out } = runScript(['--confirm'], { distTags: { latest: '9.9.9' } });
    expect(out).toMatch(/rc is \(unset\), expected 0\.1\.0-rc\.0/);
    expect(status).toBe(1);
  });

  it('refuses when EVERY name already exists — there is nothing to bootstrap', () => {
    const { status, out } = runScript([], { npmViewVersionsExitCode: 0 });
    expect(out).toMatch(/every package already exists on the registry/);
    expect(out).toMatch(/tag vX\.Y\.Z/);
    expect(status).toBe(1);
  });

  it('publishes ONLY the names the registry lacks, and skips the ones it has', () => {
    // The case the earlier version of this script could not express, and the reason it was rewritten: the
    // storage split added three packages to a family whose other two were already on npm. Refusing outright
    // (the old behaviour) left no guarded way to create them, and tagging without creating them first would
    // have published core and then failed on the first name with no Trusted Publisher — an immutable,
    // partial release of a family that ships in lockstep.
    const { status, out, calls } = runScript(['--confirm'], {
      packages: ['core', 'roaring', 's3', 'gcs', 'azure-blob'],
      existing: ['@cloudbitmaps/core', '@cloudbitmaps/roaring'],
    });
    expect(status).toBe(0);
    expect(out).toMatch(/@cloudbitmaps\/core already on the registry — skipping/);
    expect(out).toMatch(/@cloudbitmaps\/roaring already on the registry — skipping/);
    // The argv actually handed to pnpm, not the printed plan: each missing name is filtered in explicitly,
    // so an already-published name cannot be republished by hand even if the probe above were wrong.
    const publish = calls.split('\n').find((l) => l.includes('publish')) ?? '';
    expect(publish).toMatch(/--filter @cloudbitmaps\/s3\b/);
    expect(publish).toMatch(/--filter @cloudbitmaps\/gcs\b/);
    expect(publish).toMatch(/--filter @cloudbitmaps\/azure-blob\b/);
    expect(publish).not.toMatch(/--filter @cloudbitmaps\/core\b/);
    expect(publish).not.toMatch(/--filter @cloudbitmaps\/roaring\b/);
    expect(publish).not.toMatch(/\.\/packages\/\*\*/);
    expect(out).toMatch(/done — 3 name\(s\) created/);
    // The operator must be told the names are not usable by the pipeline until each has a Trusted Publisher.
    expect(out).toMatch(/Trusted\n?\s*Publisher/);
  });

  it('creates a name at a THROWAWAY prerelease, never the family version, and restores the manifests', () => {
    // Publishing the real version by hand would be unattested AND would make `pnpm publish` silently skip
    // that name on the real tag (it is already on the registry, exit 0) — so the pipeline would report
    // success having published nothing for it.
    const { status, out, calls, manifests } = runScript(['--confirm'], {
      packages: ['core', 's3'],
      version: '0.10.0',
      existing: ['@cloudbitmaps/core'],
      distTags: { rc: '0.10.0-rc.0' },
    });
    expect(status).toBe(0);
    expect(out).toMatch(/publishing as:\s+0\.10\.0-rc\.0/);
    expect(out).toMatch(/dist-tag:\s+rc/);
    // What the manifest actually said at the moment pnpm was invoked — the printed plan proves nothing here,
    // because neither npm nor pnpm can publish a version other than the one on disk.
    // The name being CREATED carries the throwaway…
    expect(calls).toMatch(/at-publish s3 +"version": "0\.10\.0-rc\.0"/);
    // …and the one being skipped is left alone, so the rewrite is scoped to what is actually published.
    expect(calls).toMatch(/at-publish core +"version": "0\.10\.0"/);
    expect(calls).not.toMatch(/at-publish s3 +"version": "0\.10\.0"/);
    // …and it is put back, so the bootstrap leaves no version bump nobody made.
    expect(manifests.s3).toMatch(/"version": "0\.10\.0"/);
    expect(manifests.core).toMatch(/"version": "0\.10\.0"/);
  });

  it('REFUSES when the registry probe fails for any reason other than a 404', () => {
    // The script hand-publishes the names it believes are missing. Treating a 500 / rate limit / timeout /
    // auth failure as "missing" therefore publishes an unattested prerelease OVER packages that are already
    // live — irreversibly. The old shim exited 1 with no output, which is exactly what a network error
    // looks like, so the suite encoded the bug as the intended behaviour.
    const { status, out } = runScript(['--confirm'], {
      npmViewStderr:
        'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed',
    });
    expect(status).toBe(1);
    expect(out).toMatch(/could not determine whether @cloudbitmaps\/core exists/);
    expect(out).toMatch(/Refusing to guess/);
    // And nothing was sent.
    expect(out).not.toMatch(/bootstrap-publish: done/);
  });

  it('REFUSES when the version literal is not where the rewrite expects it', () => {
    // `String.replace` is a silent no-op on a miss, which would hand pnpm the family's REAL version —
    // published by hand (so unattested) and then skipped by the pipeline on the tag because the registry
    // already has it. The guard has to fire BEFORE anything irreversible.
    const { status, out, calls } = runScript(['--confirm'], {
      packages: ['s3'],
      version: '0.10.0',
      compactManifests: true,
    });
    expect(status).toBe(1);
    expect(out).toMatch(/could not rewrite the version in packages\/s3\/package.json/);
    expect(out).toMatch(/Nothing was published/);
    expect(calls).not.toMatch(/publish/);
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
