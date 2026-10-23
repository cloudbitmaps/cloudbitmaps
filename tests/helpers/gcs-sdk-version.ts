import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The version of the installed `@google-cloud/storage`, as `[major, minor, patch]`; anything else throws. */
export function gcsSdkVersion(): [number, number, number] {
  let dir = dirname(createRequire(import.meta.url).resolve('@google-cloud/storage'));
  // The entry sits in `build/...`; the manifest is the nearest `package.json` above it.
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === '@google-cloud/storage') return parseGcsVersion(manifest.version);
    } catch {
      /* no manifest here: look one level up */
    }
    const up = dirname(dir);
    if (up === dir) throw new Error('found no package.json for @google-cloud/storage');
    dir = up;
  }
}

/** Parse `x.y.z` (a pre-release suffix is refused: a floor run tests a released version). */
export function parseGcsVersion(version: string | undefined): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!m) throw new Error(`"${String(version)}" is not an x.y.z version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when the installed SDK is at least `major.minor.patch`. */
export function gcsSdkAtLeast(major: number, minor: number, patch = 0): boolean {
  const have = gcsSdkVersion();
  const want = [major, minor, patch];
  for (let i = 0; i < 3; i++)
    if (have[i] !== want[i]) return (have[i] as number) > (want[i] as number);
  return true;
}
