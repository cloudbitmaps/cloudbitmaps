#!/usr/bin/env node
/**
 * `export-segments` — the standalone **eject / data-export** CLI (the exit path; see the README's "Your data
 * stays yours"). Dumps every registered segment's current *effective* set to a portable file, so your data is
 * readable **without CloudRoaring**. A thin filesystem wrapper over `CloudRoaring.exportSegments`.
 *
 * Two formats:
 *   - `roaring` (default) — one portable RoaringBitmap32 per segment (`<segment>.roaring`), loadable by any
 *     roaring library (Java/Go/Python/Rust/C++/…).
 *   - `ndjson` — newline-delimited ids per segment (`<segment>.ndjson`), zero dependencies to read, streamed.
 *
 * Output layout: `<out>/<namespace|_default>/<segment>.<ext>` + a self-describing `<out>/manifest.json`. Files
 * are written to a unique `.part` temp and atomically renamed on completion; the manifest is written last (also
 * atomically), so a directory with a `manifest.json` means the run **finished** (a crash leaves no manifest →
 * re-run). A segment that couldn't be read is isolated into the manifest's `failed[]` and the CLI exits non-zero
 * — always check it, because "manifest present" is *the run finished*, not "every segment succeeded". Re-running
 * overwrites the segments it re-exports but does **not** prune files for segments that have since disappeared —
 * **export to a fresh directory** for a clean dump. Artifacts are owner-only (decrypted **cleartext** — protect it).
 *
 * Ships the **local-filesystem** backend (zero-dependency, the dev/reference target). For a cloud store, wire a
 * ~10-line script that builds an `S3ColdDriver` (+ `DynamoDb*`/`S3RegistryDriver`) + a `CloudRoaring`, and calls
 * `store.exportSegments(sink, { format })` with your own sink — the binary stays SDK-free.
 *
 * Config is read from the environment (12-factor-friendly):
 *   CR_EXPORT_ROOT       (required) — the local-filesystem root holding cold/ warm/ registry/
 *   CR_EXPORT_OUT        (required) — the output directory for the dump
 *   CR_EXPORT_FORMAT     roaring | ndjson                (default: roaring)
 *   CR_EXPORT_NAMESPACE  scope the export to one namespace
 *   CR_EXPORT_SEGMENTS   comma-separated extra segments to include (all-warm / not-yet-registered): `seg` or `ns/seg`
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSegmentRef } from '@cloudbitmaps/core';
import {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  LocalFsWarmDriver,
} from '../index';
import type { ExportFormat, ExportManifest, ExportSink, SegmentRef } from '../index';

export interface ExportConfig {
  readonly root: string;
  readonly out: string;
  readonly format: ExportFormat;
  readonly namespace?: string;
  /** Extra segments to include beyond the registry (all-warm / not-yet-registered); from `CR_EXPORT_SEGMENTS`. */
  readonly segments?: readonly SegmentRef[];
}

/**
 * Parse `CR_EXPORT_SEGMENTS` — comma-separated `segment` or `namespace/segment` entries — into refs, or
 * `undefined` when unset/empty. Names are validated up front so a typo fails fast rather than silently landing in
 * the manifest's `failed[]`.
 */
function parseSegments(raw: string | undefined): readonly SegmentRef[] | undefined {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return undefined;
  return entries.map((entry) => {
    const slash = entry.indexOf('/'); // segment/namespace names can't contain '/', so the first one splits cleanly
    const ref: SegmentRef =
      slash === -1
        ? { segment: entry }
        : { namespace: entry.slice(0, slash), segment: entry.slice(slash + 1) };
    validateSegmentRef(ref); // fail fast on a bad name (empty part, illegal chars)
    return ref;
  });
}

/** Parse + validate config from an environment map. Throws a clear `Error` on misconfiguration. */
export function parseConfig(env: Record<string, string | undefined>): ExportConfig {
  const root = env.CR_EXPORT_ROOT;
  if (root === undefined || root === '') {
    throw new Error('CR_EXPORT_ROOT is required (the local-filesystem storage root)');
  }
  const out = env.CR_EXPORT_OUT;
  if (out === undefined || out === '') {
    throw new Error('CR_EXPORT_OUT is required (the output directory for the dump)');
  }
  const format = env.CR_EXPORT_FORMAT ?? 'roaring';
  if (format !== 'roaring' && format !== 'ndjson') {
    throw new Error(`CR_EXPORT_FORMAT must be "roaring" or "ndjson"; got ${format}`);
  }
  const namespace = env.CR_EXPORT_NAMESPACE || undefined; // treat '' (an unset shell var) as "no filter"
  return { root, out, format, namespace, segments: parseSegments(env.CR_EXPORT_SEGMENTS) };
}

