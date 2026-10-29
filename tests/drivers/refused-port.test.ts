import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REFUSING_PORT_CANDIDATES, refusedPort } from '../helpers/refused-port';

describe('refusedPort', () => {
  it('returns a port that refuses a connection, below the ephemeral range', async () => {
    const port = await refusedPort();
    expect(REFUSING_PORT_CANDIDATES).toContain(port);
    expect(port).toBeLessThan(1024);
  });

  it('skips a candidate something answers on, and takes the next that refuses', async () => {
    const live = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
    try {
      const answering = (live.address() as AddressInfo).port;
      const port = await refusedPort([answering, ...REFUSING_PORT_CANDIDATES]);
      expect(port).not.toBe(answering);
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
