/**
 * Logical-ref → S3 object-key mapping for {@link S3ColdDriver}.
 *
 * Pure string logic with no SDK dependency, so it's unit-testable without S3/MinIO. Mirrors the LocalFs
 * layout (`<namespace>/segments/<segment>.<gen>.crbm`) under an optional caller prefix, and re-validates
 * names at the boundary (defense in depth, even though the engine already validates — S2). The default
 * (absent) namespace maps to `_default`, which cannot collide with a real namespace because a caller's
 * `_default` encodes to `%5Fdefault` while the sentinel is emitted literally.
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { GenKey, SegmentRef } from '@/core/ports';
import { encodeNameForKey, namespaceKeyPart } from '../_shared/keys';

const SUFFIX = '.crbm';

/** Normalize an optional caller prefix to either `''` or `trimmed/` (no leading/trailing slashes). */
function prefixPart(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** Validate a caller-supplied key prefix. The rule is shared with every other object store. */
export { normalizeObjectPrefix as normalizeS3Prefix } from '../_shared/object-registry-keys';

/**
 * The S3 key prefix shared by all of a segment's generations: `<prefix><ns>/segments/<segment>.`. Used
 * both as the `ListObjectsV2` prefix and as the string stripped by {@link parseGenerationFromKey}.
 */
export function segmentObjectPrefix(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${prefixPart(prefix)}${namespaceKeyPart(ref.namespace)}/segments/${encodeNameForKey(ref.segment)}.`;
}

/** The full S3 key of one `.crbm` generation: `<segmentPrefix><gen>.crbm`. */
export function coldObjectKey(prefix: string | undefined, key: GenKey): string {
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return `${segmentObjectPrefix(prefix, key)}${key.generation}${SUFFIX}`;
}

// ─── Registry keys ─────────────────────────────────────────────────────────────────────────────────────
// The registry layout is identical across S3, GCS and Azure Blob — all three encode names the same way and
// build byte-identical keys — so it lives in `_shared/object-registry-keys` and is re-exported here for the
// callers (and tests) that already name it through this module.
export {
  registryPrefix,
  registryObjectKey,
  registryListPrefix,
  parseRegistryKey,
} from '../_shared/object-registry-keys';

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
