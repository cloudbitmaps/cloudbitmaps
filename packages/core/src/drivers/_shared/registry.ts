/**
 * Shared, SDK-free helpers for assembling + validating {@link RegistryRecord}s.
 *
 * The registry's record-construction, patch-application, and field-validation are identical across every
 * backend (memory / LocalFs / object store) — only the *storage* + OCC mechanics differ. This is the one home
 * for that logic so the three drivers can't drift. Pure: no I/O, no SDK, no clock (the caller passes `now`), and no
 * ambient randomness (the caller passes its `Entropy`; the Web Crypto default is in `entropy.ts`).
 */
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';
import { canonicalMetadataJson, MAX_METADATA_BYTES } from '@/core/metadata';
import { INCARNATION_TOKEN, incarnationOf } from '@/core/token';
import { MAX_LEASES_PER_SEGMENT, MAX_STORED_LEASES } from '@/core/leases';
import {
  MAX_KEPT_GENERATIONS,
  MAX_STORED_KEPT_GENERATIONS,
  usableKeptGens,
} from '@/core/kept-generations';
import type {
  LeaseEntry,
  NewRegistryRecord,
  RegistryPatch,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  Token,
} from '@/core/ports';

/** The valid {@link RegistryStatus} values — used to validate both caller input and stored bytes. */
const STATUSES: readonly string[] = ['active', 'destroyed'];
/**
 * The fields a stored record may carry: {@link RegistryRecord}'s, and nothing else. A field no reader resolves
 * through is refused on read-back like any other corruption (invariant 5), rather than ignored.
 */
const BASE_FIELDS = [
  'namespace',
  'segment',
  'currentGen',
  'wrappedDeks',
  'keyId',
  'status',
  'retention',
  'residency',
  'summary',
  'createdAt',
  'updatedAt',
  'token',
] as const;
/**
 * The fields schema 3 added. A schema-2 row carrying one is refused as undeclared. A field that joins schema 3 before
 * it is released is appended here, with its validator, and needs no new schema version.
 */
const SCHEMA_3_FIELDS = ['keptGens', 'leases'] as const;
export const RECORD_FIELDS = [...BASE_FIELDS, ...SCHEMA_3_FIELDS] as const;
/** The record fields a row of `schemaVersion` may carry: each schema adds to the one before. */
function fieldsOf(schemaVersion: number): readonly string[] {
  if (schemaVersion >= 3) return RECORD_FIELDS;
  const base: readonly string[] = BASE_FIELDS;
  return schemaVersion === 2 ? base : base.filter((f) => f !== 'summary');
}
/** The fields of the persisted envelope around a record. */
const ENVELOPE_FIELDS: readonly string[] = ['schemaVersion', 'deleted', 'record'];
/** Cap on a serialized governance blob (retention/residency) — bounds row size so a row can't be bricked. */
const MAX_GOVERNANCE_BYTES = 64 * 1024;
/** Bounds on the wrapped-DEK list (one DEK wrapped under a few KEKs) — keeps the row small + rejects abuse. */
const MAX_WRAPPED_DEKS = 8;
const MAX_WRAPPED_DEK_BYTES = 4 * 1024;
/** Ids a generation can hold: every 32-bit id. */
const MAX_SUMMARY_CARDINALITY = 2 ** 32;
/** A sealed summary's fixed part: a 12-byte nonce, the u64 count, and a 16-byte tag. */
const SEALED_SUMMARY_MIN_BYTES = 12 + 8 + 16;
/** The fixed part plus metadata at its cap. */
const SEALED_SUMMARY_MAX_BYTES = SEALED_SUMMARY_MIN_BYTES + MAX_METADATA_BYTES;
/** Padded standard base64; canonical once its pad bits are checked too (see {@link base64PadBitsAreZero}). */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `null` is legal and meaningful: the segment has no Storage generation yet (see `RegistryRecord.currentGen`). */
function validateGeneration(gen: number | null): void {
  if (gen === null) return;
  if (!Number.isSafeInteger(gen) || gen < 0) {
    throw new ValidationError(
      `currentGen must be a non-negative safe integer or null (no Storage generation yet); got ${gen}`,
    );
  }
}

/**
 * A patch that *mentions* `currentGen` must give it a real value — `null` to clear the pointer, or a generation.
 * `{ currentGen: undefined }` is refused rather than coerced. `{ currentGen: maybeUndefined }` is what `strict`
 * alone permits, since `exactOptionalPropertyTypes` is off, and a caller writing it means to leave the pointer
 * alone. Under presence-based merging the same call would silently *un-publish* a live segment: every Storage
 * generation goes invisible, and the collection then refuses to collect the objects (no pointer ⇒ nothing
 * to compare against), so they are stranded and billed forever. Fail fast at the boundary instead.
 */
