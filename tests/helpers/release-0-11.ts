/**
 * What a 0.11 process does with a registry row, for the tests that hold a fleet across the schema-2 cut-over to what
 * 0.11 shipped. Nothing here runs 0.11; it restates the one check that decides what 0.11 makes of a row 0.12 wrote.
 */
import { IntegrityError, UnsupportedError } from '@/core/errors';

/**
 * 0.11's check of a row's stamp, as it shipped: the first thing its parser does after `JSON.parse`, and the one
 * that refuses a newer row before any field is looked at. It reads schema 1 only.
 */
export function readAs011(text: string): void {
  const raw = (JSON.parse(text) as { schemaVersion?: unknown }).schemaVersion;
  if (raw === undefined) throw new IntegrityError('registry row has no schemaVersion');
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new IntegrityError(`registry row has a malformed schemaVersion (${String(raw)})`);
  }
  if (raw > 1) {
    throw new UnsupportedError(
      `registry row schemaVersion ${raw} is newer than this build reads (v1)`,
    );
  }
}
