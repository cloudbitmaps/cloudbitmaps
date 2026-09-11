import {
  applyRegistryPatch,
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
 * **A row written by an older build must still read.** The warm-tier removal dropped five fields the
 * compaction daemon used —
 * `dirtyChunkCount`, `lastCompactedAt`, `consecutiveFailures`, `leaseOwner`, `leaseExpiresAt` — from the record
 * and patch types, and with them the validation that used to police their values. What must NOT change is that
 * a stored row still *carrying* them parses: an upgrade that made every older registry row unreadable would
 * take the segment with it, since the row is the only pointer to the generation.
 *
 * The direction of the guarantee is the point, and it runs both ways: the fields are **tolerated on read** and
 * **dropped on the next write** (`applyRegistryPatch` rebuilds the record from the fields this build knows), so
 * they age out of the fleet rather than being carried forever. The conformance round-trip cannot catch a
 * regression here because a freshly created row never has them; this pins it on the shared guard directly.
 */
describe('assertStoredRecordShape — an older row with the removed daemon fields still reads', () => {
  const base = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: 't',
  };

  it('accepts a row written by this build (none of the removed fields present)', () => {
    expect(() => assertStoredRecordShape({ ...base }, 'current')).not.toThrow();
  });

  it('accepts an older row carrying every removed field', () => {
    expect(() =>
      assertStoredRecordShape(
        {
          ...base,
          dirtyChunkCount: 12,
          lastCompactedAt: 1_725_000_000_000,
          consecutiveFailures: 3,
          leaseOwner: 'host:pid:uuid',
          leaseExpiresAt: 1_725_000_060_000,
          status: 'compacting', // the transient status a daemon left behind — still a valid value, now reserved
        },
        'pre-D2',
      ),
    ).not.toThrow();
  });

  it('does not police the values of fields it no longer reads', () => {
    // A nonsensical `consecutiveFailures` was rejected while something acted on it. Nothing does now, so
    // rejecting the row would make a segment unreadable over a field with no consumer — strictly worse than
    // ignoring it. (What is still policed: `currentGen`, `status`, the wrapped DEKs and the governance blobs —
    // every field a reader actually resolves through. Those cases live below and in the conformance suite.)
    expect(() =>
      assertStoredRecordShape({ ...base, consecutiveFailures: -1, lastCompactedAt: -5 }, 'inert'),
    ).not.toThrow();
  });

  it('still rejects a row whose LIVE fields are corrupt', () => {
    expect(() => assertStoredRecordShape({ ...base, currentGen: -1 }, 'bad')).toThrow();
    expect(() => assertStoredRecordShape({ ...base, status: 'nonsense' }, 'bad')).toThrow();
    expect(() => assertStoredRecordShape({ ...base, retention: null }, 'bad')).toThrow();
  });

  it('drops the removed fields on the next write, so they age out of the fleet', () => {
    // The other half of the guarantee, and the reason "tolerated" does not mean "carried forever":
    // `applyRegistryPatch` rebuilds the record from the fields this build knows, so one ordinary CAS on a
    // older row leaves it clean. Asserted rather than described, because the merge is spelled field by field
    // and a stray `...prev` would silently reintroduce them.
    const legacy = {
      ...base,
      dirtyChunkCount: 12,
      consecutiveFailures: 3,
      leaseOwner: 'host:pid:uuid',
      leaseExpiresAt: 1,
      lastCompactedAt: 2,
    } as unknown as RegistryRecord;
    const next = applyRegistryPatch(legacy, { currentGen: 1 }, 99, '1');
    expect(next.currentGen).toBe(1);
    expect(next.createdAt).toBe(base.createdAt); // identity + audit history preserved
    for (const gone of [
      'dirtyChunkCount',
      'consecutiveFailures',
      'leaseOwner',
      'leaseExpiresAt',
      'lastCompactedAt',
    ]) {
      expect(next).not.toHaveProperty(gone);
    }
  });
});

/**
 * Registry-row schema-version stamps (a format-freeze prerequisite). The persisted envelope carries a
 * `schemaVersion` so a reader can fail-closed on a future, incompatible layout. Policy: absent → legacy v1
 * (tolerated — pre-freeze rows stay readable across the upgrade); higher → UnsupportedError; malformed →
 * IntegrityError. This pins the LocalFs/S3 envelope path; the DynamoDB body path is tested in its own suite.
 */
describe('registry envelope schema version (format freeze)', () => {
  const record: RegistryRecord = {
    segment: 's',
    currentGen: 0,
    status: 'active',
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
