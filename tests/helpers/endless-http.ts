/**
 * A loopback HTTP server whose every response is a body that never ends: no `Content-Length` unless the test gives one, written as fast
 * as the client reads. It counts the bytes it managed to send and stops at a hard ceiling so a test that fails cannot
 * run away. A client that reads a bounded amount and hangs up leaves the count small.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PIECE = Buffer.alloc(64 * 1024, 7);

export class EndlessServer {
  /** Bytes written to any response so far. */
  sent = 0;
  url = '';
  private server: Server | undefined;

  /** `status` and extra `headers` of every response; the body is endless whatever they say. */
  async start(
    status = 200,
    headers: Record<string, string> = {},
    ceiling = 256 * 1024 * 1024,
  ): Promise<void> {
    this.server = createServer((req, res) => {
      req.resume();
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '1048576' }).end();
        return;
      }
      res.writeHead(status, headers);
      let open = true;
      res.on('close', () => (open = false));
      const pump = (): void => {
        while (open && this.sent < ceiling) {
          this.sent += PIECE.length;
          if (!res.write(PIECE)) return void res.once('drain', pump);
        }
        res.destroy();
      };
      pump();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** What a driver may have pulled from an endless body before it gave up: the socket buffers' worth, far below this. */
export const BOUNDED = 32 * 1024 * 1024;
