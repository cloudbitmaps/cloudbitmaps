import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BufferReader } from '@/core/blob';
import { CrbmReader } from '@/core/crbm/reader';
import { aadFor } from '@/core/crypto';
import type { CrbmCrypto } from '@/core/crypto';
import { NodeAead } from '@/drivers/crypto';
import { CrbmReader as Reader0112 } from './fixtures/reader-0.11.2/reader';
import { extensionBlock, section, spliceBlock, utf8, writeCrbm } from '../../helpers/crbm-v1_1';

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * What a deployed 0.11 process does with a format 1.1 object: it opens it, answers from it exactly as this build
 * does, and ignores the extension block. Run against the 0.11.2 reader itself, pinned beside this file, so the claim
 * is tested rather than argued. It holds because that reader checks the major version only, and bounds payloads by
 * the index's offset alone, so it never looks at the bytes between the last payload and the index.
 */
const golden = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url))));

const KEY = Uint8Array.from({ length: 32 }, (_v, i) => i);
const goldenCrypto: CrbmCrypto = {
  aead: new NodeAead(KEY),
  aadFor: (scope) => aadFor({ namespace: 'golden', segment: 'v1.1' }, 7, scope),
};

/** Both readers' answers for one object: everything a read asks a `.crbm` for. */
async function answers(
  reader: Pick<CrbmReader, 'generation' | 'chunkKeys' | 'count' | 'cardinalities' | 'getChunk'>,
): Promise<unknown> {
  const chunks: number[][] = [];
  for (const k of reader.chunkKeys()) chunks.push([...(await reader.getChunk(k))!]);
  return {
    generation: reader.generation,
    keys: reader.chunkKeys(),
    count: reader.count(),
    cardinalities: [...reader.cardinalities()],
    chunks,
  };
}

/**
 * The pinned files are the v0.11.2 release's, checked here rather than trusted: each file, with its leading comment
 * removed and its import paths put back, must hash to the git blob the tag holds (`git rev-parse
 * v0.11.2:packages/core/src/core/crbm/<file>`). An edit to any of them fails this, and the edit is then deliberate.
 */
const PINNED: ReadonlyArray<
  readonly [file: string, blob: string, imports: ReadonlyArray<readonly [string, string]>]
> = [
  [
    'reader.ts',
    'b0ebc87841c07c747b699182e35c2f2c2bb16484',
    [
      ["'@/core/errors'", "'../errors'"],
      ["'@/core/blob'", "'../blob'"],
      ["'@/core/crypto'", "'../crypto'"],
    ],
  ],
  ['format.ts', '428bad29a7299505df863c835445765ec155c413', []],
  ['crc32c.ts', '5ba6ff2b619568152c95a6a82e785825c2a393fb', []],
  ['varint.ts', 'b350feca2cf36138d7af09ad870ead7b666939bb', [["'@/core/errors'", "'../errors'"]]],
];

describe('the pinned 0.11.2 reader is the one the release shipped', () => {
  it.each(PINNED.map(([file, blob, imports]) => [file, blob, imports] as const))(
    '%s hashes to the v0.11.2 blob %s once its comment and import paths are undone',
    (file, blob, imports) => {
      let text = readFileSync(
        fileURLToPath(new URL(`./fixtures/reader-0.11.2/${file}`, import.meta.url)),
        'utf8',
      );
      // The pin's own header: the `//` lines before the release's first line.
      text = text.replace(/^(?:\/\/.*\n)+/, '');
      for (const [pinned, released] of imports) text = text.replaceAll(pinned, released);
      const body = Buffer.from(text, 'utf8');
      const id = createHash('sha1')
        .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
        .digest('hex');
      expect(id).toBe(blob);
    },
  );
});

describe('the 0.11.2 reader opens a .crbm 1.1 object and ignores its block', () => {
  for (const [name, crypto] of [
    ['v1.1-metadata.crbm', undefined],
    ['v1.1-metadata-encrypted.crbm', goldenCrypto],
  ] as const) {
    it(`${name}: the same answers as this build, from the tail and with the index range-read`, async () => {
      const bytes = golden(name);
      const current = await CrbmReader.open(new BufferReader(bytes), { crypto });
      expect(current.metadata).toBeDefined();
      for (const tailBytes of [undefined, 104]) {
        const old = await Reader0112.open(new BufferReader(bytes), { crypto, tailBytes });
        expect(old.servedFromTail).toBe(tailBytes === undefined);
        expect(await answers(old)).toEqual(await answers(current));
      }
    });
  }

  it('a block at the metadata cap, and one with a later section type at minor 2, open on 0.11.2 too', async () => {
    const chunks = [
      { chunkKey: 3, payload: Uint8Array.of(7, 7, 7), cardinality: 2 },
      { chunkKey: 900, payload: Uint8Array.of(1), cardinality: 1 },
    ];
    const atCap = await writeCrbm(chunks, {
      generation: 2,
      metadata: { k: 'x'.repeat(1024 - 8) },
    });
    const later = spliceBlock(
      await writeCrbm(chunks, { generation: 2 }),
      extensionBlock(concat(section(1, utf8('{"a":1}')), section(9, utf8('a later type')))),
      2,
    );
    for (const bytes of [atCap, later]) {
      const old = await Reader0112.open(new BufferReader(bytes));
      expect(await answers(old)).toEqual(
        await answers(await CrbmReader.open(new BufferReader(bytes))),
      );
    }
  });
});
