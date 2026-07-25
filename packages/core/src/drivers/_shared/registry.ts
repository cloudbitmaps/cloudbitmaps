/**
 * Shared, SDK-free helpers for assembling + validating {@link RegistryRecord}s (Phase 4c).
 *
 * The registry's record-construction, patch-application, and field-validation are identical across every
 * backend (memory / LocalFs / DynamoDB) — only the *storage* + OCC mechanics differ. This is the one home
 * for that logic so the three drivers can't drift. Pure: no I/O, no SDK, no clock (the caller passes `now`).
 */
import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import type {
  NewRegistryRecord,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
} from '@/core/ports';

/** The valid {@link RegistryStatus} values — used to validate both caller input and stored bytes. */
const STATUSES: readonly string[] = ['active', 'compacting', 'erasing', 'destroyed'];
/** Cap on a serialized governance blob (retention/residency) — bounds row size so a row can't be bricked. */
const MAX_GOVERNANCE_BYTES = 64 * 1024;
/** Bounds on the wrapped-DEK list (one DEK wrapped under a few KEKs) — keeps the row small + rejects abuse. */
const MAX_WRAPPED_DEKS = 8;
const MAX_WRAPPED_DEK_BYTES = 4 * 1024;

function validateGeneration(gen: number): void {
  if (!Number.isInteger(gen) || gen < 0) {
    throw new ValidationError(`currentGen must be a non-negative integer; got ${gen}`);
  }
}

function validateCount(count: number, field = 'dirtyChunkCount'): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new ValidationError(`${field} must be a non-negative integer; got ${count}`);
  }
}

/** Validate an epoch-ms timestamp (non-negative, finite). */
function validateTimestamp(ms: number, field: string): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ValidationError(`${field} must be a non-negative finite number; got ${ms}`);
  }
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

/** Validate the caller-settable fields at `create`. */
export function validateNewRegistryRecord(rec: NewRegistryRecord): void {
  validateGeneration(rec.currentGen);
  if (rec.dirtyChunkCount !== undefined) validateCount(rec.dirtyChunkCount);
  if (rec.status !== undefined) validateStatus(rec.status);
  validateWrappedDeks(rec.wrappedDeks, false);
  validateGovernance(rec.retention, 'retention');
  validateGovernance(rec.residency, 'residency');
}

/** Validate the caller-settable fields in a `compareAndSwap` patch. */
export function validateRegistryPatch(patch: RegistryPatch): void {
  if (patch.currentGen !== undefined) validateGeneration(patch.currentGen);
  if (patch.dirtyChunkCount !== undefined) validateCount(patch.dirtyChunkCount);
  if (patch.consecutiveFailures !== undefined)
    validateCount(patch.consecutiveFailures, 'consecutiveFailures');
  if (patch.lastCompactedAt !== undefined)
    validateTimestamp(patch.lastCompactedAt, 'lastCompactedAt');
  if (patch.status !== undefined) validateStatus(patch.status);
  if ('wrappedDeks' in patch) validateWrappedDeks(patch.wrappedDeks, false);
  if ('retention' in patch) validateGovernance(patch.retention, 'retention');
  if ('residency' in patch) validateGovernance(patch.residency, 'residency');
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
 * Current registry-row schema version — a pre-1.0 format-freeze prerequisite (Phase G, DECISIONS #41). Every persistent
 * registry driver — the LocalFs/S3 `{ deleted, record }` envelope and the DynamoDB body — stamps its rows
 * with this so a reader can fail-closed on a future, incompatible layout instead of misparsing it. Bump only
 * on a backward-incompatible change. Policy: a **higher** stamp than this build knows → `UnsupportedError`
 * (fail-closed); an **absent** stamp → legacy pre-freeze row, tolerated as v1.
 */
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Validate a persisted registry row's `schemaVersion` (untrusted bytes, invariant 5): absent → legacy v1
 * (tolerated); a malformed value → `IntegrityError`; a version newer than this build → `UnsupportedError`
 * (fail-closed rather than misread a format we don't understand).
 */
export function assertRegistrySchemaVersion(raw: unknown, ctx: string): void {
  if (raw === undefined) return; // pre-stamp rows are v1
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new IntegrityError(`registry row has a malformed schemaVersion (${String(raw)}): ${ctx}`);
  }
  if (raw > REGISTRY_SCHEMA_VERSION) {
    throw new UnsupportedError(
      `registry row schemaVersion ${raw} is newer than this build reads (v${REGISTRY_SCHEMA_VERSION}): ${ctx}`,
    );
  }
}

/** Serialize a registry envelope for persistence, stamping the current {@link REGISTRY_SCHEMA_VERSION}. */
export function serializeRegistryEnvelope(env: RegistryEnvelope): string {
  return JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    deleted: env.deleted,
    record: env.record,
  });
}

/**
 * The OCC counter encoded in a record's token. A published row always has a **canonical decimal** token
 * (`String(counter)`), so anything else (`"1e3"`, `"0x10"`, `" 5 "`, `""`, a >2^53 value) is corruption /
 * tampering — reject it (invariant 5) rather than let `Number()` coerce it and silently break monotonicity.
 */
