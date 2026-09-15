/**
 * Logical-ref → filesystem-path mapping for the LocalFs drivers (decision 6).
 *
 * Names are re-validated here at the driver boundary — defense in depth, even though the engine already
 * validates (S2) — so a driver is safe against traversal/injection even if driven directly. The default
 * (absent) namespace maps to `_default`, which can never collide with a real namespace because the name
 * grammar forbids a leading underscore.
 */
import { join } from 'node:path';
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { GenKey, SegmentRef } from '@/core/ports';
import {
  DEFAULT_NAMESPACE,
  decodeNameFromPath,
  encodeNameForPath,
  namespacePathPart,
} from '../_shared/keys';

/** Directory holding all of a namespace's segment objects. */
export function segmentsDir(root: string, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return join(root, namespacePathPart(ref.namespace), 'segments');
}

/** Absolute path of one `.crbm` generation object. */
export function coldObjectPath(root: string, key: GenKey): string {
  validateSegmentRef(key);
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return join(segmentsDir(root, key), coldObjectFilename(key.segment, key.generation));
}

/** Filename pattern for a segment's generations: `<segment>.<gen>.crbm`. */
export function coldObjectFilename(segment: string, generation: number): string {
  return `${encodeNameForPath(segment)}.${generation}.crbm`;
}

/** Parse a generation number out of a `<segment>.<gen>.crbm` filename, or `null` if it doesn't match. */
export function parseGeneration(segment: string, filename: string): number | null {
  const prefix = `${encodeNameForPath(segment)}.`;
  const suffix = '.crbm';
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null;
  const middle = filename.slice(prefix.length, filename.length - suffix.length);
  // Canonical decimal only: no leading zeros (so `s.07.crbm` can't alias `s.7.crbm`), and within
  // safe-integer range. The writer only ever emits the canonical form.
  if (!/^(0|[1-9]\d*)$/.test(middle)) return null;
  const gen = Number(middle);
  return Number.isSafeInteger(gen) ? gen : null;
}

const REGISTRY_SUFFIX = '.reg';

/** Directory holding a namespace's registry rows (one file per segment). */
export function registryDir(root: string, namespace: string | undefined): string {
  // Validated like every sibling builder here. It is the caller-facing entry for a namespace-scoped
  // `list()`, so without this a namespace of `../..` reaches `readdir` outside the storage root — no content
  // escapes (iteration aborts before yielding) but it answers "does this directory exist?", and the whole
  // point of re-validating at the driver boundary is that a driver driven directly must be safe on its own.
  if (namespace !== undefined) validateSegmentRef({ segment: 'x', namespace });
  return join(root, namespacePathPart(namespace), 'registry');
}

/** Absolute path of one segment's registry row file: `<ns>/registry/<segment>.reg`. */
export function registryRowPath(root: string, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return join(
    registryDir(root, ref.namespace),
    `${encodeNameForPath(ref.segment)}${REGISTRY_SUFFIX}`,
  );
}

/**
 * Parse a segment name out of a `<segment>.reg` filename, or `null` if it doesn't match — including any
 * file whose stem isn't a valid segment name. A strict parser means a stray or planted `.reg` file makes
 * `list()` *skip* it, never abort the whole enumeration on a boundary throw.
 */
export function parseRegistryRow(filename: string): string | null {
  if (!filename.endsWith(REGISTRY_SUFFIX)) return null;
  const stem = filename.slice(0, filename.length - REGISTRY_SUFFIX.length);
  const segment = decodeNameFromPath(stem);
  // The encoding must ROUND-TRIP, not merely decode. POSIX will happily hold a literal `dedup:foo.reg`
  // alongside the driver's own `dedup%3Afoo.reg`; both decode to `dedup:foo`, and reporting that name twice
  // would hand `list()` a segment whose row path resolves to only one of them. The driver never writes the
  // literal form, so anything that does not re-encode to exactly this filename was not written by us.
  if (encodeNameForPath(segment) !== stem) return null;
  try {
    validateSegmentRef({ segment });
  } catch {
    return null;
  }
  return segment;
}

/**
 * Parse a namespace out of a directory name under the storage root, or `null` if it was not written by us.
 *
 * The inverse of the `encodeNameForPath(namespacePart(ns))` that {@link segmentsDir} and {@link registryDir}
 * write. A fleet-wide scan enumerates these directories, so getting it wrong does not fail one segment — it
 * aborts the whole enumeration, taking the consistency check, the retention sweep and subject erasure with it.
 *
 * Like {@link parseRegistryRow} this requires the encoding to **round-trip**, so a planted literal `tenant:acme`
 * directory sitting next to the driver's own `tenant%3Aacme` is skipped rather than reported as a namespace
 * whose rows then resolve to the other directory. `_default` maps back to "no namespace".
 */
export function parseNamespaceDir(entry: string): { namespace: string | undefined } | null {
  if (entry === DEFAULT_NAMESPACE) return { namespace: undefined };
  const namespace = decodeNameFromPath(entry);
  if (encodeNameForPath(namespace) !== entry) return null;
  try {
    validateSegmentRef({ segment: 'x', namespace });
  } catch {
    return null;
  }
  return { namespace };
}
