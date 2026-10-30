import { connect } from 'node:net';
import type { Socket } from 'node:net';

/**
 * A loopback port that refuses every connection, for the tests of a connection that is refused.
 *
 * A port freed a moment ago is nobody's: another test's `listen(0)`, or a sibling process's outgoing connection, can be
 * given it before the test connects, and one connect then reaches a live server. These are fixed ports in the
 * privileged range (below 1024), below every default ephemeral range, so `listen(0)` and the source port of an outgoing
 * connection are never given one. A process with the privilege, or a configured ephemeral range that reaches that low,
 * can still listen there, and nothing else keeps a port from being taken; the helper catches that instead of assuming it:
 * it connects once to every candidate, all at the same moment, and returns the first in list order that answers
 * `ECONNREFUSED`. A port that answers, times out or ends in another error is skipped, and when none refuses the helper
 * throws and names what each did, so a machine where something answers fails the test with that and never with a wrong
 * count of attempts.
 *
 * Port 1 is left out and so is every port on the Fetch standard's list of blocked ports: Node's built-in `fetch` refuses
 * those before it connects, so a driver whose SDK moved to it would see no connect at all, not a refusal. Today the GCS SDK
 * uses `node-fetch` and S3 and Azure use Node's `http`, none of which applies that list; the candidates stay off it so a
 * bump of an SDK's HTTP stack cannot change what these tests see.
 *
 * Worst case: the probes run at once and each ends by `PROBE_MS`, so the helper returns or throws within `PROBE_MS`
 * (1 s, derived from the constant; a loopback port that is not filtered answers in well under a millisecond).
 */
export const REFUSING_PORT_CANDIDATES: readonly number[] = [3, 4, 6, 8, 10, 12];

export const PROBE_MS = 1_000;

/** The connect a probe makes, replaceable in a test of the helper. */
export type Connect = (options: { port: number; host: string }) => Socket;

/** How one connect to `port` ended: its error code, `connected` when something answered, or `timeout`. */
export function probe(
  port: number,
  connectTo: Connect = connect,
  timeoutMs: number = PROBE_MS,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = connectTo({ port, host: '127.0.0.1' });
    const done = (result: string): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
  });
}

export async function refusedPort(
  candidates: readonly number[] = REFUSING_PORT_CANDIDATES,
  probePort: (port: number) => Promise<string> = probe,
): Promise<number> {
  const results = await Promise.all(candidates.map((port) => probePort(port)));
  const index = results.findIndex((result) => result === 'ECONNREFUSED');
  if (index >= 0) return candidates[index]!;
  const seen = candidates.map((port, i) => `${port}: ${results[i]}`);
  throw new Error(
    `no loopback port refuses connections here, so a refused-connection test cannot run (${seen.join(', ')})`,
  );
}