export function registryCounterOf(record: RegistryRecord): number {
  if (!/^(0|[1-9]\d*)$/.test(record.token)) {
    throw new IntegrityError(`registry row token is not a canonical counter: ${record.token}`);
  }
  const n = Number(record.token);
  if (!Number.isSafeInteger(n)) {
    throw new IntegrityError(`registry row token is out of safe-integer range: ${record.token}`);
  }
  return n;
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
  assertRegistrySchemaVersion(env.schemaVersion, ctx);
  if (typeof env.deleted !== 'boolean' || env.record === null || typeof env.record !== 'object') {
    throw new IntegrityError(`registry row has a malformed envelope: ${ctx}`);
  }
  const r = env.record as Record<string, unknown>;
  assertStoredRecordShape(r, ctx);
  if (typeof r.token !== 'string') {
    throw new IntegrityError(`registry row is missing its token: ${ctx}`);
  }
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
    dirtyChunkCount: rec.dirtyChunkCount ?? 0,
    status: rec.status ?? 'active',
    consecutiveFailures: 0, // daemon health (Phase D); lastCompactedAt stays absent until first compaction
    retention: rec.retention,
    residency: rec.residency,
    createdAt: now,
    updatedAt: now,
    token,
  };
}

/**
 * Fail-fast structural check on a record read back from a persistent tier (untrusted bytes, invariant 5):
 * a published row is always whole, so a missing/mistyped required field means corruption/tampering — reject
 * it rather than silently report "absent". `token` is checked by the caller (its source differs per backend:
 * an in-body field vs a derived OCC counter).
 */
export function assertStoredRecordShape(r: Record<string, unknown>, ctx: string): void {
  if (
    typeof r.segment !== 'string' ||
    (r.namespace !== undefined && typeof r.namespace !== 'string') ||
    typeof r.currentGen !== 'number' ||
    typeof r.dirtyChunkCount !== 'number' ||
    typeof r.status !== 'string' ||
    typeof r.createdAt !== 'number' ||
    typeof r.updatedAt !== 'number'
  ) {
    throw new IntegrityError(`registry record is missing required fields: ${ctx}`);
  }
  // Enforce the same value invariants the write path checks, so corrupt/tampered bytes are rejected at the
  // read boundary (invariant 5) rather than leaking a bad currentGen/status downstream.
  if (!Number.isInteger(r.currentGen) || r.currentGen < 0) {
    throw new IntegrityError(`registry record has an invalid currentGen (${r.currentGen}): ${ctx}`);
  }
  if (!Number.isInteger(r.dirtyChunkCount) || r.dirtyChunkCount < 0) {
    throw new IntegrityError(`registry record has an invalid dirtyChunkCount: ${ctx}`);
  }
  if (!STATUSES.includes(r.status)) {
    throw new IntegrityError(`registry record has an unknown status (${r.status}): ${ctx}`);
  }
  if (r.leaseOwner !== undefined && typeof r.leaseOwner !== 'string') {
    throw new IntegrityError(`registry record has an invalid leaseOwner: ${ctx}`);
  }
  if (r.leaseExpiresAt !== undefined && typeof r.leaseExpiresAt !== 'number') {
    throw new IntegrityError(`registry record has an invalid leaseExpiresAt: ${ctx}`);
  }
  if (
    r.consecutiveFailures !== undefined &&
    (!Number.isInteger(r.consecutiveFailures) || (r.consecutiveFailures as number) < 0)
  ) {
    throw new IntegrityError(`registry record has an invalid consecutiveFailures: ${ctx}`);
  }
  if (
    r.lastCompactedAt !== undefined &&
    (typeof r.lastCompactedAt !== 'number' ||
      !Number.isFinite(r.lastCompactedAt) ||
      (r.lastCompactedAt as number) < 0)
  ) {
    throw new IntegrityError(`registry record has an invalid lastCompactedAt: ${ctx}`);
  }
  if (r.keyId !== undefined && typeof r.keyId !== 'string') {
    throw new IntegrityError(`registry record has an invalid keyId: ${ctx}`);
  }
  validateWrappedDeks(r.wrappedDeks, true); // invariant 5: reject a corrupt wrapped-DEK list on read-back
}

/**
 * Apply a patch to an existing record, returning a new one with a fresh `updatedAt` + `token` (identity and
 * `createdAt` are preserved). Optional fields use `'k' in patch` so a patch can *clear* them (set to
 * `undefined`, e.g. dropping `keyId` on crypto-shred); required fields use `??` (they always have a value).
 */
export function applyRegistryPatch(
  prev: RegistryRecord,
  patch: RegistryPatch,
  now: number,
  token: Token,
): RegistryRecord {
  return {
    namespace: prev.namespace,
    segment: prev.segment,
    currentGen: patch.currentGen ?? prev.currentGen,
    wrappedDeks: 'wrappedDeks' in patch ? patch.wrappedDeks : prev.wrappedDeks,
    keyId: 'keyId' in patch ? patch.keyId : prev.keyId,
    dirtyChunkCount: patch.dirtyChunkCount ?? prev.dirtyChunkCount,
    status: patch.status ?? prev.status,
    leaseOwner: 'leaseOwner' in patch ? patch.leaseOwner : prev.leaseOwner,
    leaseExpiresAt: 'leaseExpiresAt' in patch ? patch.leaseExpiresAt : prev.leaseExpiresAt,
    lastCompactedAt: 'lastCompactedAt' in patch ? patch.lastCompactedAt : prev.lastCompactedAt,
    consecutiveFailures: patch.consecutiveFailures ?? prev.consecutiveFailures ?? 0,
    retention: 'retention' in patch ? patch.retention : prev.retention,
    residency: 'residency' in patch ? patch.residency : prev.residency,
    createdAt: prev.createdAt,
    updatedAt: now,
    token,
  };
}
