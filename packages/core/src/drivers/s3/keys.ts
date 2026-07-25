/**
 * Logical-ref → S3 object-key mapping for {@link S3ColdDriver}.
 *
 * Pure string logic with no SDK dependency, so it's unit-testable without S3/MinIO. Mirrors the LocalFs
 * layout (`<namespace>/segments/<segment>.<gen>.crbm`) under an optional caller prefix, and re-validates
 * names at the boundary (defense in depth, even though the engine already validates — S2). The default
 * (absent) namespace maps to `_default`, which can't collide with a real namespace (the grammar forbids a
 * leading underscore).
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { GenKey, SegmentRef } from '@/core/ports';
import { DEFAULT_NAMESPACE, namespacePart } from '../_shared/keys';

const SUFFIX = '.crbm';
const REGISTRY_SUFFIX = '.reg';

/** Normalize an optional caller prefix to either `''` or `trimmed/` (no leading/trailing slashes). */
function prefixPart(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/**
 * Validate the caller-supplied key prefix (trusted config, but make it a real containment boundary):
 * reject control characters and `.`/`..` path segments so a prefix can't traverse out of its intended space.
 * Returns it unchanged (the key builders normalize slashes). Shared by the S3 cold + registry drivers.
 */
export function normalizeS3Prefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  for (const ch of prefix) {
    if (ch.charCodeAt(0) < 0x20) {
      throw new ValidationError('prefix must not contain control characters');
    }
  }
  for (const segment of prefix.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new ValidationError(
        `prefix must not contain "." or ".." path segments: ${JSON.stringify(prefix)}`,
      );
    }
  }
  return prefix;
}

/**
 * The S3 key prefix shared by all of a segment's generations: `<prefix><ns>/segments/<segment>.`. Used
 * both as the `ListObjectsV2` prefix and as the string stripped by {@link parseGenerationFromKey}.
 */
export function segmentObjectPrefix(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${prefixPart(prefix)}${namespacePart(ref.namespace)}/segments/${ref.segment}.`;
}

/** The full S3 key of one `.crbm` generation: `<segmentPrefix><gen>.crbm`. */
export function coldObjectKey(prefix: string | undefined, key: GenKey): string {
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return `${segmentObjectPrefix(prefix, key)}${key.generation}${SUFFIX}`;
}

// ─── Registry keys ({@link S3RegistryDriver}) ───────────────────────────────────────────────────────────
// Registry objects live under a **registry-first** prefix (`<prefix>registry/<ns>/<segment>.reg`) — separate
// from the namespace-first cold layout — so discovery is a single `ListObjectsV2` over `registry/` (all
// namespaces) or `registry/<ns>/` (one), never entangled with the `.crbm` payload objects.

/** The S3 key prefix under which every registry object lives: `<prefix>registry/`. */
export function registryPrefix(prefix: string | undefined): string {
  return `${prefixPart(prefix)}registry/`;
}

/** The full S3 key of one segment's registry object: `<prefix>registry/<ns>/<segment>.reg`. */
export function registryObjectKey(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${registryPrefix(prefix)}${namespacePart(ref.namespace)}/${ref.segment}${REGISTRY_SUFFIX}`;
}

/** The `ListObjectsV2` prefix for discovery: registry-wide, or scoped to one namespace. */
export function registryListPrefix(prefix: string | undefined, namespace?: string): string {
  const base = registryPrefix(prefix);
  return namespace === undefined ? base : `${base}${namespacePart(namespace)}/`;
}

/**
 * Parse a `<prefix>registry/<ns>/<segment>.reg` key back to its {@link SegmentRef}, or `null` if it doesn't
 * match (a stray/foreign object under the prefix, or one whose parsed ref fails the name grammar). `_default`
 * maps back to the absent namespace; a segment name can't contain `/`, so the split is unambiguous.
 */
export function parseRegistryKey(prefix: string | undefined, objectKey: string): SegmentRef | null {
  const base = registryPrefix(prefix);
  if (!objectKey.startsWith(base) || !objectKey.endsWith(REGISTRY_SUFFIX)) return null;
  const rest = objectKey.slice(base.length, objectKey.length - REGISTRY_SUFFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const nsPart = rest.slice(0, slash);
  const segment = rest.slice(slash + 1);
  if (segment.length === 0 || segment.includes('/')) return null;
  const namespace = nsPart === DEFAULT_NAMESPACE ? undefined : nsPart;
  const ref: SegmentRef = { segment, namespace };
  try {
    validateSegmentRef(ref); // reject a hostile/foreign key that isn't a valid ref
  } catch {
    return null;
  }
  return ref;
}

/**
 * Parse a generation number out of a full object key, given its segment prefix, or `null` if it doesn't
 * match. Canonical decimal only — no leading zeros (so `…s.07.crbm` can't alias `…s.7.crbm`) and within
 * safe-integer range. This also rejects a *different* segment whose name merely shares the prefix (e.g. a
 * key for segment `s.x` won't parse under segment `s`'s prefix, since its middle isn't all digits).
 */
export function parseGenerationFromKey(segmentPrefix: string, objectKey: string): number | null {
  if (!objectKey.startsWith(segmentPrefix) || !objectKey.endsWith(SUFFIX)) return null;
  const middle = objectKey.slice(segmentPrefix.length, objectKey.length - SUFFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(middle)) return null;
  const generation = Number(middle);
  return Number.isSafeInteger(generation) ? generation : null;
}
