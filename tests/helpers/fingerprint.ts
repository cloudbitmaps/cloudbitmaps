/**
 * The fingerprint of the object under a generation's key, read from its footer as `CrbmReader.fingerprint` spells it
 * (`<size>:<footer checksum>`), with no key: what a row's summary of that generation names.
 */
import { FOOTER, FOOTER_BYTES } from '@/core/crbm/format';
import { fingerprintFor } from '@/core/crbm/fingerprint';
import type { GenKey, IStorageDriver } from '@/core/ports';

export async function objectFingerprint(storage: IStorageDriver, key: GenKey): Promise<string> {
  const { bytes, size } = await storage.getTail(key, FOOTER_BYTES);
  const footer = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - FOOTER_BYTES,
    FOOTER_BYTES,
  );
  return fingerprintFor(size, footer.getUint32(FOOTER.footerCrc32c, true));
}

/** A fingerprint's form, for an assertion that cannot name the object. */
export const FINGERPRINT = /^\d+:\d+$/;
