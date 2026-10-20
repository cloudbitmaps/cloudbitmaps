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

<!-- typecheck: store -->
```ts
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportSink } from '@cloudbitmaps/roaring';

// One path component per name: `encodeURIComponent` escapes `/` and `\`, a leading `_` is escaped so no namespace
// lands in `_default`, and `.`, `..` and the empty name, which would leave `dump`, are refused, as is a name Windows
// keeps for a device.
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function part(name: string): string {
  const p = encodeURIComponent(name).replace(/^_/, '%5F');
  if (p === '' || p === '.' || p === '..' || DEVICE.test(p)) {
    throw new Error(`no file for the name ${JSON.stringify(name)}`);
  }
  return p;
}

const sink: ExportSink = {
  async open(ref, ext) {
    const dir = join('dump', ref.namespace === undefined ? '_default' : part(ref.namespace));
    const path = join(dir, `${part(ref.segment)}${ext}`);
    await mkdir(dir, { recursive: true });
    const file = await open(path, 'wx'); // never over another segment's file: a clash lands in `failed`
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
//             failed:   [{ segment, namespace?, error }],              // segments that could not be read (see below)
//             skipped:  [{ segment, namespace?, reason: 'destroyed' }] } // tombstones: nothing to export
```

A name may be any non-empty string, so the sink refuses a name that would step out of `dump` (`.`, `..`) or that
Windows keeps for a device (`con`, `nul`, `com1`), and writes each file with `wx`: a second segment that maps to the
same file, by letter case on a filesystem that ignores it or by a trailing dot Windows drops from a directory name, is
recorded in `failed` rather than written over the first. Export to a fresh directory: `wx` also refuses a file an
earlier run left.

Your sink can write anywhere: a file, an S3 upload, stdout, a test buffer. `write` receives a `Uint8Array` (for
`ndjson`, a plain one, not a Node `Buffer`: decode text with `new TextDecoder().decode(bytes)`), `close` commits a
segment, and `abort` (optional) discards a partial one.

## Export from the command line (local filesystem only)

The `export-segments` command wraps `exportSegments` with a filesystem sink. **It reads a local-filesystem store
only**: `CR_EXPORT_ROOT` must be the root of a `LocalFsStorage`. It cannot read an S3, GCS or Azure Blob store. For
those, call `store.exportSegments(sink)` in code, as above.

```bash
CR_EXPORT_ROOT=./.cloudbitmaps CR_EXPORT_OUT=./dump pnpm exec export-segments
# → dump/manifest.json + dump/<namespace|_default>/<segment>.roaring   (CR_EXPORT_FORMAT=ndjson for .ndjson)
# CR_EXPORT_ROOT (required) holds the local-filesystem store: <root>/storage and <root>/registry
# CR_EXPORT_OUT  (required) is the directory the dump goes to
# CR_EXPORT_NAMESPACE=eu    (optional) scope the dump to one namespace
```

`pnpm exec export-segments --help` (or `-h`) prints these settings and exits 0. The command takes no other argument: one
prints the usage on stderr and exits 2, and a missing `CR_EXPORT_ROOT` or `CR_EXPORT_OUT` exits 1 with a message that
says what the variable is, names the other one and points at `--help`. A leading `--`, which `pnpm run` forwards, is
ignored.

Each file is written to a unique `.part` temp file and then renamed atomically, and artifacts are owner-only (`0o600`).
The command writes a self-describing `manifest.json` last, also atomically, so a directory with a `manifest.json`
means the run finished. A re-run removes the last run's `manifest.json` before it writes anything, so a crash leaves
none, and you re-run. The command exits non-zero if any segment could not be read, and before it writes anything if
`CR_EXPORT_ROOT` does not exist or is empty (a typo, or a volume that is not mounted), which would otherwise export
nothing and report a finished run.
The manifest of a command run also carries a `generatedAt` timestamp.

## Read an export back

