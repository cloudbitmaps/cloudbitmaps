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
/** A token in the incarnation form, built from its parts so it reads as the identifier it is. */
const SAMPLE_INCARNATION = '0123456789abcdef0123456789abcdef';
const SAMPLE_WRITE_PART = 'fedcba9876543210';

describe('registry envelope schema version (format freeze)', () => {
  const record: RegistryRecord = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: `${SAMPLE_INCARNATION}.0.${SAMPLE_WRITE_PART}`,
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
const W = 'fedcba9876543210';
/** A schema-2 token: every token this build writes has a write part. */
const T2 = `${INC}.1.${W}`;
const WRAPPED = [{ keyId: 'k', wrapped: 'd3JhcHBlZA==' }];
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

  it('refuses a schema-1 row carrying a summary or a token with a write part (IntegrityError)', () => {
    const summary = { generation: 3, cardinality: 5 };
    expect(() =>
      parseRegistryEnvelope(rowText(1, { ...baseRecord, token: '7', summary }), 'v1+summary'),
    ).toThrow(/summary/);
    for (const token of [`${INC}.0.${W}`, `8.${W}`]) {
      expect(() =>
        parseRegistryEnvelope(rowText(1, { ...baseRecord, token }), 'v1+written'),
      ).toThrow(IntegrityError);
    }
  });

  it('reads a schema-2 row with either written form, and a summary', () => {
    for (const token of [`8.${W}`, `${INC}.0.${W}`, `${INC}.12.${W}`]) {
      const env = parseRegistryEnvelope(
        rowText(2, { ...baseRecord, token, summary: { generation: 3, cardinality: 5 } }),
        token,
      );
      expect(env.record.token).toBe(token);
      expect(env.record.summary).toEqual({ generation: 3, cardinality: 5 });
    }
  });

  it('refuses a bare counter on a schema-2 row: every token this build writes has a write part', () => {
    expect(() => parseRegistryEnvelope(rowText(2, { ...baseRecord, token: '8' }), 'k')).toThrow(
      IntegrityError,
    );
  });

  it('refuses a token in no form, in either schema, naming the row (IntegrityError)', () => {
    const bad = [
      '',
      '01',
      '1e3',
      ' 5',
      '9007199254740992',
      `${INC}.0`,
      `${INC.toUpperCase()}.0.${W}`,
      `${INC.slice(1)}.0.${W}`,
      `${INC}0.0.${W}`,
      `${INC}.01.${W}`,
      `${INC}.0.${W.toUpperCase()}`,
      `${INC}.0.${W.slice(1)}`,
      `${INC}.0.${W}0`,
      `${INC}..${W}`,
      `${INC}.${W}`,
      `.${INC}.0.${W}`,
      `${INC}.9007199254740992.${W}`,
      `${INC}.0.${W}.0`,
      `08.${W}`,
      `8.${INC}`,
      `8.${W}.`,
      `9007199254740992.${W}`,
    ];
    for (const token of bad) {
      for (const v of [1, 2]) {
        expect(
          () => parseRegistryEnvelope(rowText(v, { ...baseRecord, token }), 'registry/k.reg'),
          `v${v} ${JSON.stringify(token)}`,
        ).toThrow(/: registry\/k\.reg$/);
      }
    }
  });
});

/**
 * How the token forms compare. A row 0.11 created holds a bare counter (`7`) until its first 0.12 write, which gives it
 * `<counter>.<write part>` (`8.<16 hex>`) and no incarnation; a row 0.12 creates holds
 * `<32 hex incarnation>.<counter>.<16 hex write part>`. No two forms are ever equal, and only a create starts a new
 * incarnation.
 */
