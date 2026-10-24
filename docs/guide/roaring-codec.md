# Our own Roaring: the codec inside `@cloudbitmaps/roaring`

`@cloudbitmaps/roaring` keeps its bitmaps with a Roaring implementation of its own, written in TypeScript on typed
arrays, with no native code. This page says what that is, what it guarantees (the same portable bytes as CRoaring, byte
for byte) and the evidence for it, what it costs and gains against the native codec, which two names of it you can use by
itself today, and where it is not yet available as a package of its own.

Everything here is about the current release. Each figure says whether it was **measured** (a run named here took it),
**derived** (computed from measured figures by the rule beside it) or **expected** (what the code is expected to do, not
taken).

## What it is

```
  your code
     |  CloudRoaring.load / segment.has / intersect ...
     v
  CloudRoaring facade ----> SegmentEngine (core: codec-agnostic; caches, fetches, combines chunks)
                                |
                                v
                           the codec seam  (packages/core/src/core/codec.ts)
                                |
                                v
                  our Roaring: tsRoaringCodec   (packages/roaring/src/ts-roaring/)
                  one bitmap = sorted 16-bit keys + one container each:
                      array (up to 4,096 values)  |  bitset (8,192 bytes)  |  run (only when strictly smaller)
```

A stored chunk (`segment.<gen>.crbm`) holds a portable Roaring bitmap of one container; the engine decodes only the chunks
a read needs. The codec is the store's only codec: no public entry exports it, and a store cannot be configured with
another.

What "no native code" changes for you:

- no install script to allow, no prebuilt binary to download, nothing to rebuild when Node's major version changes, and
  the install is the same under `--ignore-scripts`;
- no package of this family depends on `roaring` (the npm binding of CRoaring). It stays a pinned development
  dependency: the tests hold this codec to it, as the reference.

