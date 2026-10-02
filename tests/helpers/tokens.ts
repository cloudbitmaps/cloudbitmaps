/**
 * The registry token's form, as the shipped registries issue it for a row they create:
 * `<32 lowercase hex incarnation>.<counter>.<16 lowercase hex write part>`.
 * Tests assert a token through these rather than as a literal, because the incarnation is random.
 */
import type { Entropy } from '@/core/determinism';

/** A token a shipped registry gives a row it creates over an absent key: a fresh incarnation, counter 0, a write part. */
export const CREATED_TOKEN = /^[0-9a-f]{32}\.0\.[0-9a-f]{16}$/;

/** Take an incarnation-form token apart, failing the test on any other form. */
export function tokenParts(token: string): { incarnation: string; counter: number; write: string } {
  const m = /^([0-9a-f]{32})\.(0|[1-9]\d*)\.([0-9a-f]{16})$/.exec(token);
  if (m === null) throw new Error(`not an incarnation-form token: ${JSON.stringify(token)}`);
  return { incarnation: m[1]!, counter: Number(m[2]), write: m[3]! };
}

/**
 * The tokens `n` writes after `token` may have: the same incarnation, the counter `n` on, and any write part. A
 * pattern, since the write part is random.
 */
export function tokenAfter(token: string, n = 1): RegExp {
  const { incarnation, counter } = tokenParts(token);
  return new RegExp(`^${incarnation}\\.${counter + n}\\.[0-9a-f]{16}$`);
}

/**
 * A deterministic entropy source: each draw is the next value of a counter, from `seed`, big-endian in the last
 * eight bytes. Distinct draws, replayable from the seed, and nothing like a production source.
 */
export function countingEntropy(seed = 1): Entropy & { draws: number } {
  let next = BigInt(seed);
  const source = Object.assign(
    (length: number): Uint8Array => {
      const out = new Uint8Array(length);
      new DataView(out.buffer).setBigUint64(length - 8, next);
      next += 1n;
      source.draws += 1;
      return out;
    },
    { draws: 0 },
  );
  return source;
}
