import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The settings the AWS SDK reads from the environment and from its shared config file, which decide where a client
 * sends a request and how. A test that builds a real `S3Client` and lets it resolve an endpoint must not read the
 * machine's own `~/.aws`, nor any variable the shell happens to export, so each test runs inside this: the shared
 * config and credentials files point at empty files in a directory of the test's own, and every one of these
 * variables is unset until the test sets it.
 */
const SDK_VARIABLES = [
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_EC2_METADATA_DISABLED',
] as const;

export interface IsolatedAwsEnv {
  /** Set variables for the rest of the test; `undefined` leaves one unset. */
  set(variables: Partial<Record<(typeof SDK_VARIABLES)[number], string>>): void;
  /** Put `text` in the shared config file the SDK now reads. */
  writeConfig(text: string): void;
  /** Put every variable back as it was, and remove the files. */
  restore(): void;
}

/**
 * Isolate the SDK's environment for one test. The shared-config reader caches a file by its path for the life of the
 * process, so each call uses a directory of its own: a path reused by the next test would serve that test the file
 * this one wrote.
 */
export function isolateAwsEnv(): IsolatedAwsEnv {
  const saved = new Map<string, string | undefined>();
  for (const name of SDK_VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  const dir = mkdtempSync(join(tmpdir(), 'cbm-aws-env-'));
  const config = join(dir, 'config');
  const credentials = join(dir, 'credentials');
  writeFileSync(config, '');
  writeFileSync(credentials, '');
  process.env.AWS_CONFIG_FILE = config;
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentials;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  return {
    set(variables) {
      for (const [name, value] of Object.entries(variables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
    writeConfig(text) {
      writeFileSync(config, text);
    },
    restore() {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
