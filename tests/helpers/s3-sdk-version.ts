import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The minor version of the installed `@aws-sdk/client-s3` (the `723` of 3.723.0), for a test whose answer depends on
 * what the SDK does and so differs between the lowest version the package admits and the newest.
 */
export function s3SdkMinor(): number {
  const main = createRequire(import.meta.url).resolve('@aws-sdk/client-s3');
  const manifest = JSON.parse(readFileSync(join(dirname(main), '../package.json'), 'utf8')) as {
    version: string;
  };
  return Number(manifest.version.split('.')[1]);
}
