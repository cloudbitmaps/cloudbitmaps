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

/** Map an optional namespace to its physical part: the namespace itself, or {@link DEFAULT_NAMESPACE}. */
export function namespacePart(namespace: string | undefined): string {
  return namespace ?? DEFAULT_NAMESPACE;
}

/**
 * Percent-encode the one name character a **filesystem** cannot take literally, for use as a path component.
 *
 * A segment or namespace may contain `:` (`dedup:2026-08-01`). Object stores take that verbatim — an S3, GCS or
 * Azure key and a DynamoDB partition key are all happy — but a path cannot: on Windows
 * `dedup:2026-08-01.0.crbm` names an NTFS **alternate data stream** on a file called `dedup`, a write that can
 * *succeed* while `readdir` never lists the result. POSIX would accept the literal colon, which is exactly why
 * this is applied unconditionally: encoding only where the OS forces it would pass every round-trip test on a
 * Linux runner and lose a user's data on Windows.
 *
 * `%3A` is reversible because `%` is not in the name grammar: no legal name can spell an escape, so
 * {@link decodeNameFromPath} cannot mistake user text for one, and no two names can encode to the same path.
 *
 * Exported because more than one place maps a name onto a path — the LocalFs drivers and the `export-segments`
 * eject sink — and the two spellings must agree for an export to be diffable against the store it came from.
 */
export function encodeNameForPath(name: string): string {
  return name.replaceAll(':', '%3A');
}

/**
 * Inverse of {@link encodeNameForPath}, for reading a name back off a filesystem.
 *
 * Callers that read a name off disk should also require the encoding to **round-trip**
 * (`encodeNameForPath(decoded) === raw`) rather than merely decode: POSIX will hold a planted literal
 * `a:b` entry alongside the driver's own `a%3Ab`, and both decode to the same name.
 */
export function decodeNameFromPath(encoded: string): string {
  return encoded.replaceAll('%3A', ':');
}
