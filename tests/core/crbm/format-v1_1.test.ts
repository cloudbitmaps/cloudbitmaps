import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { BufferReader, BufferSink } from '@/core/blob';
import { crc32c } from '@/core/crbm/crc32c';
import { CrbmReader, parseExtension } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import {
  EXT_MAGIC,
  EXT_SECTION_METADATA,
  EXT_TRAILER_BYTES,
  FOOTER,
  FOOTER_BYTES,
  FOOTER_CRC_COVERAGE,
  MAX_EXT_BYTES,
  PAYLOAD_START,
  VERSION_MINOR,
  VERSION_MINOR_EXTENSION,
} from '@/core/crbm/format';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { IntegrityError, ValidationError } from '@/core/errors';
import { MAX_METADATA_BYTES } from '@/core/metadata';
import { NodeAead } from '@/drivers/crypto';
import {
  CountingReader,
  extensionBlock,
  layoutOf,
  section,
  spliceBlock,
  utf8,
  writeCrbm,
  type RawChunk,
} from '../../helpers/crbm-v1_1';

/**
 * Format 1.1: the extension block that carries a generation's metadata. What the writer emits, that an object
 * without metadata stays format 1.0 byte for byte, the reads a reader makes for the block, and that every malformed
 * trailer, block, section and metadata record is refused with `IntegrityError` (hard invariant 5).
 */
const CHUNKS: RawChunk[] = [
  { chunkKey: 0, payload: Uint8Array.of(1, 2, 3, 4), cardinality: 2 },
  { chunkKey: 5, payload: Uint8Array.of(9, 8, 7), cardinality: 1 },
  { chunkKey: 65_535, payload: Uint8Array.of(255, 0, 128, 64, 32), cardinality: 4 },
];
const META = { def: 'v41', landedAt: 1_790_000_000_000 };
const META_JSON = '{"def":"v41","landedAt":1790000000000}';
const GEN = 7;
const REF = { namespace: 'ns', segment: 'seg' };

const cryptoFor = (dek: Uint8Array, generation = GEN): CrbmCrypto => ({
  aead: new NodeAead(dek),
  aadFor: (scope) => aadFor(REF, generation, scope),
});

const open = (bytes: Uint8Array, crypto?: CrbmCrypto): Promise<CrbmReader> =>
  CrbmReader.open(new BufferReader(bytes), { crypto });

/** Metadata whose canonical JSON is exactly `n` bytes: `{"k":"…"}` is 8 bytes around the value. */
const metadataOf = (n: number): Record<string, string> => ({ k: 'x'.repeat(n - 8) });