A `.roaring` file needs no CloudBitmaps: any Roaring library deserializes the portable format. This sample imports
the `roaring` package from npm (the native bitmap library, not `@cloudbitmaps/roaring`), so add it to your own
`package.json` first ([which version](loading.md#what-a-load-accepts)).

<!-- typecheck -->
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
  Protect it. A destroyed segment (crypto-shredded, destroyed in the clear or dropped) resolves no
  generation, so it is skipped and listed in the manifest's `skipped[]`: with `segments` and `failed`, the manifest
  accounts for every segment row the registry
  listed. (The registry's internal due-index rows are not segments, and are in none of the three.) A segment
  destroyed after the listing named it and before its export began is skipped the same way: when a segment yields no
  ids, its row is read again, and a row now destroyed or gone is recorded in `skipped[]` and no file is committed.
- **The command refuses a namespace named `manifest.json`, in any letter case.** Its directory would be the manifest's
  path (on a filesystem that ignores case, `Manifest.json` is the same path), so each of its segments is recorded in
  `failed[]` with a `ValidationError` message, and the run still writes its manifest and exports every other namespace.
  An output directory that already holds a directory named `manifest.json` is refused up front with a `ValidationError`
  telling you to remove or rename it; the command never deletes it. A namespace directory left empty because every
  segment in it was skipped is removed.
- **A segment that cannot be read does not stop the run.** A corrupt storage object, or an encrypted segment when the
  store has no keystore (the command wires none, so it cannot decrypt those), is recorded in the manifest's `failed[]`.
  The export continues, and that segment's partial output is discarded. So "a `manifest.json` exists" means the run
  finished, not that every segment succeeded. Always check `failed`.
- **An export carries ids, not the segment's other state.** A file holds the ids of the segment's current generation and
  nothing else: not its generation metadata, its `retention` and `residency` policy, its leases, nor the older
  generations `keep` retained. If you will load the files into a new prefix, save beside each file the segment's
  generation metadata (`seg.stat()`) and its row's whole `retention` and `residency` objects
  (`backend.registry.get(ref)`). After each load, read the row the load created (`const row = await
  backend.registry.get(ref)`) and write back the ones the old row had with `backend.registry.compareAndSwap(ref,
  row.token, { retention, residency })`, since `store.setRetention` writes `expiresAt` alone; then, for a policy with an
  `expiresAt`, call `store.setRetention(ref, { expiresAt })` as well, which keeps your other keys and files the segment
  in the retention sweep's due index. A destroyed segment (crypto-shredded, destroyed in the clear or dropped) is
  skipped
  (`manifest.skipped`), and the registry row that records its destruction stays in the prefix you export from, so keep
  your own record of it.
  A file also holds what the segment held when it was read, so run again every erasure processed since the export
  began.
- **Moving a store to a release that reads a newer registry schema.** A store refuses a row stamped with an older schema
  with `UnsupportedError`, naming its key; there is no upgrade in place. Export every segment with the release that
  wrote the rows, load the files into a new prefix with the new release and the same `encryption` options, restore each
  row's `retention` and `residency` as above, re-run every erasure processed since the export began, move every reader
  and writer to the new prefix, and then delete the old prefix, with its noncurrent versions, delete markers and
  soft-deleted objects where the storage keeps them. The release's changelog entry on the registry schema has the full
  steps.
- **A re-run of the command overwrites the segments it re-exports but does not prune files for segments that have
  since disappeared.** Export to a fresh directory for a clean dump; the sample sink above needs one every time.
- **It checks the namespace directories it writes into, not the output directory itself.** A namespace directory it finds
  already there passes when an earlier run left it (yours and owner-only). A symlink, a path that is not a directory, a
  directory of another user, or one open to group or others in its place is refused with a `ValidationError`. The check
  reads the directory and then creates the file by path, so it is not proof against a process that changes the directory
  between the two, and `CR_EXPORT_OUT` itself is used as given. Point it at a directory only you can write to.
- **Each segment is exported as one instant.** The export pins a segment when it begins it: the generation is read from
  the registry then, on a warm store as on a cold one, and only that generation's object is read for the whole segment,
  so a load that publishes meanwhile cannot put chunks of two generations in one file. A cold store makes one registry
  read and one tail read per segment; a warm store makes one registry read per segment. A pin holds nothing: if a
  collection or an erasure removes the pinned generation while the segment is still being read, that segment fails with
  the error a pinned read gets, is recorded in `failed[]` and its partial output is discarded, and it never reads the
  newer generation. Different segments are different instants: a dump of several segments is not a snapshot of the
  store. Pause your loads, or export from a quiet window, for that.

This is also a building block for a data-portability response. See [`PRIVACY.md`](../../PRIVACY.md) and the README's
[Your data stays yours](../../README.md#your-data-stays-yours).