function validatePatchGeneration(patch: RegistryPatch): void {
  if (!('currentGen' in patch)) return;
  // `validateGeneration(undefined)` fails the integer test on its own, because this check reads the raw patch
  // before `applyRegistryPatch` turns an undefined `currentGen` into `null`; this branch exists to make the
  // *message* say which value to pass instead, because the generic "must be a non-negative integer or null"
  // reads like a type error rather than the trap it is.
  if (patch.currentGen === undefined) {
    throw new ValidationError(
      `currentGen was present in the patch but undefined. Pass \`null\` to clear the pointer (the segment has no ` +
        `Storage generation), or omit the key to leave it unchanged — an undefined value is refused because it ` +
        `would un-publish the segment's Storage data.`,
    );
  }
  validateGeneration(patch.currentGen);
}

function validateStatus(status: string): void {
  if (!STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${STATUSES.join('/')}; got ${status}`);
  }
}

/**
 * Validate a governance blob (retention/residency) at the write boundary: it must be JSON-serializable
 * (a `BigInt`/function/circular value fails fast with a typed error instead of a cryptic one deep in a
 * driver) and within a size cap (so an oversized blob can't write a row that's later unreadable — a brick).
 */
function validateGovernance(meta: unknown, field: string): void {
  if (meta === undefined) return;
  // A plain object, not `null`/an array/a primitive. `JSON.stringify(null)` is 4 valid bytes, so without this the
  // size + serializability checks below happily store `"retention": null` — and `retention.expiresAt` is read with
  // an `in` test, which throws an untyped `TypeError` on a non-object and would abort a whole fleet retention
  // sweep rather than becoming one ledger entry. Reject at the write boundary; the read boundary
  // ({@link assertStoredRecordShape}) rejects it too, for a row edited by hand or written by another writer.
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ValidationError(
      `${field} must be a plain object (got ${meta === null ? 'null' : typeof meta})`,
    );
  }
  let json: string;
  try {
    json = JSON.stringify(meta);
  } catch {
    throw new ValidationError(`${field} must be JSON-serializable`);
  }
  if (json.length > MAX_GOVERNANCE_BYTES) {
    throw new ValidationError(`${field} is ${json.length}B, exceeds cap ${MAX_GOVERNANCE_BYTES}B`);
  }
}

/**
 * Validate the wrapped-DEK list at the write/read boundary: a bounded array of `{ keyId, wrapped }` with
 * non-empty string fields and a per-entry size cap (so a row can't be bricked, and corrupt bytes are rejected
 * rather than reaching the keystore). `isStored` toggles the error class (write = ValidationError; read =
 * IntegrityError, invariant 5).
 */
function validateWrappedDeks(value: unknown, isStored: boolean): void {
  if (value === undefined) return;
  const fail = (msg: string): never => {
    throw isStored ? new IntegrityError(msg) : new ValidationError(msg);
  };
  if (!Array.isArray(value)) fail('wrappedDeks must be an array');
  const list = value as unknown[];
  if (list.length === 0) fail('wrappedDeks must be non-empty when present');
  if (list.length > MAX_WRAPPED_DEKS)
    fail(`wrappedDeks has ${list.length} entries, cap ${MAX_WRAPPED_DEKS}`);
  for (const w of list) {
    if (w === null || typeof w !== 'object') fail('wrappedDeks entry must be an object');
    const { keyId, wrapped } = w as { keyId?: unknown; wrapped?: unknown };
    if (typeof keyId !== 'string' || keyId.length === 0)
      fail('wrappedDeks entry needs a non-empty keyId');
    if (typeof wrapped !== 'string' || wrapped.length === 0)
      fail('wrappedDeks entry needs a non-empty wrapped blob');
    if ((wrapped as string).length > MAX_WRAPPED_DEK_BYTES)
      fail(`wrappedDeks entry is ${(wrapped as string).length}B, cap ${MAX_WRAPPED_DEK_BYTES}B`);
  }
}

/** The standard base64 alphabet, whose index of a character is the six bits it carries. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Whether a padded standard base64 string is canonical: the bits of its last character past the data are zero.
 * Without this two strings would decode to the same bytes.
 */
function base64PadBitsAreZero(text: string): boolean {
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  if (pad === 0) return true;
  const last = BASE64_ALPHABET.indexOf(text[text.length - pad - 1]!);
  return pad === 2 ? (last & 0b1111) === 0 : (last & 0b11) === 0;
}

/**
 * Validate a {@link RegistrySummary}'s shape at the write or read boundary, and return a frozen copy built from the
 * checked fields only: exactly one of the two shapes, a non-negative safe-integer generation, a cardinality from 0 to
 * 2^32, metadata by the metadata rules (never the empty object, which is never stored) with its keys in canonical
 * order, or a sealed blob in canonical base64 whose length fits a sealed count plus metadata at its cap. A writer
 * stores the copy, so a caller that changes its object after the call, while the driver awaits the row, changes
 * nothing that is written. Whether a summary may be *used* is the reader's rule, not this one: this only bounds what a
 * row can hold. `isStored` picks the error class (write = ValidationError; read = IntegrityError, invariant 5), and a
 * read names the row by `ctx`.
 */
function validateSummary(
  value: unknown,
  isStored: boolean,
  ctx?: string,
): RegistrySummary | undefined {
  if (value === undefined) return undefined;
  const fail = (msg: string): never => {
    const where = ctx === undefined ? '' : `: ${ctx}`;
    throw isStored
      ? new IntegrityError(`registry record summary: ${msg}${where}`)
      : new ValidationError(`summary: ${msg}${where}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      `must be an object (got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value})`,
    );
  }
  const s = value as Record<string, unknown>;
  const keys = Object.keys(s);
  const isSealed = keys.includes('sealed');
  const allowed = isSealed ? ['generation', 'sealed'] : ['generation', 'cardinality', 'metadata'];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    fail(
      `has fields its ${isSealed ? 'sealed' : 'clear'} shape does not declare (${extra.join(', ')})`,
    );
  }
  const generation = s.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    fail(`generation must be a non-negative safe integer (got ${String(generation)})`);
  }
  if (isSealed) {
    const sealed = s.sealed;
    if (typeof sealed !== 'string' || !BASE64.test(sealed) || !base64PadBitsAreZero(sealed)) {
      fail('sealed must be canonical, padded standard base64');
    }
    const text = sealed as string;
    const bytes = (text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
    if (bytes < SEALED_SUMMARY_MIN_BYTES || bytes > SEALED_SUMMARY_MAX_BYTES) {
      fail(
        `sealed is ${bytes}B, outside ${SEALED_SUMMARY_MIN_BYTES}..${SEALED_SUMMARY_MAX_BYTES}B ` +
          '(a nonce, a fixed-width count, a tag, and metadata up to its cap)',
      );
    }
    return Object.freeze({ generation: generation as number, sealed: text });
  }
  const n = s.cardinality;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_SUMMARY_CARDINALITY) {
    fail(`cardinality must be an integer from 0 to 2^32 (got ${String(n)})`);
  }
  if (s.metadata === undefined) {
    return Object.freeze({ generation: generation as number, cardinality: n as number });
  }
  const canonical = canonicalMetadataJson(s.metadata, fail);
  if (canonical === '{}') fail('metadata is empty; a generation without metadata carries none');
  // A read only checks the stored shape and keeps the object it parsed, so it builds no copy.
  if (isStored) return s as unknown as RegistrySummary;
  // Rebuilt from the canonical JSON, so its keys are in canonical order (JavaScript still lists integer-like keys
  // first, in numeric order, as it does in every object) and nothing of the caller's object is kept.
  const metadata = Object.freeze(JSON.parse(canonical) as Record<string, string | number>);
  return Object.freeze({ generation: generation as number, cardinality: n as number, metadata });
}

