/**
 * A write's own id, kept in blob metadata, so a conflict can be told from a replay of the write that caused it.
 *
 * The SDK's retry policy belongs to the client's pipeline and has no per-request switch, so a conditional write
 * that lands and loses its response is sent again, meets its own blob and fails its precondition (409 or 412),
 * which reads as a lost race for a write that won. Each write therefore tags its blob with a random id, in
 * metadata: outside the `.crbm` bytes and outside the registry row's body, so neither format carries it. When a
 * conditional write reports a conflict, {@link storedWriteId} reads the id back with one `getProperties`, and the
 * write is its own when the stored id is the one it sent. That read is paid only on a conflict, never on a write
 * that succeeds.
 *
 * Only a write-once object's read-back is definitive: nothing overwrites it, so the id it holds is the one it was
 * written with. A registry row is overwritten by compare-and-swap, so a writer that lands on top of ours between
 * our write and the read-back shows its own id, and ours reports a conflict for a write that did land. A publish
 * reads the row again after a conflict and recognises its own write there by its effect (the pointer at its
 * generation, over its own object), so that conflict does not reach a load as a lost race.
 *
 * Azure metadata names must be valid C# identifiers, so this one is letters only, and short because it is sent
 * with every write.
 */
import { randomBytes } from 'node:crypto';
import type { BlockBlobClient } from '@azure/storage-blob';
import { isNotFound } from './azure-errors';

/** The metadata name the id is stored under. */
const WRITE_ID_KEY = 'cbwid';

/** A fresh random id: 128 bits, hex. */
export function newWriteId(): string {
  return randomBytes(16).toString('hex');
}

/** The metadata a write attaches to its blob. */
export function writeIdMetadata(id: string): Record<string, string> {
  return { [WRITE_ID_KEY]: id };
}

/**
 * The id the stored blob carries, or `undefined` when it carries none or is gone. A failed read throws, so a caller
 * never mistakes "could not look" for "not ours".
 */
export async function storedWriteId(blob: BlockBlobClient): Promise<string | undefined> {
  try {
    const props = await blob.getProperties();
    return props.metadata?.[WRITE_ID_KEY];
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}
