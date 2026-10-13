/**
 * The process a read-timeout test runs the driver in, so a crash the SDK throws outside any promise is this process's
 * exit code (1) rather than the test runner's, and a timer or socket left behind shows as a process that does not exit.
 *
 * argv:
 * - the stub's endpoint;
 * - the call: `tail`, `range`, `registry`, `exists` (a facade call that reads the registry with the store's own retry
 *   off), `has` (a facade read, with the store's retry on), `has5` (five of them at once), `delete`, `list`, or any of
 *   the reads followed by `+upload`: a small upload on the same backend, and a read and a registry write on a second
 *   backend (prefix `q`, no timeout), all started just before the read;
 * - `readTimeoutMs`: a number, `default` to leave it unset, or `client:<n>` to pass `<n>` beside a client of the
 *   test's own (built with `autoRetry: false`);
 * - then `linger=<ms>`, how long to stay up after printing (so a late response can arrive and crash it), or `natural`,
 *   which never calls `process.exit` and lets the process end by itself once nothing is left to run.
 *
 * The call is timed; 150 ms after it settles (so a released connection has closed and a held one has not) the child
 * prints one JSON line: `{ ok }` or `{ error, message }`, the call's `ms`, and, for `+upload`, what the others gave.
 */
import { Storage } from '@google-cloud/storage';
import { CloudRoaring } from '../../../../packages/roaring/src/index';
import { GcsStorage } from '../../../../packages/gcs/src/backend';

const [endpoint, spec, timeout, end = 'linger=300'] = process.argv.slice(2);
if (endpoint === undefined || spec === undefined || timeout === undefined)
  throw new Error(
    'usage: timeout-child <endpoint> <call>[+upload] <readTimeoutMs|default|client:<n>> [linger=<ms>|natural]',
  );
const [call, extra] = spec.split('+');

function backendFor(prefix: string, setting: string): GcsStorage {
  if (setting.startsWith('client:')) {
    const client = new Storage({
      apiEndpoint: endpoint,
      projectId: 'proj',
      retryOptions: { autoRetry: false },
    });
    return new GcsStorage({ bucket: 'b', prefix, client, readTimeoutMs: Number(setting.slice(7)) });
  }
  return new GcsStorage({
    bucket: 'b',
    prefix,
    apiEndpoint: endpoint,
    projectId: 'proj',
    ...(setting === 'default' ? {} : { readTimeoutMs: Number(setting) }),
  });
}

const backend = backendFor('p', timeout);
const key = { segment: 's', generation: 0 };

const describe = (err: unknown): Record<string, unknown> => ({
  error: (err as Error).constructor.name,
  message: (err as Error).message,
});
const settle = (p: Promise<unknown>): Promise<Record<string, unknown>> =>
  p.then((ok) => ({ ok }), describe);

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
    case 'has':
      return await new CloudRoaring({ storage: backend }).segment('s').has(2);
    case 'has5': {
      const store = new CloudRoaring({ storage: backend });
      const all = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => settle(store.segment(`s${i}`).has(2))),
      );
      return all.map((r) => r.error ?? 'ok');
    }
    case 'delete':
      await backend.storage.delete(key);
      return 'deleted';
    case 'list': {
      const found: number[] = [];
      for await (const k of backend.storage.list({ segment: 's' })) found.push(k.generation);
      return found;
    }
    default:
      throw new Error(`unknown call ${call}`);
  }
}

// The others go first, so they are in flight when the read times out or is cut off.
let others: Promise<Record<string, unknown>> | undefined;
if (extra === 'upload') {
  const other = backendFor('q', 'default');
  others = Promise.all([
    settle(
      backend.storage
        .putImmutable({ segment: 'w', generation: 0 }, (sink) => sink.write(new Uint8Array(64)))
        .then((r) => r.size),
    ),
    settle(other.storage.getRange({ segment: 'o', generation: 0 }, 0, 8).then((b) => b.length)),
    settle(other.registry.create({ segment: 'o' }, { currentGen: 0 }).then(() => 'created')),
  ]).then(([upload, otherRead, otherCreate]) => ({ upload, otherRead, otherCreate }));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const started = Date.now();
let outcome: Record<string, unknown>;
try {
  outcome = { ok: await run() };
} catch (err) {
  outcome = describe(err);
}
outcome.ms = Date.now() - started;
if (others !== undefined) Object.assign(outcome, await others);
await new Promise((resolve) => setTimeout(resolve, 150));
console.log(JSON.stringify(outcome));
if (end !== 'natural') {
  await new Promise((resolve) => setTimeout(resolve, Number(end.slice('linger='.length))));
  process.exit(0);
}
