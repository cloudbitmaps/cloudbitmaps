import { randomBytes } from 'node:crypto';
import { CRC32C } from '@google-cloud/storage';
import { crc32cBase64 } from '@/gcs/crc32c';

/** The driver's CRC32C is the SDK's, in the base64 form GCS takes in an upload's `crc32c` metadata. */
describe('crc32cBase64', () => {
  const sdk = (bytes: Uint8Array): string => {
    const crc = new CRC32C();
    crc.update(Buffer.from(bytes));
    return crc.toString();
  };

  it('gives the standard check value for "123456789"', () => {
    expect(Buffer.from(crc32cBase64(Buffer.from('123456789')), 'base64').readUInt32BE()).toBe(
      0xe3069283,
    );
  });

  it('agrees with the SDK on empty, short and random inputs', () => {
    const inputs = [
      new Uint8Array(0),
      Buffer.from('{"a":1}'),
      ...[1, 7, 64, 1000, 65_537].map((n) => randomBytes(n)),
    ];
    for (const bytes of inputs) expect(crc32cBase64(bytes)).toBe(sdk(bytes));
  });
});
