/**
 * The facade's refusal of the namespace the library keeps for its own rows.
 *
 * `cbm.due.` is where the due index stores its pointers, and every fleet-wide scan skips a row there as
 * bookkeeping, so a segment in it would be invisible to an erasure, a consistency check, an export and a retention
 * sweep. `@cloudbitmaps/core` refuses the prefix in every call that takes a ref or a `namespace` option; this is a
 * copy of that one constant, for the checks the facade makes itself before anything reaches core (`segment()`,
 * `invalidate()` and the scope of the two subject scans, which read the registry directly). A test holds the copy
 * equal to core's, so the two cannot drift.
 *
 * Internal: not exported from the package entry.
 */
import { ValidationError } from '@cloudbitmaps/core';

export const RESERVED_NAMESPACE_PREFIX = 'cbm.due.';

/** Throw `ValidationError` for a namespace in the reserved prefix; `undefined` and every look-alike pass. */
export function refuseReservedNamespace(namespace: string | undefined): void {
  if (namespace !== undefined && namespace.startsWith(RESERVED_NAMESPACE_PREFIX)) {
    throw new ValidationError(
      `namespace "${namespace}" is reserved: names starting with "${RESERVED_NAMESPACE_PREFIX}" hold the ` +
        `library's own bookkeeping rows, which every fleet-wide scan skips, so a segment there would be ` +
        `invisible to an erasure, a consistency check, an export and a retention sweep. Choose another namespace.`,
    );
  }
}
