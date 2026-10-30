import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REFUSING_PORT_CANDIDATES, probe, refusedPort } from '../helpers/refused-port';

/** What a fake socket's `setTimeout` was given, so a test fires the idle timeout itself instead of waiting for it. */
interface IdleTimer {
  ms?: number;
  fire?: () => void;
}

/** A socket that ends as the test says: an error code, a connect, or never (only its idle timeout, fired by the test). */
function fakeConnect(end: { error: string } | 'connect' | 'never', timer: IdleTimer = {}) {
  return (): Socket => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    socket.destroy = () => undefined;
    socket.setTimeout = (ms, cb) => {
      timer.ms = ms;
      timer.fire = cb;
    };
    queueMicrotask(() => {
      if (end === 'connect') socket.emit('connect');
      else if (end !== 'never')
        socket.emit('error', Object.assign(new Error('x'), { code: end.error }));
    });
    return socket as unknown as Socket;
  };
}

/** A probe result the test settles by hand. */
function deferred(): { promise: Promise<string>; settle: (result: string) => void } {
  let settle!: (result: string) => void;
  const promise = new Promise<string>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** A probe whose every candidate stays pending until the test settles it; records the order the probes started in. */
function manualProbe(candidates: readonly number[]) {
  const pending = new Map(candidates.map((port) => [port, deferred()]));
  const started: number[] = [];
  return {
    started,
    settle: (port: number, result: string) => pending.get(port)!.settle(result),
    probePort: (port: number): Promise<string> => {
      started.push(port);
      return pending.get(port)!.promise;
    },
  };
}

function refuses(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
  });
}

describe('probe', () => {
  it('reports the error code a connect ended with', async () => {
    expect(await probe(1, fakeConnect({ error: 'ECONNREFUSED' }), 50)).toBe('ECONNREFUSED');
    expect(await probe(1, fakeConnect({ error: 'EACCES' }), 50)).toBe('EACCES');
  });

  it('reports `connected` when something answers', async () => {
    expect(await probe(1, fakeConnect('connect'), 50)).toBe('connected');
  });

  it('reports `timeout` when the idle timeout fires on a port that never answers', async () => {
    const timer: IdleTimer = {};
    const result = probe(1, fakeConnect('never', timer), 50);
    expect(timer.ms).toBe(50);
    timer.fire!();
    expect(await result).toBe('timeout');
  });
});

describe('refusedPort', () => {
  it('returns a port that really refuses a connection', async () => {
    const port = await refusedPort();
    expect(await refuses(port)).toBe('ECONNREFUSED');
  });

  it('takes the first candidate in list order that answers ECONNREFUSED', async () => {
    const answers: Record<number, string> = {
      1: 'connected',
      3: 'ECONNREFUSED',
      4: 'ECONNREFUSED',
    };
    expect(await refusedPort([1, 3, 4], async (port) => answers[port]!)).toBe(3);
  });

  it('starts every candidate probe before any of them settles', async () => {
    const probes = manualProbe([1, 3, 4]);
    const result = refusedPort([1, 3, 4], probes.probePort);
    expect(probes.started).toEqual([1, 3, 4]);
    for (const port of [1, 3, 4]) probes.settle(port, 'ECONNREFUSED');
    expect(await result).toBe(1);
  });

  it('returns the first refusing candidate in list order when a later one settles first', async () => {
    const probes = manualProbe([1, 3, 4]);
    const result = refusedPort([1, 3, 4], probes.probePort);
    probes.settle(4, 'ECONNREFUSED');
    probes.settle(3, 'ECONNREFUSED');
    probes.settle(1, 'ECONNREFUSED');
    expect(await result).toBe(1);
  });

  it('returns a later refusing candidate when the earlier one answers, whichever settles first', async () => {
    const probes = manualProbe([1, 3, 4]);
    const result = refusedPort([1, 3, 4], probes.probePort);
    probes.settle(4, 'ECONNREFUSED');
    probes.settle(3, 'ECONNREFUSED');
    probes.settle(1, 'connected');
    expect(await result).toBe(3);
  });

  it.each(['connected', 'timeout', 'ETIMEDOUT', 'EACCES', 'ENETUNREACH'])(
    'skips a port that ends %s, and names it when nothing else refuses',
    async (result) => {
      const answers: Record<number, string> = { 1: result, 3: result };
      await expect(refusedPort([1, 3], async (port) => answers[port]!)).rejects.toThrow(
        `no loopback port refuses connections here, so a refused-connection test cannot run (1: ${result}, 3: ${result})`,
      );
      answers[3] = 'ECONNREFUSED';
      expect(await refusedPort([1, 3], async (port) => answers[port]!)).toBe(3);
    },
  );

  it('skips a candidate a live server answers on, and takes the next that refuses', async () => {
    const live = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
    try {
      const answering = (live.address() as AddressInfo).port;
      const port = await refusedPort([answering, ...REFUSING_PORT_CANDIDATES]);
      expect(port).toBe(REFUSING_PORT_CANDIDATES[0]);
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });

  it('fails closed, naming what answered, when no candidate refuses', async () => {
    const live = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
    try {
      const answering = (live.address() as AddressInfo).port;
      await expect(refusedPort([answering])).rejects.toThrow(
        `no loopback port refuses connections here, so a refused-connection test cannot run (${answering}: connected)`,
      );
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });
});
