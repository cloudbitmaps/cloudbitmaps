/**
 * Identifier + key validation for {@link CassandraWarmDriver} (Phase 7).
 *
 * Pure, SDK-free string logic — unit-testable without a live Cassandra. The logical ref is stored across
 * **bound (`?`) columns** (`kp`/`ns`/`seg`/`ck`), so ref/prefix values are never concatenated into CQL. The
 * only values that CANNOT be bind parameters are the **keyspace + table identifiers**, so they are validated
 * against a strict grammar and quoted before interpolation — the sole CQL-injection vector, closed.
 */
import { ValidationError } from '@/core/errors';

/** A CQL identifier: leading letter/underscore, then letters/digits/underscores (≤48 = Cassandra max). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

function quoteIdent(id: string, what: string): string {
  if (!IDENT.test(id)) {
    throw new ValidationError(
      `invalid ${what} ${JSON.stringify(id)} — expected a CQL identifier ` +
        `(letters, digits, underscore; ≤48 chars; leading letter/underscore)`,
    );
  }
  return `"${id}"`;
}

/** Validate + quote `keyspace` and `table` into a fully-qualified `"keyspace"."table"` for interpolation. */
export function validateAndQuoteTable(keyspace: string, table: string): string {
  return `${quoteIdent(keyspace, 'keyspace')}.${quoteIdent(table, 'table')}`;
}

/**
 * Validate a caller-supplied key prefix (bound as a `?` value, so this is a sanity guard, not an
 * anti-injection boundary): no control characters. Empty/undefined ⇒ no prefix (stored as `''`).
 */
export function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return '';
  for (const ch of prefix) {
    if (ch.charCodeAt(0) < 0x20) {
      throw new ValidationError('keyPrefix must not contain control characters');
    }
  }
  return prefix;
}
