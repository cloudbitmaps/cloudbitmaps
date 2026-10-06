# Export your data

Your data is not locked in. `store.exportSegments(sink, options)` writes **every registered segment's current
generation** through a sink you provide, using only public read APIs, so the result is readable without CloudBitmaps.
It works on a store built on any backend: memory, local disk, S3, GCS or Azure Blob.

Two formats:

- `roaring` (default): one portable RoaringBitmap32 per segment (`<segment>.roaring`), loadable by any Roaring library
  (Java, Go, Python, Rust, C++ and others).
- `ndjson`: newline-delimited ids per segment (`<segment>.ndjson`), streamed, with nothing to install to read it.

## Export a store of any kind

A sink is an object with one method, `open(ref, ext)`, which returns a writer for one segment. This minimal sink writes
one file per segment under `./dump`:

```ts
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportSink } from '@cloudbitmaps/roaring';

const sink: ExportSink = {
  async open(ref, ext) {
    const dir = join('dump', encodeURIComponent(ref.namespace ?? '_default'));
    const path = join(dir, `${encodeURIComponent(ref.segment)}${ext}`);
    await mkdir(dir, { recursive: true });
    const file = await open(path, 'w');
    return {
      write: (bytes) => file.appendFile(bytes), // writes every byte; file.write() may write fewer
      close: () => file.close(), // commit: called once, only when every byte was written
      abort: async () => {
        await file.close(); // discard a partial file so a truncated one never looks complete
        await rm(path, { force: true });
      },
    };
  },
};

const manifest = await store.exportSegments(sink, {
  format: 'roaring', // or 'ndjson'
  namespace: 'eu', // optional: scope to one namespace
});
// manifest: { version, format, totalSegments, totalIds,
//             segments: [{ segment, namespace?, count, bytes }],
//             failed:   [{ segment, namespace?, error }] }   // segments that could not be read (see below)
```

Your sink can write anywhere: a file, an S3 upload, stdout, a test buffer. `write` receives bytes, `close` commits a
segment, and `abort` (optional) discards a partial one.

## Export from the command line (local filesystem only)

The `export-segments` command wraps `exportSegments` with a filesystem sink. **It reads a local-filesystem store
only**: `CR_EXPORT_ROOT` must be the root of a `LocalFsStorage`. It cannot read an S3, GCS or Azure Blob store. For
those, call `store.exportSegments(sink)` in code, as above.

```bash
CR_EXPORT_ROOT=./.cloudbitmaps CR_EXPORT_OUT=./dump pnpm exec export-segments
# → dump/manifest.json + dump/<namespace|_default>/<segment>.roaring   (CR_EXPORT_FORMAT=ndjson for .ndjson)
# CR_EXPORT_NAMESPACE=eu             scope the dump to one namespace
# CR_EXPORT_ROOT holds the local-filesystem store: <root>/storage and <root>/registry
```

Each file is written to a unique `.part` temp file and then renamed atomically, and artifacts are owner-only (`0o600`).
The command writes a self-describing `manifest.json` last, also atomically, so a directory with a `manifest.json`
means the run finished. A crash leaves none, so re-run. The command exits non-zero if any segment could not be read.
The manifest of a command run also carries a `generatedAt` timestamp.

## Read an export back

A `.roaring` file needs no CloudBitmaps: any Roaring library deserializes the portable format.

```ts
import { readFileSync } from 'node:fs';
import roaring from 'roaring';
const { RoaringBitmap32, DeserializationFormat } = roaring;
const ids = RoaringBitmap32.deserialize(
  readFileSync('dump/_default/vips.roaring'),
  DeserializationFormat.portable,
).toArray();
```

And a store loads one straight back, with no per-id work:
`await store.load({ segment: 'vips' }, { serialized: readFileSync('dump/_default/vips.roaring') })`
([what a load accepts](loading.md#what-a-load-accepts)).

## Things to know

- **A copy of the bucket is not an export.** A raw copy holds every generation in the bucket, including ones that were
  never current. A cleartext segment's `.crbm` objects wrap standard portable Roaring chunks that any Roaring library
  reads, but which generation is current is recorded only in the segment's registry row, in CloudBitmaps' own format,
  and the highest generation in the bucket is not always the current one: a load that died before it published, and a
  rollback, leave objects above the pointer. An encrypted segment's objects also need the wrapped key in its registry
  row and your KEK. `exportSegments` reads each segment's current generation and decrypts it, so it is the route to use.
- **It needs a store built on a backend**, for the registry. Otherwise it throws `UnsupportedError`. Every loaded
  segment has a registry row (the publish writes it), so the registry is complete by construction. Build the store on
  the backend the loads used.
- **Encrypted segments are decrypted** transparently if the store has the keystore, so the export is **cleartext**.
  Protect it. Crypto-shredded segments are skipped.
- **A segment that cannot be read does not stop the run.** A corrupt storage object, or an encrypted segment when the
  store has no keystore (the command wires none, so it cannot decrypt those), is recorded in the manifest's `failed[]`.
  The export continues, and that segment's partial output is discarded. So "a `manifest.json` exists" means the run
  finished, not that every segment succeeded. Always check `failed`.
- **Re-running overwrites the segments it re-exports but does not prune files for segments that have since
  disappeared.** Export to a fresh directory for a clean dump.
- **For a current dump, use a freshly built store.** A long-lived store may be up to `cache.genTtlMs` behind a publish
  (see [how soon a reader sees a new load](reading.md#how-soon-a-reader-sees-a-new-load)); the command builds a fresh
  store per run.
- **Each segment is exported as one instant.** The export pins a segment when it begins it: the generation is resolved
  once, and only that generation's object is read for the whole segment, so a load that publishes meanwhile cannot put
  chunks of two generations in one file. That is one registry read per segment, beside the tail read the export already
  makes, so it adds no request. A pin holds nothing: if a collection or an erasure removes the pinned generation while
  the segment is still being read, that segment fails with the error a pinned read gets, is recorded in `failed[]` and
  its partial output is discarded, and it never reads the newer generation. Different segments are different instants:
  a dump of several segments is not a snapshot of the store. Pause your loads, or export from a quiet window, for that.

This is also a building block for a data-portability response. See [`PRIVACY.md`](../../PRIVACY.md) and the README's
[Your data stays yours](../../README.md#your-data-stays-yours).