What stays the same: a project that imports `roaring` itself (the samples that build a bitmap do) still installs and
allows it, as that package documents ([the note in Loading in depth](loading.md#what-a-load-accepts)).

## The guarantee: the same bytes

**Claim.** For the same set, this codec writes the same portable Roaring bytes CRoaring writes, after both optimize, and it
reads every well-formed portable bitmap CRoaring writes. So a `.crbm` generation, a `{ serialized }` input and an
`exportSegments` file written through one codec are read by the other, and the same set written twice is the same object.
The stored-byte rule that fixes those bytes (the container kind from the cardinality and the run count, and a run only
when strictly smaller than the plain body) is written in [the format](../format.md#3-the-chunk-payload-region).

**What the claim does not say.** It is about the bytes of one optimized bitmap, not about unoptimized bytes, and it holds
to the one CRoaring version the tests pin: the bytes CRoaring writes where a run and an array tie changed between
CRoaring versions, so the pin moves only by a deliberate edit and the rule does not move with it.

| claim | evidence (all in this repository) |
|---|---|
| the same bytes as CRoaring for every set tried | the differential oracle [`tests/roaring/codec-oracle.test.ts`](../../tests/roaring/codec-oracle.test.ts), with its helper [`tests/helpers/roaring-oracle.ts`](../../tests/helpers/roaring-oracle.ts): per case, build then `optimize()` then `serialize()` is byte-identical to CRoaring's stored bytes and to the rule written from the format document alone, and contents and results agree with a plain `Set`. The generators are biased to container boundaries and run ties. 40 properties on a pull request, 200 at full strength (nightly) |
| the same refusals as the repository's structural check, and the same set from every accepted input | [`tests/roaring/codec-oracle-hostile.test.ts`](../../tests/roaring/codec-oracle-hostile.test.ts): `IntegrityError` exactly where the layout check throws, a refusal over the size cap before any byte is read, trailing bytes refused when one bitmap is required, and the same set CRoaring decodes from every accepted input; mutated payloads, 10,000 on a pull request and 100,000 at full strength |
| the reference has not moved | [`tests/roaring/oracle-pin.test.ts`](../../tests/roaring/oracle-pin.test.ts) checks the pinned `roaring` version and the CRoaring version it bundles |
| hostile bytes do not crash or corrupt | the coverage-guided target [`fuzz/targets/safe-deserialize.mjs`](../../fuzz/targets/safe-deserialize.mjs) feeds adversarial bytes to this codec's safe decode every night ([`fuzz-nightly.yml`](../../.github/workflows/fuzz-nightly.yml)); the committed reproducers are replayed on every pull request by [`tests/core/crbm/fuzz-corpus.test.ts`](../../tests/core/crbm/fuzz-corpus.test.ts); only `deser` fuzzes the codec's decode, and `crbm` reaches it by opening valid seed segments; the `index` and `ext` targets fuzz the parsers beside it, not the codec ([`fuzz/README.md`](../../fuzz/README.md)) |
| the store works on it | the flavor, core, engine and driver suites run on this codec by default, and [`tests/roaring/codec-switch.test.ts`](../../tests/roaring/codec-switch.test.ts) fails if another codec is in force; [`full-nightly.yml`](../../.github/workflows/full-nightly.yml) runs the whole suite at full strength |

**What is still open.** The oracle proves what CRoaring writes for the pinned version, not what every other Roaring
library writes. "A codec no more than 5% slower" is a measured bar, not a bound. A week of nightly fuzz with no difference
on this codec was not yet judged when the comparison was taken, and as of 2026-10-23 the switch has not merged, so that
judgement is still pending; the comparison's report says so.

### Mixing codecs and tools

Because the bytes are the standard portable format, a generation this codec wrote is readable by CRoaring-based tools, and
`exportSegments` with `'roaring'` writes files that load in any Roaring library. Two worked examples, from the module's own
README:

```
{5, 7}     20 bytes, an array:          {0..9}    15 bytes, a run (run body 6 < array body 20):
3a 30 00 00   cookie 12346               3b 30 00 00   cookie 12347
01 00 00 00   1 container                01            container 0 is a run
00 00 01 00   key 0, cardinality - 1     00 00 09 00   key 0, cardinality - 1 = 9
10 00 00 00   body at byte 16            01 00         1 run
05 00 07 00   the values 5 and 7         00 00 09 00   start 0, length - 1 = 9
```

## What it costs and gains against native

The comparison is on one Apple M3 Pro under Node v24.22.1, through the store with a warm cache, 31 rounds a figure, each
figure beside an A/A control. The figures, the method and the commits are on
[the benchmarks page](../benchmarks.md#the-typescript-codec-against-native); the record is
[`bench/ts-codec-comparison-results.json`](../../bench/ts-codec-comparison-results.json) and its report
[`bench/ts-codec-comparison.md`](../../bench/ts-codec-comparison.md). The summary, each **measured**, one machine,
wall-clock, recorded and not asserted:

- **Reads** (`has`, `count`, `iterate`, `intersect`, `andNot`, one codec per process): every cell inside the 5% bar. The
  worst is dense four-operand `intersect` at +3.4%. Sparse `intersect` is 37% to 40% faster, and the spread sets about 8% to 17%.
- **Bulk load, warm:** 183.1 ms to 117.2 ms (-35.6%) for a million ids; an erasure's rewrite -33.8%; an export -14.1%.
- **First `load` of two small segments (128 mixed chunks) in a fresh process:** 13.1% slower (135.02 ms to 153.0 ms), and the first `has` +6.6%. This is a loss.
- **Start-up:** the codec's module loads in 1.1 ms against 19.5 ms (-94.2%).
- **Memory:** in V8's counters, a cached dense chunk holds about 8.9 KB more than the native codec's V8-visible figure (the
  native codec keeps part of its memory outside those counters, and how much is not measured); no multiple of native's
  memory is claimed.
- **No union cell:** the store comparison times `intersect` and `andNot`, not `union`. One container pair of `or` is 1.2 to
  4.2 times slower in the per-operation record (measured on 2026-10-21 on an Apple M3 Pro under Node v24.18.1 at commit `7bf70e54`; the kernels changed after that commit (clone sharing, intersect and difference paths), so this figure is to be re-measured), and that does not show in the combines that were timed through the store.
  What a store `union` costs on this codec is expected to be inside the same bar, and is not measured.
- **Not measured:** in region against real S3, Alpine, arm64 Lambda; Bun and Deno ran a local self-check only. CI runs Node
  22 and 24.

The event-loop figures in [Before production](production.md#what-blocks-the-event-loop-and-where-to-run-it) and the
in-region and at-scale figures on the benchmarks page are the native codec's, and say so.

## What you can use by itself

Two names from `@cloudbitmaps/roaring` give you this codec's bitmap without a store:

- `deserializePortable(bytes: Uint8Array): ReadonlyBitmap` decodes the portable bytes of one bitmap you hold (a Node
  `Buffer` is one) through the check a `{ serialized }` load makes: the 537,403,396-byte cap, the structural check, exactly
  one bitmap (trailing bytes are refused), then the decoder. An empty buffer is the empty bitmap.
- `ReadonlyBitmap` (a type): `size`, `has(id)`, iteration in ascending order (a promise), and `serialize('portable')`
  (exactly that argument). Any other member throws `TypeError`.

```js
import { RoaringBitmap } from '@cloudbitmaps/roaring';

// The portable bytes of the set {5, 7}: 20 bytes, one array container.
const bytes = Uint8Array.from([
  0x3a, 0x30, 0x00, 0x00, // cookie 12346
  0x01, 0x00, 0x00, 0x00, // one container
  0x00, 0x00, 0x01, 0x00, // key 0, cardinality - 1 = 1
  0x10, 0x00, 0x00, 0x00, // the body starts at byte 16
  0x05, 0x00, 0x07, 0x00, // the values 5 and 7
]);

const bitmap = RoaringBitmap.deserialize(bytes); // ValidationError unless it is exactly one well-formed bitmap
console.log(bitmap.size); // 2
console.log(bitmap.has(5), bitmap.has(6)); // true false
console.log([...bitmap]); // [ 5, 7 ]
console.log(bitmap.serialize('portable').length); // 20
```

The example is run by [`tests/docs/roaring-codec-example.test.ts`](../../tests/docs/roaring-codec-example.test.ts).

The bitmap is not a `RoaringBitmap32`: its class is not part of the contract (no `instanceof`, no cast),
`JSON.stringify` of it gives `"{}"` (write `JSON.stringify([...bitmap])`), and it must not be passed to the `roaring`
package's methods. It loads as `{ bitmap }`, or bare where ids go. The full contract is in
[the API reference](api-reference.md#decode-portable-bytes--deserializeportablebytes).

**What is not public.** You cannot build, add to, remove from, union, intersect or subtract bitmaps with this codec on
its own: the codec itself, its bitmap class and its containers are internal, and a store cannot be given a codec. For
set algebra on bitmaps you hold, decode the bytes with a Roaring library of your own after the check (the example in
[the API reference](api-reference.md#decode-portable-bytes--deserializeportablebytes) and
[the parts recipe](loading.md#parts-of-one-segment-built-separately) do): the bytes are the standard portable format,
which is the point of the guarantee. A public bitmap API in `@cloudbitmaps/roaring` itself, for building and combining
bitmaps with this codec, is planned for a coming release.

## Errors you can see from it

| you see | when | what to do |
|---|---|---|
| `IntegrityError` | a stored chunk fails the structural check: a bad cookie, keys out of order, an offset that is not where the container starts, a container that runs past the buffer, a bitset whose count differs from its header, bytes over the cap | the stored object is damaged or not a bitmap: [`checkConsistency()`](disaster-recovery.md) finds it, and a restore replaces it |
| `ValidationError` | bytes you supply (`deserializePortable`, a `{ serialized }` or `{ bitmap }` load) are not exactly one well-formed bitmap, with the structural message inside; an id that is not an integer from 0 to 4294967295 | fix the input: the message names the problem |

[Errors and what to do](api-reference.md#errors-typed--you-catch-these) lists every error of the library.

## How it is built

A bitmap is a sorted list of 16-bit keys and one container each. An array container holds up to 4,096 sorted 16-bit values;
past that a bitset of 8,192 bytes is smaller; a run container (start and length pairs) is chosen only when strictly smaller
than the plain body, so a tie is an array. Copy-on-write shares a container between a bitmap and its clone until one
changes. [The module's own README](../../packages/roaring/src/ts-roaring/README.md) has the data model, the kernels, the
stored bytes and what watches each one.

## Credits

The Roaring format and its algorithms are the work of Daniel Lemire and colleagues; see
[roaringbitmap.org](https://roaringbitmap.org/) and the
[Roaring format specification](https://github.com/RoaringBitmap/RoaringFormatSpec), which defines the portable bytes this
codec reads and writes. The implementation is clean-room: it is written from the specification and these papers, and
nothing was ported from CRoaring or from the `roaring` package.

- S. Chambi, D. Lemire, O. Kaser, R. Godin, "Better bitmap performance with Roaring bitmaps", *Software: Practice and
  Experience* 46(5), 2016. [arXiv:1402.6407](https://arxiv.org/abs/1402.6407)
- D. Lemire, G. Ssi-Yan-Kai, O. Kaser, "Consistently faster and smaller compressed bitmaps with Roaring", *Software:
  Practice and Experience* 46(11), 2016. [arXiv:1603.06549](https://arxiv.org/abs/1603.06549)
- D. Lemire, O. Kaser, N. Kurz, L. Deri, C. O'Hara, F. Saint-Jacques, G. Ssi-Yan-Kai, "Roaring Bitmaps: Implementation of
  an Optimized Software Library", *Software: Practice and Experience* 48(4), 2018.
  [arXiv:1709.07821](https://arxiv.org/abs/1709.07821)

CRoaring, through the `roaring` package, is the test oracle: the tests compare this codec's contents, results and stored
bytes with it.

## Reproduce

```
node --expose-gc bench/ts-codec-engine.cjs --all   # the store comparison (about an hour; wants an idle machine)
node bench/ts-codec.cjs                            # one operation on one chunk
pnpm bench:ts-codec:check                          # both codecs answer alike, every cell present (times nothing)
pnpm fuzz:deser                                    # the decoder fuzz target
```
