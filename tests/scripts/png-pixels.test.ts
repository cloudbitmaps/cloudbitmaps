import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

/**
 * The PNG reader the browser pass's pixel comparison decodes Chrome's screenshots with. A reader that undid a row
 * filter wrong would compare the wrong pixels, and a covered run could read as changed, so each filter is round-tripped
 * against pixels it did not produce, and every format it does not read is refused rather than read wrong.
 */
const require_ = createRequire(import.meta.url);
type Image = { width: number; height: number; rgba: Buffer };
type Box = { left: number; top: number; right: number; bottom: number };
const { decodePng, changedPixels } = require_('../../scripts/lib/png-pixels.cjs') as {
  decodePng: (buf: Buffer) => Image;
  changedPixels: (
    a: Image,
    b: Image,
    box: Box,
    skip?: Box[],
    threshold?: number,
  ) => { changed: number; compared: number };
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // The reader does not check the CRC, so none is computed here.
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function paeth(a: number, b: number, c: number): number {
  const e = a + b - c;
  const pa = Math.abs(e - a);
  const pb = Math.abs(e - b);
  const pc = Math.abs(e - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A PNG of `pixels`, each row filtered with the next of `filters`, the image data split over `parts` IDAT chunks. */
function png(
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Uint8Array,
  filters: number[],
  { depth = 8, interlace = 0, parts = 1 } = {},
): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length] ?? 0;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const at = (yy: number, xx: number): number =>
        yy >= 0 && xx >= 0 ? (pixels[yy * stride + xx] ?? 0) : 0;
      const a = at(y, x - channels);
      const b = at(y - 1, x);
      const c = at(y - 1, x - channels);
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f] ?? 0;
      raw[y * (stride + 1) + 1 + x] = ((pixels[y * stride + x] ?? 0) - predicted) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = channels === 4 ? 6 : 2;
  header[12] = interlace;
  const data = deflateSync(raw);
  const step = Math.ceil(data.length / parts);
  const idat = Array.from({ length: parts }, (_, k) =>
    chunk('IDAT', data.subarray(k * step, (k + 1) * step)),
  );
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), ...idat, chunk('IEND', Buffer.alloc(0))]);
}

/** Pixels that no filter predicts well: every byte differs from its neighbours. */
function noise(width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  let s = 12345;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4])('undoes row filter %i', (filter) => {
    const pixels = noise(7, 5, 4);
    const img = decodePng(png(7, 5, 4, pixels, [filter]));
    expect(img).toMatchObject({ width: 7, height: 5 });
    expect([...img.rgba]).toEqual([...pixels]);
  });

  it('undoes the Paeth filter where its predictors tie, which four even shades make common', () => {
    // A tie that picks a different neighbour needs one neighbour to be 3c - 2b of the other two, as 0, 40 and 60 are.
    const pixels = noise(16, 16, 4).map((v) => (v % 4) * 20);
    const img = decodePng(png(16, 16, 4, pixels, [4]));
    expect([...img.rgba]).toEqual([...pixels]);
  });

  it('undoes a different filter on every row, over image data split across chunks', () => {
    const pixels = noise(9, 10, 4);
    const img = decodePng(png(9, 10, 4, pixels, [4, 0, 3, 1, 2], { parts: 3 }));
    expect([...img.rgba]).toEqual([...pixels]);
  });

  it('reads RGB as RGBA, opaque', () => {
    const pixels = noise(4, 3, 3);
    const img = decodePng(png(4, 3, 3, pixels, [1, 4]));
    for (let i = 0; i < 12; i++) {
      expect([...img.rgba.subarray(i * 4, i * 4 + 4)]).toEqual([
        pixels[i * 3],
        pixels[i * 3 + 1],
        pixels[i * 3 + 2],
        255,
      ]);
    }
  });

  it('refuses what it does not read, rather than reading it wrong', () => {
    const pixels = noise(2, 2, 4);
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/not a PNG/);
    expect(() => decodePng(png(2, 2, 4, pixels, [0], { depth: 16 }))).toThrow(/depth 16/);
    expect(() => decodePng(png(2, 2, 4, pixels, [0], { interlace: 1 }))).toThrow(/interlace 1/);
    expect(() => decodePng(png(2, 2, 4, pixels, [7]))).toThrow(/filter 7/);
    const short = png(2, 2, 4, pixels, [0]);
    // An image header that claims more rows than the data holds.
    short.writeUInt32BE(3, 8 + 8 + 4);
    expect(() => decodePng(short)).toThrow(/not the size its header says/);
  });
});

describe('changedPixels', () => {
  const solid = (width: number, height: number, v: number): Image => ({
    width,
    height,
    rgba: Buffer.alloc(width * height * 4, v),
  });

  it('counts the pixels in the box that differ by the threshold on some channel', () => {
    const a = solid(10, 10, 200);
    const b = solid(10, 10, 200);
    for (const [x, y, d] of [
      [2, 2, 48],
      [3, 2, 47],
      [8, 8, 90],
    ] as const) {
      b.rgba[(y * 10 + x) * 4 + 1] = 200 - d;
    }
    expect(changedPixels(a, b, { left: 0, top: 0, right: 5, bottom: 5 })).toEqual({
      changed: 1,
      compared: 25,
    });
    expect(changedPixels(a, b, { left: 0, top: 0, right: 5, bottom: 5 }, [], 40)).toEqual({
      changed: 2,
      compared: 25,
    });
  });

  it('leaves out the pixels inside another run, and clamps the box to the image', () => {
    const a = solid(10, 10, 0);
    const b = solid(10, 10, 255);
    const box = { left: -3, top: -3, right: 4, bottom: 4 };
    expect(changedPixels(a, b, box)).toEqual({ changed: 16, compared: 16 });
    expect(changedPixels(a, b, box, [{ left: 0, top: 0, right: 2, bottom: 4 }])).toEqual({
      changed: 8,
      compared: 8,
    });
  });

  it('refuses two images of different sizes', () => {
    expect(() =>
      changedPixels(solid(2, 2, 0), solid(3, 2, 0), { left: 0, top: 0, right: 1, bottom: 1 }),
    ).toThrow(/differ in size/);
  });
});
