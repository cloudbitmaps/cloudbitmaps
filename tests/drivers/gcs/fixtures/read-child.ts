/**
 * The process a read-retry test runs the driver in. A crash the SDK throws outside any promise ends the process,
 * and a test that made the same call in-process would take the test runner down with it, so each scenario runs here
 * and the parent reads the exit code: 1 is that crash, 0 is a call that settled and left the process alone.
 *
 * argv: the stub's endpoint, then the call to make (`tail`, `range`, `registry` or `list`). Prints one JSON line.
 */
import { GcsStorage } from '../../../../packages/gcs/src/backend';

const [endpoint, call] = process.argv.slice(2);
if (endpoint === undefined || call === undefined)
  throw new Error('usage: read-child <endpoint> <call>');

const backend = new GcsStorage({
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
      return (await backend.storage.getRange(key, 0, 4)).length;
    case 'registry':
      return (await backend.registry.get({ segment: 's' }))?.currentGen ?? null;
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
}
console.log(JSON.stringify(outcome));
// Linger past the SDK's retry: its crash fires after a retried request succeeds, not when the call settles.
await new Promise((resolve) => setTimeout(resolve, 1500));
process.exit(0);
