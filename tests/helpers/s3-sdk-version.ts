import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** From this minor an SDK honours `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` and keeps uploads off the socket pool. */
export const S3_STRONG_MINOR = 723;

/** The minor of a `3.x.y` version; anything else (another major, a tag, a short version) throws. */
export function s3MinorOf(version: string): number {
  const m = /^3\.(\d+)\.\d+$/.exec(version);
  if (!m) throw new Error(`"${version}" is not a 3.x.y version`);
  return Number(m[1]);
}

/**
 * The minor version of the installed `@aws-sdk/client-s3` (the `723` of 3.723.0), for a test whose answer depends on
 * what the SDK does and so differs between the lowest version the package admits and the newest.
 */
export function s3SdkMinor(): number {
  const main = createRequire(import.meta.url).resolve('@aws-sdk/client-s3');
  const manifest = JSON.parse(readFileSync(join(dirname(main), '../package.json'), 'utf8')) as {
    version: string;
  };
  return s3MinorOf(manifest.version);
}