describe('.crbm 1.1 writer', () => {
  it('writes format 1.0 byte for byte when there is no metadata, or only the empty object', async () => {
    const none = await writeCrbm(CHUNKS, { generation: GEN });
    expect(layoutOf(none).versionMinor).toBe(VERSION_MINOR);
    expect(await writeCrbm(CHUNKS, { generation: GEN, metadata: undefined })).toEqual(none);
    expect(await writeCrbm(CHUNKS, { generation: GEN, metadata: {} })).toEqual(none);
    expect((await open(none)).metadata).toBeUndefined();
  });

  it('writes minor 1 and the block between the last payload and the index, where the spec places it', async () => {
    const bytes = await writeCrbm(CHUNKS, { generation: GEN, metadata: META });
    const { indexOffset, versionMinor } = layoutOf(bytes);
    expect(versionMinor).toBe(VERSION_MINOR_EXTENSION);
    expect(bytes[5]).toBe(VERSION_MINOR_EXTENSION); // the preamble agrees

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const payloadEnd = PAYLOAD_START + 4 + 3 + 5;
    const json = utf8(META_JSON);
    const sectionsLength = 5 + json.length;
    // trailer: u32 sectionsLength ‖ u32 crc32c(sections ‖ sectionsLength) ‖ "CRBX", ending where the index starts
    expect(indexOffset).toBe(payloadEnd + sectionsLength + EXT_TRAILER_BYTES);
    expect(view.getUint32(indexOffset - 12, true)).toBe(sectionsLength);
    expect(view.getUint32(indexOffset - 8, true)).toBe(
      crc32c(bytes.subarray(payloadEnd, indexOffset - 8)),
    );
    expect([...bytes.subarray(indexOffset - 4, indexOffset)]).toEqual([...EXT_MAGIC]);
    // one section: u8 type ‖ u32 length ‖ the canonical JSON
    expect(bytes[payloadEnd]).toBe(EXT_SECTION_METADATA);
    expect(view.getUint32(payloadEnd + 1, true)).toBe(json.length);
    expect(
      new TextDecoder().decode(bytes.subarray(payloadEnd + 5, payloadEnd + 5 + json.length)),
    ).toBe(META_JSON);
  });

  it('a reader weighs what it holds: its index, and twice the metadata it decoded', async () => {
    const plain = await open(await writeCrbm(CHUNKS, { generation: GEN }));
    const withMeta = await open(await writeCrbm(CHUNKS, { generation: GEN, metadata: META }));
    expect(plain.retainedBytes).toBe(plain.retainedIndexBytes);
    expect(withMeta.retainedIndexBytes).toBe(plain.retainedIndexBytes);
    expect(withMeta.retainedBytes).toBe(plain.retainedIndexBytes + 2 * utf8(META_JSON).length);
  });

  it('round-trips the metadata, frozen, and key order never changes the bytes', async () => {
    const a = await writeCrbm(CHUNKS, { generation: GEN, metadata: META });
    const b = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: { landedAt: META.landedAt, def: META.def },
    });
    expect(b).toEqual(a);
    const reader = await open(a);
    expect(reader.metadata).toEqual(META);
    expect(Object.isFrozen(reader.metadata)).toBe(true);
    expect(reader.chunkKeys()).toEqual([0, 5, 65_535]);
    expect(reader.count()).toBe(7);
    for (const c of CHUNKS)
      expect([...(await reader.getChunk(c.chunkKey))!]).toEqual([...c.payload]);
  });

  it('refuses metadata that breaks a rule from the constructor, before a byte is written', () => {
    const writes: Uint8Array[] = [];
    const sink = { write: async (b: Uint8Array) => void writes.push(b) };
    for (const metadata of [
      { a: true },
      { a: null },
      { a: { b: 1 } },
      { a: Number.NaN },
      { a: Infinity },
      { a: '\uD800' },
      { '': 'v' },
      ['a'],
      new Map([['a', 'b']]),
      metadataOf(MAX_METADATA_BYTES + 1),
    ]) {
      expect(() => new CrbmWriter(sink, { generation: GEN, metadata: metadata as never })).toThrow(
        ValidationError,
      );
    }
    expect(writes).toEqual([]);
  });

  it('copies the metadata when constructed: a later change to the caller object never reaches the object', async () => {
    const caller: Record<string, string> = { def: 'v41' };
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: GEN, metadata: caller });
    caller.def = 'changed';
    caller.extra = 'added';
    for (const c of CHUNKS) await writer.addChunk(c.chunkKey, c.payload, c.cardinality);
    await writer.finish();
    expect((await open(sink.bytes())).metadata).toEqual({ def: 'v41' });
  });

  it('the cap: canonical JSON of exactly 1 KiB is written and read back, one byte more is refused', async () => {
    const atCap = metadataOf(MAX_METADATA_BYTES);
    expect(JSON.stringify(atCap).length).toBe(MAX_METADATA_BYTES);
    const bytes = await writeCrbm(CHUNKS, { generation: GEN, metadata: atCap });
    expect((await open(bytes)).metadata).toEqual(atCap);
    expect(
      () => new CrbmWriter(new BufferSink(), { generation: GEN, metadata: metadataOf(1025) }),
    ).toThrow(/1025B as canonical JSON, over the 1024B cap/);

    // and a stored section one byte over the cap is refused on read, before it is decoded
    const base = await writeCrbm(CHUNKS, { generation: GEN });
    const over = utf8(JSON.stringify(metadataOf(MAX_METADATA_BYTES + 1)));
    const hostile = spliceBlock(base, extensionBlock(section(EXT_SECTION_METADATA, over)));
    await expect(open(hostile)).rejects.toThrow(/1025B, over the 1024B cap/);
  });
});

