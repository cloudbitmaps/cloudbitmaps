/**
 * Identifier + key validation for {@link MysqlWarmDriver} (Phase 7).
 *
 * Pure, SDK-free string logic — unit-testable without a live MySQL. Like the Postgres driver, the logical ref
 * is stored across **parameterized columns** (`namespace`, `segment`, `chunk_key`, `key_prefix`), so ref/prefix
 * values are never concatenated into SQL — `mysql2`'s `?` placeholders bind them as data (no injection surface).
 * The one value that CANNOT be a bind parameter is the **table name** (an identifier, not a value), so it is
 * validated against a strict grammar and **backtick-quoted** before interpolation — that is why this exists.
 */
import { ValidationError } from '@/core/errors';

/** A SQL identifier segment: leading letter/underscore, then letters/digits/underscores (ASCII, ≤64 = MySQL max). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Validate a table name — optionally database-qualified (`db.table`) — and return it **safely quoted** for
 * interpolation (each part wrapped in backticks, MySQL's identifier quote). A table name is an identifier, so
 * it can't be a bind parameter; validating against {@link IDENT} (which excludes backticks, whitespace, `;`,
 * `-`, etc.) and quoting closes the only SQL-injection vector the driver has. Rejects anything else, fail-fast.
 */
export function validateAndQuoteTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some((p) => !IDENT.test(p))) {
    throw new ValidationError(
      `invalid table name ${JSON.stringify(table)} — expected an identifier or "db.table" ` +
        `(letters, digits, underscore; ≤64 chars; leading letter/underscore)`,
    );
  }
  return parts.map((p) => `\`${p}\``).join('.');
}

/**
 * The `key_prefix` column is `VARCHAR(191)` (sized so the composite primary key fits InnoDB's 3072-byte index
 * limit under utf8mb4). A longer prefix must be rejected **fail-fast**: under a non-strict `sql_mode` MySQL
 * would otherwise *silently truncate* it, and two logical stores whose prefixes share the same first 191
 * characters would then collide on the same rows — defeating the isolation `keyPrefix` exists to provide.
 */
const MAX_KEY_PREFIX_CHARS = 191;

/**
 * Validate a caller-supplied `keyPrefix` (lets several logical stores share one table). It's bound as a `?`
 * value, not concatenated, so the character check is a light sanity guard (no control characters), not an
 * anti-injection boundary; the length check, by contrast, is a real correctness guard (see
 * {@link MAX_KEY_PREFIX_CHARS}). Empty/undefined means no prefix (stored as the empty string).
 */
export function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return '';
  let chars = 0;
  for (const ch of prefix) {
    chars++; // `for…of` iterates Unicode code points — matches MySQL's VARCHAR character count
    if (ch.charCodeAt(0) < 0x20) {
      throw new ValidationError('keyPrefix must not contain control characters');
    }
  }
  if (chars > MAX_KEY_PREFIX_CHARS) {
    throw new ValidationError(
      `keyPrefix must be at most ${MAX_KEY_PREFIX_CHARS} characters (the key_prefix column width); got ${chars}`,
    );
  }
  return prefix;
}