/** A summary given at a write must describe the generation the row will point at. */
function validateSummaryNames(
  summary: RegistrySummary | undefined,
  currentGen: number | null,
): void {
  if (summary !== undefined && summary.generation !== currentGen) {
    throw new ValidationError(
      `summary describes generation ${summary.generation}, but the row points at ${String(currentGen)}`,
    );
  }
}

/**
 * Whether a summary's shape agrees with the row's encryption: sealed on a row with wrapped keys, clear on one without.
 * A clear count or metadata beside a key would leak what the segment's objects hide; a sealed one on a cleartext row
 * could never be opened.
 */
function summaryAgreesWithKeys(
  summary: RegistrySummary,
  wrappedDeks: RegistryRecord['wrappedDeks'],
): boolean {
  return 'sealed' in summary === (wrappedDeks !== undefined);
}

/** A summary given at a write must agree with the row's encryption (see {@link summaryAgreesWithKeys}). */
function validateSummaryKeys(
  summary: RegistrySummary | undefined,
  wrappedDeks: RegistryRecord['wrappedDeks'],
): void {
  if (summary !== undefined && !summaryAgreesWithKeys(summary, wrappedDeks)) {
    throw new ValidationError(
      wrappedDeks === undefined
        ? 'summary is sealed, but the row has no wrapped keys to open it with'
        : "summary is in the clear, but the row is encrypted: an encrypted segment's summary must be sealed",
    );
  }
}

/**
 * Validate a {@link RegistryRecord.keptGens} list's shape at the write or read boundary: an array of at most `max`
 * entries, each a non-negative safe integer, strictly ascending (which refuses a duplicate). A write returns a frozen
 * copy, so a caller that changes its array afterwards changes nothing that is written. `isStored` picks the error class
 * (write = ValidationError; read = IntegrityError, invariant 5). Whether the entries are below the pointer is not
 * checked here on a read: a list that disagrees with the pointer is one its reader does not use, not a row to refuse.
 */
