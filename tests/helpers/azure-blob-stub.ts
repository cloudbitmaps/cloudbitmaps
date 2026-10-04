import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AnonymousCredential,
  ContainerClient,
  type StoragePipelineOptions,
} from '@azure/storage-blob';

/**
 * A stub of the slice of the Azure Blob service the drivers use, on 127.0.0.1, for tests that drive a real
 * `@azure/storage-blob` client: what the SDK does with a response, and whether the socket under it is let go, happens
 * below any seam a fake could stand in.
 *
 * It holds blobs in memory and serves the requests the drivers send: a conditional `PUT` (`If-None-Match: *`,
 * `If-Match`), a `GET` of a whole blob or of an `x-ms-range`, a `HEAD`, a `DELETE`, and a container listing. A test
 * can replace the answer to every `GET` (`getOverride`), or plan what happens to any request (`plan`): hold it and then
 * answer, or stall it before the headers, after them, or part-way through the body, and see whether the client let go
 * of the connection that carried it.
 */

export interface StoredBlob {
  readonly body: Buffer;
  readonly etag: string;
  readonly metadata: Record<string, string>;
}

export interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  /**
   * The body; `'endless'` for one that never ends until the client hangs up; or `{ cut }`, those bytes and then the
   * connection dropped.
   */
  readonly body: Buffer | 'endless' | { readonly cut: Buffer };
}

/** One request as the stub saw it, numbered from 1 in the order it arrived. */
export interface StubRequest {
  readonly n: number;
  readonly method: string;
  /** The blob's name, or `''` for a request on the container. */
  readonly name: string;
  readonly range?: string;
  readonly ifMatch?: string;
  /** `true` for a container listing. */
  readonly list: boolean;
}

/**
 * What to do with a request: hold it for `delayMs` and then answer it, stall it for good before its headers, after
 * them (the headers sent and nothing more), or part-way through its body (the headers and half the body), or drop its
 * connection part-way through the body (the headers and half the body, and then the socket destroyed).
 */
export type Plan =
  | { readonly delayMs: number }
  | { readonly stall: 'before-headers' | 'after-headers' | 'mid-body' }
  | { readonly drop: 'mid-body' }
  /**
   * Answer `respond` instead of what the stub holds: without applying the request, or (`apply`) after applying it, and
   * then running `after`, as another writer landing on top before the answer arrives.
   */
  | { readonly respond: Answer; readonly apply?: boolean; readonly after?: () => Promise<void> };

