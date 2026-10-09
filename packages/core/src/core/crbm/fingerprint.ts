/**
 * An object's fingerprint: its size and its footer's CRC, `<size>:<crc>` in decimal, which names one `.crbm` object. The
 * spelling and its parse are here, apart from the reader, so the registry can check a summary's fingerprint without
 * the reader. Pure: no I/O.
 */
import { FOOTER_BYTES, PREAMBLE_BYTES } from './frame';

/** What names an object: its size, then its footer's CRC. One spelling, for an open reader and a footer read alone. */
export const sizePart = (size: number): string => `${size}:`;
/** An object's fingerprint, from its size and its footer's CRC (see `CrbmReader.fingerprint`). */
export const fingerprintFor = (size: number, footerCrc: number): string =>
  `${sizePart(size)}${footerCrc}`;

/** A fingerprint as {@link fingerprintFor} spells one: two canonical decimals. */
const FINGERPRINT = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

/**
 * A fingerprint taken apart, or `undefined` for text that is not one an object can have: a size that is a safe integer
 * no smaller than a `.crbm` preamble and footer, and a footer CRC that fits in 32 bits. For a row's summary, which
 * names its object by it and reports the size from it.
 */
export function fingerprintParts(
  fingerprint: unknown,
): { readonly size: number; readonly footerCrc: number } | undefined {
  const match = typeof fingerprint === 'string' ? FINGERPRINT.exec(fingerprint) : null;
  if (match === null) return undefined;
  const size = Number(match[1]);
  const footerCrc = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < PREAMBLE_BYTES + FOOTER_BYTES) return undefined;
  if (footerCrc > 0xffff_ffff) return undefined;
  return { size, footerCrc };
}

/**
 * A fingerprint spelled short, for a key a read builds on every chunk: its size and its footer's CRC in base 36,
 * `<size>.<crc>`. Two compact spellings are equal exactly when the fingerprints are.
 */
export function compactFingerprint(fingerprint: string): string {
  const colon = fingerprint.indexOf(':');
  const size = Number(fingerprint.slice(0, colon));
  const crc = Number(fingerprint.slice(colon + 1));
  return `${size.toString(36)}.${crc.toString(36)}`;
}
