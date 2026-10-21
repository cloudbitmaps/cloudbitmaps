import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Under `CR_CALIBRATE_CODEC` the calibration harness takes its stores from one bundle of this checkout's sources, with
 * the store package's codec switch set. A harness file that imported `@cloudbitmaps/roaring` or `@cloudbitmaps/s3`
 * directly would count, check or construct against the installed published package instead, and the run would claim a
 * codec its numbers did not come from. So the harness reaches those packages only through `packageOf`, and this holds
 * it to that by text, over every file the harness runs from.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const { HARNESS_FILES } = require_('./lib/calibrate-process.cjs') as { HARNESS_FILES: string[] };

/** The one file that defines `packageOf`'s fallback to the installed packages, so the one place that may import them. */
const DEFINES_THE_FALLBACK = 'bench/lib/codec-engine.cjs';

/** Whether a source text reaches a library package by `import(...)`, `require(...)` or `from '...'`, not through `packageOf`. */
const importsDirectly = (text: string): boolean =>
  /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s)\s*['"`]@cloudbitmaps\/(?:roaring|s3)(?:\/[^'"`]*)?['"`]/.test(
    text,
  );

describe('the harness reaches the library only through packageOf', () => {
  const files = HARNESS_FILES.filter((f) => f.endsWith('.cjs') && f !== DEFINES_THE_FALLBACK);

  it('refuses each way of importing a library package directly', () => {
    for (const planted of [
      "const { CloudRoaring } = await import('@cloudbitmaps/roaring');",
      'const r = require("@cloudbitmaps/roaring");',
      "import { S3Storage } from '@cloudbitmaps/s3';",
      "await import( '@cloudbitmaps/s3' )",
      "require('@cloudbitmaps/roaring/package.json')",
    ])
      expect(importsDirectly(planted), planted).toBe(true);
  });

  it('lets the legitimate sites through: packageOf, the tools package, and prose that names a package', () => {
    for (const fine of [
      "const { CloudRoaring } = await packageOf('roaring');",
      "const { S3Storage } = await packageOf('s3');",
      "({ AWS_US_EAST_1_ONDEMAND } = await import('@cloudbitmaps/tools'));",
      '// the installed @cloudbitmaps/roaring does not collect by name',
      "refuse('the installed @cloudbitmaps/roaring is too old');",
      "const rel = 'node_modules/@cloudbitmaps/roaring/package.json';",
    ])
      expect(importsDirectly(fine), fine).toBe(false);
  });

  it('holds in every harness file', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files)
      expect(importsDirectly(readFileSync(join(ROOT, f), 'utf8')), f).toBe(false);
  });

  it('passes the engine the stores come from to the large suite’s counter, and reads the engine constants from that engine', () => {
    const harness = readFileSync(join(ROOT, 'bench/calibrate-aws.cjs'), 'utf8');
    expect(harness).toMatch(/countSize\(\{[^}]*engine: await packageOf\('roaring'\)/s);
    expect(harness).toContain('bundledSources(ROOT) ?? installedSources(ROOT)');
    const counts = readFileSync(join(ROOT, 'bench/lib/large-counts.cjs'), 'utf8');
    expect(counts).toContain('countedBackend needs the engine');
  });
});

describe('calibrate-cloudshell.sh and the codec', () => {
  const sh = readFileSync(join(ROOT, 'bench/calibrate-cloudshell.sh'), 'utf8');

  it('refuses a codec name that is neither native nor typescript before it copies or installs anything', () => {
    const at = sh.indexOf('\nrefuse_bad_codec\n');
    expect(at).toBeGreaterThan(0);
    for (const later of ['nvm install', 'npm i ', 'cp -R "packages/$pkg/src"'])
      expect(at, later).toBeLessThan(sh.indexOf(later));
    const bad = spawnSync('bash', [join(ROOT, 'bench', 'calibrate-cloudshell.sh')], {
      env: { PATH: process.env.PATH ?? '', CR_CALIBRATE_CODEC: 'wasm', CR_CALIBRATE_REHEARSE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(
      /CR_CALIBRATE_CODEC must be native or typescript, or unset, not "wasm"/,
    );
  });
});
