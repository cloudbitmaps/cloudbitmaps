/**
 * Name → physical-key encoding. The library validates *length*, and encodes everything else.
 *
 * Lives in `core/` rather than beside the drivers because it is pure string logic — no I/O, no SDK, no
 * `node:` builtin — and because `validate.ts` needs it to measure a name against the key budget. Core may
 * not import a driver (invariant 7), and a driver may import core, so this is the only layer both can see.
 *
 * The old grammar was an allowlist — `[A-Za-z0-9._:-]` — and the colon was missing from it by accident rather
 * than by decision, which made `dedup:2026-08-01` throw for every user who spells keys the way Redis users do.
 * The lesson generalises: an allowlist rejects names for the storage layer's convenience, and the storage
 * layer's convenience is the library's job, not the caller's. So a name is **any non-empty string**, and each
 * physical boundary escapes what *it* cannot take literally.
 *
 * Percent-encoding, because it is the one escape everybody already reads. `%` escapes itself as `%25` and is
 * encoded **first**, which is what makes the transform injective: every `%` in an encoded string starts an
 * escape, so decoding is unambiguous and two distinct names can never collide on one key.
 *
 * There are two alphabets, because the boundaries differ:
 *
 * - **Object keys** (S3, GCS, Azure, DynamoDB) take almost anything. They need `/` escaped so a name cannot
 *   invent hierarchy or break a key parser that splits on it, `#` and `|` because DynamoDB delimits its
 *   partition key with them, and control characters because they are not legal in the XML an S3 LIST returns.
 * - **Filesystem paths** need all of that plus `:` (an NTFS alternate-data-stream separator, where a write can
 *   *succeed* while `readdir` never lists the result), plus three hazards that are about the component as a
 *   whole rather than its characters — see {@link encodeNameForPath}.
 *
 * **Every name that was legal before encodes to itself**, on both alphabets, so no stored key moves and there
 * is nothing to migrate. That is the property to preserve if this file is ever edited.
 */

/** Characters safe in an object key, left literal so existing keys are byte-identical. */
const KEY_SAFE = /[A-Za-z0-9._:-]/;
/** Characters safe in a path component. As {@link KEY_SAFE} minus `:`. */
const PATH_SAFE = /[A-Za-z0-9._-]/;

/** Percent-encode one character's UTF-8 bytes: `é` → `%C3%A9`. */
function escapeChar(ch: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(ch)) {
    out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function encodeWith(name: string, safe: RegExp): string {
  let out = '';
  // Iterate by code POINT, not code unit: a surrogate pair is one character and must encode as one UTF-8
  // sequence. Indexing by `charAt` would split an emoji into two unpaired halves and produce garbage bytes.
  for (const ch of name) {
    out += ch !== '%' && safe.test(ch) ? ch : escapeChar(ch);
  }
  return out;
}

function decodePercent(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] === '%' && i + 2 < encoded.length + 1) {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return encoded; // not an escape we wrote
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      for (const b of new TextEncoder().encode(encoded[i])) bytes.push(b);
      i += 1;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * Encode a name for use inside an **object key** (S3, GCS, Azure, DynamoDB).
 *
 * Leaves the historically-legal alphabet literal so existing keys do not move, and escapes everything else —
 * including `/` (which would invent hierarchy and break a parser that splits on it), `#` and `|` (DynamoDB's
 * partition-key delimiters), and control characters (not legal in S3's XML responses).
 */
export function encodeNameForKey(name: string): string {
  return encodeWith(name, KEY_SAFE);
}

/** Inverse of {@link encodeNameForKey}. */
export function decodeNameFromKey(encoded: string): string {
  return decodePercent(encoded);
}

/**
 * Encode a name for use as a **filesystem path component**.
 *
 * Everything {@link encodeNameForKey} escapes, plus `:`, plus three hazards that are properties of the whole
 * component rather than of any character in it. All three are silent corruption rather than errors, which is
 * why they are handled here instead of being left to the OS:
 *
 * 1. **`.` and `..`** are traversal. `join(root, '..')` leaves the storage root.
 * 2. **Windows reserved device names** — `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case
 *    insensitive and *with or without an extension*, so `con.0.crbm` is reserved too. Opening one addresses a
 *    device rather than a file. Note the old grammar **permitted** these: `store.segment('con')` validated
 *    cleanly and broke only on a user's Windows box.
 * 3. **A trailing `.` or space**, which Windows silently strips — so `a.` and `a` would become the same
 *    directory, quietly merging two segments.
 *
 * Each is fixed by escaping the one character that defuses it, which keeps the encoding injective: a name that
 * needed defusing produces a `%XX` no other name produces.
 */
export function encodeNameForPath(name: string): string {
  let encoded = encodeWith(name, PATH_SAFE);

  // The three fixes COMPOSE rather than short-circuit. An earlier draft returned straight out of the traversal
  // case, and `..` became `%2E.` — which ends in a dot, i.e. hazard 3, reintroduced by the fix for hazard 1.
  if (encoded === '.' || encoded === '..') {
    // Escape every dot, so the result cannot end in one either.
    encoded = encoded.replaceAll('.', '%2E');
  } else {
    // A Windows device name is reserved with OR without an extension, so the test is on the stem.
    const stem = encoded.split('.')[0] ?? '';
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) {
      encoded = escapeChar(encoded[0] as string) + encoded.slice(1);
    }
  }

  // Windows strips a trailing dot or space, which would alias two distinct names onto one path.
  const last = encoded.at(-1);
  if (last === '.' || last === ' ') encoded = encoded.slice(0, -1) + escapeChar(last);

  return encoded;
}

/** Inverse of {@link encodeNameForPath}. */
export function decodeNameFromPath(encoded: string): string {
  return decodePercent(encoded);
}
