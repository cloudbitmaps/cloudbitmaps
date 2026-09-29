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
  const data = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(
          `png: depth ${depth}, colour type ${colour}, interlace ${interlace} is not read here`,
        );
      }
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('png: no image header');
  const raw = inflateSync(Buffer.concat(data));
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

/**
 * How many pixels inside `box` differ between two same-sized images by at least `threshold` on some channel, and how
 * many were compared. Pixels inside any of `skip` are left out, so a change there is not credited to `box`.
 */
function changedPixels(a, b, box, skip = [], threshold = 48) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error('png: the two images differ in size');
  const x0 = Math.max(0, Math.floor(box.left));
  const y0 = Math.max(0, Math.floor(box.top));
  const x1 = Math.min(a.width, Math.ceil(box.right));
  const y1 = Math.min(a.height, Math.ceil(box.bottom));
  // Only the boxes that overlap this one can take pixels from it.
  const near = skip.filter((s) => s.left < x1 && s.right > x0 && s.top < y1 && s.bottom > y0);
  let changed = 0;
  let compared = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (
        near.length > 0 &&
        near.some((s) => x >= s.left && x < s.right && y >= s.top && y < s.bottom)
      )
        continue;
      compared++;
      const i = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.rgba[i] - b.rgba[i]),
        Math.abs(a.rgba[i + 1] - b.rgba[i + 1]),
        Math.abs(a.rgba[i + 2] - b.rgba[i + 2]),
      );
      if (d >= threshold) changed++;
    }
  }
  return { changed, compared };
}

module.exports = { decodePng, changedPixels };
