import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertRegistrySchemaVersion,
  assertStoredRecordShape,
  parseRegistryEnvelope,
  RECORD_FIELDS,
  REGISTRY_SCHEMA_VERSION,
  serializeRegistryEnvelope,
  type RegistryEnvelope,
} from '@/drivers/_shared/registry';
import type { RegistryRecord } from '@/core/ports';
import { IntegrityError, UnsupportedError } from '@/core/errors';

/**
 * **A stored record carries its declared fields and nothing else.** A field no reader resolves through is refused
 * on read-back like any other corruption (invariant 5), rather than ignored, and the record type's fields are the
 * list the check holds rows to. Every value a reader resolves through is policed too.
 */
describe('assertStoredRecordShape — a stored record carries exactly its declared fields', () => {
  const base = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: 't',
  };

  it('accepts a row with the required fields, and with every optional one', () => {
    expect(() => assertStoredRecordShape({ ...base }, 'required')).not.toThrow();
    expect(() =>
      assertStoredRecordShape(
        { ...base, namespace: 'n', keyId: 'k', retention: { expiresAt: 5 }, residency: {} },
        'optional',
      ),
    ).not.toThrow();
  });

  it('refuses a field the record does not declare, naming it', () => {
    expect(() => assertStoredRecordShape({ ...base, leaseOwner: 'host' }, 'extra')).toThrow(
      IntegrityError,
    );
    expect(() => assertStoredRecordShape({ ...base, leaseOwner: 'host' }, 'extra')).toThrow(
      /leaseOwner/,
    );
  });

  it('refuses a status other than active and destroyed', () => {
    expect(() => assertStoredRecordShape({ ...base, status: 'destroyed' }, 'ok')).not.toThrow();
    for (const status of ['compacting', 'erasing', 'nonsense']) {
      expect(() => assertStoredRecordShape({ ...base, status }, status)).toThrow(IntegrityError);
    }
  });

  it('refuses a row whose resolved fields are corrupt', () => {
    expect(() => assertStoredRecordShape({ ...base, currentGen: -1 }, 'bad')).toThrow();
    expect(() => assertStoredRecordShape({ ...base, retention: null }, 'bad')).toThrow();
  });

  it('lists exactly the fields RegistryRecord declares', () => {
    const src = readFileSync(
      join(__dirname, '../../../packages/core/src/core/ports.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const own =
      /export interface RegistryRecord extends SegmentRef \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const ref = /export interface SegmentRef \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const fields = [...`${ref}\n${own}`.matchAll(/readonly\s+(\w+)\??:/g)].map((m) => m[1]).sort();
    expect(fields.length).toBeGreaterThan(5);
    expect([...RECORD_FIELDS].sort()).toEqual(fields);
  });
});

/**
 * Registry-row schema-version stamps (a format-freeze prerequisite). The persisted envelope carries a
 * `schemaVersion` so a reader can fail-closed on a future, incompatible layout. Policy: higher → UnsupportedError;
 * absent or malformed → IntegrityError, since every row this build writes carries one. This pins the envelope
 * path every registry driver shares.
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

  it('refuses a row with no schemaVersion, and an envelope field it does not declare (IntegrityError)', () => {
    const unstamped = JSON.stringify({ deleted: false, record });
    expect(() => parseRegistryEnvelope(unstamped, 'unstamped')).toThrow(IntegrityError);
    expect(() => parseRegistryEnvelope(unstamped, 'unstamped')).toThrow(/no schemaVersion/);
    const extra = JSON.stringify({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      deleted: false,
      record,
      note: 1,
    });
    expect(() => parseRegistryEnvelope(extra, 'extra')).toThrow(/note/);
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
    for (const bad of ['1', 0, -1, 1.5, null, undefined]) {
      expect(() => assertRegistrySchemaVersion(bad, 'bad')).toThrow(IntegrityError);
    }
  });

  it('rejects null/primitive JSON with a typed IntegrityError, not a TypeError (invariant 5)', () => {
    // `JSON.parse` yields null/primitives for these — the parser must guard before dereferencing, so a
    // hostile registry store gets a typed rejection rather than an uncaught TypeError.
    for (const hostile of ['null', '5', '"x"', 'true', '[]']) {
      expect(() => parseRegistryEnvelope(hostile, 'hostile')).toThrow(IntegrityError);
    }
  });
});
