import {
  assertRegistrySchemaVersion,
  assertStoredRecordShape,
  parseRegistryEnvelope,
  REGISTRY_SCHEMA_VERSION,
  serializeRegistryEnvelope,
  type RegistryEnvelope,
} from '@/drivers/_shared/registry';
import type { RegistryRecord } from '@/core/ports';
import { IntegrityError, UnsupportedError } from '@/core/errors';

/**
 * Phase D added two OPTIONAL registry fields (`consecutiveFailures`, `lastCompactedAt`). The read-back guard
 * must keep accepting rows written *before* Phase D (no such keys) — otherwise an upgrade makes every existing
 * row unreadable. The conformance round-trip can't catch a regression here because a freshly created row always
 * carries the fields; this pins the back-compat + the value-validation directly on the shared guard.
 */
describe('assertStoredRecordShape — daemon-health field back-compat (Phase D)', () => {
  const base = {
    segment: 's',
    currentGen: 0,
    dirtyChunkCount: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: 't',
  };

  it('accepts a pre-Phase-D row with neither consecutiveFailures nor lastCompactedAt', () => {
    expect(() => assertStoredRecordShape({ ...base }, 'back-compat')).not.toThrow();
  });

  it('accepts valid daemon-health fields (including a legitimate 0)', () => {
    expect(() =>
      assertStoredRecordShape({ ...base, consecutiveFailures: 0, lastCompactedAt: 123 }, 'ok'),
    ).not.toThrow();
    expect(() => assertStoredRecordShape({ ...base, consecutiveFailures: 5 }, 'ok')).not.toThrow();
  });

  it('rejects corrupt daemon-health fields (invariant 5: untrusted bytes)', () => {
    expect(() => assertStoredRecordShape({ ...base, consecutiveFailures: -1 }, 'bad')).toThrow();
    expect(() => assertStoredRecordShape({ ...base, consecutiveFailures: 1.5 }, 'bad')).toThrow();
    expect(() => assertStoredRecordShape({ ...base, lastCompactedAt: -5 }, 'bad')).toThrow();
    expect(() =>
      assertStoredRecordShape({ ...base, lastCompactedAt: Number.POSITIVE_INFINITY }, 'bad'),
    ).toThrow();
  });
});

/**
 * Registry-row schema-version stamps (Phase G1 format-freeze prerequisite, DECISIONS #41). The persisted envelope carries a
 * `schemaVersion` so a reader can fail-closed on a future, incompatible layout. Policy: absent → legacy v1
 * (tolerated — pre-freeze rows stay readable across the upgrade); higher → UnsupportedError; malformed →
 * IntegrityError. This pins the LocalFs/S3 envelope path; the DynamoDB body path is tested in its own suite.
 */
describe('registry envelope schema version (Phase G1, format freeze)', () => {
  const record: RegistryRecord = {
    segment: 's',
    currentGen: 0,
    dirtyChunkCount: 0,
    status: 'active',
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    token: '0',
  };
  const envelope: RegistryEnvelope = { deleted: false, record };

  it('serializeRegistryEnvelope stamps the current version and round-trips through parse', () => {
    const text = serializeRegistryEnvelope(envelope);
    expect(JSON.parse(text).schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const parsed = parseRegistryEnvelope(text, 'round-trip');
    expect(parsed.deleted).toBe(false);
    expect(parsed.record.segment).toBe('s');
    // the wire-only stamp is stripped — it never leaks into the in-memory record
    expect(parsed.record).not.toHaveProperty('schemaVersion');
  });

  it('tolerates a legacy row with no schemaVersion (reads as v1)', () => {
    const legacy = JSON.stringify({ deleted: false, record }); // pre-freeze: no stamp
    expect(() => parseRegistryEnvelope(legacy, 'legacy')).not.toThrow();
    expect(parseRegistryEnvelope(legacy, 'legacy').record.segment).toBe('s');
  });

  it('rejects a row stamped with a newer schemaVersion (UnsupportedError, fail-closed)', () => {
    const future = JSON.stringify({
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      deleted: false,
      record,
    });
    expect(() => parseRegistryEnvelope(future, 'future')).toThrow(UnsupportedError);
  });

  it('rejects a malformed schemaVersion (IntegrityError, invariant 5)', () => {
    for (const bad of ['1', 0, -1, 1.5, null]) {
      expect(() => assertRegistrySchemaVersion(bad, 'bad')).toThrow(IntegrityError);
    }
    // undefined is the tolerated legacy case, not a malformed value
    expect(() => assertRegistrySchemaVersion(undefined, 'legacy')).not.toThrow();
  });

  it('rejects null/primitive JSON with a typed IntegrityError, not a TypeError (invariant 5)', () => {
    // `JSON.parse` yields null/primitives for these — the parser must guard before dereferencing, so a
    // hostile Warm/registry store gets a typed rejection rather than an uncaught TypeError.
    for (const hostile of ['null', '5', '"x"', 'true', '[]']) {
      expect(() => parseRegistryEnvelope(hostile, 'hostile')).toThrow(IntegrityError);
    }
  });
});
