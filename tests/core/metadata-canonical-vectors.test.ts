import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalMetadataJson, metadataFromBytes } from '@/core/metadata';

/**
 * The canonical form other languages must reproduce, as committed vectors: `tests/golden/metadata-canonical.json`
 * holds JSON inputs, the canonical text each must become, and its UTF-8 bytes. The form is RFC 8785 (JCS) restricted
 * to a flat object of strings and finite numbers, so a port can check itself against the same file.
 */
interface Vector {
  readonly name: string;
  readonly input: string;
  readonly canonical: string;
  readonly canonicalUtf8Hex: string;
  /** For a vector of numbers given by their bits: each key's IEEE-754 double, big-endian hex. */
  readonly doubles?: Readonly<Record<string, string>>;
}
const { vectors } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../golden/metadata-canonical.json', import.meta.url)),
    'utf8',
  ),
) as { vectors: Vector[] };

class Refused extends Error {}
const fail = (message: string): never => {
  throw new Refused(message);
};

describe('canonical metadata: the committed vectors', () => {
  it('covers key order, the number forms and the escapes', () => {
    expect(vectors.map((v) => v.name.split(':')[0])).toEqual([
      'keys',
      'keys',
      'numbers',
      'strings',
      'keys',
      'numbers',
    ]);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const parsed = JSON.parse(v.input) as Record<string, number | string>;
    // A vector given by bits holds the input's spelling to those exact doubles.
    for (const [key, hex] of Object.entries(v.doubles ?? {})) {
      const bits = Buffer.alloc(8);
      bits.writeDoubleBE(parsed[key] as number, 0);
      expect(`${key}=${bits.toString('hex')}`).toBe(`${key}=${hex}`);
    }
    const canonical = canonicalMetadataJson(parsed, fail);
    expect(canonical).toBe(v.canonical);
    const bytes = new TextEncoder().encode(canonical);
    expect(Buffer.from(bytes).toString('hex')).toBe(v.canonicalUtf8Hex);
    // A reader takes the canonical bytes back to the same values, and refuses the input's own spelling.
    expect(canonicalMetadataJson(metadataFromBytes(bytes, fail), fail)).toBe(v.canonical);
    expect(v.input).not.toBe(v.canonical);
    expect(() => metadataFromBytes(new TextEncoder().encode(v.input), fail)).toThrow(Refused);
  });
});
