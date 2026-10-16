import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crc32c } from '@/core/crbm/crc32c';
import { FOOTER, FOOTER_BYTES, FOOTER_CRC_COVERAGE } from '@/core/crbm/format';

/**
 * The golden-file table in `docs/format.md` names each file's size and fingerprint (`<size>:<footer CRC32C>`). A
 * port checks its own writer against those numbers, so a file regenerated without the table following, or a digit
 * mistyped in it, sends a port chasing a difference that is not there. Each row is compared with the file in
 * `tests/golden/`: its length, the CRC32C the footer stores, and that CRC recomputed over footer bytes `[0, 96)`
 * with the library's own CRC32C.
 */
const ROOT = join(__dirname, '..', '..');
const page = readFileSync(join(ROOT, 'docs/format.md'), 'utf8');

/** A table row that names a golden file: file, size, fingerprint. */
const ROW = /^\| `(v1\.0-[\w-]+\.crbm)` \| ([\d,]+) \| [^|]*\| `(\d+):(\d+)` \|/gm;
const rows = [...page.matchAll(ROW)].map((m) => ({
  file: m[1] ?? '',
  size: Number((m[2] ?? '').replaceAll(',', '')),
  fingerprintSize: Number(m[3]),
  crc: Number(m[4]),
}));

describe('the golden-file table in docs/format.md matches tests/golden', () => {
  it('lists every golden object file', () => {
    expect(rows.map((r) => r.file).sort()).toEqual(
      readdirSync(join(ROOT, 'tests/golden'))
        .filter((f) => f.endsWith('.crbm'))
        .sort(),
    );
  });

  it.each(rows)('$file: size, fingerprint and footer checksum', (row) => {
    const bytes = readFileSync(join(ROOT, 'tests/golden', row.file));
    const footer = new DataView(
      bytes.buffer,
      bytes.byteOffset + bytes.length - FOOTER_BYTES,
      FOOTER_BYTES,
    );
    const stored = footer.getUint32(FOOTER.footerCrc32c, true);
    expect(row.size, 'size column').toBe(bytes.length);
    expect(row.fingerprintSize, 'size in the fingerprint').toBe(bytes.length);
    expect(row.crc, 'checksum in the fingerprint').toBe(stored);
    const covered = bytes.subarray(
      bytes.length - FOOTER_BYTES,
      bytes.length - FOOTER_BYTES + FOOTER_CRC_COVERAGE,
    );
    expect(crc32c(covered), "the stored checksum is the footer's").toBe(stored);
  });
});
