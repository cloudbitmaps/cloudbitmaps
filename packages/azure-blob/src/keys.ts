/**
 * Logical-ref → Azure blob-name mapping for {@link AzureBlobStorageDriver}.
 *
 * Pure string logic, no SDK dependency — unit-testable without Azure or an emulator. Uses the **same
 * backend-agnostic `.crbm` object-name scheme** as the S3 + GCS + LocalFs storage drivers
 * (`<prefix><ns>/segments/<segment>.<gen>.crbm`), so a segment reads identically whichever storage backend holds
 * it. The default (absent) namespace maps to `_default`, which cannot collide with a real namespace because a
 * caller's `_default` encodes to `%5Fdefault` while the sentinel is emitted literally.
 *
 * The storage-key layout is shared, not copied: `prefixPart` and the name encoders come from
 * `@cloudbitmaps/core/driver-kit`, so a segment written by one driver reads identically under another. Two
 * drivers disagreeing about how a name becomes a key would be a silent cross-driver incompatibility on the
 * same bucket, which is exactly the kind of thing a local copy drifts into.
 */

import {
  ValidationError,
  encodeNameForKey,
  namespaceKeyPart,
  prefixPart,
  validateSegmentRef,
} from '@cloudbitmaps/core/driver-kit';
import type { GenKey, SegmentRef } from '@cloudbitmaps/core/driver-kit';

const SUFFIX = '.crbm';

/** Validate a caller-supplied key prefix. The rule is shared with every other object store. */
export { normalizeObjectPrefix as normalizeAzurePrefix } from '@cloudbitmaps/core/driver-kit';

/**
 * The Azure blob-name prefix shared by all of a segment's generations: `<prefix><ns>/segments/<segment>.`.
 * Used both as the `listBlobsFlat` prefix and as the string stripped by {@link parseGenerationFromName}.
 */
export function segmentObjectPrefix(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${prefixPart(prefix)}${namespaceKeyPart(ref.namespace)}/segments/${encodeNameForKey(ref.segment)}.`;
}

/** The full Azure blob name of one `.crbm` generation: `<segmentPrefix><gen>.crbm`. */
export function storageObjectName(prefix: string | undefined, key: GenKey): string {
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return `${segmentObjectPrefix(prefix, key)}${key.generation}${SUFFIX}`;
}

/**
 * Parse a generation number out of a full blob name, given its segment prefix, or `null` if it doesn't match.
 * Canonical decimal only — no leading zeros (so `…s.07.crbm` can't alias `…s.7.crbm`) and within safe-integer
 * range. Also rejects a *different* segment whose name merely shares the prefix (its middle isn't all digits).
 */
export function parseGenerationFromName(segmentPrefix: string, objectName: string): number | null {
  if (!objectName.startsWith(segmentPrefix) || !objectName.endsWith(SUFFIX)) return null;
  const middle = objectName.slice(segmentPrefix.length, objectName.length - SUFFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(middle)) return null;
  const generation = Number(middle);
  return Number.isSafeInteger(generation) ? generation : null;
}
