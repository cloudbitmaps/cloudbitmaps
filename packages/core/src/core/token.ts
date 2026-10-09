/**
 * The registry token's incarnation: the part of a token that says which incarnation of a name a row is.
 *
 * A shipped registry gives a row it creates a token `<incarnation>.<counter>.<write>`: 32 lowercase hex digits drawn
 * from injected entropy when the row is created, a decimal counter, and 16 hex digits drawn for each write. Every write
 * of the row keeps the incarnation, and a name created again draws a new one, so two incarnations are told apart by it
 * even when their rows were created in the same millisecond or one is gone. A row a 0.11 build wrote has no incarnation
 * for as long as it lives (`"7"`, then `"8.<write>"`), and a registry of someone else's issues tokens in any form.
 *
 * This lives in `core/` so the publish can read it, and the registry drivers, which build the tokens, import it from
 * here: the form has one definition.
 */
import type { Token } from './ports';

/** An incarnation-form token: the incarnation id, the counter and a write part, `.`-separated, in lowercase hex. */
export const INCARNATION_TOKEN = /^([0-9a-f]{32})\.(0|[1-9]\d*)\.([0-9a-f]{16})$/;

/**
 * The incarnation id in a token, or `undefined` for one that has none: a schema-1-born row's, or any token another
 * driver issues. Two tokens with the same incarnation are writes of one incarnation of a row.
 */
export function incarnationOf(token: Token): string | undefined {
  return INCARNATION_TOKEN.exec(token)?.[1];
}

/** An audit event's `incarnation`, from the token of the row it is about: absent for a token that carries none. */
export function incarnationField(token: Token | undefined): { readonly incarnation?: string } {
  const incarnation = token === undefined ? undefined : incarnationOf(token);
  return incarnation === undefined ? {} : { incarnation };
}

/**
 * Whether two reads of one name's row are one incarnation of it.
 *
 * - Both tokens carry an incarnation id: the ids decide, and the clock stamps do not enter.
 * - Only one does: different incarnations. A name created again is always given an incarnation id, and a write never
 *   takes one away, so a row without an id never becomes a row with one, nor the reverse.
 * - Neither does (a row 0.11 wrote, or a registry of someone else's): there is no id to compare, and the creation stamp
 *   is the only signal left. It is a clock reading, so a caller that acts on this answer proves its own object too.
 */
export function sameIncarnation(
  a: { readonly token: Token; readonly createdAt: number },
  b: { readonly token: Token; readonly createdAt: number },
): boolean {
  const ia = incarnationOf(a.token);
  const ib = incarnationOf(b.token);
  if (ia !== undefined || ib !== undefined) return ia === ib;
  return a.createdAt === b.createdAt;
}
