import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CRC32C, File, Storage } from '@google-cloud/storage';
import { loadSegment } from '@/core/load';
import type { SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { GcsStorageDriver } from '@/gcs/storage';
import { roaringCodec } from '@/roaring-codec';
import { counterEntropy } from '../../helpers/entropy';
import { guardLoopback } from '../../helpers/loopback-guard';

/**
 * A write the GCS driver abandons past its simple-upload threshold, where the object streams as a resumable upload,
 * ends that upload's request at once, and no object is finalized.
 *
 * Destroying the SDK's write stream alone leaves the request open: the SDK destroys its upload with no error and
 * aborts the request only when the upload errors, so the request body waits for bytes that never come and holds the
 * socket, and the process, until the service drops the connection. The driver's abort ends the upload with an error
 * first. A sorted load reaches this whenever its ids fail past the threshold, and an erasure's rewrite on a read fault.
 *
 * The client is the SDK's own, over a stub of the resumable endpoints on the loopback interface; the guard refuses a
 * connection to anything else.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const BUCKET = 'b';
const THRESHOLD = 256 * 1024;

/**
 * The resumable upload endpoints, enough for one session, and an empty listing: what each session's creation asked
 * for, and what each upload's request did. A finished upload is answered with the object's hashes, which the SDK
 * checks against what it sent.
 */
class ResumableStub {
  private readonly server: Server = createServer((req, res) => this.serve(req, res));
  endpoint = '';
  finalized = 0;
  /** Each session's creation: its query, and the object metadata in its body. */
  readonly sessions: Array<{ query: URLSearchParams; body: Record<string, unknown> }> = [];
  /** While set, a session's creation is answered only once it settles. */
  answerSessions: Promise<void> | undefined;
  private onSession: () => void = () => undefined;
  /** Settles when the first session's creation arrives. */
  readonly sessionAsked = new Promise<void>((resolve) => {
    this.onSession = resolve;
  });
  private onSessionAnswered: () => void = () => undefined;
  /** Settles once the first session's creation has been answered in full. */
  readonly sessionAnswered = new Promise<void>((resolve) => {
    this.onSessionAnswered = resolve;
  });
  /** Settles when a session's upload request closes: `true` if its body ended, `false` if it was cut off first. */
  private closed: Array<(ended: boolean) => void> = [];
  readonly uploads: Promise<boolean>[] = [];
  private onUpload: () => void = () => undefined;
  /** Settles when the first upload request arrives, so a test can fail its write while the request is open. */
  readonly uploading = new Promise<void>((resolve) => {
    this.onUpload = resolve;
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
      const body: Buffer[] = [];
      req.on('data', (chunk: Buffer) => body.push(chunk));
      req.on('end', () => {
        this.sessions.push({
          query: url.searchParams,
          body: JSON.parse(Buffer.concat(body).toString('utf8') || '{}') as Record<string, unknown>,
        });
        this.onSession();
        void (this.answerSessions ?? Promise.resolve()).then(() => {
          res.writeHead(200, {
            location: `${this.endpoint}/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&upload_id=session`,
          });
          res.end('{}', () => this.onSessionAnswered());
        });
      });
      return;
    }
    if (req.method === 'PUT' && url.searchParams.get('upload_id') === 'session') {
      let ended = false;
      this.uploads.push(new Promise((resolve) => this.closed.push(resolve)));
      const settle = this.closed.at(-1)!;
      const md5 = createHash('md5');
      const crc = new CRC32C();
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        md5.update(chunk);
        crc.update(chunk);
        size += chunk.length;
      });
      req.on('end', () => {
        ended = true;
        this.finalized++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            kind: 'storage#object',
            name: 'x',
            bucket: BUCKET,
            generation: '1',
            size: String(size),
            md5Hash: md5.digest('base64'),
            crc32c: crc.toString(),
          }),
        );
      });
      req.on('close', () => settle(ended));
      this.onUpload();
      return;
    }
    if (req.method === 'GET' && url.pathname === `/storage/v1/b/${BUCKET}/o`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'storage#objects', items: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 404, message: 'not found', errors: [] } }));
  }
}

/** `promise`, or `'still open'` once `ms` pass without it settling. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'still open'> =>
  Promise.race([promise, new Promise<'still open'>((r) => setTimeout(() => r('still open'), ms))]);

/** The uploads the SDK hands the driver's write streams, recorded on the way past the driver's own hold. */
function handedUploads(): object[] {
  const handed: object[] = [];
  const start = File.prototype.startResumableUpload_;
  vi.spyOn(File.prototype, 'startResumableUpload_').mockImplementation(function (
    this: File,
    dup,
    options,
  ) {
    const handOver = dup.setWritable;
    dup.setWritable = (upload) => {
      handOver.call(dup, upload);
      if (upload) handed.push(upload);
    };
    start.call(this, dup, options);
  });
  return handed;
}

