/**
 * The process a read-timeout test runs one read in. The read's timeout is a minute and the read is fast, so a process
 * that is still alive long after the read settled is being held open by something the read left behind: the parent
 * reads how long this one took to exit.
 *
 * argv: the stub's endpoint, then the read to make: `range`, `tail`, `head` or `registry`, which succeed, or `missing` or
 * `head-missing`, a GET and a HEAD of a generation the stub does not hold, which fail. Prints one JSON line.
 */
import { S3Storage } from '../../../../packages/s3/src/backend';

const [endpoint, call] = process.argv.slice(2);
if (endpoint === undefined || call === undefined) {
  throw new Error('usage: read-child <endpoint> <call>');
}

const backend = new S3Storage({
  bucket: 'b',
  endpoint,
  pathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
  readTimeoutMs: 60_000,
});
const key = { segment: 's', generation: 0 };

async function run(): Promise<unknown> {
  switch (call) {
    case 'range':
      return (await backend.storage.getRange(key, 0, 4)).length;
    case 'tail':
      return (await backend.storage.getTail(key, 4)).size;
    case 'head':
      return (await backend.storage.getTail(key, 0)).size;
    case 'registry':
      return (await backend.registry.get({ segment: 's' }))?.currentGen ?? null;
    case 'missing':
      return (await backend.storage.getRange({ segment: 's', generation: 9 }, 0, 4)).length;
    case 'head-missing':
      return (await backend.storage.getTail({ segment: 's', generation: 9 }, 0)).size;
    default:
      throw new Error(`unknown call ${call}`);
  }
}

run().then(
  (ok) => process.stdout.write(`${JSON.stringify({ ok })}\n`),
  (err: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ error: (err as Error).name, message: (err as Error).message })}\n`,
    );
    process.exitCode = 1;
  },
);
