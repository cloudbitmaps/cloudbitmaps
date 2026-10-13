/**
 * The shape of a row's known-generations ledger (`knownGens`), in one place. A registry holds a row to it when it writes
 * and when it reads back, and `checkConsistency` holds a row to it before it reads or walks a ledger a registry of your
 * own handed back, so the two cannot part on what a ledger is. Pure: no I/O, time or randomness.
 */

const ENTRY_KEYS: readonly string[] = ['generation', 'footerCrc'];

/**
 * Why `value` is not a ledger, or `undefined` when it is one (an absent ledger, `undefined`, passes: whether a row
 * without one is usable is another rule). A ledger is an array of at most `max` entries, each exactly `{ generation,
 * footerCrc }`, the generation a non-negative safe integer and unique, the checksum an integer from 0 to 2^32 - 1. The
 * order is not checked: it is not derivable from the numbers. `show` renders a value for the description, which a
 * caller can truncate.
 */
export function knownGensShapeFault(
  value: unknown,
  max: number,
  show: (v: unknown) => string = String,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'must be an array';
  const list = value as unknown[];
  if (list.length > max) return `has ${list.length} entries, cap ${max}`;
  const seen = new Set<number>();
  for (const e of list) {
    if (typeof e !== 'object' || e === null || Array.isArray(e))
      return 'an entry must be an object';
    const entry = e as Record<string, unknown>;
    const extra = Object.keys(entry).filter((k) => !ENTRY_KEYS.includes(k));
    if (extra.length > 0) {
      return `an entry carries an undeclared field (${show(extra.join(', '))})`;
    }
    const { generation, footerCrc } = entry;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
      return `a generation must be a non-negative safe integer (got ${show(generation)})`;
    }
    if (
      !Number.isInteger(footerCrc) ||
      (footerCrc as number) < 0 ||
      (footerCrc as number) > 0xffff_ffff
    ) {
      return `a footerCrc must be an integer from 0 to 2^32 - 1 (got ${show(footerCrc)})`;
    }
    if (seen.has(generation as number)) return `generation ${String(generation)} is repeated`;
    seen.add(generation as number);
  }
  return undefined;
}
