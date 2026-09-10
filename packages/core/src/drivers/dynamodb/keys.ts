/**
 * Logical-ref → DynamoDB key mapping for {@link DynamoDbRegistryDriver}.
 *
 * **Single-table design**: every item is partitioned by segment (`PK`), and the sort key (`SK`) prefix
 * distinguishes entity types — `reg#…` for the registry row. (Earlier builds co-located `chunk#<key>` rows in the
 * same partition; the prefix scheme is kept so a table that still holds them is not misread.) Pure string logic,
 * no SDK dependency, so it's unit-testable without DynamoDB-Local. Names are re-validated at the boundary
 * (defense in depth — S2); the absent namespace maps to `_default`, which can't collide with a real namespace
 * (the grammar forbids a leading underscore).
 */
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';
import type { SegmentRef } from '@/core/ports';
import { namespacePart } from '../_shared/keys';

/**
 * Validate a caller-supplied `keyPrefix` so prefix-isolation is *structural*, not convention: it must not
 * contain the PK delimiters (`|`, `#`) — which would let one prefix's PK alias another's — or control
 * characters. Empty/undefined means no prefix.
 */
export function assertValidKeyPrefix(prefix: string | undefined): void {
  if (prefix === undefined || prefix === '') return;
  for (const ch of prefix) {
    const code = ch.charCodeAt(0);
    if (ch === '|' || ch === '#' || code < 0x20) {
      throw new ValidationError(`keyPrefix must not contain "|", "#", or control characters`);
    }
  }
}

/**
 * Partition key for all of a segment's items: `[<prefix>|]ns#<ns>|seg#<segment>`. An optional caller
 * `prefix` lets several logical stores share one physical table (and gives tests cheap isolation); it's
 * opaque (the PK is matched exactly, never parsed back), so no traversal concerns apply.
 */
export function partitionKey(ref: SegmentRef, prefix?: string): string {
  validateSegmentRef(ref);
  const base = `ns#${namespacePart(ref.namespace)}|seg#${ref.segment}`;
  return prefix === undefined || prefix === '' ? base : `${prefix}|${base}`;
}

/** Sort key of a segment's single registry row. */
const REGISTRY_SK = 'reg#';
export function registrySortKey(): string {
  return REGISTRY_SK;
}

/** The `(PK, SK)` of a segment's registry row, validating the ref. */
export function registryKeyPair(ref: SegmentRef, prefix?: string): { pk: string; sk: string } {
  validateSegmentRef(ref);
  return { pk: partitionKey(ref, prefix), sk: REGISTRY_SK };
}