describe('.crbm 1.1 round trip, over generated metadata', () => {
  // Keys and string values drawn from the whole of Unicode, lone surrogates excluded by the rules themselves;
  // numbers from every finite double, -0 included (canonical JSON writes it as 0).
  const text = fc.string({ unit: 'grapheme', maxLength: 12 });
  const record = fc.dictionary(
    text.filter((k) => k.length > 0 && k !== '__proto__'),
    fc.oneof(text, fc.double({ noNaN: true, noDefaultInfinity: true })),
    { minKeys: 1, maxKeys: 12 },
  );
  const fits = (m: Record<string, unknown>): boolean =>
    utf8(JSON.stringify(m)).length <= MAX_METADATA_BYTES &&
    Object.keys(m).every((k) => utf8(k).length <= 128);

  it('what is written is what is read, whatever order the keys came in, cleartext and encrypted', async () => {
    const dek = randomBytes(32);
    await fc.assert(
      fc.asyncProperty(record.filter(fits), async (metadata) => {
        const expected = JSON.parse(JSON.stringify(metadata)) as unknown;
        const reversed = Object.fromEntries(Object.entries(metadata).reverse());
        const a = await writeCrbm(CHUNKS, { generation: GEN, metadata });
        expect(await writeCrbm(CHUNKS, { generation: GEN, metadata: reversed })).toEqual(a);
        expect((await open(a)).metadata).toEqual(expected);
        const sealed = await writeCrbm(CHUNKS, {
          generation: GEN,
          metadata,
          crypto: cryptoFor(dek),
        });
        expect((await open(sealed, cryptoFor(dek))).metadata).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });
});

describe('.crbm 1.1 reader: the reads it makes', () => {
  it('reads the block from the tail, in the one request that reads the index', async () => {
    const counting = new CountingReader(
      await writeCrbm(CHUNKS, { generation: GEN, metadata: META }),
    );
    const reader = await CrbmReader.open(counting);
    expect(reader.metadata).toEqual(META);
    expect(reader.servedFromTail).toBe(true);
    expect([counting.tails, counting.ranges]).toEqual([1, 0]);
  });

  it('reads it with the index in one range read when the index is past the tail', async () => {
    const counting = new CountingReader(
      await writeCrbm(CHUNKS, { generation: GEN, metadata: META }),
    );
    const reader = await CrbmReader.open(counting, { tailBytes: FOOTER_BYTES });
    expect(reader.metadata).toEqual(META);
    expect(reader.servedFromTail).toBe(false);
    expect([counting.tails, counting.ranges]).toEqual([1, 1]);
  });

  it('makes one read more when the tail ends inside the block or inside its trailer, never two', async () => {
    const bytes = await writeCrbm(CHUNKS, { generation: GEN, metadata: META });
    const { indexOffset } = layoutOf(bytes);
    const fromIndex = bytes.length - indexOffset;
    // the tail starts 2 bytes before the index (inside the trailer), then 20 bytes before it (inside the sections)
    for (const before of [2, 20]) {
      const counting = new CountingReader(bytes);
      const reader = await CrbmReader.open(counting, { tailBytes: fromIndex + before });
      expect(reader.metadata).toEqual(META);
      expect(reader.servedFromTail).toBe(false);
      expect([counting.tails, counting.ranges]).toEqual([1, 1]);
    }
  });

  it('a 1.0 object costs what it did: no read for a block it does not have', async () => {
    const counting = new CountingReader(await writeCrbm(CHUNKS, { generation: GEN }));
    await CrbmReader.open(counting, { tailBytes: FOOTER_BYTES });
    expect([counting.tails, counting.ranges]).toEqual([1, 1]);
  });
});

describe('.crbm 1.1 reader: a malformed trailer or block is refused', () => {
  const json = utf8(META_JSON);
  const good = section(EXT_SECTION_METADATA, json);

  it('accepts the hand-built block the cases below forge (sanity for the splicer)', async () => {
    const base = await writeCrbm(CHUNKS, { generation: GEN });
    expect((await open(spliceBlock(base, extensionBlock(good)))).metadata).toEqual(META);
  });

  const trailerCases: Array<[string, (base: Uint8Array) => Uint8Array, RegExp]> = [
    [
      'the wrong magic',
      (b) => spliceBlock(b, extensionBlock(good, { magic: utf8('CRBM') })),
      /trailer magic/,
    ],
    [
      'a CRC that does not match',
      (b) => spliceBlock(b, extensionBlock(good, { crc: 0xdeadbeef })),
      /CRC mismatch/,
    ],
    [
      'a length over the 4 KiB cap',
      (b) => spliceBlock(b, extensionBlock(good, { sectionsLength: MAX_EXT_BYTES + 1 })),
      /exceeds cap 4096B/,
    ],
    [
      'a length reaching back before the payloads',
      (b) => spliceBlock(b, extensionBlock(good, { sectionsLength: 4000 })),
      /out of bounds/,
    ],
    [
      'a length one byte short of the sections (so the CRC covers other bytes)',
      (b) => spliceBlock(b, extensionBlock(good, { sectionsLength: good.length - 1 })),
      /CRC mismatch|section/,
    ],
    ['minor 1 with no block at all', (b) => spliceBlock(b, new Uint8Array(0)), /trailer magic/],
  ];
  it.each(trailerCases)('refuses %s', async (_name, forge, message) => {
    const hostile = forge(await writeCrbm(CHUNKS, { generation: GEN }));
    await expect(open(hostile)).rejects.toBeInstanceOf(IntegrityError);
    await expect(open(hostile)).rejects.toThrow(message);
  });

  it('refuses minor 1 when the index starts too close to the payloads to have a trailer', async () => {
    const tiny = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: GEN,
    });
    const minorOnly = spliceBlock(tiny, new Uint8Array(0));
    await expect(open(minorOnly)).rejects.toThrow(/no room for its extension block/);
  });

  it('refuses a preamble whose minor disagrees with the footer', async () => {
    const bytes = await writeCrbm(CHUNKS, { generation: GEN, metadata: META });
    bytes[5] = 0;
    await expect(open(bytes)).rejects.toThrow(/preamble magic\/version mismatch/);
  });

  it('holds payloads to the bytes before the block', async () => {
    // Cut the last 3 bytes of the last payload and put the block there: the index still says that payload is
    // 5 bytes long, so it now runs 3 bytes into the block. A 1.0 reader would fetch them as payload; this one
    // refuses the index at open.
    const base = await writeCrbm(CHUNKS, { generation: GEN });
    const { indexOffset } = layoutOf(base);
    const cut = new Uint8Array(base.length - 3);
    cut.set(base.subarray(0, indexOffset - 3), 0);
    cut.set(base.subarray(indexOffset), indexOffset - 3);
    const overlapping = spliceBlock(withIndexAt(cut, indexOffset - 3), extensionBlock(good));
    await expect(open(overlapping)).rejects.toThrow(/chunk 65535 payload out of bounds/);
  });
});

describe('.crbm 1.1 reader: a malformed section or metadata record is refused', () => {
  const sectionCases: Array<[string, Uint8Array, RegExp]> = [
    ['a cut-off section header', Uint8Array.of(1, 0, 0), /section header is cut off/],
    ['a section running past the block', section(1, utf8(META_JSON), 999), /runs past the block/],
    ['section type 0', section(0, utf8('x')), /type 0 is not a section type/],
    [
      'a metadata section listed twice',
      concat(section(1, utf8(META_JSON)), section(1, utf8(META_JSON))),
      /section type 1 after 1/,
    ],
    [
      'sections out of type order',
      concat(section(7, utf8('later')), section(1, utf8(META_JSON))),
      /section type 1 after 7/,
    ],
    ['metadata that is not UTF-8', section(1, Uint8Array.of(0x7b, 0xff, 0x7d)), /not valid UTF-8/],
    ['metadata that is not JSON', section(1, utf8('{"a":')), /not JSON/],
    ['an empty record', section(1, utf8('{}')), /empty/],
    ['whitespace', section(1, utf8('{"a": 1}')), /not in canonical form/],
    ['keys out of order', section(1, utf8('{"b":1,"a":2}')), /not in canonical form/],
    ['a key listed twice', section(1, utf8('{"a":1,"a":1}')), /not in canonical form/],
    ['a number written another way', section(1, utf8('{"a":1.0}')), /not in canonical form/],
    ['an escape written another way', section(1, utf8('{"a":"\\u0041"}')), /not in canonical form/],
    ['a byte-order mark', section(1, utf8('﻿{"a":1}')), /not JSON/],
    ['an array', section(1, utf8('["a"]')), /plain object/],
    ['a string', section(1, utf8('"a"')), /plain object/],
    ['null', section(1, utf8('null')), /plain object/],
    ['a nested value', section(1, utf8('{"a":{"b":1}}')), /string or a finite number/],
    ['a boolean value', section(1, utf8('{"a":true}')), /string or a finite number/],
    ['a null value', section(1, utf8('{"a":null}')), /string or a finite number/],
    [
      'a number too large for a double',
      section(1, utf8('{"a":1e400}')),
      /string or a finite number/,
    ],
    ['a lone surrogate', section(1, utf8('{"a":"\\ud800"}')), /well-formed/],
    ['the key __proto__', section(1, utf8('{"__proto__":1}')), /__proto__/],
    ['an empty key', section(1, utf8('{"":1}')), /non-empty/],
    ['a key over 128 bytes', section(1, utf8(`{"${'k'.repeat(129)}":1}`)), /over the 128B cap/],
  ];
  it.each(sectionCases)('refuses %s', async (_name, sections, message) => {
    expect(() => parseExtension(sections, undefined)).toThrow(IntegrityError);
    expect(() => parseExtension(sections, undefined)).toThrow(message);
    // and through a whole object, CRC intact, which is what a reader meets
    const hostile = spliceBlock(
      await writeCrbm(CHUNKS, { generation: GEN }),
      extensionBlock(sections),
    );
    await expect(open(hostile)).rejects.toThrow(message);
  });

  it('skips a section type it does not know, before or after the metadata', async () => {
    const meta = section(1, utf8(META_JSON));
    expect(parseExtension(concat(meta, section(200, utf8('a later minor'))), undefined)).toEqual(
      META,
    );
    expect(parseExtension(section(9, new Uint8Array(0)), undefined)).toBeUndefined();
    expect(parseExtension(new Uint8Array(0), undefined)).toBeUndefined();
    const base = await writeCrbm(CHUNKS, { generation: GEN });
    const later = spliceBlock(base, extensionBlock(concat(meta, section(2, randomBytes(64)))), 2);
    const reader = await open(later);
    expect(reader.metadata).toEqual(META);
    expect(reader.count()).toBe(7);
  });
});

describe('.crbm 1.1 on an encrypted object', () => {
  it('seals the metadata like the index: no plaintext in the object, read back with the key', async () => {
    const dek = randomBytes(32);
    const bytes = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: META,
      crypto: cryptoFor(dek),
    });
    const raw = Buffer.from(bytes);
    expect(raw.includes(Buffer.from('v41'))).toBe(false);
    expect(raw.includes(Buffer.from('landedAt'))).toBe(false);
    expect((await open(bytes, cryptoFor(dek))).metadata).toEqual(META);
  });

  it('writes no block for no metadata, as on a cleartext object', async () => {
    const dek = randomBytes(32);
    const bytes = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: {},
      crypto: cryptoFor(dek),
    });
    expect(layoutOf(bytes).versionMinor).toBe(VERSION_MINOR);
    expect((await open(bytes, cryptoFor(dek))).metadata).toBeUndefined();
  });

  it('detects tampering: a flipped byte of the sealed metadata, its CRC re-stamped, fails authentication', async () => {
    const dek = randomBytes(32);
    const bytes = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: META,
      crypto: cryptoFor(dek),
    });
    const { indexOffset } = layoutOf(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const sectionsLength = view.getUint32(indexOffset - 12, true);
    const extStart = indexOffset - 12 - sectionsLength;
    // a byte of the nonce, of the ciphertext and of the tag, one at a time (the section header is 5 bytes)
    for (const at of [5, 5 + 12 + 3, sectionsLength - 1]) {
      const tampered = bytes.slice();
      tampered[extStart + at] = tampered[extStart + at]! ^ 0x01;
      new DataView(tampered.buffer).setUint32(
        indexOffset - 8,
        crc32c(tampered.subarray(extStart, indexOffset - 8)),
        true,
      );
      await expect(open(tampered, cryptoFor(dek))).rejects.toThrow(
        /the sealed metadata does not open/,
      );
    }
  });

  it('binds the metadata to its generation, its segment and its scope', async () => {
    const dek = randomBytes(32);
    const sealedFor = (generation: number, scope: 'metadata' | 'index'): Uint8Array => {
      const s = new NodeAead(dek).seal(utf8(META_JSON), aadFor(REF, generation, scope));
      return concat(s.nonce, s.ciphertext, s.tag);
    };
    const base = await writeCrbm(CHUNKS, { generation: GEN, crypto: cryptoFor(dek) });
    // The right key and scope, sealed for generation 8, spliced into generation 7: a block moved between objects.
    const moved = spliceBlock(base, extensionBlock(section(1, sealedFor(GEN + 1, 'metadata'))));
    await expect(open(moved, cryptoFor(dek))).rejects.toBeInstanceOf(IntegrityError);
    // Sealed for generation 7 but under the index's scope.
    const rescoped = spliceBlock(base, extensionBlock(section(1, sealedFor(GEN, 'index'))));
    await expect(open(rescoped, cryptoFor(dek))).rejects.toBeInstanceOf(IntegrityError);
    // The genuine article opens, so the two refusals above are the binding, not the splice.
    const genuine = spliceBlock(base, extensionBlock(section(1, sealedFor(GEN, 'metadata'))));
    expect((await open(genuine, cryptoFor(dek))).metadata).toEqual(META);
  });

  it('refuses cleartext metadata on an encrypted object, and a sealed section too short or too long', async () => {
    const dek = randomBytes(32);
    const base = await writeCrbm(CHUNKS, { generation: GEN, crypto: cryptoFor(dek) });
    const clear = spliceBlock(base, extensionBlock(section(1, utf8(META_JSON))));
    await expect(open(clear, cryptoFor(dek))).rejects.toBeInstanceOf(IntegrityError);
    for (const length of [28, 28 + MAX_METADATA_BYTES + 1]) {
      const odd = spliceBlock(base, extensionBlock(section(1, new Uint8Array(length))));
      await expect(open(odd, cryptoFor(dek))).rejects.toThrow(
        /is not a nonce, up to 1 KiB and a tag/,
      );
    }
  });

  it('the wrong key fails at the index or the metadata, never with a wrong answer', async () => {
    const bytes = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: META,
      crypto: cryptoFor(randomBytes(32)),
    });
    await expect(open(bytes, cryptoFor(randomBytes(32)))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('names the likely cause when the sealed metadata does not open: a CrbmCrypto that does not map its scope', async () => {
    const dek = randomBytes(32);
    const bytes = await writeCrbm(CHUNKS, {
      generation: GEN,
      metadata: META,
      crypto: cryptoFor(dek),
    });
    // A hand-written CrbmCrypto from before 1.1 knows chunk keys and 'index' only, and gives anything else chunk 0's
    // associated data. It still opens the index, so the failure comes at the metadata.
    const old: CrbmCrypto = {
      aead: new NodeAead(dek),
      aadFor: (scope) =>
        aadFor(REF, GEN, scope === 'index' ? 'index' : typeof scope === 'number' ? scope : 0),
    };
    await expect(open(bytes, old)).rejects.toBeInstanceOf(IntegrityError);
    await expect(open(bytes, old)).rejects.toThrow(
      /sealed metadata does not open: .*a CrbmCrypto whose aadFor does not map the 'metadata' scope/,
    );
  });

  it('refuses a cleartext object opened with a key, 1.0 or 1.1, before it believes its index or metadata', async () => {
    // A key is passed only for an encrypted segment, and every generation such a segment publishes is encrypted,
    // so a cleartext object under one is corrupt or forged: its count and its metadata must not be believed.
    const forged = await writeCrbm(
      [{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 65_536 }],
      { generation: GEN, metadata: { owner: 'attacker' } },
    );
    const plain10 = await writeCrbm(CHUNKS, { generation: GEN });
    for (const bytes of [forged, plain10]) {
      await expect(open(bytes, cryptoFor(randomBytes(32)))).rejects.toThrow(
        /not encrypted, but it was opened with a key/,
      );
      await expect(open(bytes, cryptoFor(randomBytes(32)))).rejects.toBeInstanceOf(IntegrityError);
    }
    // Without a key it is an ordinary cleartext object.
    expect((await open(forged)).metadata).toEqual({ owner: 'attacker' });
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A copy of `bytes` whose footer says the index starts at `indexOffset`, its CRC re-stamped. */
function withIndexAt(bytes: Uint8Array, indexOffset: number): Uint8Array {
  const out = bytes.slice();
  const footer = out.subarray(out.length - FOOTER_BYTES);
  const view = new DataView(footer.buffer, footer.byteOffset, FOOTER_BYTES);
  view.setBigUint64(FOOTER.indexOffset, BigInt(indexOffset), true);
  view.setUint32(FOOTER.footerCrc32c, crc32c(footer.subarray(0, FOOTER_CRC_COVERAGE)), true);
  return out;
}
