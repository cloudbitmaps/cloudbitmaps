/**
 * The registry object layout, shared by every object-store registry (S3, GCS, Azure Blob).
 *
 * One tiny JSON object per segment at `<prefix>registry/<ns>/<segment>.reg`, **registry-first** — separate
 * from the namespace-first cold layout (`<prefix><ns>/segments/…`) — so discovery is a single list over
 * `registry/` for all namespaces, or `registry/<ns>/` for one, never entangled with the `.crbm` payloads.
 *
 * It lives here rather than in a driver because all three object stores encode names the same way
 * (`encodeNameForKey`, `namespaceKeyPart`) and build byte-identical keys. Three copies of this would be
 * three chances for one cloud's layout to drift from the others — and a drifted key is not a visible bug, it
 * is a segment that quietly cannot be found by a store pointed at the same bucket.
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { SegmentRef } from '@/core/ports';
import { DEFAULT_NAMESPACE, decodeNameFromKey, encodeNameForKey, namespaceKeyPart } from './keys';

const REGISTRY_SUFFIX = '.reg';

/** Normalize an optional caller prefix to either `''` or `trimmed/` (no leading/trailing slashes). */
export function prefixPart(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/**
 * Validate a caller-supplied key prefix (trusted config, but make it a real containment boundary): reject
 * control characters and `.`/`..` path segments so a prefix cannot traverse out of its intended space.
 * Returns it unchanged — the key builders normalize slashes.
 *
 * The traversal check covers three spellings, because the tools that walk these buckets do. A bare `..` is
 * the obvious one. A **backslash** segment matters on ADLS Gen2 and to Windows-side tooling, which treat it
 * as a separator this code otherwise would not. And a percent-encoded `..` matters because `gsutil`,
 * `s3fs`, `gcsfuse` and `azcopy` decode a key on their way to a local path — the same reasoning
 * `name-codec.ts` already applies to segment names, which a prefix has no reason to be exempt from.
 */
export function normalizeObjectPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  for (const ch of prefix) {
    const code = ch.charCodeAt(0);
    // C0 plus DEL: a bare `< 0x20` lets U+007F through, and it is as unprintable as the rest.
    if (code < 0x20 || code === 0x7f) {
      throw new ValidationError('prefix must not contain control characters');
    }
  }
  if (prefix.includes('\\')) {
    throw new ValidationError(
      `prefix must not contain backslashes (a path separator on some backends): ${JSON.stringify(prefix)}`,
    );
  }
  // Check the decoded spelling too, so an encoded `..` cannot slip past the literal comparison.
  let decoded: string;
  try {
    decoded = decodeURIComponent(prefix);
  } catch {
    decoded = prefix; // not valid percent-encoding; the literal check still applies
  }
  for (const source of decoded === prefix ? [prefix] : [prefix, decoded]) {
    for (const segment of source.split('/')) {
      if (segment === '.' || segment === '..') {
        throw new ValidationError(
          `prefix must not contain "." or ".." path segments: ${JSON.stringify(prefix)}`,
        );
      }
    }
  }
  return prefix;
}

/** The key prefix under which every registry object lives: `<prefix>registry/`. */
export function registryPrefix(prefix: string | undefined): string {
  return `${prefixPart(prefix)}registry/`;
}

/** The full key of one segment's registry object: `<prefix>registry/<ns>/<segment>.reg`. */
export function registryObjectKey(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${registryPrefix(prefix)}${namespaceKeyPart(ref.namespace)}/${encodeNameForKey(ref.segment)}${REGISTRY_SUFFIX}`;
}

/** The list prefix for discovery: registry-wide, or scoped to one namespace. */
export function registryListPrefix(prefix: string | undefined, namespace?: string): string {
  const base = registryPrefix(prefix);
  return namespace === undefined ? base : `${base}${namespaceKeyPart(namespace)}/`;
}

/**
 * Parse a `<prefix>registry/<ns>/<segment>.reg` key back to its {@link SegmentRef}, or `null` if it does not
 * match — a stray or foreign object under the prefix, or one whose parsed ref fails the round-trip check.
 * `_default` maps back to the absent namespace. A name is percent-encoded on the way in, so no encoded name
 * can contain `/` and the split stays unambiguous whatever the caller named their segment.
 */
export function parseRegistryKey(prefix: string | undefined, objectKey: string): SegmentRef | null {
  const base = registryPrefix(prefix);
  if (!objectKey.startsWith(base) || !objectKey.endsWith(REGISTRY_SUFFIX)) return null;
  const rest = objectKey.slice(base.length, objectKey.length - REGISTRY_SUFFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const nsPart = rest.slice(0, slash);
  const encodedSegment = rest.slice(slash + 1);
  if (encodedSegment.length === 0 || encodedSegment.includes('/')) return null;
  const segment = decodeNameFromKey(encodedSegment);
  const namespace = nsPart === DEFAULT_NAMESPACE ? undefined : decodeNameFromKey(nsPart);
  // The encoding must ROUND-TRIP, not merely decode: a foreign object placed under our prefix could spell a
  // name two ways, and reporting both would hand a sweep one segment under two identities.
  if (encodeNameForKey(segment) !== encodedSegment) return null;
  if (namespace !== undefined && encodeNameForKey(namespace) !== nsPart) return null;
  const ref: SegmentRef = { segment, namespace };
  try {
    validateSegmentRef(ref); // reject a hostile/foreign key that isn't a valid ref
  } catch {
    return null;
  }
  return ref;
}
