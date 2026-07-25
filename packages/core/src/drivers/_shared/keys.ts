/**
 * Shared key-grammar fragments used by every driver's logical-ref → physical-key mapping (Phase 4c).
 *
 * Extracted once the registry drivers became the 4th/5th consumer of the same `_default` namespace sentinel
 * (it lived copy-pasted in `s3/keys`, `dynamodb/keys`, `localfs/paths`). Pure string logic, no SDK, no I/O —
 * lives in the SDK-free `_shared` bundle so any driver may import it.
 */

/**
 * The physical stand-in for an **absent** namespace. The name grammar forbids a leading underscore
 * so `_default` can never collide with a real
 * namespace — `segment("s")` and `segment("s", { namespace: "_default" })` would be a grammar error, not an
 * aliasing hazard.
 */
export const DEFAULT_NAMESPACE = '_default';

/** Map an optional namespace to its physical part: the namespace itself, or {@link DEFAULT_NAMESPACE}. */
export function namespacePart(namespace: string | undefined): string {
  return namespace ?? DEFAULT_NAMESPACE;
}
