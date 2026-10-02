/**
 * The registry token's form, as the shipped registries issue it: `<32 lowercase hex incarnation>.<counter>`.
 * Tests assert a token through these rather than as a literal, because the incarnation is random.
 */
import type { Entropy } from '@/core/determinism';

/** A token a shipped registry gives a row it creates over an absent key: a fresh incarnation, counter 0. */
export const CREATED_TOKEN = /^[0-9a-f]{32}\.0$/;

/** Take an incarnation-form token apart, failing the test on any other form. */
export function tokenParts(token: string): { incarnation: string; counter: number } {
  const m = /^([0-9a-f]{32})\.(0|[1-9]\d*)$/.exec(token);
  if (m === null) throw new Error(`not an incarnation-form token: ${JSON.stringify(token)}`);
  return { incarnation: m[1]!, counter: Number(m[2]) };
}

/** The token `n` writes after `token`, on the same incarnation. */
export function tokenAfter(token: string, n = 1): string {
  const { incarnation, counter } = tokenParts(token);
  return `${incarnation}.${counter + n}`;
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