/**
 * A filesystem {@link ExportSink}. Writes each segment to a **unique** `<segment><ext>.<uuid>.part` temp
 * (`O_EXCL` create, mode `0o600`) and atomically renames it into `<out>/<namespace>/<segment><ext>` on `close()`,
 * so a half-written file never masquerades as complete and concurrent exports to the same dir can't clobber one
 * another. Uses a `FileHandle` (not `createWriteStream`) so an I/O fault **rejects the write** rather than
 * emitting an unhandled `'error'` event that would crash the process, and loops on short writes so a partial
 * `write()` never truncates the output. Artifacts are **owner-only** (dir `0o700`, files `0o600`) — cleartext.
 */
export function fsSink(out: string): ExportSink {
  return {
    async open(ref: SegmentRef, ext: string) {
      const dir = join(out, ref.namespace ?? '_default');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const finalPath = join(dir, `${ref.segment}${ext}`);
      const tmpPath = `${finalPath}.${randomUUID()}.part`;
      const handle = await open(tmpPath, 'wx', 0o600); // wx = create-exclusive; unique name ⇒ no collision
      return {
        async write(bytes: Uint8Array): Promise<void> {
          // Loop until every byte lands — FileHandle.write may do a short write; it rejects on I/O error (no
          // stray 'error' event → no process crash).
          let off = 0;
          while (off < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, off, bytes.length - off);
            if (bytesWritten === 0) throw new Error('export write made no progress');
            off += bytesWritten;
          }
        },
        async close(): Promise<void> {
          await handle.close();
          try {
            await rename(tmpPath, finalPath);
          } catch (err) {
            await rm(tmpPath, { force: true }); // don't strand the temp if the rename fails
            throw err;
          }
        },
        async abort(): Promise<void> {
          // Discard the partial; best-effort so a failing cleanup never masks the caller's original fault.
          await handle.close().catch(() => {});
          await rm(tmpPath, { force: true });
        },
      };
    },
  };
}

const log = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

/** CLI entry: build a LocalFs store, export every enumerated segment, then write the manifest. */
export async function main(
  env: Record<string, string | undefined> = process.env,
  now: () => number = () => Date.now(),
): Promise<ExportManifest> {
  const config = parseConfig(env);
  const registry = new LocalFsRegistryDriver(join(config.root, 'registry'));
  const store = new CloudRoaring({
    cold: new LocalFsColdDriver(join(config.root, 'cold')),
    warm: new LocalFsWarmDriver(join(config.root, 'warm')),
    registry,
  });

  const manifest = await store.exportSegments(fsSink(config.out), {
    format: config.format,
    namespace: config.namespace,
    candidates: config.segments,
  });

  // The manifest is written LAST (after every segment file is committed), so its presence marks a finished run —
  // and it's written the same atomic (temp→rename) way, so the marker itself can't be torn by a crash mid-write.
  // Owner-only (0o600) — the dump is cleartext. (A finished run may still have skipped unreadable segments — see
  // `manifest.failed`.)
  await mkdir(config.out, { recursive: true, mode: 0o700 });
  const manifestPath = join(config.out, 'manifest.json');
  const manifestTmp = `${manifestPath}.${randomUUID()}.part`;
  await writeFile(
    manifestTmp,
    `${JSON.stringify({ generatedAt: new Date(now()).toISOString(), ...manifest }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  try {
    await rename(manifestTmp, manifestPath);
  } catch (err) {
    await rm(manifestTmp, { force: true });
    throw err;
  }
  // Log AGGREGATES only — never per-segment names/counts (a segment name can encode sensitive purpose, and stdout
  // is captured by CI/journald/docker, which don't honor the 0o600 boundary). The detail lives in the manifest.
  log({
    event: 'export',
    out: config.out,
    version: manifest.version,
    format: manifest.format,
    totalSegments: manifest.totalSegments,
    totalIds: manifest.totalIds,
    failed: manifest.failed.length,
  });
  return manifest;
}

// Run only when invoked directly (not when imported by tests). See compact-segments for the URL-compare rationale.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((manifest) => {
      if (manifest.failed.length > 0) {
        // The run finished and the manifest is written, but some segments couldn't be read — signal it non-zero.
        process.stderr.write(
          `${manifest.failed.length} segment(s) failed to export; see manifest.json "failed"\n`,
        );
        process.exitCode = 1;
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
}
