import { BufferReader, BufferSink } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import {
  canonicalMetadataJson,
  MAX_METADATA_KEY_BYTES,
  metadataBytes,
  metadataFromBytes,
} from '@/core/metadata';

/**
 * The metadata a generation stores, as bytes: what the writer snapshots from a caller's value, and what a reader
 * accepts back from a tier. The bytes are serialised from the values the rules checked, never read again.
 */
class Refused extends Error {}
const fail = (message: string): never => {
  throw new Refused(message);
};

describe('metadata as stored bytes', () => {
  it('serialises the values it checked: a proxy that answers a second read differently changes nothing', async () => {
    const proxy = new Proxy({ a: 'x' } as Record<string, string>, { get: () => undefined });
    expect(canonicalMetadataJson(proxy, fail)).toBe('{"a":"x"}');
    // And so the writer never writes an object its own reader refuses.
    const sink = new BufferSink();
    const writer = new CrbmWriter(sink, { generation: 1, metadata: proxy });
    await writer.addChunk(0, Uint8Array.of(1), 1);
    await writer.finish();
    expect((await CrbmReader.open(new BufferReader(sink.bytes()))).metadata).toEqual({ a: 'x' });
  });

  it('a key of any length up to the cap is measured in UTF-8, whichever way it is checked', () => {
    // 42 three-byte characters are 126 bytes; 43 are 129. The short ASCII key is under the cap however it is counted.
    const euro = '€';
    expect(() => canonicalMetadataJson({ [euro.repeat(42)]: 1 }, fail)).not.toThrow();
    expect(() => canonicalMetadataJson({ [euro.repeat(43)]: 1 }, fail)).toThrow(/129B/);
    expect(() =>
      canonicalMetadataJson({ ['k'.repeat(MAX_METADATA_KEY_BYTES)]: 1 }, fail),
    ).not.toThrow();
    expect(() =>
      canonicalMetadataJson({ ['k'.repeat(MAX_METADATA_KEY_BYTES + 1)]: 1 }, fail),
    ).toThrow(/129B/);
    // A key of surrogate pairs: 32 emoji are 64 UTF-16 units and 128 UTF-8 bytes; 33 are 132.
    expect(() => canonicalMetadataJson({ ['\u{1F600}'.repeat(32)]: 1 }, fail)).not.toThrow();
    expect(() => canonicalMetadataJson({ ['\u{1F600}'.repeat(33)]: 1 }, fail)).toThrow(/132B/);
  });

  it('metadataBytes is the canonical JSON in UTF-8, and none for undefined or the empty object', () => {
    expect(metadataBytes(undefined, fail)).toBeUndefined();
    expect(metadataBytes({}, fail)).toBeUndefined();
    expect(new TextDecoder().decode(metadataBytes({ b: 1, a: '日' }, fail))).toBe(
      '{"a":"日","b":1}',
    );
  });

  it('metadataFromBytes takes back exactly what metadataBytes gives, frozen', () => {
    const bytes = metadataBytes({ def: 'v41', n: -1.5 }, fail)!;
    const back = metadataFromBytes(bytes, fail);
    expect(back).toEqual({ def: 'v41', n: -1.5 });
    expect(Object.isFrozen(back)).toBe(true);
  });
});
