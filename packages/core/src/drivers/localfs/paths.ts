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
import { namespacePart } from '../_shared/keys';

/** Directory holding all of a namespace's segment objects. */
export function segmentsDir(root: string, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return join(root, namespacePart(ref.namespace), 'segments');
}

/** Absolute path of one `.crbm` generation object. */
export function coldObjectPath(root: string, key: GenKey): string {
  validateSegmentRef(key);
  if (!Number.isInteger(key.generation) || key.generation < 0) {
    throw new ValidationError(`generation must be a non-negative integer; got ${key.generation}`);
  }
  return join(segmentsDir(root, key), `${key.segment}.${key.generation}.crbm`);
}

/** Filename pattern for a segment's generations: `<segment>.<gen>.crbm`. */
export function coldObjectFilename(segment: string, generation: number): string {
  return `${segment}.${generation}.crbm`;
}

/** Parse a generation number out of a `<segment>.<gen>.crbm` filename, or `null` if it doesn't match. */
export function parseGeneration(segment: string, filename: string): number | null {
  const prefix = `${segment}.`;
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
  return join(root, namespacePart(namespace), 'registry');
}

/** Absolute path of one segment's registry row file: `<ns>/registry/<segment>.reg`. */
export function registryRowPath(root: string, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return join(registryDir(root, ref.namespace), `${ref.segment}${REGISTRY_SUFFIX}`);
}

/**
 * Parse a segment name out of a `<segment>.reg` filename, or `null` if it doesn't match — including any
 * file whose stem isn't a valid segment name. A strict parser means a stray or planted `.reg` file makes
 * `list()` *skip* it, never abort the whole enumeration on a boundary throw.
 */
export function parseRegistryRow(filename: string): string | null {
  if (!filename.endsWith(REGISTRY_SUFFIX)) return null;
  const segment = filename.slice(0, filename.length - REGISTRY_SUFFIX.length);
  try {
    validateSegmentRef({ segment });
  } catch {
    return null;
  }
  return segment;
}
