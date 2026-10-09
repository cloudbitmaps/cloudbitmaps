/**
 * The process a read-retry test runs the driver in. A crash the SDK throws outside any promise ends the process,
 * and a test that made the same call in-process would take the test runner down with it, so each scenario runs here
 * and the parent reads the exit code: 1 is that crash, 0 is a call that settled and left the process alone.
 *
 * argv: the stub's endpoint, then the call to make (`tail`, `range`, `registry`, `list`, or `exists`, a facade call that reads the registry with the store's own retry off), then optionally `count-connects`, which adds how many connections the
 * call opened to the endpoint's port, `creds-missing`, which reads through a client that authenticates against the
 * endpoint (whose credentials file, named by the environment, does not exist) and adds how many reads it opened, or
 * `own-client`, which hands the backend a client of the caller's own with the SDK's default retries, or
 * `own-pinned`, the same from a subclass that sets a retry policy of its own over the options it is given.
 * Prints one JSON line.
 */
import { Socket } from 'node:net';
import { File, Storage, type StorageOptions } from '@google-cloud/storage';
import { CloudRoaring } from '../../../../packages/roaring/src/index';
import { GcsStorage } from '../../../../packages/gcs/src/backend';

const [endpoint, call, count] = process.argv.slice(2);
if (endpoint === undefined || call === undefined)
  throw new Error('usage: read-child <endpoint> <call> [count-connects]');

// Every connection the SDK opens goes through `Socket#connect`; count the ones to the endpoint's port. Node's own
// `net.connect` hands it one normalized array, `[options, callback]`, rather than the options themselves.
const port = Number(new URL(endpoint).port);
let connects = 0;
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...args: unknown[]): Socket {
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const target =
    typeof first === 'object' && first !== null ? (first as { port?: unknown }).port : first;
  if (Number(target) === port) connects++;
  return (connect as (...a: unknown[]) => Socket).apply(this, args);
} as typeof connect;

// Every read the driver opens is one `File#createReadStream`.
let reads = 0;
const createReadStream = File.prototype.createReadStream;
File.prototype.createReadStream = function (this: File, ...args: unknown[]) {
  reads++;
  return (createReadStream as (...a: unknown[]) => ReturnType<File['createReadStream']>).apply(
    this,
    args,
  );
} as typeof createReadStream;

class Pinned extends Storage {
  constructor(options: StorageOptions = {}) {
    super({ ...options, retryOptions: { maxRetries: 3 } });
  }
}

const backend =
  count === 'own-pinned'
    ? new GcsStorage({
        bucket: 'b',
        prefix: 'p',
        client: new Pinned({ apiEndpoint: endpoint, projectId: 'proj' }),
      })
    : count === 'own-client'
      ? new GcsStorage({
          bucket: 'b',
          prefix: 'p',
          client: new Storage({ apiEndpoint: endpoint, projectId: 'proj' }),
        })
      : count === 'creds-missing'
        ? new GcsStorage({
            bucket: 'b',
            prefix: 'p',
            client: new Storage({
              apiEndpoint: endpoint,
              projectId: 'proj',
              useAuthWithCustomEndpoint: true,
              retryOptions: { autoRetry: false },
            }),
          })
        : new GcsStorage({
            bucket: 'b',
            prefix: 'p',
            apiEndpoint: endpoint,
            projectId: 'proj',
          });
const key = { segment: 's', generation: 0 };

async function run(): Promise<unknown> {
  switch (call) {
    case 'tail':
      return (await backend.storage.getTail(key, 8)).size;
    case 'range':
      return (await backend.storage.getRange(key, 0, 8)).length;
    case 'registry':
      return (await backend.registry.get({ segment: 's' }))?.currentGen ?? null;
    case 'exists':
      return await new CloudRoaring({ storage: backend, retry: false }).exists({ segment: 's' });
    case 'list': {
      const found: number[] = [];
      for await (const k of backend.storage.list({ segment: 's' })) found.push(k.generation);
      return found;
    }
    default:
      throw new Error(`unknown call ${call}`);
  }
}

let outcome: Record<string, unknown>;
try {
  outcome = { ok: await run() };
} catch (err) {
  outcome = { error: (err as Error).constructor.name };
  if (count === 'creds-missing') outcome.code = (err as { code?: unknown }).code;
}
if (count === 'count-connects') outcome.connects = connects;
if (count === 'creds-missing') outcome.reads = reads;
console.log(JSON.stringify(outcome));
// Linger past the SDK's retry: its crash fires after a retried request succeeds, not when the call settles.
await new Promise((resolve) => setTimeout(resolve, 400));
process.exit(0);
