'use strict';
/**
 * The pixels of a PNG as Chrome's screenshots write it: 8-bit RGB or RGBA, not interlaced. Node's `zlib` inflates the
 * image data and this undoes the per-row filters, so the browser pass can compare two screenshots with no
 * dependency. Anything else is refused rather than read wrong.
 */
const { Buffer } = require('node:buffer');
const { inflateSync } = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `{ width, height, rgba }`, with four bytes a pixel whatever the file carries. */
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  const data = [];
  for (let at = 8; at < buf.length;) {
    if (at + 12 > buf.length) throw new Error('png: a chunk runs past the end of the file');
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > buf.length)
      throw new Error(`png: the ${type} chunk runs past the end of the file`);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (at === 8 && type !== 'IHDR')
      throw new Error('png: the first chunk is not the image header');
    if (type === 'IHDR') {
      if (at !== 8 || length !== 13)
        throw new Error('png: the image header is not a 13-byte first chunk');
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, compression, filtering, interlace] = body.subarray(8, 13);
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (
        depth !== 8 ||
        channels === 0 ||
        compression !== 0 ||
        filtering !== 0 ||
        interlace !== 0
      ) {
        throw new Error(
          `png: depth ${depth}, colour type ${colour}, compression ${compression}, filtering ${filtering}, ` +
            `interlace ${interlace} is not read here`,
        );
      }
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('png: no image header');
  if (!ended) throw new Error('png: no end chunk');
  const compressed = Buffer.concat(data);
  const { buffer: raw, engine } = inflateSync(compressed, { info: true });
  if (engine.bytesWritten !== compressed.length)
    throw new Error('png: the image data runs on past its stream');
  const stride = width * channels;
  if (raw.length !== height * (stride + 1))
    throw new Error('png: the image data is not the size its header says');
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    const up = out - stride;
    // One filter a row, so the branch is taken once a row rather than once a byte.
    switch (filter) {
      case 0:
        raw.copy(rows, out, src, src + stride);
        break;
      case 1:
        for (let x = 0; x < stride; x++) {
          rows[out + x] = (raw[src + x] + (x >= channels ? rows[out + x - channels] : 0)) & 0xff;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x++)
          rows[out + x] = (raw[src + x] + (y > 0 ? rows[up + x] : 0)) & 0xff;
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? rows[out + x - channels] : 0;
          const b = y > 0 ? rows[up + x] : 0;
          rows[out + x] = (raw[src + x] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? rows[out + x - channels] : 0;
          const b = y > 0 ? rows[up + x] : 0;
          const c = x >= channels && y > 0 ? rows[up + x - channels] : 0;
          const e = a + b - c;
          const pa = Math.abs(e - a);
          const pb = Math.abs(e - b);
          const pc = Math.abs(e - c);
          rows[out + x] = (raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
        break;
      default:
        throw new Error(`png: row ${y} has filter ${filter}`);
    }
  }
  if (channels === 4) return { width, height, rgba: rows };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    rgba[j] = rows[i];
    rgba[j + 1] = rows[i + 1];
    rgba[j + 2] = rows[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** A channel as linear light, for WCAG's relative luminance. */
const LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const luminance = (rgba, i) =>
  0.2126 * LINEAR[rgba[i]] + 0.7152 * LINEAR[rgba[i + 1]] + 0.0722 * LINEAR[rgba[i + 2]];

/**
 * The best contrast any pixel inside `box` reaches between two same-sized images, by WCAG's contrast ratio: 1 when no
 * pixel changed. Pixels inside any of `skip` are left out, so a change there is not credited to `box`.
 *
 * With the letters drawn in `a` and cleared in `b`, a pixel of `b` is the ground as actually painted behind the
 * letter, so this reads the letter's contrast against what is behind it, a see-through box or a cover included.
 */
function bestContrast(a, b, box, skip = []) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error('png: the two images differ in size');
  const x0 = Math.max(0, Math.floor(box.left));
  const y0 = Math.max(0, Math.floor(box.top));
  const x1 = Math.min(a.width, Math.ceil(box.right));
  const y1 = Math.min(a.height, Math.ceil(box.bottom));
  // Only the boxes that overlap this one can take pixels from it.
  const near = skip.filter((s) => s.left < x1 && s.right > x0 && s.top < y1 && s.bottom > y0);
  let best = 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (
        near.length > 0 &&
        near.some((s) => x >= s.left && x < s.right && y >= s.top && y < s.bottom)
      ) {
        continue;
      }
      const i = (y * a.width + x) * 4;
      const la = luminance(a.rgba, i);
      const lb = luminance(b.rgba, i);
      const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      if (r > best) best = r;
    }
  }
  return best;
}

module.exports = { decodePng, bestContrast };
