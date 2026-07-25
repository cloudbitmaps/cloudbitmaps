/**
 * Segment **export ("eject")** — dump every registered segment's current *effective* set to a portable file,
 * using only public read APIs, so your data is readable **without CloudRoaring** (a first-class exit path;
 * see the README "Your data stays yours" section).
 *
 * Two formats:
 * - `'roaring'` (default) — one **portable RoaringBitmap32** per segment (the cross-language CRoaring format,
 *   loadable by any roaring library in Java/Go/Python/Rust/C++/…). Compact; builds one bitmap in memory per
 *   segment.
 * - `'ndjson'` — newline-delimited ids, streamed (constant memory, any segment size); zero dependencies to read.
 *
 * The engine is **storage-agnostic and I/O-free**: it enumerates via an {@link IRegistryDriver}, reads the
 * tier-merged effective set via a store's `segment(...).iterate()`, and writes bytes through an injected
 * {@link ExportSink} — so it never imports `node:fs` (the `export-segments` CLI supplies a filesystem sink; a
 * test supplies an in-memory one; you could supply an S3 uploader). Crypto-shredded (`destroyed`) segments are
 * skipped (their bytes are unrecoverable); an encrypted segment is decrypted transparently **iff** the store was
 * wired with its keystore — so the export is **cleartext**, and protecting it is on you.
 *
 * **Enumeration** = the registry's known set (segments with a committed cold generation) **plus** any explicit
 * {@link ExportOptions.candidates}. A brand-new **all-warm** segment — written only via real-time
 * `add()`/`remove()`, never compacted — isn't in the registry yet, so name it in `candidates` (CLI:
 * `CR_EXPORT_SEGMENTS`) to include it, or compact/bulk-load it once first. This mirrors the compaction daemon's
 * discovery contract (see `findCompactable`).
 *
 * **Per-segment fault isolation:** a segment that can't be read (a corrupt cold object, or an encrypted segment
 * when the store has no keystore) is recorded in the manifest's {@link ExportManifest.failed} list and the export
 * **continues** — one bad segment never blocks the rest. Its partial output is aborted, so a truncated file never
 * masquerades as complete. Therefore "a manifest exists" means *the run finished*, not that every segment
 * succeeded — check `failed` (the CLI also exits non-zero when it's non-empty).
 */
import type { CodecInterface } from '../core/codec';
import { requireCodec } from '../core/codec';
import type { IRegistryDriver, SegmentRef } from '../core/ports';
import { validateSegmentRef } from '../core/validate';

/** Output format for {@link runExport} / `CloudRoaring.exportSegments`. */
export type ExportFormat = 'roaring' | 'ndjson';

/** A writer for one segment's output — inject a filesystem file, an S3 upload, stdout, or a test buffer. */
export interface ExportWriter {
  /** Append bytes (called one or more times; for `ndjson`, batched line chunks; for `roaring`, once). */
  write(bytes: Uint8Array): Promise<void> | void;
  /** **Commit** the output — called once, only on success (all bytes written). Finalize/flush/rename here. */
  close(): Promise<void> | void;
  /**
   * **Discard** a partial output — called instead of `close()` if a fault occurs mid-segment, so a truncated file
   * never masquerades as complete (e.g. delete the temp file). Optional; sinks with nothing to undo can omit it.
   */
  abort?(): Promise<void> | void;
}

/** A destination the export writes each segment to. `ext` is `.roaring` or `.ndjson`. */
export interface ExportSink {
  open(ref: SegmentRef, ext: string): Promise<ExportWriter> | ExportWriter;
}

export interface ExportOptions {
  /** Output format; defaults to `'roaring'`. */
  readonly format?: ExportFormat;
  /**
   * Bitmap codec used to build the exported bitmap for the `'roaring'` format ([DECISIONS #58]). Optional in the
   * type so this stays call-compatible public API; a **flavor** package binds it (see `requireCodec`). Not needed
   * for `'ndjson'`, which streams plain ids.
   */
  readonly codec?: CodecInterface;
  /** Scope the export to one namespace; omit to export every registered segment. */
  readonly namespace?: string;
  /** `ndjson` flush threshold in ~bytes (ids are ASCII, so ≈ chars); defaults to 64 KiB. */
  readonly ndjsonBatchBytes?: number;
  /**
   * Extra segments to export beyond the registry's known set. The registry only lists segments with a committed
   * cold generation, so an **all-warm** segment (written via real-time `add()`/`remove()`, never compacted) must
   * be named here to be included (CLI: `CR_EXPORT_SEGMENTS`). Deduped against the registry set; when `namespace`
   * is set, only candidates in that namespace are exported.
   */
  readonly candidates?: readonly SegmentRef[];
}

/** Per-segment result recorded in the {@link ExportManifest}. */
export interface ExportedSegment {
  readonly segment: string;
  readonly namespace?: string;
  /** Ids written (the segment's effective cardinality at export time). */
  readonly count: number;
  /** Bytes written to the sink for this segment. */
  readonly bytes: number;
}

/**
 * A segment that could **not** be exported — recorded rather than aborting the whole run (fault isolation), so a
 * single corrupt/undecryptable segment never blocks the rest of the dump.
 */
export interface ExportFailure {
  readonly segment: string;
  readonly namespace?: string;
  /** Why it failed (an error message) — e.g. a corrupt cold object, or an encrypted segment with no keystore. */
  readonly error: string;
}

