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
    ]);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const canonical = canonicalMetadataJson(JSON.parse(v.input), fail);
    expect(canonical).toBe(v.canonical);
    const bytes = new TextEncoder().encode(canonical);
    expect(Buffer.from(bytes).toString('hex')).toBe(v.canonicalUtf8Hex);
    // A reader takes the canonical bytes back to the same values, and refuses the input's own spelling.
    expect(canonicalMetadataJson(metadataFromBytes(bytes, fail), fail)).toBe(v.canonical);
    expect(v.input).not.toBe(v.canonical);
    expect(() => metadataFromBytes(new TextEncoder().encode(v.input), fail)).toThrow(Refused);
  });
});
