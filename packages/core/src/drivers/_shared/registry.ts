/**
 * Shared, SDK-free helpers for assembling + validating {@link RegistryRecord}s.
 *
 * The registry's record-construction, patch-application, and field-validation are identical across every
 * backend (memory / LocalFs / object store) — only the *storage* + OCC mechanics differ. This is the one home
 * for that logic so the three drivers can't drift. Pure: no I/O, no SDK, no clock (the caller passes `now`).
 */
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';
import { canonicalMetadataJson, MAX_METADATA_BYTES } from '@/core/metadata';
import type {
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
export const RECORD_FIELDS = [
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
/** The record fields a schema-1 row may carry: every field but the ones schema 2 added. */
const SCHEMA_1_RECORD_FIELDS: readonly string[] = RECORD_FIELDS.filter((f) => f !== 'summary');
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
/** Canonical, padded standard base64. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `null` is legal and meaningful: the segment has no Storage generation yet (see `RegistryRecord.currentGen`). */
function validateGeneration(gen: number | null): void {
  if (gen === null) return;
  if (!Number.isInteger(gen) || gen < 0) {
    throw new ValidationError(
      `currentGen must be a non-negative integer or null (no Storage generation yet); got ${gen}`,
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

/**
 * Validate a {@link RegistrySummary}'s shape at the write or read boundary: exactly one of the two shapes, a
 * non-negative safe-integer generation, a cardinality from 0 to 2^32, metadata by the metadata rules (never the
 * empty object, which is never stored), or a sealed blob in canonical base64 whose length fits a sealed count plus
 * metadata at its cap. Whether a summary may be *used* is the reader's rule, not this one: this only bounds what
 * a row can hold. `isStored` picks the error class (write = ValidationError; read = IntegrityError, invariant 5).
 */
function validateSummary(value: unknown, isStored: boolean): void {
  if (value === undefined) return;
  const fail = (msg: string): never => {
    throw isStored ? new IntegrityError(`summary: ${msg}`) : new ValidationError(`summary: ${msg}`);
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
  if (!Number.isSafeInteger(s.generation) || (s.generation as number) < 0) {
    fail(`generation must be a non-negative safe integer (got ${String(s.generation)})`);
  }
  if (isSealed) {
    const sealed = s.sealed;
    if (typeof sealed !== 'string' || !BASE64.test(sealed)) fail('sealed must be canonical base64');
    const text = sealed as string;
    const bytes = (text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
    if (bytes < SEALED_SUMMARY_MIN_BYTES || bytes > SEALED_SUMMARY_MAX_BYTES) {
      fail(
        `sealed is ${bytes}B, outside ${SEALED_SUMMARY_MIN_BYTES}..${SEALED_SUMMARY_MAX_BYTES}B ` +
          '(a nonce, a fixed-width count, a tag, and metadata up to its cap)',
      );
    }
    return;
  }
  const n = s.cardinality;
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_SUMMARY_CARDINALITY) {
    fail(`cardinality must be an integer from 0 to 2^32 (got ${String(n)})`);
  }
  if (s.metadata !== undefined && canonicalMetadataJson(s.metadata, fail) === '{}') {
    fail('metadata is empty; a generation without metadata carries none');
  }
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

/** Validate the caller-settable fields at `create`. */
export function validateNewRegistryRecord(rec: NewRegistryRecord): void {
  validateGeneration(rec.currentGen);
  if (rec.status !== undefined) validateStatus(rec.status);
  validateWrappedDeks(rec.wrappedDeks, false);
  validateGovernance(rec.retention, 'retention');
  validateGovernance(rec.residency, 'residency');
  validateSummary(rec.summary, false);
  validateSummaryNames(rec.summary, rec.currentGen);
}

/**
 * Validate the caller-settable fields in a `compareAndSwap` patch. That a given `summary` names the row's
 * resulting `currentGen` needs the stored row, so {@link applyRegistryPatch} checks it.
 */
export function validateRegistryPatch(patch: RegistryPatch): void {
  validatePatchGeneration(patch);
  if (patch.status !== undefined) validateStatus(patch.status);
  if ('wrappedDeks' in patch) validateWrappedDeks(patch.wrappedDeks, false);
  if ('retention' in patch) validateGovernance(patch.retention, 'retention');
  if ('residency' in patch) validateGovernance(patch.residency, 'residency');
  if ('summary' in patch) validateSummary(patch.summary, false);
}

/**
 * The persisted envelope for a registry row: the record plus a tombstone flag. A **deleted** row keeps its
 * record (with an advanced counter) rather than being removed, so the monotonic token survives a
 * delete→recreate — ABA-safety. Shared by the persistent drivers (LocalFs file, S3 object).
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
 * Schema 2 adds the record's `summary` and the incarnation-form token. Every row this build writes is stamped 2,
 * whatever it holds, and a build that reads only schema 1 refuses it, so a fleet cannot go back once one has been
 * written.
 */
export const REGISTRY_SCHEMA_VERSION = 2;

/**
 * The oldest schema this build reads. A schema-1 row is read as it was written; the first write to it stamps it 2.
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
// A token is `<incarnation>.<counter>`: 32 lowercase hex digits drawn from injected entropy when the row is
// created, and a canonical decimal counter that every write of the row advances by one. The incarnation is what
// keeps a re-created name from ever being taken for an earlier incarnation of it, even once the earlier row's
// record is gone and nothing is left to continue a counter from; the counter keeps the tokens of one incarnation
// apart. A row created over a tombstone continues the tombstone's counter too, so while a tombstone exists the
// separation is by construction as well as by the random id.
//
// A row first written by a schema-1 build has a bare decimal counter (`"7"`), and keeps that form for as long as
// it lives: its writes advance the counter as before. Only a create starts a new incarnation, and every create
// gives the incarnation form. So a token's form says which kind of row issued it, and the two forms never compare
// equal: a bare counter has no `.`. Tokens are compared only by equality; nothing orders them.

/** A row's token on a schema-1-born row: a canonical decimal counter. */
const COUNTER_TOKEN = /^(0|[1-9]\d*)$/;
/** An incarnation-form token: 128 bits as 32 lowercase hex digits, a `.`, and a canonical decimal counter. */
const INCARNATION_TOKEN = /^([0-9a-f]{32})\.(0|[1-9]\d*)$/;
/** The incarnation id's width, in bytes. */
const INCARNATION_BYTES = 16;

/** A token taken apart: its incarnation (absent for a bare counter) and its counter. */
interface TokenParts {
  readonly incarnation: string | undefined;
  readonly counter: number;
}

/**
 * Take a stored token apart, refusing anything that is not one of the two forms a shipped driver writes, or one a
 * schema-1 row may not hold (invariant 5): `"1e3"`, `"0x10"`, `" 5 "`, `""`, a counter past 2^53, upper-case hex.
 */
function tokenParts(token: string, schemaVersion: number, ctx: string): TokenParts {
  const legacy = COUNTER_TOKEN.exec(token);
  const born = legacy === null && schemaVersion >= 2 ? INCARNATION_TOKEN.exec(token) : null;
  if (legacy === null && born === null) {
    throw new IntegrityError(
      `registry row token is not one a schema-${schemaVersion} row holds (${JSON.stringify(token)}): ${ctx}`,
    );
  }
  const counter = Number(legacy !== null ? legacy[1] : born![2]);
  if (!Number.isSafeInteger(counter)) {
    throw new IntegrityError(`registry row token's counter is out of safe-integer range: ${ctx}`);
  }
  return { incarnation: born === null ? undefined : born[1], counter };
}

/**
 * The incarnation id in a token, or `undefined` for one that has none: a bare counter from a schema-1-born row, or
 * any token another driver issues. Two tokens with the same incarnation are writes of one incarnation of a row.
 */
export function incarnationOf(token: Token): string | undefined {
  return INCARNATION_TOKEN.exec(token)?.[1];
}

/** The token after `record`'s: the same incarnation and form, the counter one on. For a write or a tombstone. */
export function nextRegistryToken(record: RegistryRecord): Token {
  const { incarnation, counter } = tokenParts(
    record.token,
    REGISTRY_SCHEMA_VERSION,
    record.segment,
  );
  return incarnation === undefined ? String(counter + 1) : `${incarnation}.${counter + 1}`;
}

/** A fresh incarnation id from `entropy`: 128 bits as 32 lowercase hex digits. */
export function drawIncarnation(entropy: Entropy): string {
  const bytes = entropy(INCARNATION_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== INCARNATION_BYTES) {
    throw new ValidationError(
      `the registry's entropy source must return ${INCARNATION_BYTES} bytes as a Uint8Array`,
    );
  }
  let incarnation = '';
  for (const b of bytes) incarnation += b.toString(16).padStart(2, '0');
  return incarnation;
}

/**
 * The token of a new row: a fresh incarnation from `entropy`, and a counter that continues `tombstone`'s when the
 * row is created over one, else starts at 0.
 */
export function newIncarnationToken(
  entropy: Entropy,
  tombstone: RegistryRecord | undefined,
): Token {
  const counter =
    tombstone === undefined
      ? 0
      : tokenParts(tombstone.token, REGISTRY_SCHEMA_VERSION, tombstone.segment).counter + 1;
  return `${drawIncarnation(entropy)}.${counter}`;
}

/**
 * The default entropy: the platform's Web Crypto. Refused with `UnsupportedError` when there is none, at the first
 * row created rather than at construction, so a read-only process runs anywhere.
 */
export const webCryptoEntropy: Entropy = (length) => {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (webCrypto === undefined || typeof webCrypto.getRandomValues !== 'function') {
    throw new UnsupportedError(
      'this runtime has no Web Crypto (crypto.getRandomValues), which a registry needs to create a row: ' +
        'give the registry driver an entropy source',
    );
  }
  return (webCrypto as { getRandomValues(a: Uint8Array): Uint8Array }).getRandomValues(
    new Uint8Array(length),
  );
};

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
  if (r.currentGen !== null && (!Number.isInteger(r.currentGen) || r.currentGen < 0)) {
    throw new IntegrityError(`registry record has an invalid currentGen (${r.currentGen}): ${ctx}`);
  }
  if (!STATUSES.includes(r.status)) {
    throw new IntegrityError(`registry record has an unknown status (${r.status}): ${ctx}`);
  }
  const declared: readonly string[] = schemaVersion >= 2 ? RECORD_FIELDS : SCHEMA_1_RECORD_FIELDS;
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
  validateSummary(r.summary, true);
}

/**
 * Apply a patch to an existing record, returning a new one with a fresh `updatedAt` + `token` (identity and
 * `createdAt` are preserved). Optional fields use `'k' in patch` so a patch can *clear* them (set to
 * `undefined`, e.g. dropping `keyId` on crypto-shred); required fields use `??` (they always have a value).
 *
 * `summary` describes the current generation, so it follows the pointer: a patch that moves `currentGen` without
 * mentioning it drops the old one, and a summary the patch gives must name the resulting `currentGen`
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
  let summary: RegistrySummary | undefined;
  if ('summary' in patch) {
    validateSummaryNames(patch.summary, currentGen);
    summary = patch.summary;
  } else {
    summary = currentGen === prev.currentGen ? prev.summary : undefined;
  }
  return {
    namespace: prev.namespace,
    segment: prev.segment,
    currentGen,
    wrappedDeks: 'wrappedDeks' in patch ? patch.wrappedDeks : prev.wrappedDeks,
    keyId: 'keyId' in patch ? patch.keyId : prev.keyId,
    status: patch.status ?? prev.status,
    retention: 'retention' in patch ? patch.retention : prev.retention,
    residency: 'residency' in patch ? patch.residency : prev.residency,
    summary,
    createdAt: prev.createdAt,
    updatedAt: now,
    token,
  };
}