function validateKeptGens(
  value: unknown,
  isStored: boolean,
  ctx?: string,
): readonly number[] | undefined {
  if (value === undefined) return undefined;
  const fail = (msg: string): never => {
    const where = ctx === undefined ? '' : `: ${ctx}`;
    throw isStored
      ? new IntegrityError(`registry record keptGens: ${msg}${where}`)
      : new ValidationError(`keptGens: ${msg}`);
  };
  if (!Array.isArray(value)) fail('must be an array');
  const list = value as unknown[];
  const max = isStored ? MAX_STORED_KEPT_GENERATIONS : MAX_KEPT_GENERATIONS;
  if (list.length > max) fail(`has ${list.length} entries, cap ${max}`);
  let last = -1;
  for (const g of list) {
    if (!Number.isSafeInteger(g) || (g as number) < 0) {
      fail(`entries must be non-negative safe integers (got ${String(g)})`);
    }
    if ((g as number) <= last) fail('entries must be strictly ascending');
    last = g as number;
  }
  return isStored ? (list as number[]) : Object.freeze([...(list as number[])]);
}

const HOLDER = /^[0-9a-f]{16}$/;
const LEASE_ENTRY_KEYS: readonly string[] = ['holder', 'generation', 'until'];

/**
 * Validate a {@link RegistryRecord.leases} list at the write or read boundary: an array of at most the writer's cap
 * (write) or the reader's (read), each entry exactly `{ holder, generation, until }`, the holder 16 lowercase hex digits
 * and unique, the two numbers non-negative safe integers. A write returns a frozen copy, and an empty list as
 * `undefined`, so a row that never held a lease is the row it was before leases. `isStored` picks the error class
 * (write = ValidationError; read = IntegrityError, invariant 5). Whether an entry is still live, or its generation
 * exists, is not checked here: a collector reads that, and a row is not refused for it.
 */
function validateLeases(
  value: unknown,
  isStored: boolean,
  ctx?: string,
): readonly LeaseEntry[] | undefined {
  if (value === undefined) return undefined;
  const fail = (msg: string): never => {
    const where = ctx === undefined ? '' : `: ${ctx}`;
    throw isStored
      ? new IntegrityError(`registry record leases: ${msg}${where}`)
      : new ValidationError(`leases: ${msg}`);
  };
  if (!Array.isArray(value)) fail('must be an array');
  const list = value as unknown[];
  const max = MAX_STORED_LEASES; // a write's own cap is applied against the row it patches
  if (list.length > max) fail(`has ${list.length} entries, cap ${max}`);
  const seen = new Set<string>();
  const out: LeaseEntry[] = [];
  for (const e of list) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) fail('an entry must be an object');
    const entry = e as Record<string, unknown>;
    const extra = Object.keys(entry).filter((k) => !LEASE_ENTRY_KEYS.includes(k));
    if (extra.length > 0) fail(`an entry carries an undeclared field (${extra.join(', ')})`);
    const { holder, generation, until } = entry;
    if (typeof holder !== 'string' || !HOLDER.test(holder)) {
      fail('a holder must be 16 lowercase hex digits');
    }
    if (seen.has(holder as string)) fail('holders must be unique');
    seen.add(holder as string);
    for (const [name, n] of [
      ['generation', generation],
      ['until', until],
    ] as const) {
      if (!Number.isSafeInteger(n) || (n as number) < 0) {
        fail(`${name} must be a non-negative safe integer (got ${String(n)})`);
      }
    }
    out.push(
      isStored
        ? (entry as unknown as LeaseEntry)
        : Object.freeze({
            holder: holder as string,
            generation: generation as number,
            until: until as number,
          }),
    );
  }
  if (isStored) return out;
  return out.length === 0 ? undefined : Object.freeze(out);
}

/** A non-empty list given at a write needs a pointer to hold generations of. */
function validateLeasesPointer(
  leases: readonly LeaseEntry[] | undefined,
  currentGen: number | null,
): void {
  if (leases !== undefined && leases.length > 0 && currentGen === null) {
    throw new ValidationError('leases: a row with no pointer has no generation to lease');
  }
}

/** A list given at a write must name only generations below the pointer the row will have, and none on no pointer. */
function validateKeptGensBelow(
  keptGens: readonly number[] | undefined,
  currentGen: number | null,
): void {
  if (keptGens === undefined) return;
  if (currentGen === null) {
    throw new ValidationError(
      'keptGens: a row with no pointer has no generations below it to keep',
    );
  }
  const top = keptGens[keptGens.length - 1];
  if (top !== undefined && top >= currentGen) {
    throw new ValidationError(
      `keptGens names generation ${top}, which is not below the row's pointer ${currentGen}`,
    );
  }
}

/**
 * Validate the caller-settable fields at `create`, and return the record to store: the caller's, with its summary
 * replaced by the checked, frozen copy {@link validateSummary} builds.
 */
