/**
 * The storage object layout, shared by every object-store driver (S3, GCS, Azure Blob): one `.crbm` object per
 * generation at `<prefix><ns>/segments/<segment>.<gen>.crbm`, namespace-first, beside the registry's own layout
 * (`object-registry-keys.ts`) under the same caller prefix.
 *
 * One definition, so a segment written by one driver reads identically under another: two drivers disagreeing about
 * how a name becomes a key would be a silent cross-driver incompatibility on the same bucket, a segment that quietly
 * cannot be found. Pure string logic, no SDK. The names are re-validated here, because a driver can be constructed and
 * driven directly rather than through the engine that would otherwise have validated them. The default (absent)
 * namespace maps to `_default`, which cannot collide with a real namespace because a caller's `_default` encodes to
 * `%5Fdefault` while the sentinel is emitted literally.
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { GenKey, SegmentRef } from '@/core/ports';
import { encodeNameForKey, namespaceKeyPart } from './keys';
import { prefixPart } from './object-registry-keys';

const SUFFIX = '.crbm';

/**
 * The key prefix shared by all of a segment's generations, `<prefix><ns>/segments/<segment>.`: the prefix a listing of
 * the segment's generations asks for, and the string {@link parseGenerationFromKey} strips.
 */
export function segmentObjectPrefix(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${prefixPart(prefix)}${namespaceKeyPart(ref.namespace)}/segments/${encodeNameForKey(ref.segment)}.`;
}

/** The full key of one generation's object, `<segmentPrefix><gen>.crbm`; a generation that is not a whole number from 0 is refused. */
export function storageObjectKey(prefix: string | undefined, key: GenKey): string {
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return `${segmentObjectPrefix(prefix, key)}${key.generation}${SUFFIX}`;
}

/**
 * The generation number in a full object key, given its segment's prefix, or `null` when the key is not one of that
 * segment's generations. Canonical decimal only: no leading zeros (so `…s.07.crbm` cannot alias `…s.7.crbm`), within
 * the safe-integer range. A *different* segment whose name merely shares the prefix does not parse either: a key for
 * segment `s.x` under segment `s`'s prefix has a middle that is not all digits.
 */
export function parseGenerationFromKey(segmentPrefix: string, objectKey: string): number | null {
  if (!objectKey.startsWith(segmentPrefix) || !objectKey.endsWith(SUFFIX)) return null;
  const middle = objectKey.slice(segmentPrefix.length, objectKey.length - SUFFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(middle)) return null;
  const generation = Number(middle);
  return Number.isSafeInteger(generation) ? generation : null;
}
