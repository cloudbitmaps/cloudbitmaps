import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { guardLoopback } from '../helpers/loopback-guard';

/**
 * The guard the driver matrices run under refuses every connection that is not to the loopback address, in each form
 * `connect` is called with, an HTTP agent's included, and lets a loopback one through. The refused address is one
 * reserved for documentation, and the guard throws before any packet is sent.
 */
const AWAY = '192.0.2.1';

describe('the loopback guard', () => {
  let guard: ReturnType<typeof guardLoopback>;
  beforeEach(() => {
    guard = guardLoopback();
  });
  afterEach(() => {
    guard.restore();
  });

  it('refuses an HTTP request to another address, and records it', () => {
    let sent: ReturnType<typeof request> | undefined;
    expect(() => {
      sent = request(`http://${AWAY}/x`);
    }).toThrow(/only to the loopback address/);
    sent?.destroy();
    expect(guard.attempts).toEqual([AWAY]);
  });

  it.each<[string, (s: net.Socket) => void]>([
    ['options', (s) => s.connect({ host: AWAY, port: 80 })],
    ['a port and a host', (s) => s.connect(80, AWAY)],
    ['a port as text and a host', (s) => s.connect('80' as unknown as number, AWAY)],
  ])('refuses a socket connected with %s', (_form, open) => {
    const socket = new net.Socket();
    try {
      expect(() => open(socket)).toThrow(/only to the loopback address/);
    } finally {
      socket.destroy();
    }
    expect(guard.attempts).toEqual([AWAY]);
  });

  it('lets a request to the loopback address through', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${port}/`, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok');
      expect(guard.attempts).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('puts the socket back when restored', () => {
    guard.restore();
    expect(net.Socket.prototype.connect.name).not.toBe('guarded');
  });
});

describe('the loopback guard over a recorder, so what it lets through is never sent', () => {
  const real = net.Socket.prototype.connect;
  let passed: unknown[];
  let guard: ReturnType<typeof guardLoopback>;
  beforeEach(() => {
    passed = [];
    net.Socket.prototype.connect = function recorded(this: net.Socket, ...args: unknown[]) {
      passed.push(args);
      return this;
    } as typeof real;
    guard = guardLoopback();
  });
  afterEach(() => {
    guard.restore();
    net.Socket.prototype.connect = real;
  });

  it.each<[string, net.NetConnectOpts]>([
    ['an empty path beside a host', { path: '', host: AWAY, port: 80 } as net.NetConnectOpts],
    [
      'a null path beside a host',
      { path: null, host: AWAY, port: 80 } as unknown as net.NetConnectOpts,
    ],
  ])('refuses %s, which Node connects to by TCP', (_form, options) => {
    expect(() => new net.Socket().connect(options)).toThrow(/only to the loopback address/);
    expect(guard.attempts).toEqual([AWAY]);
    expect(passed).toEqual([]);
  });

  it('lets a pipe through', () => {
    new net.Socket().connect({ path: '/tmp/a-pipe' });
    expect(guard.attempts).toEqual([]);
    expect(passed).toHaveLength(1);
  });
});