export function validateNewRegistryRecord(rec: NewRegistryRecord): NewRegistryRecord {
  validateGeneration(rec.currentGen);
  if (rec.status !== undefined) validateStatus(rec.status);
  validateWrappedDeks(rec.wrappedDeks, false);
  validateGovernance(rec.retention, 'retention');
  validateGovernance(rec.residency, 'residency');
  const keptGens = validateKeptGens(rec.keptGens, false);
  validateKeptGensBelow(keptGens, rec.currentGen);
  const withKept = keptGens === undefined ? rec : { ...rec, keptGens };
  if (!('summary' in rec)) return withKept;
  const summary = validateSummary(rec.summary, false);
  validateSummaryNames(summary, rec.currentGen);
  validateSummaryKeys(summary, rec.wrappedDeks);
  return { ...withKept, summary };
}

/**
 * Validate the caller-settable fields in a `compareAndSwap` patch, and return the patch to apply: the caller's, with
 * its summary replaced by the checked, frozen copy. That a given `summary` names the row's resulting `currentGen`,
 * and agrees with its resulting keys, needs the stored row, so {@link applyRegistryPatch} checks both.
 */
export function validateRegistryPatch(patch: RegistryPatch): RegistryPatch {
  validatePatchGeneration(patch);
  if (patch.status !== undefined) validateStatus(patch.status);
  if ('wrappedDeks' in patch) validateWrappedDeks(patch.wrappedDeks, false);
  if ('retention' in patch) validateGovernance(patch.retention, 'retention');
  if ('residency' in patch) validateGovernance(patch.residency, 'residency');
  const withKept =
    patch.keptGens === undefined
      ? patch
      : { ...patch, keptGens: validateKeptGens(patch.keptGens, false) };
  const withLeases =
    'leases' in withKept
      ? { ...withKept, leases: validateLeases(withKept.leases, false) }
      : withKept;
  if (!('summary' in patch)) return withLeases;
  return { ...withLeases, summary: validateSummary(patch.summary, false) };
}

/**
 * The persisted envelope for a registry row: the record plus a tombstone flag. A **deleted** row keeps its
 * record (with an advanced counter) rather than being removed, so a re-create carries the counter on and the two
 * incarnations' tokens are apart by construction, as well as by their random parts — ABA-safety. A row removed by a
 * conditional delete leaves no counter to carry on, so a re-create starts at 0 and only the random parts keep its
 * tokens apart from the old ones. Shared by the
 * persistent drivers (LocalFs file, S3 object).
 *
 * `schemaVersion` is a wire-only concern — it stamps the persisted bytes, not the in-memory domain object —
 * so it lives on the serialize/parse boundary ({@link serializeRegistryEnvelope} /
 * {@link parseRegistryEnvelope}), never on this interface.
 */
export interface RegistryEnvelope {
  readonly deleted: boolean;
  readonly record: RegistryRecord;
}

/**
 * Current registry-row schema version — a pre-1.0 format-freeze prerequisite. Every persistent
 * registry driver — every one of which persists the `{ deleted, record }` envelope — stamps its rows
 * with this so a reader can fail-closed on a future, incompatible layout instead of misparsing it. Bump only
 * on a backward-incompatible change. Policy: a **higher** stamp than this build knows → `UnsupportedError`
 * (fail-closed); an **absent** or malformed stamp → `IntegrityError`, since every row this build writes has one.
 *
 * Schema 2 added the record's `summary` and the incarnation-form token; schema 3 adds `keptGens`. Every row this
 * build writes is stamped 3, whatever it holds, and a build that reads only schema 2 refuses it, so a fleet cannot go
 * back once one has been written.
 */
export const REGISTRY_SCHEMA_VERSION = 3;

/**
 * The oldest schema this build reads. A schema-1 or schema-2 row is read as it was written; the first write to it
 * stamps it 3.
 */
const OLDEST_REGISTRY_SCHEMA_VERSION = 1;

/**
 * Validate a persisted registry row's `schemaVersion` (untrusted bytes, invariant 5) and return it: an absent or
 * malformed value → `IntegrityError`; a version newer than this build → `UnsupportedError` (fail-closed rather than
 * misread a format we don't understand).
 */
export function assertRegistrySchemaVersion(raw: unknown, ctx: string): number {
  if (raw === undefined) {
    throw new IntegrityError(`registry row has no schemaVersion: ${ctx}`);
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < OLDEST_REGISTRY_SCHEMA_VERSION) {
    throw new IntegrityError(`registry row has a malformed schemaVersion (${String(raw)}): ${ctx}`);
  }
  if (raw > REGISTRY_SCHEMA_VERSION) {
    throw new UnsupportedError(
      `registry row schemaVersion ${raw} is newer than this build reads (v${REGISTRY_SCHEMA_VERSION}): ${ctx}`,
    );
  }
  return raw;
}

/** Serialize a registry envelope for persistence, stamping the current {@link REGISTRY_SCHEMA_VERSION}. */
export function serializeRegistryEnvelope(env: RegistryEnvelope): string {
  return JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    deleted: env.deleted,
    record: env.record,
  });
}

