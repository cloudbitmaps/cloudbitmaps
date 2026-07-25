/**
 * Logical-ref → Azure blob-name mapping for {@link AzureBlobColdDriver} (Phase 7).
 *
 * Pure string logic, no SDK dependency — unit-testable without Azure or an emulator. Uses the **same
 * backend-agnostic `.crbm` object-name scheme** as the S3 + GCS + LocalFs cold drivers
 * (`<prefix><ns>/segments/<segment>.<gen>.crbm`), so a segment reads identically whichever cold backend holds
 * it. The default (absent) namespace maps to `_default` (the grammar forbids a leading underscore, so it can't
 * collide with a real namespace).
 *
 * NOTE (DRY): this mirrors the pure cold-key builders in `drivers/s3/keys.ts` + `drivers/gcs/keys.ts`. They
 * are deliberately **not** shared across driver folders today — a driver must stay self-contained so it lifts
 * cleanly into its own package at the [Phase 9 split]. At that
 * split the shared cold-key scheme is promoted into `@cloudbitmaps/core`'s driver-kit (imported by every driver
 * package), which is the right home for it; until then a self-contained copy beats a cross-driver import.
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { GenKey, SegmentRef } from '@/core/ports';
import { namespacePart } from '../_shared/keys';

const SUFFIX = '.crbm';

/** Normalize an optional caller prefix to either `''` or `trimmed/` (no leading/trailing slashes). */
function prefixPart(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/**
 * Validate the caller-supplied blob-name prefix (trusted config, but a real containment boundary): reject
 * control characters and `.`/`..` path segments so a prefix can't traverse out of its intended space. Returns
 * it unchanged (the key builders normalize slashes).
 */
export function normalizeAzurePrefix(prefix: string | undefined): string | undefined {
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
 * The Azure blob-name prefix shared by all of a segment's generations: `<prefix><ns>/segments/<segment>.`.
 * Used both as the `listBlobsFlat` prefix and as the string stripped by {@link parseGenerationFromName}.
 */
export function segmentObjectPrefix(prefix: string | undefined, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `${prefixPart(prefix)}${namespacePart(ref.namespace)}/segments/${ref.segment}.`;
}

/** The full Azure blob name of one `.crbm` generation: `<segmentPrefix><gen>.crbm`. */
export function coldObjectName(prefix: string | undefined, key: GenKey): string {
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
