/**
 * The refusal of a combine operand that names no segment, shared by the streamed combines and the batch combine, so
 * the two ask the same way and say the same words. Pure: the registry is read through the `exists` it is given.
 */
import { boundedAll } from './concurrency';
import { ValidationError } from './errors';

/**
 * Throws {@link ValidationError} naming every one of `candidates` whose segment does not exist, asking `exists` of
 * each, at most `limit` at once, in their order. A streamed combine asks only after operands that hold no chunk at all;
 * the batch combine also asks after every operand it did not index (one no output names, or every operand when the range
 * is empty). `op` begins the message (`intersect`, `materializeMany`); `nameOf` is how the caller's operands are named
 * in it, each in double quotes. The first `exists` to reject rejects the call at once; none is asked after that.
 */
export async function refuseAbsent<T>(
  op: string,
  candidates: readonly T[],
  limit: number,
  exists: (candidate: T) => Promise<boolean>,
  nameOf: (candidate: T) => string,
): Promise<void> {
  if (candidates.length === 0) return;
  const found = await boundedAll(candidates, limit, exists);
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