// ── The OCC token ────────────────────────────────────────────────────────────────────────────────────────────
//
// A token is `<incarnation>.<counter>.<write>`. The incarnation is 32 lowercase hex digits drawn from injected
// entropy when the row is created; it keeps a re-created name from ever being taken for an earlier incarnation of
// it, even once the earlier row's record is gone and nothing is left to continue a counter from. The counter is a
// canonical decimal that every write of the row advances by one, and carries on across a tombstone, so while a row's
// history is intact its tokens are apart by construction. The write part is 16 lowercase hex digits drawn afresh for
// every write: a row restored from a backup is back at an older counter, and without it the writes after the restore
// would be given the tokens the writes after the backup already had.
//
// A row first written by a schema-1 build has a bare decimal counter (`"7"`), and gains no incarnation for as long as
// it lives: a write to it advances the counter and adds a write part (`"8.<write>"`). Only a create starts a new
// incarnation. So a token's form says which kind of row issued it, and no two forms ever compare equal: they differ
// in how many `.` they hold. Tokens are compared only by equality; nothing orders them.

/** A schema-1 row's token: a canonical decimal counter. */
const COUNTER_TOKEN = /^(0|[1-9]\d*)$/;
/** A schema-1-born row's token once this build has written it: the counter, a `.`, and a write part. */
const WRITTEN_COUNTER_TOKEN = /^(0|[1-9]\d*)\.([0-9a-f]{16})$/;
/** The incarnation id's width, in bytes. */
const INCARNATION_BYTES = 16;
/** The write part's width, in bytes. */
const WRITE_BYTES = 8;

/** A token taken apart: its incarnation (absent on a schema-1-born row) and its counter. */
interface TokenParts {
  readonly incarnation: string | undefined;
  readonly counter: number;
}

/**
 * Take a token apart, refusing anything that is not a form a shipped driver writes (invariant 5): `"1e3"`, `"0x10"`,
 * `" 5 "`, `""`, a counter past 2^53, upper-case hex. A stored row of `schemaVersion` 1 holds only a bare counter, and
 * one of 2 only a form with a write part; a record already read (`schemaVersion` undefined) may hold any of them.
 */
function tokenParts(token: string, schemaVersion: number | undefined, ctx: string): TokenParts {
  const bare =
    schemaVersion === undefined || schemaVersion === 1 ? COUNTER_TOKEN.exec(token) : null;
  const written =
    schemaVersion === undefined || schemaVersion >= 2
      ? (WRITTEN_COUNTER_TOKEN.exec(token) ?? INCARNATION_TOKEN.exec(token))
      : null;
  const match = bare ?? written;
  if (match === null) {
    throw new IntegrityError(
      `registry row token is not one a schema-${schemaVersion ?? REGISTRY_SCHEMA_VERSION} row holds ` +
        `(${JSON.stringify(token)}): ${ctx}`,
    );
  }
  const born = match.length === 4; // the incarnation form has three groups
  const counter = Number(born ? match[2] : match[1]);
  if (!Number.isSafeInteger(counter)) {
    throw new IntegrityError(`registry row token's counter is out of safe-integer range: ${ctx}`);
  }
  return { incarnation: born ? match[1] : undefined, counter };
}

export { usableKeptGens };

// `incarnationOf` is defined in `core/token`, where the publish reads it too, and is the same function here.
export { incarnationOf };

