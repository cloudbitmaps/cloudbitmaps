/**
 * The refusal of a combine operand that names no segment, shared by the streamed combines and the batch combine, so
 * the two ask the same way and say the same words. Pure: the registry is read through the `exists` it is given.
 */
import { mapWithConcurrency } from './concurrency';
import { ValidationError } from './errors';

/**
 * The most `exists` reads one refusal has in flight at once (invariant 6). A combine asks only after the operands that
 * hold no chunk at all, which on a combine as it is meant to be called is none, so this bounds a mistaken or hostile
 * call, not a normal one.
 */
const ABSENT_CHECK_PARALLELISM = 16;

/**
 * Throws {@link ValidationError} naming every one of `candidates` whose segment does not exist, asking `exists` of
 * each, at most {@link ABSENT_CHECK_PARALLELISM} at once, in their order. `op` begins the message (`intersect`,
 * `materializeMany`); `nameOf` is how the caller's operands are named in it, each in double quotes. A rejected `exists`
 * rejects the call, with the first error to come back.
 */
export async function refuseAbsent<T>(
  op: string,
  candidates: readonly T[],
  exists: (candidate: T) => Promise<boolean>,
  nameOf: (candidate: T) => string,
): Promise<void> {
  if (candidates.length === 0) return;
  const found = await mapWithConcurrency(candidates, ABSENT_CHECK_PARALLELISM, (c) => exists(c));
  const absent = candidates.filter((_, i) => !found[i]);
  if (absent.length === 0) return;
  const named = absent.map((c) => `"${nameOf(c)}"`).join(', ');
  throw new ValidationError(
    `${op}: operand ${named} names a segment that does not exist or was dropped, so it would contribute nothing — ` +
      'an exclude would suppress no ids and an include would contribute none. Check the name and the namespace (a ' +
      'segment addressed without its `namespace` is a DIFFERENT segment). Pass `allowAbsentOperands: true` if you ' +
      'meant it.',
  );
}