describe('the registry token: its forms, and how they compare', () => {
  const rec = (token: string): RegistryRecord => ({ ...baseRecord, status: 'active', token });
  const ZEROS = '0'.repeat(16);

  it('advances a token within its incarnation, with a fresh write part every time', () => {
    const entropy = countingEntropy(1);
    expect(nextRegistryToken(rec('7'), entropy)).toBe(`8.${ZEROS.slice(0, 15)}1`);
    expect(nextRegistryToken(rec(`8.${W}`), entropy)).toBe(`9.${ZEROS.slice(0, 15)}2`);
    expect(nextRegistryToken(rec(`${INC}.7.${W}`), entropy)).toBe(
      `${INC}.8.${ZEROS.slice(0, 15)}3`,
    );
  });

  it("starts a new incarnation at create, continuing a tombstone's counter of any form", () => {
    const entropy = countingEntropy(5);
    const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
    expect(newIncarnationToken(entropy, undefined)).toBe(`${hex(5, 32)}.0.${hex(6, 16)}`);
    expect(newIncarnationToken(entropy, rec('7'))).toBe(`${hex(7, 32)}.8.${hex(8, 16)}`);
    expect(newIncarnationToken(entropy, rec(`7.${W}`))).toBe(`${hex(9, 32)}.8.${hex(10, 16)}`);
    const overBorn = newIncarnationToken(entropy, rec(`${INC}.7.${W}`));
    expect(overBorn).toBe(`${hex(11, 32)}.8.${hex(12, 16)}`);
    expect(incarnationOf(overBorn)).not.toBe(INC);
  });

  it('a restored row at an old counter is never given the token it had at that counter before', () => {
    // Two histories of one row from the same counter, as a restore from a backup makes: only the write part differs.
    const before = nextRegistryToken(rec(`${INC}.7.${W}`), countingEntropy(1));
    const after = nextRegistryToken(rec(`${INC}.7.${W}`), countingEntropy(2));
    expect(before).not.toBe(after);
    expect(incarnationOf(after)).toBe(incarnationOf(before));
  });

  it('no two forms ever compare equal, at any counter', () => {
    for (const n of [0, 1, 7, 1_000_000]) {
      const forms = [String(n), `${n}.${W}`, `${INC}.${n}.${W}`];
      expect(new Set(forms).size).toBe(3);
    }
  });

  it('incarnationOf names the incarnation of an incarnation-form token and of nothing else', () => {
    expect(incarnationOf(`${INC}.0.${W}`)).toBe(INC);
    expect(incarnationOf(`${INC}.12.${W}`)).toBe(INC);
    for (const token of [
      '7',
      '',
      `7.${W}`,
      `${INC}.0`,
      `${INC}.0.${W}x`,
      `x${INC}.0.${W}`,
      `${INC.toUpperCase()}.0.${W}`,
      `${INC.slice(1)}.0.${W}`,
      `${INC}0.0.${W}`,
      `abc.5.${W}`,
      `V1.9.${W}`,
      `${INC}.0.${W}.1`,
      `ns/${INC}.0.${W}`,
    ]) {
      expect(incarnationOf(token), JSON.stringify(token)).toBeUndefined();
    }
  });

  it('refuses an entropy source that does not give the bytes asked for (ValidationError)', () => {
    for (const bad of [new Uint8Array(15), new Uint8Array(17), [1, 2, 3], 'x'.repeat(16)]) {
      expect(() => newIncarnationToken(() => bad as Uint8Array, undefined)).toThrow(
        ValidationError,
      );
    }
    const short = (n: number): Uint8Array => new Uint8Array(n === 8 ? 7 : n);
    expect(() => nextRegistryToken(rec('7'), short)).toThrow(ValidationError);
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
    const text = rowText(2, { ...baseRecord, token: T2, summary });
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
      `"createdAt":1,"updatedAt":1,"token":"0123456789abcdef0123456789abcdef.1.fedcba9876543210","summary":{"generation":3,"cardinality":5,` +
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
      const text = rowText(2, { ...baseRecord, currentGen: generation, token: T2, summary });
      expect(() => parseRegistryEnvelope(text, 'ok'), JSON.stringify(summary)).not.toThrow();
      const keys = 'sealed' in (summary as object) ? { wrappedDeks: WRAPPED } : {};
      expect(() =>
        validateNewRegistryRecord({
          currentGen: generation,
          ...keys,
          summary: summary as RegistrySummary,
        }),
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
  const prev: RegistryRecord = { ...baseRecord, status: 'active', token: T2, summary };

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

/** A malformed summary on a stored row is refused naming the row, like every other field. */
describe('a malformed summary names its row', () => {
  it('puts the row key in the IntegrityError', () => {
    const text = rowText(2, {
      ...baseRecord,
      token: T2,
      summary: { generation: 3, cardinality: -1 },
    });
    expect(() => parseRegistryEnvelope(text, 'registry/ns/seg.reg')).toThrow(
      /summary: cardinality .*: registry\/ns\/seg\.reg$/,
    );
    const meta = rowText(2, {
      ...baseRecord,
      token: T2,
      summary: { generation: 3, cardinality: 1, metadata: { a: true } },
    });
    expect(() => parseRegistryEnvelope(meta, 'registry/ns/seg.reg')).toThrow(
      /registry\/ns\/seg\.reg$/,
    );
  });
});

/**
 * A sealed blob has one spelling: padded, standard alphabet, and the bits of its last character past the data zero,
 * so two strings never decode to the same bytes.
 */
describe('a sealed summary is canonical base64', () => {
  const sealedRow = (sealed: string): string =>
    rowText(2, { ...baseRecord, token: T2, summary: { generation: 3, sealed } });

  it('refuses non-zero pad bits and the URL-safe alphabet', () => {
    const twoPad = sealedOf(37); // 37 bytes: ends "AA==", 4 pad bits
    const onePad = sealedOf(38); // 38 bytes: ends "AAA=", 2 pad bits
    expect(twoPad.endsWith('A==')).toBe(true);
    expect(onePad.endsWith('A=')).toBe(true);
    expect(() => parseRegistryEnvelope(sealedRow(twoPad), 'ok')).not.toThrow();
    expect(() => parseRegistryEnvelope(sealedRow(onePad), 'ok')).not.toThrow();
    const bits = [
      `${twoPad.slice(0, -3)}B==`,
      `${twoPad.slice(0, -3)}P==`,
      `${onePad.slice(0, -2)}B=`,
      `${onePad.slice(0, -2)}D=`,
    ];
    for (const bad of bits) {
      expect(() => parseRegistryEnvelope(sealedRow(bad), bad), bad).toThrow(IntegrityError);
    }
    // The pad bits of a character that carries only zeros there pass.
    expect(() => parseRegistryEnvelope(sealedRow(`${twoPad.slice(0, -3)}Q==`), 'Q')).not.toThrow();
    expect(() => parseRegistryEnvelope(sealedRow(`${onePad.slice(0, -2)}E=`), 'E')).not.toThrow();
    for (const bad of [
      `${twoPad.slice(0, 4)}-${twoPad.slice(5)}`,
      `${twoPad.slice(0, 4)}_${twoPad.slice(5)}`,
    ]) {
      expect(() => parseRegistryEnvelope(sealedRow(bad), bad), bad).toThrow(IntegrityError);
    }
  });
});

/**
 * An encrypted segment's row carries a sealed summary, a cleartext one a clear summary. A write that disagrees is
 * refused; a stored row that disagrees is still read, so that one such row cannot stop every listing, and its summary
 * is one a reader must not use.
 */
describe("the summary agrees with the row's encryption", () => {
  const clear: RegistrySummary = { generation: 3, cardinality: 5 };
  const sealed: RegistrySummary = { generation: 3, sealed: sealedOf(36) };

  it('refuses a create whose summary disagrees with its keys (ValidationError)', () => {
    expect(() =>
      validateNewRegistryRecord({ currentGen: 3, wrappedDeks: WRAPPED, summary: clear }),
    ).toThrow(/clear, but the row is encrypted/);
    expect(() => validateNewRegistryRecord({ currentGen: 3, summary: sealed })).toThrow(
      /no wrapped keys/,
    );
    expect(() =>
      validateNewRegistryRecord({ currentGen: 3, wrappedDeks: WRAPPED, summary: sealed }),
    ).not.toThrow();
    expect(() => validateNewRegistryRecord({ currentGen: 3, summary: clear })).not.toThrow();
  });

  it('refuses a patch whose summary disagrees with the keys the row will have', () => {
    const plain: RegistryRecord = { ...baseRecord, status: 'active', token: T2 };
    const encrypted: RegistryRecord = { ...plain, wrappedDeks: WRAPPED };
    expect(() => applyRegistryPatch(encrypted, { summary: clear }, 2, '2')).toThrow(
      ValidationError,
    );
    expect(() => applyRegistryPatch(plain, { summary: sealed }, 2, '2')).toThrow(ValidationError);
    expect(() =>
      applyRegistryPatch(plain, { wrappedDeks: WRAPPED, summary: sealed }, 2, '2'),
    ).not.toThrow();
    expect(() =>
      applyRegistryPatch(encrypted, { wrappedDeks: undefined, summary: clear }, 2, '2'),
    ).not.toThrow();
  });

  it('drops a summary a patch leaves disagreeing with the keys, rather than refuse the patch', () => {
    // A crypto-shred that did not mention the summary must still land; the sealed one cannot be opened after it.
    const encrypted: RegistryRecord = {
      ...baseRecord,
      status: 'active',
      token: T2,
      wrappedDeks: WRAPPED,
      summary: sealed,
    };
    const shredded = applyRegistryPatch(
      encrypted,
      { wrappedDeks: undefined, status: 'destroyed' },
      2,
      '2',
    );
    expect(shredded.summary).toBeUndefined();
    expect(applyRegistryPatch(encrypted, { retention: {} }, 2, '2').summary).toEqual(sealed);
  });

  it('reads a stored row that disagrees, rather than refuse it', () => {
    const text = rowText(2, { ...baseRecord, token: T2, wrappedDeks: WRAPPED, summary: clear });
    expect(parseRegistryEnvelope(text, 'row').record.summary).toEqual(clear);
    const sealedPlain = rowText(2, { ...baseRecord, token: T2, summary: sealed });
    expect(parseRegistryEnvelope(sealedPlain, 'row').record.summary).toEqual(sealed);
  });
});

/** The summary a write stores is a frozen copy, its metadata keys in canonical order. */
describe('a written summary is a frozen, canonical copy', () => {
  it('copies, freezes and orders the metadata', () => {
    const summary = { generation: 3, cardinality: 5, metadata: { b: 1, a: 'x', '10': 2, '2': 3 } };
    const checked = validateNewRegistryRecord({ currentGen: 3, summary }).summary as {
      metadata: Record<string, unknown>;
    };
    expect(checked).not.toBe(summary);
    expect(checked.metadata).not.toBe(summary.metadata);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.metadata)).toBe(true);
    // Integer-like keys come first in numeric order, as JavaScript lists them in every object; the rest are sorted.
    expect(Object.keys(checked.metadata)).toEqual(['2', '10', 'a', 'b']);
    const patched = validateRegistryPatch({ summary }).summary as { metadata: object };
    expect(Object.isFrozen(patched)).toBe(true);
    expect(Object.keys(patched.metadata)).toEqual(['2', '10', 'a', 'b']);
  });
});