/** `bytes` fresh bytes from `entropy`, as lowercase hex, refusing a source that does not give them. */
function drawHex(entropy: Entropy, bytes: number): string {
  const drawn = entropy(bytes);
  if (!(drawn instanceof Uint8Array) || drawn.length !== bytes) {
    throw new ValidationError(
      `the registry's entropy source must return ${bytes} bytes as a Uint8Array`,
    );
  }
  let hex = '';
  for (const b of drawn) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** A fresh incarnation id from `entropy`: 128 bits as 32 lowercase hex digits. */
export function drawIncarnation(entropy: Entropy): string {
  return drawHex(entropy, INCARNATION_BYTES);
}

/** A fresh write part from `entropy`: 64 bits as 16 lowercase hex digits. */
export function drawWrite(entropy: Entropy): string {
  return drawHex(entropy, WRITE_BYTES);
}

/**
 * The token for the write after `record`'s: the same incarnation, if it has one, the counter one on, and a fresh write
 * part. For a compare-and-swap or a tombstone.
 */
export function nextRegistryToken(record: RegistryRecord, entropy: Entropy): Token {
  const { incarnation, counter } = tokenParts(record.token, undefined, record.segment);
  const tail = `${counter + 1}.${drawWrite(entropy)}`;
  return incarnation === undefined ? tail : `${incarnation}.${tail}`;
}

/**
 * The token of a new row: a fresh incarnation and write part from `entropy`, and a counter that continues
 * `tombstone`'s when the row is created over one, else starts at 0.
 */
export function newIncarnationToken(
  entropy: Entropy,
  tombstone: RegistryRecord | undefined,
): Token {
  const counter =
    tombstone === undefined
      ? 0
      : tokenParts(tombstone.token, undefined, tombstone.segment).counter + 1;
  return `${drawIncarnation(entropy)}.${counter}.${drawWrite(entropy)}`;
}

/**
 * Parse + structurally validate a persisted `{ deleted, record }` envelope from stored bytes. A published row
 * is always whole (atomic write), so a parse failure or a missing/mistyped field means corruption/tampering —
 * fail fast (invariant 5), never silently report "absent". `ctx` names the source (path/key) for the message.
 */
export function parseRegistryEnvelope(text: string, ctx: string): RegistryEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrityError(`registry row is not valid JSON: ${ctx}`);
  }
  // Guard before any property access: `JSON.parse` yields `null`/primitives for hostile bytes (e.g. `"null"`,
  // `"5"`), which would throw an *untyped* TypeError on the dereference below (invariant 5 wants a typed error).
  if (parsed === null || typeof parsed !== 'object') {
    throw new IntegrityError(`registry row has a malformed envelope: ${ctx}`);
  }
  const env = parsed as { schemaVersion?: unknown; deleted?: unknown; record?: unknown };
  const schemaVersion = assertRegistrySchemaVersion(env.schemaVersion, ctx);
  const extra = Object.keys(env).filter((k) => !ENVELOPE_FIELDS.includes(k));
  if (extra.length > 0) {
    throw new IntegrityError(
      `registry row has fields its envelope does not declare (${extra.join(', ')}): ${ctx}`,
    );
  }
  if (typeof env.deleted !== 'boolean' || env.record === null || typeof env.record !== 'object') {
    throw new IntegrityError(`registry row has a malformed envelope: ${ctx}`);
  }
  const r = env.record as Record<string, unknown>;
  assertStoredRecordShape(r, ctx, schemaVersion);
  if (typeof r.token !== 'string') {
    throw new IntegrityError(`registry row is missing its token: ${ctx}`);
  }
  tokenParts(r.token, schemaVersion, ctx);
  return { deleted: env.deleted, record: env.record as RegistryRecord };
}

/** Build a full record from a {@link NewRegistryRecord} plus identity, audit timestamps, and an OCC token. */
export function recordFromNew(
  ref: SegmentRef,
  rec: NewRegistryRecord,
  now: number,
  token: Token,
): RegistryRecord {
  return {
    namespace: ref.namespace,
    segment: ref.segment,
    currentGen: rec.currentGen,
    wrappedDeks: rec.wrappedDeks,
    keyId: rec.keyId,
    status: rec.status ?? 'active',
    retention: rec.retention,
    residency: rec.residency,
    summary: rec.summary,
    keptGens: rec.keptGens,
    // A new row has no holder: a lease is written only against a row that already exists.
    leases: undefined,
    createdAt: now,
    updatedAt: now,
    token,
  };
}

/**
 * Fail-fast structural check on a record read back from a persistent tier (untrusted bytes, invariant 5):
 * a published row is always whole, so a missing/mistyped required field means corruption/tampering — reject
 * it rather than silently report "absent". A row of an older `schemaVersion` may carry only that schema's
 * fields. `token` is checked by the caller.
 */
export function assertStoredRecordShape(
  r: Record<string, unknown>,
  ctx: string,
  schemaVersion: number = REGISTRY_SCHEMA_VERSION,
): void {
  if (
    typeof r.segment !== 'string' ||
    (r.namespace !== undefined && typeof r.namespace !== 'string') ||
    (r.currentGen !== null && typeof r.currentGen !== 'number') ||
    typeof r.status !== 'string' ||
    typeof r.createdAt !== 'number' ||
    typeof r.updatedAt !== 'number'
  ) {
    throw new IntegrityError(`registry record is missing required fields: ${ctx}`);
  }
  // Enforce the same value invariants the write path checks, so corrupt/tampered bytes are rejected at the
  // read boundary (invariant 5) rather than leaking a bad currentGen/status downstream.
  if (r.currentGen !== null && (!Number.isSafeInteger(r.currentGen) || r.currentGen < 0)) {
    throw new IntegrityError(`registry record has an invalid currentGen (${r.currentGen}): ${ctx}`);
  }
  if (!STATUSES.includes(r.status)) {
    throw new IntegrityError(`registry record has an unknown status (${r.status}): ${ctx}`);
  }
  const declared = fieldsOf(schemaVersion);
  const extra = Object.keys(r).filter((k) => !declared.includes(k));
  if (extra.length > 0) {
    throw new IntegrityError(
      `registry record has fields a schema-${schemaVersion} row does not declare (${extra.join(', ')}): ${ctx}`,
    );
  }
  if (r.keyId !== undefined && typeof r.keyId !== 'string') {
    throw new IntegrityError(`registry record has an invalid keyId: ${ctx}`);
  }
  validateWrappedDeks(r.wrappedDeks, true); // invariant 5: reject a corrupt wrapped-DEK list on read-back
  // The governance blobs' SHAPE is checked on read-back too, because one of them carries semantics:
  // `retention.expiresAt` is read with an `in` test, which throws an untyped `TypeError` on a stored
  // `null`/string/number. That is reachable — the write boundary only checks
  // JSON-serializability and size, so `"retention": null` round-trips through every driver from a hand-edit,
  // another writer, or a restore — and it would abort a whole fleet retention sweep rather than becoming one
  // ledger entry. Reject it here, typed, at the trust boundary (invariant 5).
  for (const field of ['retention', 'residency'] as const) {
    const meta = r[field];
    if (meta !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
      throw new IntegrityError(`registry record has a non-object ${field}: ${ctx}`);
    }
  }
  // Shape only. Whether the summary agrees with the row's keys and names its `currentGen` is not checked here: a
  // stored row that disagrees is a summary its reader must not use, not a row to refuse, and refusing it would let
  // one row stop every listing that reaches it.
  validateSummary(r.summary, true, ctx);
  validateKeptGens(r.keptGens, true, ctx);
  validateLeases(r.leases, true, ctx);
}

