import { createHash } from 'node:crypto';
import { S3ColdDriver } from '@/drivers/s3/cold';
import { ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/index';
import type { S3Client } from '@aws-sdk/client-s3';

const KEY: GenKey = { segment: 's', generation: 0 };
const FIVE_MB = 5 * 1024 * 1024;

/** A tiny in-memory S3 fake: records the command sequence, honors If-None-Match: *, reassembles multipart. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const mpus = new Map<string, Map<number, Buffer>>();
  const calls: string[] = [];
  let seq = 0;
  const precondition = (): never => {
    const e = new Error('precondition failed') as Error & { name: string; $metadata: unknown };
    e.name = 'PreconditionFailed';
    e.$metadata = { httpStatusCode: 412 };
    throw e;
  };
  const client = {
    send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      calls.push(name);
      switch (name) {
        case 'PutObjectCommand': {
          if (input.IfNoneMatch === '*' && objects.has(input.Key as string)) precondition();
          objects.set(input.Key as string, Buffer.from(input.Body as Uint8Array));
          return Promise.resolve({});
        }
        case 'CreateMultipartUploadCommand': {
          const id = `mpu-${++seq}`;
          mpus.set(id, new Map());
          return Promise.resolve({ UploadId: id });
        }
        case 'UploadPartCommand': {
          mpus
            .get(input.UploadId as string)!
            .set(input.PartNumber as number, Buffer.from(input.Body as Uint8Array));
          return Promise.resolve({ ETag: `"etag-${input.PartNumber as number}"` });
        }
        case 'CompleteMultipartUploadCommand': {
          if (input.IfNoneMatch === '*' && objects.has(input.Key as string)) precondition();
          const parts = mpus.get(input.UploadId as string)!;
          const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
          objects.set(input.Key as string, Buffer.concat(ordered));
          mpus.delete(input.UploadId as string);
          return Promise.resolve({});
        }
        case 'AbortMultipartUploadCommand': {
          mpus.delete(input.UploadId as string);
          return Promise.resolve({});
        }
        default:
          return Promise.reject(new Error(`unexpected command ${name}`));
      }
    },
  } as unknown as S3Client;
  return { client, objects, mpus, calls };
}

const writeBytes =
  (...buffers: Uint8Array[]) =>
  async (sink: { write: (b: Uint8Array) => Promise<void> }): Promise<void> => {
    for (const b of buffers) await sink.write(b);
  };

describe('S3ColdDriver — streaming/multipart putImmutable (Phase 4f)', () => {
  it('small object → single conditional PutObject (no multipart), correct size + sha256', async () => {
    const s3 = fakeS3();
    const driver = new S3ColdDriver({ client: s3.client, bucket: 'b' });
    const body = Buffer.from('a small .crbm object');
    const res = await driver.putImmutable(KEY, writeBytes(body));

    expect(s3.calls).toEqual(['PutObjectCommand']); // no multipart for a small object
    expect(res.size).toBe(body.length);
    expect(res.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(s3.objects.get('_default/segments/s.0.crbm')!.equals(body)).toBe(true);
  });

  it('large object → CreateMultipartUpload → UploadPart×N → conditional CompleteMultipartUpload', async () => {
    const s3 = fakeS3();
    const driver = new S3ColdDriver({ client: s3.client, bucket: 'b', partBytes: FIVE_MB });
    const a = Buffer.alloc(FIVE_MB + 1, 7); // each write trips a part flush
    const b = Buffer.alloc(FIVE_MB + 1, 9);
    const c = Buffer.from('tail');
    const res = await driver.putImmutable(KEY, writeBytes(a, b, c));

    expect(s3.calls).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand', // flush after `a`
      'UploadPartCommand', // flush after `b`
      'UploadPartCommand', // final `c` part on finish
      'CompleteMultipartUploadCommand',
    ]);
    const whole = Buffer.concat([a, b, c]);
    expect(res.size).toBe(whole.length);
    expect(res.sha256).toBe(createHash('sha256').update(whole).digest('hex'));
    expect(s3.objects.get('_default/segments/s.0.crbm')!.equals(whole)).toBe(true); // parts reassembled
  });

  it('write-once on the multipart path: a conditional Complete failure → WriteConflictError + abort', async () => {
    const s3 = fakeS3();
    s3.objects.set('_default/segments/s.0.crbm', Buffer.from('already here')); // the generation already exists
    const driver = new S3ColdDriver({ client: s3.client, bucket: 'b', partBytes: FIVE_MB });
    await expect(
      driver.putImmutable(KEY, writeBytes(Buffer.alloc(FIVE_MB + 1, 1))),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(s3.calls).toContain('AbortMultipartUploadCommand'); // in-flight upload cleaned up
    expect(s3.mpus.size).toBe(0);
  });

  it('an error mid-upload aborts the in-flight multipart upload', async () => {
    const s3 = fakeS3();
    const driver = new S3ColdDriver({ client: s3.client, bucket: 'b', partBytes: FIVE_MB });
    await expect(
      driver.putImmutable(KEY, async (sink) => {
        await sink.write(Buffer.alloc(FIVE_MB + 1, 1)); // starts the MPU + uploads a part
        throw new Error('codec blew up mid-write');
      }),
    ).rejects.toThrow('codec blew up');
    expect(s3.calls).toContain('AbortMultipartUploadCommand');
    expect(s3.mpus.size).toBe(0); // no leaked upload
  });

  it('advertises an HONEST cap (≤ 10,000 parts) and fails over it with a typed ValidationError', async () => {
    const s3 = fakeS3();
    // Default cap is partBytes × 10,000 — reachable within S3's part limit, not an aspirational 5 TiB.
    const driver = new S3ColdDriver({ client: s3.client, bucket: 'b', partBytes: FIVE_MB });
    expect(driver.capabilities().maxObjectBytes).toBe(FIVE_MB * 10_000);

    // A tiny explicit cap → an over-cap write fails fast + typed (never an opaque late S3 error), MPU aborted.
    const capped = new S3ColdDriver({ client: s3.client, bucket: 'b', maxObjectBytes: 100 });
    await expect(capped.putImmutable(KEY, writeBytes(Buffer.alloc(101, 1)))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(s3.mpus.size).toBe(0);
  });
});
