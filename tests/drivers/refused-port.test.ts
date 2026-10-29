import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REFUSING_PORT_CANDIDATES, probe, refusedPort } from '../helpers/refused-port';

/** A socket that ends as the test says: an error code, a connect, or never (only its idle timeout fires). */
function fakeConnect(end: { error: string } | 'connect' | 'never') {
  return (): Socket => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    socket.destroy = () => undefined;
    socket.setTimeout = (ms, cb) => {
      setTimeout(cb, ms);
    };
    queueMicrotask(() => {
      if (end === 'connect') socket.emit('connect');
      else if (end !== 'never')
        socket.emit('error', Object.assign(new Error('x'), { code: end.error }));
    });
    return socket as unknown as Socket;
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

  it('reports `timeout` for a port that never answers, within its timeout', async () => {
    const started = Date.now();
    expect(await probe(1, fakeConnect('never'), 50)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(500);
  }, 5_000);
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

  it('probes every candidate at once and returns the first in list order that refuses, not the first to answer', async () => {
    const delays: Record<number, number> = { 1: 100, 3: 100, 4: 0 };
    const started = Date.now();
    const port = await refusedPort(
      [1, 3, 4],
      (candidate) =>
        new Promise((resolve) => setTimeout(() => resolve('ECONNREFUSED'), delays[candidate]!)),
    );
    expect(port).toBe(1);
    // Serially the three would take 200 ms.
    expect(Date.now() - started).toBeLessThan(180);
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
