/**
 * The process a read-timeout test runs the driver in, so a crash the SDK throws outside any promise is this process's
 * exit code (1) rather than the test runner's, and a timer or socket left behind shows as a process that does not exit.
 *
 * argv: the stub's endpoint; the call (`tail`, `range`, `registry`, `exists` — a facade call that reads the registry with
 * the store's own retry off — or `tail+upload`, a small upload started just before a tail read on the same backend);
 * `readTimeoutMs` (a number, or `default` to leave it unset); then `linger=<ms>`, how long to stay up after the call
 * settles before exiting (so a late response can arrive and crash it), or `natural`, which never calls `process.exit`
 * and lets the process end by itself once nothing is left to run.
 *
 * Prints one JSON line: `{ ok }` or `{ error, message }`, the call's `ms`, and, for `tail+upload`, the upload's outcome.
 */
import { CloudRoaring } from '../../../../packages/roaring/src/index';
import { GcsStorage } from '../../../../packages/gcs/src/backend';

const [endpoint, call, timeout, end = 'linger=300'] = process.argv.slice(2);
if (endpoint === undefined || call === undefined || timeout === undefined)
  throw new Error(
    'usage: timeout-child <endpoint> <call> <readTimeoutMs|default> [linger=<ms>|natural]',
  );

const backend = new GcsStorage({
  bucket: 'b',
  prefix: 'p',
  apiEndpoint: endpoint,
  projectId: 'proj',
  ...(timeout === 'default' ? {} : { readTimeoutMs: Number(timeout) }),
});
const key = { segment: 's', generation: 0 };

const describe = (err: unknown): Record<string, unknown> => ({
  error: (err as Error).constructor.name,
  message: (err as Error).message,
});

async function run(): Promise<unknown> {
  switch (call) {
    case 'tail':
    case 'tail+upload':
      return (await backend.storage.getTail(key, 8)).size;
    case 'range':
      return (await backend.storage.getRange(key, 0, 8)).length;
    case 'registry':
      return (await backend.registry.get({ segment: 's' }))?.currentGen ?? null;
    case 'exists':
      return await new CloudRoaring({ storage: backend, retry: false }).exists({ segment: 's' });
    default:
      throw new Error(`unknown call ${call}`);
  }
}

// The upload goes first, so it is in flight on the backend's other client when the read times out.
const upload =
  call === 'tail+upload'
    ? backend.storage
        .putImmutable({ segment: 'w', generation: 0 }, (sink) => sink.write(new Uint8Array(64)))
        .then(
          (r) => ({ ok: r.size }),
          (err: unknown) => describe(err),
        )
    : undefined;
if (upload !== undefined) await new Promise((resolve) => setTimeout(resolve, 50));

const started = Date.now();
let outcome: Record<string, unknown>;
try {
  outcome = { ok: await run() };
} catch (err) {
  outcome = describe(err);
}
outcome.ms = Date.now() - started;
if (upload !== undefined) outcome.upload = await upload;
console.log(JSON.stringify(outcome));
if (end !== 'natural') {
  await new Promise((resolve) => setTimeout(resolve, Number(end.slice('linger='.length))));
  process.exit(0);
}
