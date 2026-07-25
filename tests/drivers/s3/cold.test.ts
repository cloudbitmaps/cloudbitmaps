import type { S3Client } from '@aws-sdk/client-s3';
import { S3ColdDriver } from '@/drivers/s3/cold';
import { ValidationError } from '@/core/errors';

// Constructor-level checks need no network (the client is never called), so they run on the normal lane.
const fakeClient = {} as unknown as S3Client;

describe('S3ColdDriver construction', () => {
  it('accepts a clean prefix (or none) and advertises conditional-put + range-read', () => {
    for (const prefix of [undefined, '', 'cloudroaring', 'a/b/c', '/leading/trailing/']) {
      const driver = new S3ColdDriver({ client: fakeClient, bucket: 'b', prefix });
      const caps = driver.capabilities();
      expect(caps.rangeRead).toBe(true);
      expect(caps.conditionalPut).toBe(true);
      expect(caps.maxObjectBytes).toBeGreaterThan(0);
    }
  });

  it('rejects a prefix with `..` / `.` path segments (containment)', () => {
    for (const prefix of ['..', 'a/../b', './x', 'a/./b', '../escape']) {
      expect(() => new S3ColdDriver({ client: fakeClient, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a prefix with control characters', () => {
    for (const prefix of ['a\tb', 'a\nb']) {
      expect(() => new S3ColdDriver({ client: fakeClient, bucket: 'b', prefix })).toThrow(
        ValidationError,
      );
    }
  });
});
