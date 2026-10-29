import { connect } from 'node:net';

/**
 * A loopback port that refuses every connection, for the tests of a connection that is refused.
 *
 * A port freed a moment ago is nobody's: another test's `listen(0)`, or a sibling process's outgoing connection, can be
 * given it before the test connects, and one connect then reaches a live server. These are fixed ports below the
 * ephemeral range and the privileged line, where no `listen(0)` and no outgoing connection is ever given one, and
 * where nothing on a test machine listens. The helper does not trust that: it connects once to each candidate in
 * turn and returns the first that answers `ECONNREFUSED`, and when none does it throws and names what each one did, so a
 * machine where something answers fails the test with that, and never with a wrong count of attempts.
 */
export const REFUSING_PORT_CANDIDATES: readonly number[] = [1, 3, 4, 6, 8, 10];

const PROBE_MS = 5_000;

/** How one connect to `port` ended: its error code, `connected` when something answered, or `timeout`. */
function probe(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (result: string): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_MS, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
  });
}

export async function refusedPort(
  candidates: readonly number[] = REFUSING_PORT_CANDIDATES,
): Promise<number> {
  const seen: string[] = [];
  for (const port of candidates) {
    const result = await probe(port);
    if (result === 'ECONNREFUSED') return port;
    seen.push(`${port}: ${result}`);
  }
  throw new Error(
    `no loopback port refuses connections here, so a refused-connection test cannot run (${seen.join(', ')})`,
  );
}
