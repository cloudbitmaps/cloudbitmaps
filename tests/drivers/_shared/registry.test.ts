import {
  applyRegistryPatch,
  assertRegistrySchemaVersion,
  assertStoredRecordShape,
  incarnationOf,
  newIncarnationToken,
  nextRegistryToken,
  parseRegistryEnvelope,
  RECORD_FIELDS,
  recordFromNew,
  REGISTRY_SCHEMA_VERSION,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  webCryptoEntropy,
  type RegistryEnvelope,
} from '@/drivers/_shared/registry';
import type { RegistryRecord, RegistrySummary } from '@/core/ports';

import { IntegrityError, UnsupportedError, ValidationError } from '@/core/errors';
import type { SameKeys } from '../../helpers/types';
import { countingEntropy } from '../../helpers/tokens';

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

  it('lists exactly the fields RegistryRecord declares (checked by the compiler), and the writers write those', () => {
    const agree: SameKeys<(typeof RECORD_FIELDS)[number], keyof RegistryRecord> = true;
    expect(agree).toBe(true);
    const everyField = recordFromNew(
      { namespace: 'n', segment: 's' },
      {
        currentGen: 0,
        wrappedDeks: [],
        keyId: 'k',
        status: 'active',
        retention: {},
        residency: {},
      },
      1,
      '0',
    );
    expect(Object.keys(everyField).sort()).toEqual([...RECORD_FIELDS].sort());
    const patched = applyRegistryPatch(everyField, { currentGen: 1 }, 2, '1');
    expect(Object.keys(patched).sort()).toEqual([...RECORD_FIELDS].sort());
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
    expect(() => parseRegistryEnvelope(extra, 'extra')).toThrow(IntegrityError);
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

/** A row of the given schema, as text, the way a driver would read it back. */
const rowText = (schemaVersion: number, record: Record<string, unknown>, deleted = false): string =>
  JSON.stringify({ schemaVersion, deleted, record });

const INC = '0123456789abcdef0123456789abcdef';
const baseRecord = {
  segment: 's',
  currentGen: 3,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};

/**
 * Schema 2 is read beside schema 1, never instead of it: a row 0.11 wrote is read as it was written, and holds
 * only what schema 1 could hold. Anything newer than 2 is refused, as before.
 */
describe('registry row schema 2: what each schema may hold', () => {
  it('stamps 2, and reads 1 and 2', () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(2);
    expect(assertRegistrySchemaVersion(1, 'v1')).toBe(1);
    expect(assertRegistrySchemaVersion(2, 'v2')).toBe(2);
    expect(() => assertRegistrySchemaVersion(3, 'v3')).toThrow(UnsupportedError);
  });

  it('reads a schema-1 row with its decimal token as it was written', () => {
    const env = parseRegistryEnvelope(rowText(1, { ...baseRecord, token: '7' }), 'v1');
    expect(env.record).toMatchObject({ currentGen: 3, token: '7' });
  });

  it('refuses a schema-1 row carrying a summary or an incarnation-form token (IntegrityError)', () => {
    const summary = { generation: 3, cardinality: 5 };
    expect(() =>
      parseRegistryEnvelope(rowText(1, { ...baseRecord, token: '7', summary }), 'v1+summary'),
    ).toThrow(/summary/);
    expect(() =>
      parseRegistryEnvelope(rowText(1, { ...baseRecord, token: `${INC}.0` }), 'v1+incarnation'),
    ).toThrow(IntegrityError);
  });

  it('reads a schema-2 row with either token form, and a summary', () => {
    for (const token of ['8', `${INC}.0`, `${INC}.12`]) {
      const env = parseRegistryEnvelope(
        rowText(2, { ...baseRecord, token, summary: { generation: 3, cardinality: 5 } }),
        token,
      );
      expect(env.record.token).toBe(token);
      expect(env.record.summary).toEqual({ generation: 3, cardinality: 5 });
    }
  });

  it('refuses a token in neither form, in either schema (IntegrityError)', () => {
    const bad = [
      '',
      '01',
      '1e3',
      ' 5',
      '9007199254740992',
      `${INC.toUpperCase()}.0`,
      `${INC.slice(1)}.0`,
      `${INC}0.0`,
      `${INC}.01`,
      `${INC}.`,
      `.${INC}`,
      `${INC}.9007199254740992`,
      `${INC}.0.0`,
    ];
    for (const token of bad) {
      for (const v of [1, 2]) {
        expect(
          () => parseRegistryEnvelope(rowText(v, { ...baseRecord, token }), token),
          `v${v} ${JSON.stringify(token)}`,
        ).toThrow(IntegrityError);
      }
    }
  });
});

/**
 * How a schema-1 token and a schema-2 token compare: never equal, because only the incarnation form has a `.`; a
 * row keeps the form it was born with, and only a create starts a new incarnation.
 */
describe('the registry token: a bare counter and the incarnation form', () => {
  const rec = (token: string): RegistryRecord => ({ ...baseRecord, status: 'active', token });

  it('advances a token within its form and incarnation', () => {
    expect(nextRegistryToken(rec('7'))).toBe('8');
    expect(nextRegistryToken(rec(`${INC}.7`))).toBe(`${INC}.8`);
  });

  it("starts a new incarnation at create, continuing a tombstone's counter of either form", () => {
    const entropy = countingEntropy(5);
    const fresh = newIncarnationToken(entropy, undefined);
    expect(fresh).toBe(`${'0'.repeat(30)}05.0`);
    const overLegacy = newIncarnationToken(entropy, rec('7'));
    expect(overLegacy).toBe(`${'0'.repeat(30)}06.8`);
    const overBorn = newIncarnationToken(entropy, rec(`${INC}.7`));
    expect(overBorn).toBe(`${'0'.repeat(30)}07.8`);
    expect(incarnationOf(overBorn)).not.toBe(INC);
  });

  it('a bare counter never equals an incarnation-form token, at any counter', () => {
    for (const n of [0, 1, 7, 1_000_000]) {
      expect(String(n)).not.toBe(`${INC}.${n}`);
      expect(incarnationOf(String(n))).toBeUndefined();
      expect(incarnationOf(`${INC}.${n}`)).toBe(INC);
    }
  });

  it('refuses an entropy source that does not give 16 bytes (ValidationError)', () => {
    for (const bad of [new Uint8Array(15), new Uint8Array(17), [1, 2, 3], 'x'.repeat(16)]) {
      expect(() => newIncarnationToken(() => bad as Uint8Array, undefined)).toThrow(
        ValidationError,
      );
    }
  });

  it('defaults to Web Crypto: 16 bytes, fresh every draw', () => {
    const a = webCryptoEntropy(16);
    const b = webCryptoEntropy(16);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toHaveLength(16);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

/** Base64 of `n` zero bytes: a sealed blob of that length. */
const sealedOf = (n: number): string => Buffer.alloc(n).toString('base64');
/** Metadata whose canonical JSON is exactly `n` bytes (`{"k":"…"}` is 8 bytes of frame). */
const metadataOf = (n: number): Record<string, string> => ({ k: 'x'.repeat(n - 8) });

/**
 * The summary's shape is checked like every other row field: at the write boundary (`ValidationError`) and on
 * read-back (`IntegrityError`, invariant 5). Each case is one malformed shape.
 */
describe('the summary field: every malformed shape is refused at both boundaries', () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['an array', [3, 5]],
    ['a string', 'summary'],
    ['a number', 5],
    ['no generation', { cardinality: 5 }],
    ['a negative generation', { generation: -1, cardinality: 5 }],
    ['a fractional generation', { generation: 1.5, cardinality: 5 }],
    ['a string generation', { generation: '3', cardinality: 5 }],
    ['a generation past 2^53', { generation: 2 ** 53, cardinality: 5 }],
    ['no cardinality', { generation: 3 }],
    ['a negative cardinality', { generation: 3, cardinality: -1 }],
    ['a fractional cardinality', { generation: 3, cardinality: 0.5 }],
    ['a cardinality past 2^32', { generation: 3, cardinality: 2 ** 32 + 1 }],
    ['a string cardinality', { generation: 3, cardinality: '5' }],
    ['an undeclared field', { generation: 3, cardinality: 5, note: 'x' }],
    ['a clear field beside sealed', { generation: 3, sealed: sealedOf(36), cardinality: 5 }],
    ['metadata beside sealed', { generation: 3, sealed: sealedOf(36), metadata: { a: 'b' } }],
    ['sealed not a string', { generation: 3, sealed: 36 }],
    ['sealed not base64', { generation: 3, sealed: `${sealedOf(36).slice(0, -4)}!!!!` }],
    ['sealed unpadded', { generation: 3, sealed: sealedOf(37).replace(/=+$/, '') }],
    ['sealed shorter than its fixed part', { generation: 3, sealed: sealedOf(35) }],
    ['sealed longer than metadata at its cap', { generation: 3, sealed: sealedOf(36 + 1024 + 1) }],
    ['metadata null', { generation: 3, cardinality: 5, metadata: null }],
    ['metadata an array', { generation: 3, cardinality: 5, metadata: ['a'] }],
    ['metadata empty', { generation: 3, cardinality: 5, metadata: {} }],
    ['metadata nested', { generation: 3, cardinality: 5, metadata: { a: { b: 1 } } }],
    ['metadata boolean', { generation: 3, cardinality: 5, metadata: { a: true } }],
    ['metadata null value', { generation: 3, cardinality: 5, metadata: { a: null } }],
    ['metadata empty key', { generation: 3, cardinality: 5, metadata: { '': 'v' } }],
    [
      'metadata key over 128 bytes',
      { generation: 3, cardinality: 5, metadata: { ['k'.repeat(129)]: 'v' } },
    ],
    ['metadata over 1 KiB', { generation: 3, cardinality: 5, metadata: metadataOf(1025) }],
  ];

  it.each(malformed)('refuses %s on read (IntegrityError)', (_, summary) => {
    const text = rowText(2, { ...baseRecord, token: '1', summary });
    expect(() => parseRegistryEnvelope(text, 'row')).toThrow(IntegrityError);
  });

  it.each(malformed)('refuses %s on write (ValidationError)', (_, summary) => {
    const bad = summary as RegistrySummary;
    expect(() => validateNewRegistryRecord({ currentGen: 3, summary: bad })).toThrow(
      ValidationError,
    );
    expect(() => validateRegistryPatch({ summary: bad })).toThrow(ValidationError);
  });

  it('refuses what only stored bytes can carry: a __proto__ key and a lone surrogate', () => {
    const at = (metadataJson: string): string =>
      `{"schemaVersion":2,"deleted":false,"record":{"segment":"s","currentGen":3,"status":"active",` +
      `"createdAt":1,"updatedAt":1,"token":"1","summary":{"generation":3,"cardinality":5,` +
      `"metadata":${metadataJson}}}}`;
    expect(() => parseRegistryEnvelope(at('{"a":1}'), 'ok')).not.toThrow();
    for (const bad of ['{"__proto__":"x"}', '{"\\ud800":"x"}', '{"a":"\\udc00"}']) {
      expect(() => parseRegistryEnvelope(at(bad), bad), bad).toThrow(IntegrityError);
    }
  });

  it('refuses what only a caller can pass: NaN, Infinity, symbols, class instances', () => {
    for (const metadata of [
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { [Symbol('s')]: 'x' },
      new Map([['a', 'b']]),
      new (class Meta {
        a = 'b';
      })(),
    ]) {
      const summary = { generation: 3, cardinality: 5, metadata } as unknown as RegistrySummary;
      expect(() => validateNewRegistryRecord({ currentGen: 3, summary })).toThrow(ValidationError);
    }
  });

  it('accepts each bound exactly at its edge', () => {
    const ok: unknown[] = [
      { generation: 0, cardinality: 0 },
      { generation: 3, cardinality: 2 ** 32 },
      { generation: 3, cardinality: 5, metadata: metadataOf(1024) },
      { generation: 3, cardinality: 5, metadata: { ['k'.repeat(128)]: 'v', n: -1.5 } },
      { generation: 3, cardinality: 5, metadata: { '\u65e5': '\u{1F600}' } },
      { generation: 3, sealed: sealedOf(36) },
      { generation: 3, sealed: sealedOf(36 + 1024) },
      { generation: 3, sealed: sealedOf(37) },
      { generation: 3, sealed: sealedOf(38) },
    ];
    for (const summary of ok) {
      const generation = (summary as { generation: number }).generation;
      const text = rowText(2, { ...baseRecord, currentGen: generation, token: '1', summary });
      expect(() => parseRegistryEnvelope(text, 'ok'), JSON.stringify(summary)).not.toThrow();
      expect(() =>
        validateNewRegistryRecord({ currentGen: generation, summary: summary as RegistrySummary }),
      ).not.toThrow();
    }
  });
});

/**
 * The summary describes the current generation, so it follows the pointer: a writer that moves the pointer and
 * says nothing of the summary leaves a row with none, never one describing another generation.
 */
describe('the summary follows the pointer', () => {
  const summary: RegistrySummary = { generation: 3, cardinality: 5 };
  const prev: RegistryRecord = { ...baseRecord, status: 'active', token: '1', summary };

  it('a patch that moves the pointer without a summary drops the old one', () => {
    expect(applyRegistryPatch(prev, { currentGen: 4 }, 2, '2').summary).toBeUndefined();
    expect(applyRegistryPatch(prev, { currentGen: null }, 2, '2').summary).toBeUndefined();
  });

  it('a patch that leaves the pointer where it is keeps it', () => {
    expect(applyRegistryPatch(prev, { retention: { expiresAt: 9 } }, 2, '2').summary).toEqual(
      summary,
    );
    expect(applyRegistryPatch(prev, { currentGen: 3 }, 2, '2').summary).toEqual(summary);
  });

  it("a patch can replace it with the new generation's, or clear it", () => {
    const next: RegistrySummary = { generation: 4, cardinality: 6 };
    expect(applyRegistryPatch(prev, { currentGen: 4, summary: next }, 2, '2').summary).toEqual(
      next,
    );
    expect(applyRegistryPatch(prev, { summary: undefined }, 2, '2').summary).toBeUndefined();
  });

  it('refuses a summary naming another generation than the row will point at (ValidationError)', () => {
    expect(() =>
      applyRegistryPatch(prev, { summary: { generation: 4, cardinality: 6 } }, 2, '2'),
    ).toThrow(ValidationError);
    expect(() => applyRegistryPatch(prev, { currentGen: 5, summary }, 2, '2')).toThrow(
      ValidationError,
    );
    expect(() => validateNewRegistryRecord({ currentGen: 4, summary })).toThrow(ValidationError);
    expect(() => validateNewRegistryRecord({ currentGen: null, summary })).toThrow(ValidationError);
  });
});
