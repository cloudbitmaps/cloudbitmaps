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
const { decodePng, bestContrast } = require_('../../scripts/lib/png-pixels.cjs') as {
  decodePng: (buf: Buffer) => Image;
  bestContrast: (a: Image, b: Image, box: Box, skip?: Box[]) => number;
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
  { depth = 8, interlace = 0, parts = 1, compression = 0, filtering = 0 } = {},
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
  header[10] = compression;
  header[11] = filtering;
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
    expect(() => decodePng(png(2, 2, 4, pixels, [0], { compression: 1 }))).toThrow(/compression 1/);
    expect(() => decodePng(png(2, 2, 4, pixels, [0], { filtering: 1 }))).toThrow(/filtering 1/);
    const short = png(2, 2, 4, pixels, [0]);
    // An image header that claims more rows than the data holds.
    short.writeUInt32BE(3, 8 + 8 + 4);
    expect(() => decodePng(short)).toThrow(/not the size its header says/);
  });

  it('refuses a file whose chunks are out of order, cut short, unended or run on', () => {
    const good = png(2, 2, 4, noise(2, 2, 4), [0]);
    expect(decodePng(good).width).toBe(2);
    // The image header's chunk is 8 + 13 + 4 bytes after the signature; the image data follows it.
    const header = good.subarray(8, 8 + 25);
    const rest = good.subarray(8 + 25);
    expect(() => decodePng(Buffer.concat([SIGNATURE, rest, header]))).toThrow(
      /first chunk is not the image header/,
    );
    expect(() => decodePng(good.subarray(0, good.length - 12))).toThrow(/no end chunk/);
    expect(() => decodePng(good.subarray(0, good.length - 20))).toThrow(/runs past the end/);
    const shortHeader = Buffer.from(good);
    shortHeader.writeUInt32BE(12, 8);
    expect(() => decodePng(shortHeader)).toThrow(/13-byte first chunk|runs past the end/);
    // Trailing bytes after the compressed stream, inside the image data.
    const raw = Buffer.alloc(2 * (2 * 4 + 1));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const runOn = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', Buffer.concat([deflateSync(raw), Buffer.from([1, 2, 3])])),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => decodePng(runOn)).toThrow(/runs on past its stream/);
  });
});

describe('bestContrast', () => {
  const solid = (width: number, height: number, v: number): Image => ({
    width,
    height,
    rgba: Buffer.alloc(width * height * 4, v),
  });
  const grey = (img: Image, x: number, y: number, v: number): void => {
    const i = (y * img.width + x) * 4;
    img.rgba[i] = img.rgba[i + 1] = img.rgba[i + 2] = v;
  };

  it('reads the best contrast a pixel in the box reaches between the two images, by WCAG', () => {
    // White against greys: #767676 is 4.54:1 on white, #a0a0a0 2.61:1, and black 21:1 outside the box.
    const a = solid(10, 10, 255);
    const b = solid(10, 10, 255);
    grey(b, 2, 2, 0x76);
    grey(b, 3, 2, 0xa0);
    grey(b, 8, 8, 0x00);
    expect(bestContrast(a, b, { left: 0, top: 0, right: 5, bottom: 5 })).toBeCloseTo(4.54, 2);
    expect(bestContrast(a, b, { left: 3, top: 0, right: 5, bottom: 5 })).toBeCloseTo(2.61, 2);
    expect(bestContrast(a, b, { left: 0, top: 0, right: 10, bottom: 10 })).toBeCloseTo(21, 5);
  });

  it('reads exactly 1 where no pixel changed, which is what a cover leaves', () => {
    expect(
      bestContrast(solid(4, 4, 90), solid(4, 4, 90), { left: 0, top: 0, right: 4, bottom: 4 }),
    ).toBe(1);
  });

  it('puts #949494 on white just over 3:1 and #969696 just under it', () => {
    const a = solid(2, 1, 255);
    const b = solid(2, 1, 255);
    grey(b, 0, 0, 0x94);
    grey(b, 1, 0, 0x96);
    expect(bestContrast(a, b, { left: 0, top: 0, right: 1, bottom: 1 })).toBeGreaterThanOrEqual(3);
    expect(bestContrast(a, b, { left: 1, top: 0, right: 2, bottom: 1 })).toBeLessThan(3);
  });

  it('leaves out the pixels inside another run, and clamps the box to the image', () => {
    const a = solid(10, 10, 255);
    const b = solid(10, 10, 255);
    grey(b, 1, 1, 0x00);
    grey(b, 3, 3, 0x76);
    const box = { left: -3, top: -3, right: 4, bottom: 4 };
    expect(bestContrast(a, b, box)).toBeCloseTo(21, 5);
    expect(bestContrast(a, b, box, [{ left: 0, top: 0, right: 2, bottom: 4 }])).toBeCloseTo(
      4.54,
      2,
    );
    expect(bestContrast(a, b, box, [{ left: 0, top: 0, right: 4, bottom: 4 }])).toBe(1);
  });

  it('refuses two images of different sizes', () => {
    expect(() =>
      bestContrast(solid(2, 2, 0), solid(3, 2, 0), { left: 0, top: 0, right: 1, bottom: 1 }),
    ).toThrow(/differ in size/);
  });
});