/** What {@link runExport} produced — a self-describing summary the CLI persists as `manifest.json`. */
export interface ExportManifest {
  /** Schema version of this manifest shape (currently `1`) — insurance for evolving the format post-1.0. */
  readonly version: number;
  readonly format: ExportFormat;
  readonly totalSegments: number;
  readonly totalIds: number;
  readonly segments: readonly ExportedSegment[];
  /**
   * Segments that could not be read (empty when everything succeeded). Its presence in the manifest is the point:
   * "a manifest exists" ⇒ the run finished, **not** that every segment succeeded — always check this list.
   */
  readonly failed: readonly ExportFailure[];
}

/** The minimal read surface the export needs from a store — a `CloudRoaring` satisfies this structurally. */
export interface SegmentReader {
  segment(name: string, options?: { namespace?: string }): { iterate(): AsyncIterable<number> };
}

const DEFAULT_NDJSON_BATCH_BYTES = 64 * 1024;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** A dedup key for a ref; namespace can't contain a space (grammar), and '' uniquely denotes the default ns. */
const refKey = (ref: SegmentRef): string => `${ref.namespace ?? ''} ${ref.segment}`;

/**
 * Export every enumerated segment's effective set through `sink`. Enumerates via `registry` (+ any
 * `options.candidates`), reads via `reader` (the store). Returns a manifest. `CloudRoaring.exportSegments` is the
 * public entry — it calls this with its own store + registry (so enumeration and the read path provably share one
 * registry).
 *
 * **Fault isolation:** a per-segment read/write fault aborts that segment's partial (so a truncated file never
 * looks complete), records it in `failed`, and the run continues — one bad segment never blocks the rest. A
 * `close()` fault is likewise recorded (never triggering `abort()` — they're mutually exclusive).
 *
 * Re-running overwrites the segments it re-exports but does **not** prune files for segments that have since
 * disappeared — export to a fresh directory for a clean dump. For a *current* image, run against a
 * freshly-constructed store: a store's cold source pins each segment's generation for its lifetime, so a
 * long-lived store that has since been compacted would export the pinned (stale) view.
 */
export async function runExport(
  reader: SegmentReader,
  registry: IRegistryDriver,
  sink: ExportSink,
  options: ExportOptions = {},
): Promise<ExportManifest> {
  const format = options.format ?? 'roaring';
  const ext = format === 'roaring' ? '.roaring' : '.ndjson';
  const batchCap = options.ndjsonBatchBytes ?? DEFAULT_NDJSON_BATCH_BYTES;
  const candidates = options.candidates ?? [];
  const segments: ExportedSegment[] = [];
  const failed: ExportFailure[] = [];
  let totalIds = 0;
  // Only track seen keys when there are candidates to dedup against — keeps the common (no-candidates) path from
  // building a set over the whole registry.
  const seen = candidates.length > 0 ? new Set<string>() : null;

  const exportRef = async (ref: SegmentRef): Promise<void> => {
    let writer: ExportWriter | undefined;
    let count = 0;
    let bytes = 0;
    try {
      validateSegmentRef(ref); // defense-in-depth: registry rows AND user-named candidates are untrusted here
      const ids = reader.segment(ref.segment, { namespace: ref.namespace }).iterate();
      writer = await sink.open(ref, ext);
      if (format === 'roaring') {
        const bm = requireCodec(options.codec, "runExport({ format: 'roaring' })").empty();
        for await (const id of ids) {
          bm.add(id);
          count += 1;
        }
        const out = bm.serialize(); // portable RoaringBitmap32 — the cross-language CRoaring format
        await writer.write(out);
        bytes = out.length;
      } else {
        let buf = '';
        for await (const id of ids) {
          buf += `${id}\n`;
          count += 1;
          if (buf.length >= batchCap) {
            const b = Buffer.from(buf, 'utf8');
            await writer.write(b);
            bytes += b.length;
            buf = '';
          }
        }
        if (buf.length > 0) {
          const b = Buffer.from(buf, 'utf8');
          await writer.write(b);
          bytes += b.length;
        }
      }
    } catch (err) {
      // Read/write fault: discard the partial (best-effort, so a failing cleanup can't mask the real fault),
      // record it, and move on — one bad segment never blocks the rest.
      if (writer !== undefined) {
        try {
          await writer.abort?.();
        } catch {
          /* best-effort cleanup */
        }
      }
      failed.push({ segment: ref.segment, namespace: ref.namespace, error: errMessage(err) });
      return;
    }
    // Commit outside the write try: a `close()` failure must NOT also trigger `abort()` (they're mutually
    // exclusive — abort on a write fault, close on success — so a custom sink never double-finalizes). A close
    // fault is still isolated: recorded, not thrown.
    try {
      await writer.close();
    } catch (err) {
      failed.push({ segment: ref.segment, namespace: ref.namespace, error: errMessage(err) });
      return;
    }
    segments.push({ segment: ref.segment, namespace: ref.namespace, count, bytes });
    totalIds += count;
  };

  for await (const rec of registry.list(options.namespace)) {
    if (rec.status === 'destroyed') continue; // crypto-shredded → bytes unrecoverable; nothing to export
    if (seen !== null) seen.add(refKey(rec));
    await exportRef({ segment: rec.segment, namespace: rec.namespace });
  }
  for (const ref of candidates) {
    if (options.namespace !== undefined && ref.namespace !== options.namespace) continue; // respect the ns filter
    const key = refKey(ref);
    if (seen !== null && seen.has(key)) continue; // already exported via the registry (or a duplicate candidate)
    seen?.add(key);
    await exportRef(ref);
  }
  return { version: 1, format, totalSegments: segments.length, totalIds, segments, failed };
}
