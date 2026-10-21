import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

/**
 * `scripts/check-no-native-package.cjs` reads the packed manifests the Lambda smoke and the layer build unpack, because
 * nothing is installed there and a dependency on a native package leaves no file behind. It must refuse the ways a
 * package brings native code, and stay quiet for the packages as they ship.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'check-no-native-package.cjs');
const { nativeFindings, check } = createRequire(import.meta.url)(SCRIPT) as {
  nativeFindings: (m: Record<string, unknown>) => string[];
  check: (dir: string) => string[];
};

describe('the packed-package native-code check', () => {
  it('refuses a re-added roaring dependency in any field an install follows', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(nativeFindings({ [field]: { roaring: '^2' } })).toEqual([`${field} names roaring`]);
    }
    expect(nativeFindings({ bundledDependencies: ['roaring'] })).toHaveLength(1);
  });

  it('refuses native build helpers, a gypfile and install-time scripts', () => {
    expect(nativeFindings({ dependencies: { 'node-gyp-build': '1' } })).toHaveLength(1);
    expect(nativeFindings({ dependencies: { 'node-addon-api': '1' } })).toHaveLength(1);
    expect(nativeFindings({ gypfile: true })).toHaveLength(1);
    expect(nativeFindings({ scripts: { postinstall: 'node-gyp rebuild' } })).toHaveLength(1);
  });

  it('stays quiet for the manifests the packages ship', () => {
    expect(
      nativeFindings({
        dependencies: { '@cloudbitmaps/core': '1.0.0' },
        devDependencies: { roaring: '^2' },
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    ).toEqual([]);
    expect(nativeFindings({})).toEqual([]);
  });

  it('fires on a planted package and exits non-zero, and passes a clean one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-native-'));
    try {
      const planted = join(dir, 'planted');
      const clean = join(dir, 'clean');
      mkdirSync(planted);
      mkdirSync(join(clean, 'dist'), { recursive: true });
      writeFileSync(
        join(planted, 'package.json'),
        JSON.stringify({ name: 'planted', dependencies: { roaring: '^2' } }),
      );
      writeFileSync(join(clean, 'package.json'), JSON.stringify({ name: 'clean' }));
      writeFileSync(join(clean, 'dist', 'index.js'), '');
      expect(check(planted)).toEqual(['planted: dependencies names roaring']);
      expect(check(clean)).toEqual([]);
      const red = spawnSync(process.execPath, [SCRIPT, clean, planted], { encoding: 'utf8' });
      expect(red.status).toBe(1);
      expect(red.stderr).toContain('dependencies names roaring');
      expect(spawnSync(process.execPath, [SCRIPT, clean], { encoding: 'utf8' }).status).toBe(0);
      writeFileSync(join(clean, 'dist', 'addon.node'), '');
      expect(check(clean)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