let stub: ResumableStub;
let guard: ReturnType<typeof guardLoopback>;
beforeEach(async () => {
  guard = guardLoopback();
  stub = new ResumableStub();
  await stub.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stub.stop();
  guard.restore();
  expect(guard.attempts).toEqual([]);
});

function driver(): GcsStorageDriver {
  return new GcsStorageDriver({
    storage: new Storage({ projectId: 'test', apiEndpoint: stub.endpoint }),
    bucket: BUCKET,
    simpleUploadThresholdBytes: THRESHOLD,
  });
}

/** Array containers of 4,096 ids two apart, 8 KiB each, over `chunks` chunks. */
function* spread(chunks: number): Generator<number> {
  for (let chunk = 0; chunk < chunks; chunk++) {
    for (let i = 0; i < 4_096; i++) yield chunk * 65_536 + 2 * i;
  }
}

describe('GCS: an upload abandoned past the simple-upload threshold', () => {
  it('ends its request at once when a sorted load is refused, and finalizes nothing', async () => {
    const raised = new Error('the warehouse cursor expired');
    async function* ids(): AsyncGenerator<number> {
      yield* spread(128); // about 1 MiB, four times the threshold
      await stub.uploading;
      throw raised;
    }
    const deps = {
      storage: driver(),
      registry: new MemoryRegistryDriver(),
      entropy: counterEntropy(),
      codec: roaringCodec,
    };
    const err = await loadSegment(SEG, ids(), deps, { sorted: true }).catch((e: unknown) => e);
    expect(err).toBe(raised);
    expect(stub.uploads).toHaveLength(1);
    expect(await within(stub.uploads[0]!, 3_000)).toBe(false);
    expect(stub.finalized).toBe(0);
  });

  it("ends its request at once when the write fails, whoever's write it is", async () => {
    const failure = new Error('the rewrite could not read a chunk');
    const err = await driver()
      .putImmutable({ ...SEG, generation: 0 }, async (sink) => {
        for (let i = 0; i < 4; i++) await sink.write(new Uint8Array(THRESHOLD).fill(i));
        await stub.uploading;
        throw failure;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(stub.uploads).toHaveLength(1);
    expect(await within(stub.uploads[0]!, 3_000)).toBe(false);
    expect(stub.finalized).toBe(0);
  });

  it('starts no request when the write fails before its upload has a session', async () => {
    let answer: () => void = () => undefined;
    stub.answerSessions = new Promise((resolve) => (answer = resolve));
    const failure = new Error('the rewrite could not read a chunk');
    const err = await driver()
      .putImmutable({ ...SEG, generation: 0 }, async (sink) => {
        for (let i = 0; i < 2; i++) await sink.write(new Uint8Array(THRESHOLD).fill(i));
        await stub.sessionAsked;
        throw failure;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The session is created only now, after the abort: the SDK would start its upload's request on it.
    answer();
    await stub.sessionAnswered;
    expect(await within(stub.uploading, 500)).toBe('still open');
    expect(stub.uploads).toHaveLength(0);
    expect(stub.finalized).toBe(0);
  });

  it('commits an upload that completes, through the same stub (the control)', async () => {
    const handed = handedUploads();
    const written = await driver().putImmutable({ ...SEG, generation: 0 }, async (sink) => {
      for (let i = 0; i < 4; i++) await sink.write(new Uint8Array(THRESHOLD).fill(i));
    });
    expect(written.size).toBe(4 * THRESHOLD);
    expect(await within(stub.uploads[0]!, 3_000)).toBe(true);
    expect(stub.finalized).toBe(1);
    // The driver held the upload, the hold an abort depends on: an SDK that stops handing it over fails here.
    expect(handed).toHaveLength(1);
    expect(Object.hasOwn(handed[0]!, 'startUploading')).toBe(true);
    // The session was created write-once, with the write id the driver reads back on a 412.
    expect(stub.sessions).toHaveLength(1);
    expect(stub.sessions[0]!.query.get('ifGenerationMatch')).toBe('0');
    expect(stub.sessions[0]!.body).toMatchObject({
      metadata: { cbwid: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
  });
});
