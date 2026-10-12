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
import { MAX_TAIL_BYTES } from '@/core/summary';
import { usableKnownGens } from '@/core/known-generations';
import type { KnownGeneration, RegistryRecord, RegistrySummary } from '@/core/ports';

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
    pointerId: 't',
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
 * `schemaVersion` so a reader can fail-closed on a layout it does not read. Policy: this build reads schema 5 and
 * nothing else; an earlier or a later stamp is `UnsupportedError`, and an absent or malformed one `IntegrityError`, since
 * every row this build writes carries one. This pins the envelope path every registry driver shares.
 */
/** A token in the incarnation form, built from its parts so it reads as the identifier it is. */
const SAMPLE_INCARNATION = '0123456789abcdef0123456789abcdef';
const SAMPLE_WRITE_PART = 'fedcba9876543210';

describe('registry envelope schema version (format freeze)', () => {
  const token = `${SAMPLE_INCARNATION}.0.${SAMPLE_WRITE_PART}`;
  const record: RegistryRecord = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token,
    pointerId: token,
  };
  const envelope: RegistryEnvelope = { deleted: false, record };

  it('serializeRegistryEnvelope stamps the current version and round-trips through parse', () => {
    const text = serializeRegistryEnvelope(envelope);
    expect(JSON.parse(text).schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const parsed = parseRegistryEnvelope(text, 'round-trip');
    expect(parsed.deleted).toBe(false);
    expect(parsed.record.segment).toBe('s');
    expect(parsed.record.pointerId).toBe(token);
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
    expect(() => parseRegistryEnvelope(future, 'future')).toThrow(/newer/);
  });

  it('rejects a malformed schemaVersion (IntegrityError, invariant 5)', () => {
    for (const bad of ['1', '5', 0, -1, 1.5, 4.5, null, undefined]) {
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
/** A token of this build's form: every token a shipped registry writes has an incarnation and a write part. */
const TK = `${INC}.1.${W}`;
/** The fingerprint of the object a summary describes, `<size>:<footer checksum>`. */
const FP = '4096:7';
/** The bytes of that object's end one open reads. */
const TAIL = 300;
const WRAPPED = [{ keyId: 'k', wrapped: 'd3JhcHBlZA==' }];
const baseRecord = {
  segment: 's',
  currentGen: 3,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};
/** A whole schema-5 record carrying `token`, and `pointerId` the same unless given. */
const stored = (token: string, pointerId: string = token): Record<string, unknown> => ({
  ...baseRecord,
  token,
  pointerId,
});

/**
 * This build reads schema 5 alone. A row stamped 1 to 4 carries no ledger of the generations it published (and, below
 * 4, no `pointerId`), so nothing could say what it resolves to or vouches for: it is refused as a row this build does
 * not read, with a message that says what to do, and never read as empty or written over.
 */
describe('registry row schemas: only schema 5 is read', () => {
  it('stamps 5, reads 5, and refuses 1 to 4 as well as 6 (UnsupportedError)', () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(5);
    expect(assertRegistrySchemaVersion(5, 'v5')).toBe(5);
    for (const v of [1, 2, 3, 4, 6]) {
      expect(() => assertRegistrySchemaVersion(v, `v${v}`), `v${v}`).toThrow(UnsupportedError);
    }
  });

  it('refuses an earlier stamp naming the row, and saying what to do', () => {
    for (const v of [1, 2, 3, 4]) {
      const text = rowText(v, { ...baseRecord, token: v === 1 ? '7' : TK });
      expect(() => parseRegistryEnvelope(text, 'registry/k.reg')).toThrow(UnsupportedError);
      expect(() => parseRegistryEnvelope(text, 'registry/k.reg')).toThrow(/registry\/k\.reg$/);
      expect(() => parseRegistryEnvelope(text, 'registry/k.reg')).toThrow(
        new RegExp(`schemaVersion ${v}.*reads schema 5 only.*new prefix`),
      );
      // The steps are named by the changelog's entry, with no anchor: the release date is not known where this is written.
      expect(() => parseRegistryEnvelope(text, 'registry/k.reg')).toThrow(
        /steps: CHANGELOG\.md, 0\.21\.0, Breaking\)/,
      );
    }
  });

  it('refuses a stamp 4 row that carries keptGens before it reads a field of it', () => {
    const text = rowText(4, { ...stored(TK), keptGens: [1, 2] });
    expect(() => parseRegistryEnvelope(text, 'registry/k.reg')).toThrow(UnsupportedError);
  });

  it('refuses a token in any form but the incarnation form, naming the row (IntegrityError)', () => {
    const bad = [
      '',
      '7',
      `8.${W}`,
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
    ];
    for (const token of bad) {
      expect(
        () => parseRegistryEnvelope(rowText(5, stored(token)), 'registry/k.reg'),
        JSON.stringify(token),
      ).toThrow(/: registry\/k\.reg$/);
      expect(() => parseRegistryEnvelope(rowText(5, stored(token)), 'registry/k.reg')).toThrow(
        IntegrityError,
      );
    }
  });
});

/**
 * `pointerId` is held to what a shipped registry can have written (invariant 5): present, in the token's form, of the
 * row's own incarnation, and written at or before the row's token. One that names another incarnation was spliced
 * from another row, and trusting it could key a cache on another incarnation's identity.
 */
describe('a stored pointerId', () => {
  const at = (counter: number, inc = INC): string => `${inc}.${counter}.${W}`;

  it('reads one equal to the token, and one an earlier write of the incarnation set', () => {
    expect(parseRegistryEnvelope(rowText(5, stored(at(5))), 'k').record.pointerId).toBe(at(5));
    expect(parseRegistryEnvelope(rowText(5, stored(at(5), at(2))), 'k').record.pointerId).toBe(
      at(2),
    );
    expect(
      parseRegistryEnvelope(rowText(5, stored(at(5), at(5).replace(W, '0'.repeat(16)))), 'k'),
    ).toBeDefined();
  });

  it('refuses a row with none (IntegrityError)', () => {
    const without = stored(at(5));
    delete without.pointerId;
    expect(() => parseRegistryEnvelope(rowText(5, without), 'registry/k.reg')).toThrow(
      IntegrityError,
    );
    expect(() => parseRegistryEnvelope(rowText(5, without), 'registry/k.reg')).toThrow(
      /registry\/k\.reg$/,
    );
  });

  it('refuses one malformed, of another incarnation, or written after the token (IntegrityError)', () => {
    const other = 'f'.repeat(32);
    for (const pointerId of [
      7,
      null,
      '',
      '7',
      `5.${W}`,
      at(5, other),
      at(6),
      at(5).toUpperCase(),
    ]) {
      expect(
        () =>
          parseRegistryEnvelope(rowText(5, stored(at(5), pointerId as string)), 'registry/k.reg'),
        JSON.stringify(pointerId),
      ).toThrow(IntegrityError);
    }
  });
});

/**
 * How a token is made. Every token a shipped registry writes is `<32 hex incarnation>.<counter>.<16 hex write part>`:
 * only a create starts a new incarnation, every write advances the counter, and every write draws a write part.
 */
describe('the registry token: its form, and how it advances', () => {
  const rec = (token: string): RegistryRecord => ({
    ...baseRecord,
    status: 'active',
    token,
    pointerId: token,
  });
  const ZEROS = '0'.repeat(16);

  it('advances a token within its incarnation, with a fresh write part every time', () => {
    const entropy = countingEntropy(1);
    expect(nextRegistryToken(rec(`${INC}.7.${W}`), entropy)).toBe(
      `${INC}.8.${ZEROS.slice(0, 15)}1`,
    );
    expect(nextRegistryToken(rec(`${INC}.8.${W}`), entropy)).toBe(
      `${INC}.9.${ZEROS.slice(0, 15)}2`,
    );
  });

  it("starts a new incarnation at create, continuing a tombstone's counter", () => {
    const entropy = countingEntropy(5);
    const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
    expect(newIncarnationToken(entropy, undefined)).toBe(`${hex(5, 32)}.0.${hex(6, 16)}`);
    const overBorn = newIncarnationToken(entropy, rec(`${INC}.7.${W}`));
    expect(overBorn).toBe(`${hex(7, 32)}.8.${hex(8, 16)}`);
    expect(incarnationOf(overBorn)).not.toBe(INC);
  });

  it('a restored row at an old counter is never given the token it had at that counter before', () => {
    // Two histories of one row from the same counter, as a restore from a backup makes: only the write part differs.
    const before = nextRegistryToken(rec(`${INC}.7.${W}`), countingEntropy(1));
    const after = nextRegistryToken(rec(`${INC}.7.${W}`), countingEntropy(2));
    expect(before).not.toBe(after);
    expect(incarnationOf(after)).toBe(incarnationOf(before));
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
    expect(() => nextRegistryToken(rec(`${INC}.7.${W}`), short)).toThrow(ValidationError);
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
    ['no generation', { cardinality: 5, fingerprint: FP, tailBytes: TAIL }],
    ['a negative generation', { generation: -1, cardinality: 5, fingerprint: FP, tailBytes: TAIL }],
    [
      'a fractional generation',
      { generation: 1.5, cardinality: 5, fingerprint: FP, tailBytes: TAIL },
    ],
    ['a string generation', { generation: '3', cardinality: 5, fingerprint: FP, tailBytes: TAIL }],
    [
      'a generation past 2^53',
      { generation: 2 ** 53, cardinality: 5, fingerprint: FP, tailBytes: TAIL },
    ],
    ['no cardinality', { generation: 3 }],
    [
      'a negative cardinality',
      { generation: 3, cardinality: -1, fingerprint: FP, tailBytes: TAIL },
    ],
    [
      'a fractional cardinality',
      { generation: 3, cardinality: 0.5, fingerprint: FP, tailBytes: TAIL },
    ],
    [
      'a cardinality past 2^32',
      { generation: 3, cardinality: 2 ** 32 + 1, fingerprint: FP, tailBytes: TAIL },
    ],
    ['a string cardinality', { generation: 3, cardinality: '5', fingerprint: FP, tailBytes: TAIL }],
    [
      'an undeclared field',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, note: 'x' },
    ],
    ['no fingerprint', { generation: 3, cardinality: 5 }],
    [
      'a fingerprint that is a number',
      { generation: 3, cardinality: 5, fingerprint: 4096, tailBytes: TAIL },
    ],
    [
      'a fingerprint with no checksum',
      { generation: 3, cardinality: 5, fingerprint: '4096', tailBytes: TAIL },
    ],
    [
      'a fingerprint of no object (too small)',
      { generation: 3, cardinality: 5, fingerprint: '111:7', tailBytes: TAIL },
    ],
    [
      'a fingerprint past 2^53',
      { generation: 3, cardinality: 5, fingerprint: `${2 ** 53}:7`, tailBytes: TAIL },
    ],
    [
      'a checksum past 32 bits',
      { generation: 3, cardinality: 5, fingerprint: '4096:4294967296', tailBytes: TAIL },
    ],
    [
      'a fingerprint not canonical',
      { generation: 3, cardinality: 5, fingerprint: '04096:7', tailBytes: TAIL },
    ],
    [
      'a fingerprint in base 36',
      { generation: 3, cardinality: 5, fingerprint: '35s.7', tailBytes: TAIL },
    ],
    [
      'a fingerprint beside sealed',
      { generation: 3, sealed: sealedOf(52), fingerprint: FP, tailBytes: TAIL },
    ],
    [
      'a clear field beside sealed',
      { generation: 3, sealed: sealedOf(52), cardinality: 5, fingerprint: FP, tailBytes: TAIL },
    ],
    ['metadata beside sealed', { generation: 3, sealed: sealedOf(52), metadata: { a: 'b' } }],
    ['sealed not a string', { generation: 3, sealed: 36 }],
    ['sealed not base64', { generation: 3, sealed: `${sealedOf(52).slice(0, -4)}!!!!` }],
    ['sealed unpadded', { generation: 3, sealed: sealedOf(52).replace(/=+$/, '') }],
    ['sealed shorter than its fixed part', { generation: 3, sealed: sealedOf(51) }],
    ['sealed longer than metadata at its cap', { generation: 3, sealed: sealedOf(52 + 1024 + 1) }],
    [
      'metadata null',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: null },
    ],
    [
      'metadata an array',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: ['a'] },
    ],
    [
      'metadata empty',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: {} },
    ],
    [
      'metadata nested',
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { a: { b: 1 } },
      },
    ],
    [
      'metadata boolean',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: { a: true } },
    ],
    [
      'metadata null value',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: { a: null } },
    ],
    [
      'metadata empty key',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: TAIL, metadata: { '': 'v' } },
    ],
    [
      'metadata key over 128 bytes',
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { ['k'.repeat(129)]: 'v' },
      },
    ],
    [
      'metadata over 1 KiB',
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: metadataOf(1025),
      },
    ],
    ['no tailBytes', { generation: 3, cardinality: 5, fingerprint: FP }],
    [
      'a tailBytes below a footer',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 103 },
    ],
    ['a tailBytes of zero', { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 0 }],
    ['a negative tailBytes', { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: -104 }],
    [
      'a tailBytes past the size less the preamble',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 4089 },
    ],
    [
      'a tailBytes the size of the object',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 4096 },
    ],
    [
      'a fractional tailBytes',
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 300.5 },
    ],
    ['a string tailBytes', { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: '300' }],
    ['a null tailBytes', { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: null }],
    [
      'a tailBytes past the cap of one open',
      { generation: 3, cardinality: 5, fingerprint: '20000000:7', tailBytes: MAX_TAIL_BYTES + 1 },
    ],
    ['a tailBytes beside sealed', { generation: 3, sealed: sealedOf(52), tailBytes: TAIL }],
  ];

  it.each(malformed)('refuses %s on read (IntegrityError)', (_, summary) => {
    const text = rowText(5, { ...stored(TK), summary });
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
      `{"schemaVersion":5,"deleted":false,"record":{"segment":"s","currentGen":3,"status":"active",` +
      `"createdAt":1,"updatedAt":1,"token":"${TK}","pointerId":"${TK}","summary":{"generation":3,"cardinality":5,"fingerprint":"${FP}","tailBytes":${TAIL},` +
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
      const summary = {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata,
      } as unknown as RegistrySummary;
      expect(() => validateNewRegistryRecord({ currentGen: 3, summary })).toThrow(ValidationError);
    }
  });

  it('accepts each bound exactly at its edge', () => {
    const ok: unknown[] = [
      { generation: 0, cardinality: 0, fingerprint: FP, tailBytes: TAIL },
      { generation: 3, cardinality: 2 ** 32, fingerprint: FP, tailBytes: TAIL },
      // A footer's worth, the size less the preamble, and the cap of one open's tail read.
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 104 },
      { generation: 3, cardinality: 5, fingerprint: FP, tailBytes: 4088 },
      { generation: 3, cardinality: 5, fingerprint: '20000000:7', tailBytes: MAX_TAIL_BYTES },
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: metadataOf(1024),
      },
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { ['k'.repeat(128)]: 'v', n: -1.5 },
      },
      {
        generation: 3,
        cardinality: 5,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { '\u65e5': '\u{1F600}' },
      },
      { generation: 3, sealed: sealedOf(52) },
      { generation: 3, sealed: sealedOf(52 + 1024) },
      { generation: 3, sealed: sealedOf(53) },
      { generation: 3, sealed: sealedOf(54) },
    ];
    for (const summary of ok) {
      const generation = (summary as { generation: number }).generation;
      const text = rowText(5, { ...stored(TK), currentGen: generation, summary });
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
  const summary: RegistrySummary = {
    generation: 3,
    cardinality: 5,
    fingerprint: FP,
    tailBytes: TAIL,
  };
  const prev: RegistryRecord = {
    ...baseRecord,
    status: 'active',
    token: TK,
    pointerId: TK,
    summary,
  };

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
    const next: RegistrySummary = {
      generation: 4,
      cardinality: 6,
      fingerprint: FP,
      tailBytes: TAIL,
    };
    expect(applyRegistryPatch(prev, { currentGen: 4, summary: next }, 2, '2').summary).toEqual(
      next,
    );
    expect(applyRegistryPatch(prev, { summary: undefined }, 2, '2').summary).toBeUndefined();
  });

  it('refuses a summary naming another generation than the row will point at (ValidationError)', () => {
    expect(() =>
      applyRegistryPatch(
        prev,
        { summary: { generation: 4, cardinality: 6, fingerprint: FP, tailBytes: TAIL } },
        2,
        '2',
      ),
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
    const text = rowText(5, {
      ...stored(TK),
      summary: { generation: 3, cardinality: -1, fingerprint: FP, tailBytes: TAIL },
    });
    expect(() => parseRegistryEnvelope(text, 'registry/ns/seg.reg')).toThrow(
      /summary: cardinality .*: registry\/ns\/seg\.reg$/,
    );
    const meta = rowText(5, {
      ...stored(TK),
      summary: {
        generation: 3,
        cardinality: 1,
        fingerprint: FP,
        tailBytes: TAIL,
        metadata: { a: true },
      },
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
    rowText(5, { ...stored(TK), summary: { generation: 3, sealed } });

  it('refuses non-zero pad bits and the URL-safe alphabet', () => {
    const twoPad = sealedOf(52); // 52 bytes: ends "AA==", 4 pad bits
    const onePad = sealedOf(53); // 53 bytes: ends "AAA=", 2 pad bits
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
  const clear: RegistrySummary = {
    generation: 3,
    cardinality: 5,
    fingerprint: FP,
    tailBytes: TAIL,
  };
  const sealed: RegistrySummary = { generation: 3, sealed: sealedOf(52) };

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
    const plain: RegistryRecord = { ...baseRecord, status: 'active', token: TK, pointerId: TK };
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
      token: TK,
      pointerId: TK,
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
    const text = rowText(5, { ...stored(TK), wrappedDeks: WRAPPED, summary: clear });
    expect(parseRegistryEnvelope(text, 'row').record.summary).toEqual(clear);
    const sealedPlain = rowText(5, { ...stored(TK), summary: sealed });
    expect(parseRegistryEnvelope(sealedPlain, 'row').record.summary).toEqual(sealed);
  });
});

/** The summary a write stores is a frozen copy, its metadata keys in canonical order. */
describe('a written summary is a frozen, canonical copy', () => {
  it('copies, freezes and orders the metadata', () => {
    const summary = {
      generation: 3,
      cardinality: 5,
      fingerprint: FP,
      tailBytes: TAIL,
      metadata: { b: 1, a: 'x', '10': 2, '2': 3 },
    };
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

/**
 * `knownGens` is the ledger of the generations a row made current and has not decided to delete, each with its object's
 * footer checksum, in the order they were made current, the current one last. Absent means the row does not know (the
 * load lists).
 */
describe('the known generations: schema, shape and the pointer', () => {
  const MAX_WRITTEN = 192;
  const MAX_READ = 384;
  const ledger = (...gens: number[]): KnownGeneration[] =>
    gens.map((generation) => ({ generation, footerCrc: generation * 10 }));
  const range = (n: number): KnownGeneration[] => ledger(...Array.from({ length: n }, (_, i) => i));
  const prev: RegistryRecord = {
    ...baseRecord,
    status: 'active',
    token: TK,
    pointerId: TK,
    knownGens: ledger(1, 2, 3),
  };
  const row = (knownGens: unknown) => rowText(5, { ...stored(TK), knownGens });

  it('a row round-trips the ledger in the order given, and one without it reads as absent', () => {
    const text = serializeRegistryEnvelope({ deleted: false, record: prev });
    expect(JSON.parse(text).record.knownGens).toEqual(ledger(1, 2, 3));
    expect(parseRegistryEnvelope(text, 'k').record.knownGens).toEqual(ledger(1, 2, 3));
    // Not sorted: a ledger written after a rollback has the generations it left numbered above the pointer.
    const rolledBack = ledger(2, 5, 4, 3);
    expect(parseRegistryEnvelope(row(rolledBack), 'k').record.knownGens).toEqual(rolledBack);
    const none = parseRegistryEnvelope(
      serializeRegistryEnvelope({ deleted: false, record: { ...prev, knownGens: undefined } }),
      'k',
    );
    expect(none.record.knownGens).toBeUndefined();
  });

  it.each([
    ['a string', '5'],
    ['an object', {}],
    ['null', null],
    ['an entry that is a number', [3]],
    ['an entry that is null', [null]],
    ['an entry that is an array', [[3, 4]]],
    ['an entry with an extra key', [{ generation: 3, footerCrc: 1, size: 9 }]],
    ['an entry with no footerCrc', [{ generation: 3 }]],
    ['an entry with no generation', [{ footerCrc: 1 }]],
    ['a fractional generation', [{ generation: 1.5, footerCrc: 1 }]],
    ['a negative generation', [{ generation: -1, footerCrc: 1 }]],
    ['a string generation', [{ generation: '3', footerCrc: 1 }]],
    ['a generation past 2^53', [{ generation: 2 ** 53, footerCrc: 1 }]],
    ['a footerCrc of -1', [{ generation: 3, footerCrc: -1 }]],
    ['a fractional footerCrc', [{ generation: 3, footerCrc: 1.5 }]],
    ['a footerCrc of 2^32', [{ generation: 3, footerCrc: 2 ** 32 }]],
    ['a string footerCrc', [{ generation: 3, footerCrc: '7' }]],
    ['a repeated generation', [...ledger(2, 3), ...ledger(2)]],
    ['too long', range(MAX_READ + 1)],
  ])('refuses %s on a stored row, naming the row (IntegrityError)', (_name, value) => {
    expect(() => parseRegistryEnvelope(row(value), 'registry/k.reg')).toThrow(IntegrityError);
    expect(() => parseRegistryEnvelope(row(value), 'registry/k.reg')).toThrow(
      /knownGens.*: registry\/k\.reg$/,
    );
  });

  it('refuses a stored row that still carries keptGens, as a field the record does not declare', () => {
    expect(() =>
      parseRegistryEnvelope(rowText(5, { ...stored(TK), keptGens: [1, 2] }), 'registry/k.reg'),
    ).toThrow(/keptGens.*registry\/k\.reg$/);
    expect(RECORD_FIELDS).not.toContain('keptGens');
    expect(RECORD_FIELDS).toContain('knownGens');
  });

  it('reads up to 384 entries and writes at most 192', () => {
    expect(() => parseRegistryEnvelope(row(range(MAX_READ)), 'k')).not.toThrow();
    expect(() =>
      validateRegistryPatch({ currentGen: MAX_WRITTEN - 1, knownGens: range(MAX_WRITTEN) }),
    ).not.toThrow();
    expect(() =>
      validateRegistryPatch({ currentGen: MAX_WRITTEN, knownGens: range(MAX_WRITTEN + 1) }),
    ).toThrow(ValidationError);
    expect(() =>
      validateNewRegistryRecord({ currentGen: MAX_WRITTEN, knownGens: range(MAX_WRITTEN + 1) }),
    ).toThrow(ValidationError);
  });

  it('a well-formed ledger that disagrees with its row is read, and is not usable', () => {
    const stale = parseRegistryEnvelope(row(ledger(1, 5)), 'k').record; // currentGen is 3
    expect(stale.knownGens).toEqual(ledger(1, 5));
    expect(usableKnownGens(stale)).toBeUndefined();
    expect(usableKnownGens({ ...stale, knownGens: ledger(1, 2, 3) })).toEqual(ledger(1, 2, 3));
    // Entries above the pointer are legal, anywhere before the last.
    expect(usableKnownGens({ ...stale, knownGens: ledger(5, 1, 3) })).toEqual(ledger(5, 1, 3));
    expect(usableKnownGens({ ...stale, knownGens: [] })).toBeUndefined();
    expect(usableKnownGens({ ...stale, knownGens: undefined })).toBeUndefined();
    expect(usableKnownGens({ ...stale, currentGen: null, knownGens: ledger(3) })).toBeUndefined();
    expect(
      usableKnownGens({ ...stale, status: 'destroyed', knownGens: ledger(3) }),
    ).toBeUndefined();
    expect(usableKnownGens(null)).toBeUndefined();
  });

  it("a ledger whose current entry's checksum is not a clear summary's is read, and is not usable", () => {
    const summary = { generation: 3, cardinality: 5, fingerprint: '4096:30', tailBytes: TAIL };
    const agreeing = { ...prev, summary };
    expect(usableKnownGens(agreeing)).toEqual(ledger(1, 2, 3)); // generation 3's checksum is 30
    expect(
      usableKnownGens({ ...agreeing, summary: { ...summary, fingerprint: '4096:31' } }),
    ).toBeUndefined();
    // A summary of another generation, or a sealed one, is no reason to distrust the ledger.
    expect(
      usableKnownGens({
        ...agreeing,
        summary: { ...summary, generation: 2, fingerprint: '4096:31' },
      }),
    ).toEqual(ledger(1, 2, 3));
    expect(
      usableKnownGens({ ...agreeing, summary: { generation: 3, sealed: sealedOf(52) } }),
    ).toEqual(ledger(1, 2, 3));
    const text = rowText(5, {
      ...stored(TK),
      summary: { ...summary, fingerprint: '4096:31' },
      knownGens: ledger(1, 2, 3),
    });
    expect(parseRegistryEnvelope(text, 'k').record.knownGens).toEqual(ledger(1, 2, 3));
  });

  it('refuses at the write boundary a ledger that is malformed, too long, empty, on no pointer, or not ending with the pointer', () => {
    expect(() => validateNewRegistryRecord({ currentGen: 5, knownGens: ledger(1, 5, 2) })).toThrow(
      ValidationError,
    );
    expect(() => validateNewRegistryRecord({ currentGen: 5, knownGens: ledger(1, 4) })).toThrow(
      ValidationError,
    );
    expect(() => validateNewRegistryRecord({ currentGen: 5, knownGens: [] })).toThrow(
      ValidationError,
    );
    expect(() => validateNewRegistryRecord({ currentGen: null, knownGens: ledger(1) })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateNewRegistryRecord({ currentGen: 5, knownGens: [...ledger(5), ...ledger(5)] }),
    ).toThrow(/repeated/);
    expect(() =>
      validateNewRegistryRecord({
        currentGen: 5,
        knownGens: [{ generation: 5, footerCrc: 2 ** 32 }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateNewRegistryRecord({
        currentGen: 5,
        knownGens: [{ generation: 5, footerCrc: 1, note: 1 } as unknown as KnownGeneration],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateNewRegistryRecord({ currentGen: 5, knownGens: ledger(1, 4, 5) }),
    ).not.toThrow();
    expect(() =>
      validateNewRegistryRecord({ currentGen: 1, knownGens: ledger(0, 2, 3, 1) }),
    ).not.toThrow();
    // A patch is held to the pointer the row will have.
    expect(() =>
      applyRegistryPatch(prev, { currentGen: 4, knownGens: ledger(2, 3) }, 2, '2'),
    ).toThrow(ValidationError);
    expect(() => applyRegistryPatch(prev, { knownGens: ledger(1, 3, 2) }, 2, '2')).toThrow(
      ValidationError,
    );
    expect(() =>
      applyRegistryPatch(prev, { currentGen: null, knownGens: ledger(3) }, 2, '2'),
    ).toThrow(ValidationError);
    expect(
      applyRegistryPatch(prev, { currentGen: 4, knownGens: ledger(3, 4) }, 2, '2').knownGens,
    ).toEqual(ledger(3, 4));
  });

  it("refuses a current entry whose checksum disagrees with a clear summary's, given or kept from the row", () => {
    const summary = { generation: 5, cardinality: 5, fingerprint: '4096:50', tailBytes: TAIL };
    // Given in the same write: generation 5's checksum is 50 in `ledger(5)`.
    expect(() =>
      validateNewRegistryRecord({ currentGen: 5, summary, knownGens: ledger(5) }),
    ).not.toThrow();
    expect(() =>
      validateNewRegistryRecord({
        currentGen: 5,
        summary,
        knownGens: [{ generation: 5, footerCrc: 51 }],
      }),
    ).toThrow(/footerCrc 51.*another/);
    // Kept from the row: a patch that names only the ledger is held to the summary the row carries.
    const withSummary: RegistryRecord = { ...prev, currentGen: 5, summary, knownGens: ledger(5) };
    expect(() =>
      applyRegistryPatch(withSummary, { knownGens: [{ generation: 5, footerCrc: 51 }] }, 2, '2'),
    ).toThrow(ValidationError);
    expect(applyRegistryPatch(withSummary, { knownGens: ledger(4, 5) }, 2, '2').knownGens).toEqual(
      ledger(4, 5),
    );
    // A sealed summary cannot be compared by a registry, so any checksum is accepted beside one.
    expect(() =>
      validateNewRegistryRecord({
        currentGen: 3,
        wrappedDeks: WRAPPED,
        summary: { generation: 3, sealed: sealedOf(52) },
        knownGens: [{ generation: 3, footerCrc: 99 }],
      }),
    ).not.toThrow();
    // A patch that names the summary but not the ledger is not held to it: the ledger is then read and not used.
    const changed = applyRegistryPatch(
      { ...withSummary, summary: undefined },
      { summary: { ...summary, fingerprint: '4096:51' } },
      2,
      '2',
    );
    expect(usableKnownGens(changed)).toBeUndefined();
  });

  it('a patch that moves the pointer without the ledger drops it; one that leaves the pointer keeps it', () => {
    expect(applyRegistryPatch(prev, { currentGen: 4 }, 2, '2').knownGens).toBeUndefined();
    expect(applyRegistryPatch(prev, { currentGen: null }, 2, '2').knownGens).toBeUndefined();
    expect(applyRegistryPatch(prev, { retention: { expiresAt: 9 } }, 2, '2').knownGens).toEqual(
      ledger(1, 2, 3),
    );
    expect(applyRegistryPatch(prev, { currentGen: 3 }, 2, '2').knownGens).toEqual(ledger(1, 2, 3));
    // A crypto-shred leaves the pointer, so the patch that clears the ledger must say so.
    expect(applyRegistryPatch(prev, { status: 'destroyed' }, 2, '2').knownGens).toEqual(
      ledger(1, 2, 3),
    );
    expect(
      applyRegistryPatch(prev, { status: 'destroyed', knownGens: undefined }, 2, '2').knownGens,
    ).toBeUndefined();
  });

  it('a patch can name the ledger with the move, replace it, or clear it', () => {
    expect(
      applyRegistryPatch(prev, { currentGen: 4, knownGens: ledger(2, 3, 4) }, 2, '2').knownGens,
    ).toEqual(ledger(2, 3, 4));
    expect(applyRegistryPatch(prev, { knownGens: ledger(2, 3) }, 2, '2').knownGens).toEqual(
      ledger(2, 3),
    );
    expect(applyRegistryPatch(prev, { knownGens: undefined }, 2, '2').knownGens).toBeUndefined();
  });

  it('naming the ledger alone does not renew the pointerId, and naming it beside the pointer does', () => {
    expect(applyRegistryPatch(prev, { knownGens: ledger(2, 3) }, 2, '2').pointerId).toBe(TK);
    expect(
      applyRegistryPatch(prev, { currentGen: 4, knownGens: ledger(3, 4) }, 2, '2').pointerId,
    ).toBe('2');
  });

  it('writes a frozen copy: changing the caller array or an entry afterwards changes nothing written', () => {
    const mine = ledger(1, 2);
    const checked = validateRegistryPatch({ knownGens: mine });
    mine.push({ generation: 9, footerCrc: 1 });
    expect(checked.knownGens).toEqual(ledger(1, 2));
    const created = validateNewRegistryRecord({ currentGen: 9, knownGens: mine });
    (mine[0] as { footerCrc: number }).footerCrc = 7;
    mine.length = 0;
    expect(created.knownGens).toEqual([...ledger(1, 2), { generation: 9, footerCrc: 1 }]);
    expect(Object.isFrozen(created.knownGens)).toBe(true);
    expect(Object.isFrozen(created.knownGens?.[0])).toBe(true);
  });

  it('recordFromNew carries the ledger', () => {
    const made = recordFromNew({ segment: 's' }, { currentGen: 5, knownGens: ledger(4, 5) }, 1, TK);
    expect(made.knownGens).toEqual(ledger(4, 5));
  });
});

/**
 * `leases` is the holds on a segment's generations, recorded in the row so a load's collection spares them. It joins
 * schema 3 beside `knownGens`, so a build that does not declare it refuses the row, and unlike `knownGens` it does not
 * follow the pointer.
 */
describe('the leases: schema, shape and the pointer', () => {
  const H1 = '00112233aabbccdd';
  const H2 = 'ffeeddcc99887766';
  const entry = (holder: string, generation: number, until: number) => ({
    holder,
    generation,
    until,
  });
  const prev: RegistryRecord = {
    ...baseRecord,
    status: 'active',
    token: TK,
    pointerId: TK,
    leases: [entry(H1, 1, 1000)],
  };
  const row = (leases: unknown) => rowText(5, { ...stored(TK), leases });

  it('a row round-trips the list, and one without it reads as absent', () => {
    const text = serializeRegistryEnvelope({ deleted: false, record: prev });
    expect(parseRegistryEnvelope(text, 'k').record.leases).toEqual([entry(H1, 1, 1000)]);
    expect(parseRegistryEnvelope(row([]), 'k').record.leases).toEqual([]);
    const none = parseRegistryEnvelope(
      serializeRegistryEnvelope({ deleted: false, record: { ...prev, leases: undefined } }),
      'k',
    );
    expect(none.record.leases).toBeUndefined();
  });

  it.each([
    ['a string', '5'],
    ['null', null],
    ['an entry that is a number', [5]],
    ['an entry that is null', [null]],
    ['an extra entry key', [{ ...entry(H1, 1, 5), fingerprint: '1:2' }]],
    ['a missing key', [{ holder: H1, generation: 1 }]],
    ['an upper-case holder', [entry(H1.toUpperCase(), 1, 5)]],
    ['a 15-digit holder', [entry(H1.slice(1), 1, 5)]],
    ['a 17-digit holder', [entry(`${H1}0`, 1, 5)]],
    ['a non-hex holder', [entry('zz112233aabbccdd', 1, 5)]],
    ['a duplicate holder', [entry(H1, 1, 5), entry(H1, 2, 6)]],
    ['a negative generation', [entry(H1, -1, 5)]],
    ['a fractional generation', [entry(H1, 1.5, 5)]],
    ['a negative until', [entry(H1, 1, -5)]],
    ['a fractional until', [entry(H1, 1, 5.5)]],
    ['an until past 2^53', [entry(H1, 1, 2 ** 53)]],
    ['a string until', [{ holder: H1, generation: 1, until: '5' }]],
    [
      'too long',
      Array.from({ length: 257 }, (_, i) => entry(i.toString(16).padStart(16, '0'), 1, 5)),
    ],
  ])('refuses %s on a stored row, naming the row (IntegrityError)', (_name, value) => {
    expect(() => parseRegistryEnvelope(row(value), 'registry/k.reg')).toThrow(IntegrityError);
    expect(() => parseRegistryEnvelope(row(value), 'registry/k.reg')).toThrow(
      /leases.*: registry\/k\.reg$/,
    );
  });

  it('reads up to 256 entries and writes at most 64', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => entry(i.toString(16).padStart(16, '0'), 1, 5));
    expect(() => parseRegistryEnvelope(row(many(256)), 'k')).not.toThrow();
    expect(() => validateRegistryPatch({ leases: many(256) })).not.toThrow();
    expect(() => validateRegistryPatch({ leases: many(257) })).toThrow(ValidationError);
    // A write is held to 64 against the row it patches, except that a list may always shrink.
    const at = (n: number): RegistryRecord => ({ ...prev, leases: many(n) });
    expect(applyRegistryPatch(at(0), { leases: many(64) }, 2, '2').leases).toHaveLength(64);
    expect(() => applyRegistryPatch(at(0), { leases: many(65) }, 2, '2')).toThrow(ValidationError);
    expect(() => applyRegistryPatch(at(64), { leases: many(65) }, 2, '2')).toThrow(ValidationError);
    expect(applyRegistryPatch(at(100), { leases: many(99) }, 2, '2').leases).toHaveLength(99);
    expect(applyRegistryPatch(at(100), { leases: many(100) }, 2, '2').leases).toHaveLength(100);
    expect(() => applyRegistryPatch(at(100), { leases: many(101) }, 2, '2')).toThrow(
      ValidationError,
    );
  });

  it('refuses at the write boundary a malformed entry, and a list on a row with no pointer', () => {
    expect(() => validateRegistryPatch({ leases: [entry('nothex', 1, 5)] })).toThrow(
      ValidationError,
    );
    expect(() => validateRegistryPatch({ leases: [entry(H1, 1, 5), entry(H1, 1, 6)] })).toThrow(
      ValidationError,
    );
    expect(() =>
      applyRegistryPatch(prev, { currentGen: null, leases: [entry(H1, 1, 5)] }, 2, '2'),
    ).toThrow(ValidationError);
  });

  it('writes an empty list as none, and a frozen copy of any other', () => {
    expect(validateRegistryPatch({ leases: [] }).leases).toBeUndefined();
    expect('leases' in validateRegistryPatch({ leases: [] })).toBe(true);
    const mine = [entry(H1, 1, 5)];
    const checked = validateRegistryPatch({ leases: mine });
    mine.push(entry(H2, 2, 6));
    expect(checked.leases).toEqual([entry(H1, 1, 5)]);
    expect(Object.isFrozen(checked.leases)).toBe(true);
    expect(Object.isFrozen(checked.leases?.[0])).toBe(true);
  });

  it('does not follow the pointer: a move keeps the list, and only a patch that names it changes it', () => {
    const moved = applyRegistryPatch(prev, { currentGen: 4 }, 2, '2');
    expect(moved.leases).toEqual([entry(H1, 1, 1000)]);
    expect(
      applyRegistryPatch(
        prev,
        { currentGen: 4, knownGens: [{ generation: 4, footerCrc: 4 }] },
        2,
        '2',
      ).leases,
    ).toEqual([entry(H1, 1, 1000)]);
    expect(applyRegistryPatch(prev, { retention: { expiresAt: 9 } }, 2, '2').leases).toEqual([
      entry(H1, 1, 1000),
    ]);
    expect(applyRegistryPatch(prev, { leases: undefined }, 2, '2').leases).toBeUndefined();
    expect(applyRegistryPatch(prev, { leases: [entry(H2, 3, 5)] }, 2, '2').leases).toEqual([
      entry(H2, 3, 5),
    ]);
  });

  it('a new row carries no leases', () => {
    expect(recordFromNew({ segment: 's' }, { currentGen: 5 }, 1, TK).leases).toBeUndefined();
  });
});

describe('a registry generation is a safe integer', () => {
  const row = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: '0',
    pointerId: '0',
  };
  const UNSAFE = [2 ** 53, 2 ** 53 + 2, 1e21];

  it('the largest safe generation is accepted, on the write and the read boundary', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() => validateNewRegistryRecord({ currentGen: max })).not.toThrow();
    expect(() => validateRegistryPatch({ currentGen: max })).not.toThrow();
    expect(() => assertStoredRecordShape({ ...row, currentGen: max }, 'ok')).not.toThrow();
  });

  it.each(UNSAFE)('%s is refused when written, as a new row or a patch', (gen) => {
    expect(() => validateNewRegistryRecord({ currentGen: gen })).toThrow(ValidationError);
    expect(() => validateRegistryPatch({ currentGen: gen })).toThrow(ValidationError);
  });

  it.each(UNSAFE)('%s is refused when a stored row is read back', (gen) => {
    expect(() => assertStoredRecordShape({ ...row, currentGen: gen }, 'bad')).toThrow(
      IntegrityError,
    );
  });
});

describe('registry validators: a bad wrappedDeks list is a ValidationError from a caller and an IntegrityError from stored bytes', () => {
  const bad: unknown[] = [
    [],
    'not-an-array',
    [{ keyId: '', wrapped: 'w' }],
    [{ keyId: 'k', wrapped: '' }],
  ];
  const classOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      if (err instanceof IntegrityError) return 'integrity';
      if (err instanceof ValidationError) return 'validation';
      throw err;
    }
    return 'accepted';
  };
  it.each(bad.map((b) => [JSON.stringify(b), b] as const))('%s', (_label, wrappedDeks) => {
    expect(classOf(() => validateNewRegistryRecord({ currentGen: 0, wrappedDeks } as never))).toBe(
      'validation',
    );
    expect(classOf(() => validateRegistryPatch({ wrappedDeks } as never))).toBe('validation');
    expect(classOf(() => assertStoredRecordShape({ ...stored(TK), wrappedDeks }, 'row'))).toBe(
      'integrity',
    );
  });
});