export const xmlError = (status: number, code: string): Answer => ({
  status,
  headers: { 'content-type': 'application/xml', 'x-ms-error-code': code },
  body: Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  ),
});

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class StubBlobService {
  readonly blobs = new Map<string, StoredBlob>();
  /** Every request: its method, and the range and condition it carried. */
  readonly requests: Array<{ method: string; range?: string; ifMatch?: string }> = [];
  /** When set, answers every GET instead of the stored blob; `host` is the name the request was sent to. */
  getOverride: ((cur: StoredBlob | undefined, host: string) => Answer) | undefined;
  /**
   * For each GET answered by `getOverride`, whether the connection that carried it has closed, and the body bytes the
   * stub had handed to it by then.
   */
  readonly overridden: Array<{ closed: boolean; sent: number }> = [];
  /** When set, decides what happens to each request before it is served; `undefined` serves it at once. */
  plan: ((req: StubRequest) => Plan | undefined) | undefined;
  /** For each request `plan` stalled, its method and whether the connection that carried it has closed. */
  readonly stalled: Array<{ method: string; closed: boolean }> = [];
  private seq = 0;
  private received = 0;
  private readonly server: Server = createServer((req, res) => {
    void this.serve(req, res);
  });
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/devstoreaccount1/c`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A container client of the SDK's own, with its default pipeline unless `options` change it. */
  client(options?: StoragePipelineOptions): ContainerClient {
    return new ContainerClient(this.url, new AnonymousCredential(), options);
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  /** Every stalled request's connection has closed: the client let go of it rather than leaving it to hang. */
  async releasedStalls(): Promise<boolean> {
    const done = (): boolean => this.stalled.length > 0 && this.stalled.every((s) => s.closed);
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
    return done();
  }

  private send(res: ServerResponse, answer: Answer, watched?: { sent: number }): void {
    res.writeHead(answer.status, { 'x-ms-request-id': 'stub', ...answer.headers });
    if (Buffer.isBuffer(answer.body)) {
      res.end(answer.body);
      return;
    }
    if (answer.body !== 'endless') {
      // Dropped a moment after the write, so the bytes written go out before the connection does.
      res.write(answer.body.cut);
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const chunk = Buffer.alloc(64 * 1024, 0x7b);
    const pump = (): void => {
      while (!res.destroyed) {
        if (watched !== undefined) watched.sent += chunk.length;
        if (!res.write(chunk)) break;
      }
      if (!res.destroyed) res.once('drain', pump);
    };
    pump();
  }

  /** The answer the stub gives `req` from what it holds, after applying a write. */
  private answer(req: IncomingMessage, request: StubRequest, body: Buffer): Answer {
    const cur = this.blobs.get(request.name);
    const header = (h: string): string | undefined => {
      const v = req.headers[h];
      return typeof v === 'string' ? v : undefined;
    };
    if (request.list) return this.listing(new URL(req.url ?? '', 'http://stub').searchParams);
    if (request.ifMatch !== undefined && (cur === undefined || cur.etag !== request.ifMatch)) {
      return req.method === 'HEAD'
        ? { ...xmlError(412, 'ConditionNotMet'), body: Buffer.alloc(0) }
        : xmlError(412, 'ConditionNotMet');
    }
    if (req.method === 'PUT') {
      if (header('if-none-match') === '*' && cur !== undefined) {
        return xmlError(409, 'BlobAlreadyExists');
      }
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith('x-ms-meta-') && typeof v === 'string') metadata[k.slice(10)] = v;
      }
      const etag = `"0x8D${String(++this.seq).padStart(12, '0')}"`;
      this.blobs.set(request.name, { body, etag, metadata });
      return { status: 201, headers: { etag }, body: Buffer.alloc(0) };
    }
    if (req.method === 'DELETE') {
      if (cur === undefined) return xmlError(404, 'BlobNotFound');
      this.blobs.delete(request.name);
      return { status: 202, headers: {}, body: Buffer.alloc(0) };
    }
    if (cur === undefined) {
      return req.method === 'HEAD'
        ? { status: 404, headers: {}, body: Buffer.alloc(0) }
        : xmlError(404, 'BlobNotFound');
    }
    const headers: Record<string, string> = {
      etag: cur.etag,
      'content-type': 'application/octet-stream',
      'x-ms-blob-type': 'BlockBlob',
      'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
    };
    for (const [k, v] of Object.entries(cur.metadata)) headers[`x-ms-meta-${k}`] = v;
    if (req.method === 'HEAD') {
      return {
        status: 200,
        headers: { ...headers, 'content-length': String(cur.body.length) },
        body: Buffer.alloc(0),
      };
    }
    const range = request.range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(request.range);
    if (range === null) {
      return {
        status: 200,
        headers: { ...headers, 'content-length': String(cur.body.length) },
        body: cur.body,
      };
    }
    const start = Number(range[1]);
    if (start >= cur.body.length) return xmlError(416, 'InvalidRange');
    const end = Math.min(Number(range[2]), cur.body.length - 1);
    const slice = cur.body.subarray(start, end + 1);
    return {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${end}/${cur.body.length}`,
      },
      body: slice,
    };
  }

  /** A container listing of every blob under `prefix`, in one page. */
  private listing(query: URLSearchParams): Answer {
    const prefix = query.get('prefix') ?? '';
    const blobs = [...this.blobs.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([name, b]) =>
          `<Blob><Name>${xmlEscape(name)}</Name><Properties>` +
          `<Last-Modified>Wed, 01 Oct 2026 00:00:00 GMT</Last-Modified><Etag>${b.etag}</Etag>` +
          `<Content-Length>${b.body.length}</Content-Length><BlobType>BlockBlob</BlobType>` +
          `</Properties></Blob>`,
      )
      .join('');
    return {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="${this.url}" ` +
          `ContainerName="c"><Prefix>${xmlEscape(prefix)}</Prefix><Blobs>${blobs}</Blobs><NextMarker /></EnumerationResults>`,
      ),
    };
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', 'http://stub');
    const name = decodeURIComponent(url.pathname.replace(/^\/devstoreaccount1\/c\/?/, ''));
    const header = (h: string): string | undefined => {
      const v = req.headers[h];
      return typeof v === 'string' ? v : undefined;
    };
    const request: StubRequest = {
      n: ++this.received,
      method: req.method ?? '',
      name,
      range: header('x-ms-range') ?? header('range'),
      ifMatch: header('if-match'),
      list: url.searchParams.get('comp') === 'list',
    };
    this.requests.push({ method: request.method, range: request.range, ifMatch: request.ifMatch });
    const body = await bodyOf(req);
    const plan = this.plan?.(request);
    if (plan !== undefined && 'delayMs' in plan) {
      await new Promise((r) => setTimeout(r, plan.delayMs));
    }
    if (plan !== undefined && 'stall' in plan) {
      const watched = { method: request.method, closed: false };
      this.stalled.push(watched);
      req.socket.once('close', () => (watched.closed = true));
      if (plan.stall === 'before-headers') return;
      const answer = this.answer(req, request, body);
      res.writeHead(answer.status, { 'x-ms-request-id': 'stub', ...answer.headers });
      if (plan.stall === 'after-headers' || !Buffer.isBuffer(answer.body)) {
        res.flushHeaders();
        return;
      }
      res.write(answer.body.subarray(0, Math.floor(answer.body.length / 2)));
      return;
    }
    if (plan !== undefined && 'respond' in plan) {
      if (plan.apply === true) {
        this.answer(req, request, body);
        await plan.after?.();
      }
      return this.send(res, plan.respond);
    }
    if (plan !== undefined && 'drop' in plan) {
      const answer = this.answer(req, request, body);
      res.writeHead(answer.status, { 'x-ms-request-id': 'stub', ...answer.headers });
      if (Buffer.isBuffer(answer.body)) {
        res.write(answer.body.subarray(0, Math.floor(answer.body.length / 2)));
      }
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    if (req.method === 'GET' && !request.list && this.getOverride !== undefined) {
      const watched = { closed: false, sent: 0 };
      this.overridden.push(watched);
      req.socket.once('close', () => (watched.closed = true));
      const cur = this.blobs.get(name);
      return this.send(res, this.getOverride(cur, (header('host') ?? '').split(':')[0]!), watched);
    }
    return this.send(res, this.answer(req, request, body));
  }
}

/** Collect the process events nothing caught, from now until `stop`. */
export function watchProcess(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const onEvent = (e: unknown): void => void events.push(e);
  process.on('unhandledRejection', onEvent);
  process.on('uncaughtException', onEvent);
  return {
    events,
    stop: () => {
      process.off('unhandledRejection', onEvent);
      process.off('uncaughtException', onEvent);
    },
  };
}
