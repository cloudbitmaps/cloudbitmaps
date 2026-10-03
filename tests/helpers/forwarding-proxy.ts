/**
 * A forwarding HTTP proxy in front of a local emulator that records each request it passes on, so a test can count
 * what a call sends on the wire. Headers go through untouched, so a signed request stays valid.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ForwardingProxy {
  /** The proxy's own URL, to give a client in place of the emulator's. */
  readonly url: string;
  /** Every request passed on since the last `requests.length = 0`. */
  readonly requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

export async function forwardingProxy(target: string): Promise<ForwardingProxy> {
  const to = new URL(target);
  const requests: Array<{ method: string; path: string }> = [];
  const server: Server = createServer((inReq, inRes) => {
    requests.push({ method: inReq.method ?? '', path: inReq.url ?? '' });
    const out = request(
      {
        host: to.hostname,
        port: to.port,
        method: inReq.method,
        path: inReq.url,
        headers: inReq.headers,
      },
      (res) => {
        inRes.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(inRes);
      },
    );
    out.on('error', () => inRes.destroy());
    inReq.pipe(out);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
