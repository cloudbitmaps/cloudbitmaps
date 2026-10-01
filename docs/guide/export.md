# Export your data

Getting your data out.

## Export / eject your data

Your data isn't locked in. `store.exportSegments(sink, options)` dumps **every registered segment's current
generation** through an injected sink, using only public read APIs — so it's readable **without CloudBitmaps**.
Two formats:

- `roaring` (default) — one **portable RoaringBitmap32** per segment (`<segment>.roaring`), loadable by any
  roaring library (Java/Go/Python/Rust/C++/…).
- `ndjson` — newline-delimited ids per segment (`<segment>.ndjson`), zero dependencies to read, streamed.

The `export-segments` CLI wraps it with a filesystem sink (each file written to a unique `.part` temp then
atomically renamed; artifacts are owner-only `0o600`) and writes a self-describing `manifest.json` **last** (also
atomically) — so a directory with a `manifest.json` means the run **finished** (a crash leaves none → just
re-run). It exits non-zero if any segment couldn't be read (see _fault isolation_ below):

```bash
CR_EXPORT_ROOT=./.cloudbitmaps CR_EXPORT_OUT=./dump pnpm exec export-segments
# → dump/manifest.json + dump/<namespace|_default>/<segment>.roaring   (CR_EXPORT_FORMAT=ndjson for .ndjson)
# CR_EXPORT_NAMESPACE=eu             scope the dump to one namespace
# CR_EXPORT_ROOT holds the local-filesystem store: <root>/storage and <root>/registry
```

In-process (any store built on a backend), with your own sink (an fs writer, an S3 upload, stdout, a test buffer):

```ts
import type { ExportSink } from '@cloudbitmaps/roaring';
const mySink: ExportSink = /* your sink: open(ref, ext) → { write, close, abort? } */;
const manifest = await store.exportSegments(mySink, {
  format: 'roaring', // or 'ndjson'
  namespace: 'eu', // optional: scope to one namespace
});
// manifest: { version, format, totalSegments, totalIds,
//             segments: [{ segment, namespace?, count, bytes }],
//             failed:   [{ segment, namespace?, error }] }   // segments that couldn't be read (see below)
// (the CLI's manifest.json also carries a `generatedAt` timestamp.)
```

Reading a `.roaring` file back needs **no CloudBitmaps** — any roaring library deserializes the portable format:

```ts
import { readFileSync } from 'node:fs';
import roaring from 'roaring';
const { RoaringBitmap32, DeserializationFormat } = roaring;
const ids = RoaringBitmap32.deserialize(readFileSync('dump/_default/vips.roaring'), DeserializationFormat.portable).toArray();
```

Notes: `exportSegments` needs a store built on a backend, for its registry (it throws `UnsupportedError`
otherwise). Enumeration is the registry's known set, and **every loaded segment has a row** — the publish writes
it — so the registry is complete by construction; build the store on the backend the loads used.
Encrypted segments are **decrypted** transparently if the store has the keystore — so the export is **cleartext**
(protect it). Crypto-shredded segments are skipped.

**Fault isolation.** A segment that can't be read — a corrupt storage object, or an encrypted segment when the store
has no keystore (the CLI wires none, so it can't decrypt those) — is recorded in the manifest's `failed[]` and the
export **continues**; one bad segment never blocks the rest, and its partial output is discarded. So "a
`manifest.json` exists" means the run _finished_, not that every segment succeeded — always check `failed` (the CLI
also exits non-zero when it's non-empty).

Re-running overwrites the segments it re-exports but does **not** prune files for segments that have since
disappeared — export to a **fresh directory** for a clean dump. For a *current* dump, run against a freshly-built
store (a long-lived store with a registry and a `cache.genTtlMs` above 0 may be up to that long behind a publish,
and one missing either has no such bound — the CLI builds a fresh store per run). Each segment is read live, so a
publish while a long segment exports can leave its file holding chunks of two generations; for a *consistent* dump,
of one segment or across segments, pause your loads or export from a quiet window. This is also a building
block for a **data-portability** response. See [`PRIVACY.md`](../../PRIVACY.md) and the README's "Your data stays
yours".
