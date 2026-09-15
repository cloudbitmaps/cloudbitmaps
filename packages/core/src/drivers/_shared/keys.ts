/**
 * Shared key-grammar fragments used by every driver's logical-ref → physical-key mapping.
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

/**
 * Map an optional namespace to its physical part: the namespace itself, or {@link DEFAULT_NAMESPACE}.
 *
 * **Prefer {@link namespaceKeyPart} / {@link namespacePathPart}** — they encode the caller's namespace and
 * leave the sentinel alone, which is the distinction that keeps the two apart.
 */
export function namespacePart(namespace: string | undefined): string {
  return namespace ?? DEFAULT_NAMESPACE;
}

/**
 * The physical namespace component of an **object key**: the caller's namespace encoded, or the sentinel.
 *
 * The sentinel is emitted **literally, never encoded**, and that asymmetry is the whole point. Encoding it too
 * would send an absent namespace to `%5Fdefault` — exactly where a caller who names their namespace `_default`
 * already goes, since the encoder escapes their leading underscore. Both would land in one place and read each
 * other's data. Encoding only the caller's side means `_default` (ours) and `%5Fdefault` (theirs) are two
 * different strings, and no caller can produce the first.
 */
export function namespaceKeyPart(namespace: string | undefined): string {
  return namespace === undefined ? DEFAULT_NAMESPACE : encodeNameForKey(namespace);
}

/** As {@link namespaceKeyPart}, for a filesystem path component. */
export function namespacePathPart(namespace: string | undefined): string {
  return namespace === undefined ? DEFAULT_NAMESPACE : encodeNameForPath(namespace);
}

// The name codec lives in `core/` (pure string logic, and `validate.ts` needs it); imported here so the
// drivers keep one import for key shaping, and re-exported for the same reason.
import { encodeNameForKey, encodeNameForPath } from '@/core/name-codec';

export {
  encodeNameForKey,
  decodeNameFromKey,
  encodeNameForPath,
  decodeNameFromPath,
} from '@/core/name-codec';
