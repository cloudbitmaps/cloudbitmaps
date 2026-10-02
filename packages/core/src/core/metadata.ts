/**
 * Generation metadata: a small, flat record of strings and finite numbers attached to one generation.
 *
 * The rules live here once, for every boundary that meets a value: a caller's input, refused with
 * `ValidationError`, and bytes read back from a tier, refused with `IntegrityError`. The caller passes the error
 * to raise. Pure: no I/O.
 */
import { isWellFormedString } from './validate';

/** A generation's metadata: string keys, string or finite-number values, no nesting. */
export type GenerationMetadata = Readonly<Record<string, string | number>>;

/** Cap on the canonical JSON of one generation's metadata, in UTF-8 bytes (braces and quotes included). */
export const MAX_METADATA_BYTES = 1024;
/** Cap on one metadata key, in UTF-8 bytes. */
export const MAX_METADATA_KEY_BYTES = 128;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Validate `value` as {@link GenerationMetadata} and return its canonical JSON: keys sorted by UTF-16 code unit,
 * each key and value as `JSON.stringify` writes it, no whitespace. Key order therefore never changes the bytes.
 * `fail` raises the error the boundary calls for. The empty object passes and returns `{}`: whether it may be
 * stored is the caller's rule.
 */
export function canonicalMetadataJson(value: unknown, fail: (message: string) => never): string {
  if (value === null || typeof value !== 'object') {
    fail(`metadata must be a plain object (got ${value === null ? 'null' : typeof value})`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    Object.prototype.toString.call(value) !== '[object Object]' ||
    (proto !== Object.prototype && proto !== null)
  ) {
    fail('metadata must be a plain object, not an array, a Map, a boxed value or a class instance');
  }
  const entries: string[] = [];
  const keys = Reflect.ownKeys(value as object);
  for (const key of keys) {
    if (typeof key !== 'string') fail('metadata keys must be strings, not symbols');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      fail(`metadata key ${JSON.stringify(key)} must be an enumerable data property`);
    }
    if (key.length === 0) fail('metadata keys must be non-empty');
    if (key === '__proto__') fail('metadata may not use the key "__proto__"');
    if (!isWellFormedString(key)) fail('metadata keys must be well-formed UTF-16');
    const keyBytes = utf8Length(key);
    if (keyBytes > MAX_METADATA_KEY_BYTES) {
      fail(`metadata key is ${keyBytes}B, over the ${MAX_METADATA_KEY_BYTES}B cap`);
    }
    const v: unknown = descriptor.value;
    if (typeof v === 'string') {
      if (!isWellFormedString(v)) {
        fail(`metadata value of ${JSON.stringify(key)} must be well-formed UTF-16`);
      }
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(`metadata value of ${JSON.stringify(key)} must be a string or a finite number`);
    }
    entries.push(key);
  }
  entries.sort();
  const record = value as Record<string, string | number>;
  const json = `{${entries.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(',')}}`;
  const bytes = utf8Length(json);
  if (bytes > MAX_METADATA_BYTES) {
    fail(`metadata is ${bytes}B as canonical JSON, over the ${MAX_METADATA_BYTES}B cap`);
  }
  return json;
}
