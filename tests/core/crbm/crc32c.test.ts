import { crc32c } from '@/core/crbm/crc32c';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32c (Castagnoli)', () => {
  it('matches the canonical "123456789" check value', () => {
    // The standard CRC-32C check value (e.g. RFC 3720 / iSCSI) is 0xE3069283.
    expect(crc32c(enc('123456789'))).toBe(0xe3069283);
  });

  it('is 0 for the empty input', () => {
    expect(crc32c(new Uint8Array())).toBe(0);
  });

  it('is order-sensitive and returns an unsigned 32-bit value', () => {
    const a = crc32c(enc('hello'));
    const b = crc32c(enc('olleh'));
    expect(a).not.toBe(b);
    for (const v of [a, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('streams: seeding with a prefix CRC equals a one-shot over the concatenation', () => {
    const whole = enc('the quick brown fox');
    const head = whole.subarray(0, 9);
    const tail = whole.subarray(9);
    expect(crc32c(tail, crc32c(head))).toBe(crc32c(whole));
  });
});
