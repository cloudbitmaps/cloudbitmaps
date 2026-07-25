/**
 * Identifier + key validation for {@link PostgresWarmDriver} (Phase 7).
 *
 * Pure, SDK-free string logic — unit-testable without a live Postgres. Unlike the object-store drivers (which
 * build a single string key), the Postgres driver stores the logical ref across **parameterized columns**
 * (`namespace`, `segment`, `chunk_key`, `key_prefix`), so ref/prefix values are never concatenated into SQL —
 * `pg`'s `$n` placeholders bind them as data (no injection surface). The one value that CANNOT be a bind
 * parameter is the **table name** (an identifier, not a value), so it is validated against a strict grammar
 * and quoted before interpolation — that is the whole reason this module exists.
 */
import { ValidationError } from '@/core/errors';

/** A SQL identifier segment: leading letter/underscore, then letters/digits/underscores (ASCII, ≤63 = PG max). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Validate a table name — optionally schema-qualified (`schema.table`) — and return it **safely quoted** for
 * interpolation (each part wrapped in double quotes). A table name is an identifier, so it can't be a bind
 * parameter; validating against {@link IDENT} (which excludes quotes, whitespace, `;`, `-`, etc.) and quoting
 * closes the only SQL-injection vector the driver has. Rejects anything else, fail-fast.
 */
export function validateAndQuoteTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some((p) => !IDENT.test(p))) {
    throw new ValidationError(
      `invalid table name ${JSON.stringify(table)} — expected an identifier or "schema.table" ` +
        `(letters, digits, underscore; ≤63 chars; leading letter/underscore)`,
    );
  }
  return parts.map((p) => `"${p}"`).join('.');
}

/**
 * Validate a caller-supplied `keyPrefix` (lets several logical stores share one table). It's bound as a `$n`
 * value, not concatenated, so this is a light sanity guard (no control characters), not an anti-injection
 * boundary. Empty/undefined means no prefix (stored as the empty string).
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