/**
 * Apply a patch to an existing record, returning a new one with a fresh `updatedAt` + `token` (identity and
 * `createdAt` are preserved). Optional fields use `'k' in patch` so a patch can *clear* them (set to
 * `undefined`, e.g. dropping `keyId` on crypto-shred); required fields use `??` (they always have a value).
 *
 * `summary` describes the current generation, so it follows the pointer and the keys: a patch that moves
 * `currentGen`, or changes `wrappedDeks` so the summary's shape no longer agrees, without mentioning `summary` drops
 * the old one; and a summary the patch gives must name the resulting `currentGen` and agree with the resulting keys
 * (`ValidationError`, before anything is written).
 */
export function applyRegistryPatch(
  prev: RegistryRecord,
  patch: RegistryPatch,
  now: number,
  token: Token,
): RegistryRecord {
  // `'currentGen' in patch`, NOT `patch.currentGen ?? prev.currentGen`. `null` is a legal, meaningful value
  // here (no Storage generation yet), and `??` treats it as absent — so the nullish form would silently ignore a
  // patch that clears the pointer and leave the old generation in place. The same reason `wrappedDeks` and
  // `keyId` below use presence: any field whose null is a *value* cannot be merged with `??`.
  const currentGen = 'currentGen' in patch ? (patch.currentGen ?? null) : prev.currentGen;
  const wrappedDeks = 'wrappedDeks' in patch ? patch.wrappedDeks : prev.wrappedDeks;
  let summary: RegistrySummary | undefined;
  if ('summary' in patch) {
    validateSummaryNames(patch.summary, currentGen);
    validateSummaryKeys(patch.summary, wrappedDeks);
    summary = patch.summary;
  } else {
    // Kept only while it still describes the row: the same generation, and the same encryption.
    const kept = currentGen === prev.currentGen ? prev.summary : undefined;
    summary = kept !== undefined && summaryAgreesWithKeys(kept, wrappedDeks) ? kept : undefined;
  }
  // The list names generations below the pointer, so it follows the pointer as the summary does: kept while the
  // pointer stays, dropped when it moves without the patch naming the list, and checked against the pointer it gets.
  let keptGens: readonly number[] | undefined;
  if ('keptGens' in patch) {
    validateKeptGensBelow(patch.keptGens, currentGen);
    keptGens = patch.keptGens;
  } else {
    keptGens = currentGen === prev.currentGen ? prev.keptGens : undefined;
  }
  // Leases name generations a holder pinned, and the pointer moving does not end them: kept unless the patch names the list.
  let leases: readonly LeaseEntry[] | undefined;
  if ('leases' in patch) {
    leases = patch.leases;
    validateLeasesPointer(leases, currentGen);
    // A writer writes at most the cap, except that a list may always shrink: a release over a row that holds more
    // (written by another build) writes that list less one, and so can never be stuck behind the cap.
    const most = Math.max(MAX_LEASES_PER_SEGMENT, prev.leases?.length ?? 0);
    if (leases !== undefined && leases.length > most) {
      throw new ValidationError(`leases: has ${leases.length} entries, cap ${most}`);
    }
  } else {
    leases = prev.leases;
  }
  return {
    namespace: prev.namespace,
    segment: prev.segment,
    currentGen,
    wrappedDeks,
    keyId: 'keyId' in patch ? patch.keyId : prev.keyId,
    status: patch.status ?? prev.status,
    retention: 'retention' in patch ? patch.retention : prev.retention,
    residency: 'residency' in patch ? patch.residency : prev.residency,
    summary,
    keptGens,
    leases,
    createdAt: prev.createdAt,
    updatedAt: now,
    token,
  };
}
