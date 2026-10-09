import { incarnationOf, sameIncarnation } from '@/core/token';
import { incarnationOf as incarnationOfFromRegistry } from '@/drivers/_shared/registry';

/**
 * The incarnation in a registry token, and whether two reads of one name are one incarnation of it. A token a shipped
 * registry issues for a row it creates is `<32 hex incarnation>.<counter>.<16 hex write part>`; a registry of someone
 * else's makes tokens in any form, and one whose tokens carry no incarnation id is told apart by the creation stamp.
 */

const INC_A = 'a'.repeat(32);
const INC_B = 'b'.repeat(32);
const W = '0123456789abcdef';
const at = (token: string, createdAt: number) => ({ token, createdAt });

describe('incarnationOf', () => {
  it('has a single definition, shared with the registry drivers', () => {
    expect(incarnationOfFromRegistry).toBe(incarnationOf);
  });

  it('names the incarnation of an incarnation-form token and of nothing else', () => {
    expect(incarnationOf(`${INC_A}.0.${W}`)).toBe(INC_A);
    expect(incarnationOf(`${INC_A}.41.${W}`)).toBe(INC_A);
    for (const token of [
      '7',
      `7.${W}`,
      '',
      `${INC_A}.0`,
      `${INC_A.toUpperCase()}.0.${W}`,
      'opaque-etag',
    ]) {
      expect(incarnationOf(token)).toBeUndefined();
    }
  });
});

describe('sameIncarnation', () => {
  it('is the incarnation id alone when both rows have one: the clock stamp does not enter', () => {
    // Created in the same millisecond, told apart by token.
    expect(sameIncarnation(at(`${INC_A}.3.${W}`, 1_000), at(`${INC_B}.0.${W}`, 1_000))).toBe(false);
    // One incarnation, written at different times.
    expect(sameIncarnation(at(`${INC_A}.3.${W}`, 1_000), at(`${INC_A}.9.${W}`, 2_000))).toBe(true);
  });

  it('says a row with an incarnation and one without are different incarnations, whatever their stamps', () => {
    // A registry gives its rows one form of token: a row with an id and one without are never one row.
    expect(sameIncarnation(at('etag-7', 1_000), at(`${INC_A}.0.${W}`, 1_000))).toBe(false);
    expect(sameIncarnation(at(`${INC_A}.0.${W}`, 1_000), at('etag-7', 1_000))).toBe(false);
  });

  it('falls back to the creation stamp when neither row has an incarnation id', () => {
    // A registry of someone else's: whatever its tokens look like, its stamp is all there is.
    expect(sameIncarnation(at('7', 1_000), at('8', 1_000))).toBe(true);
    expect(sameIncarnation(at('7', 1_000), at('8', 2_000))).toBe(false);
    expect(sameIncarnation(at('etag-1', 5), at('etag-2', 5))).toBe(true);
    expect(sameIncarnation(at('etag-1', 5), at('etag-2', 6))).toBe(false);
  });
});
