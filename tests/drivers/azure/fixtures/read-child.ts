/**
 * The process a read-timeout test runs one read in. The read's timeout is a minute and the read settles at once, so a
 * process that is still alive long after the read settled is being held open by something the read left behind: the
 * parent reads how long this one took to exit.
 *
 * argv: the stub container's URL, then the read to make: `range`, `tail` or `registry` for one that succeeds, and
 * `missing-range`, `missing-tail` or `registry` against a stub set to refuse it for one that fails. Prints one JSON
 * line.
 */
import { AnonymousCredential, ContainerClient } from '@azure/storage-blob';
import { AzureBlobStorage } from '../../../../packages/azure-blob/src/backend';

const [url, call] = process.argv.slice(2);
if (url === undefined || call === undefined) {
  throw new Error('usage: read-child <container-url> <call>');
}

const backend = new AzureBlobStorage({
  containerClient: new ContainerClient(url, new AnonymousCredential()),
  readTimeoutMs: 60_000,
});
const key = { segment: 's', generation: 1 };
const missing = { segment: 's', generation: 9 };

async function run(): Promise<unknown> {
  switch (call) {
    case 'range':
      return (await backend.storage.getRange(key, 0, 4)).length;
    case 'tail':
      return (await backend.storage.getTail(key, 4)).size;
    case 'registry':
      return (await backend.registry.get({ segment: 's' }))?.currentGen ?? null;
    case 'missing-range':
      return (await backend.storage.getRange(missing, 0, 4)).length;
    case 'missing-tail':
      return (await backend.storage.getTail(missing, 4)).size;
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
