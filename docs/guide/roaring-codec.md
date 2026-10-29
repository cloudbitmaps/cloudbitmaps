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

### The public class against native, in memory

The figures above go through the store. [`RoaringBitmap`](api-reference.md#build-and-combine-bitmaps-by-themselves--roaringbitmap)
is also used on its own, where nothing hides the cost of an operation behind a network read. This is the class against
the `roaring` package it is compared with, cell by cell, generated from
[`bench/bitmap-api-results.json`](../../bench/bitmap-api-results.json) (the record of
[`bench/bitmap-api.cjs`](../../bench/bitmap-api.cjs)):

<!-- BITMAP_API:TABLE:START -->

**Measured** on Apple M3 Pro (11 cores), darwin arm64, Node v24.22.1, commit `3be54a7e` (dirty tree), `roaring` 2.7.0, 31 rounds a figure, pass 2, started 2026-10-27. Each figure is the median over the rounds of the class's time divided by the `roaring` package's in the same round, so 2.00 means twice as slow and 0.50 half the time. One subject per process, rotated orders, an A/A control per cell, wall-clock on one machine; each first-call figure is one call in one fresh process; the kept rounds ended at a load of at most 5.96 and 448 rounds were set aside at 6 or more and taken again (at most 7 of any one figure, on 96 figures). Recorded, never asserted.

| Against `roaring` (class time / native time) | Group | dense | sparse | runs | mixed | spread8k |
|---|---|---:|---:|---:|---:|---:|
| `build array` | build | 2.15 | 1.23 | 2.39 | 2.40 | 0.59 * |
| `build Uint32Array` | build | 1.66 | 0.93 | 1.64 | 1.64 | 0.37 |
| `build addMany` | build | 1.66 | 0.95 | 1.64 | 1.64 | 0.38 |
| `build add per id` | build | 1.08 | 2.41 | 1.12 | 1.10 | 1.73 |
| `has` | has | 0.33 | 0.82 | 0.79 | 0.62 | 0.65 |
| `and returning` | combine returning | 2.90 * | 0.46 | 2.51 * | 1.35 | 0.90 |
| `or returning` | combine returning | 2.62 * | 1.94 | 2.22 | 1.85 * | 1.72 |
| `xor returning` | combine returning | 2.40 | 1.59 | 1.84 | 1.50 | 2.21 |
| `andNot returning` | combine returning | 2.68 * | 0.49 | 2.55 | 2.03 | 1.86 |
| `and in place` | combine in place | 3.30 | 0.46 | 2.09 | 2.13 * | 0.87 |
| `or in place` | combine in place | 3.14 | 1.97 | 1.78 | 2.02 * | 1.06 |
| `xor in place` | combine in place | 2.47 * | 1.61 | 1.80 | 1.79 | 1.26 |
| `andNot in place` | combine in place | 2.46 | 0.50 | 2.19 | 2.79 | 1.75 |
| `serialize` | serialize | 0.25 * | 0.29 * | 0.47 * | 0.32 * | 2.68 |
| `deserialize` | serialize | 2.83 | 5.50 | 5.29 | 4.26 | 4.55 |
| `runOptimize` | serialize | 0.41 | 2.40 | 0.06 | 0.70 | 0.32 |
| `iterate` | export | 1.12 | 1.40 | 1.06 | 1.10 | 1.04 |
| `toUint32Array` | export | 1.72 * | 2.02 | 4.71 | 2.34 | 3.17 |
| `toArray` | export | 0.52 * | 0.44 | 0.54 * | 0.50 | 0.48 |
| `orMany 8` | orMany | 5.79 | 1.14 | 5.75 | 2.50 | 1.28 |
| `orMany 64` | orMany | 22.82 | 0.92 | 6.96 | 2.40 | 0.89 |
| `clone` | clone | 0.00 | 0.01 | 0.01 | 0.00 | 0.06 |
| `clone then write` | clone | 1.66 | 2.86 | 4.46 | 1.62 * | 0.76 |
| `andCardinality` | count | 8.66 | 0.41 | 1.76 * | 2.06 | 1.57 |
| `orCardinality` | count | 7.88 | 0.41 | 1.73 * | 2.14 | 1.56 |
| `isSubset` | compare | 3.11 | 0.39 | 3.67 | 0.07 | 1.61 |
| `isEqual` | compare | 8.09 | 16.89 | 19.44 | 10.19 | 8.12 |
| `intersects overlapping` | count | 0.67 | 7.62 | 0.57 | 0.66 | 2.25 |
| `intersects disjoint` | count | 3.18 | 0.41 | 3.06 | 2.05 | 1.45 |
| `write after or` | write after combine | 12.43 * | 4.98 | 8.32 | 6.55 * | 1.16 |
| `write after xor` | write after combine | 12.62 * | 5.23 | 9.82 * | 6.57 | 1.13 |
| `write after andNot` | write after combine | 14.32 * | 5.87 | 10.03 * | 6.84 | 1.14 |

| The shell against the codec's own call (class time / codec time) | Group | dense | sparse | runs | mixed | spread8k |
|---|---|---:|---:|---:|---:|---:|
| `build array` | build | 1.01 | 1.07 | 1.00 | 1.00 | 1.09 * |
| `build Uint32Array` | build | 1.01 | 1.01 | 1.00 | 1.00 | 1.05 |
| `build addMany` | build | 1.01 | 1.01 | 1.00 | 1.00 | 1.07 |
| `build add per id` | build | 1.09 | 1.00 | 1.08 | 1.07 | 1.03 |
| `has` | has | 1.13 | 1.02 | 1.02 | 1.06 | 0.89 |
| `and returning` | combine returning | 1.63 * | 1.02 | 0.92 * | 1.04 | 1.05 |
| `or returning` | combine returning | 1.57 * | 1.00 | 1.03 | 1.13 * | 1.13 |
| `xor returning` | combine returning | 1.27 | 1.01 | 1.01 | 0.97 | 1.22 |
| `andNot returning` | combine returning | 1.62 * | 1.02 | 0.98 | 0.85 | 1.20 |
| `and in place` | combine in place | 1.29 | 1.03 | 0.94 | 1.12 * | 1.06 |
| `or in place` | combine in place | 1.34 | 1.02 | 1.02 | 1.12 * | 1.12 |
| `andNot in place` | combine in place | 1.07 | 1.01 | 1.01 | 0.82 | 1.07 |
| `serialize` | serialize | 1.10 * | 1.06 * | 1.06 * | 1.05 * | 1.06 |
| `deserialize` | serialize | 1.61 | 1.14 | 1.14 | 1.26 | 2.35 |
| `runOptimize` | serialize | 1.25 | 0.84 | 1.25 | 1.06 | 1.14 |
| `iterate` | export | 0.99 | 1.10 | 1.00 | 1.05 | 1.26 |
| `toUint32Array` | export | 1.08 * | 0.99 | 0.99 | 0.96 | 0.96 |
| `toArray` | export | 1.01 * | 0.99 | 1.01 * | 1.00 | 1.00 |
| `clone` | clone | 1.08 | 1.01 | 1.05 | 1.05 | 1.43 |
| `clone then write` | clone | 1.32 | 1.03 | 1.10 | 1.15 * | 1.01 |
| `andCardinality` | count | 0.57 | 0.92 | 0.70 * | 0.65 | 0.97 |
| `orCardinality` | count | 0.61 | 0.21 | 0.51 * | 0.34 | 0.65 |
| `write after or` | write after combine | 2.67 * | 1.07 | 1.45 | 1.20 * | 1.09 |
| `write after xor` | write after combine | 3.02 * | 1.07 | 1.43 * | 1.18 | 1.07 |
| `write after andNot` | write after combine | 3.34 * | 1.05 | 1.38 * | 1.17 | 1.08 |

| The first call in a fresh process (`mixed`) | Class / native | Class / codec |
|---|---:|---:|
| `first deserialize` | 13.04 * | 1.19 * |
| `first build` | 2.35 | 1.01 |
| `first and` | 7.09 | 1.00 |

| `store.load(ref, { bitmap })` | Load (ms) | `serialize` (ms) | `deserialize` (ms) | Round trip, share of a load |
|---|---:|---:|---:|---:|
| dense | 1.02 | 0.028 | 0.141 | 16.1% |
| sparse | 2.34 | 0.044 | 0.427 | 20.2% |
| runs | 0.822 | 0.022 | 0.132 | 19.1% |
| mixed | 1.75 | 0.046 | 0.275 | 18.4% |
| spread8k | 13.5 | 0.418 | 2.00 | 18.3% |

\* The A/A control of this cell differed from the class by more than 2%, so the figure is not resolved.

Close to native (within 3 times native on every cell of the group, every control in band): has.
Not called close to native: build (worst 2.41 times, sparse build add per id; 1 cell(s) with a control out of band); combine returning (worst 2.90 times, dense and returning; 5 cell(s) with a control out of band); combine in place (worst 3.30 times, dense and in place; 3 cell(s) with a control out of band); serialize (worst 5.50 times, sparse deserialize; 4 cell(s) with a control out of band); export (worst 4.71 times, runs toUint32Array; 3 cell(s) with a control out of band); orMany (worst 22.82 times, dense orMany 64); clone (worst 4.46 times, runs clone then write; 1 cell(s) with a control out of band); count (worst 8.66 times, dense andCardinality; 2 cell(s) with a control out of band); compare (worst 19.44 times, runs isEqual); write after combine (worst 14.32 times, dense write after andNot; 6 cell(s) with a control out of band); cold (worst 13.04 times, cold first deserialize; 1 cell(s) with a control out of band).
More than 10 times native on some data set, so not shipped unless the maintainer decides otherwise having seen this table: `RoaringBitmap.orMany` (22.82 times, dense orMany 64); `isEqual` (19.44 times, runs isEqual); `RoaringBitmap.andNot` (14.32 times, dense write after andNot); `RoaringBitmap.deserialize` (13.04 times, cold first deserialize); `RoaringBitmap.xor` (12.62 times, dense write after xor); `RoaringBitmap.or` (12.43 times, dense write after or).

The class answered `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality` and `intersects` by the count kernels in this pass; the count kernels' own bench (`bench/count-kernels.cjs`) kept them: `andCardinality` took less time than building and counting on every operand-pair group it judges. The codec column of `andCardinality` and `orCardinality` is build-then-count, so a class figure below 1.00 there is a count that cost less than building the result and counting it on that data set.

Notes on rows that are not a like-for-like call:

- `deserialize` and `first deserialize`: the class caps the size and checks the layout of the bytes before it decodes them; the `roaring` package's decode is called with no validating option, so these rows compare the class with its check against native without one.
- `clone` and `clone then write`: the class's clone shares the containers and copies one on the first write that reaches it; native's clone copies everything at once. These rows are that policy difference, not two copies of the same work.
- `write after or`, `write after xor` and `write after andNot`: only the first operand's next write is timed, on an operand decoded fresh for each repetition, after a returning combine that flagged the containers it keeps by reference. The codec has no such flag, so its figure is the same write on an unflagged bitmap.
- `intersects overlapping` answers `true` at the first id the two bitmaps share: the codec walks the two key lists in order, compares the two containers of each key both hold, and returns at the first pair that has a value in common (a pair with none is passed over), so it times how fast each subject finds a first hit; `intersects disjoint` answers `false` after walking every key. `isSubset` and `isEqual` answer `true`, which is the full scan.
- `serialize` is held to identical bytes on every subject; every other answer is held to the same value.

<!-- BITMAP_API:TABLE:END -->

## Using it by itself

`RoaringBitmap` from `@cloudbitmaps/roaring` is this codec's bitmap as a public class, usable without a store: a mutable
set of unsigned 32-bit ids with the portable Roaring bytes, in TypeScript on typed arrays, with no native code. It loads
with the package's main entry, the same import line as the store (`import { CloudRoaring, MemoryStorage, RoaringBitmap }
from '@cloudbitmaps/roaring'`), and that entry also loads the store's in-process backends and their Node builtins, so
importing the class loads the whole package. The class runs where the package runs: CI runs it on Node 22 and 24, the
earlier Bun and Deno self-check ran the codec inside a store, not this class, and no isolate or browser was run. Its
methods, errors and costs are in [the API reference](api-reference.md#build-and-combine-bitmaps-by-themselves--roaringbitmap).

- **One door for bytes.** `RoaringBitmap.deserialize(bytes: Uint8Array)` decodes the portable bytes of one bitmap you hold
  (a Node `Buffer` is one) through the check a `{ serialized }` load makes: the 537,403,396-byte cap, the structural
  check, exactly one bitmap (trailing bytes are refused), then the decoder. An empty buffer is refused, not the empty set:
  `new RoaringBitmap()` is the empty set. The result owns its storage, so decoding a large input and reducing the result
  does not keep the input alive.
- **Build and change.** `new RoaringBitmap(ids)`, `add`, `addMany`, `remove`, `removeMany`, `clear`, `clone`, and the
  in-place `andInPlace`, `orInPlace`, `xorInPlace` and `andNotInPlace`; the statics that return a new bitmap and change no
  operand (`RoaringBitmap.and`, `or`, `xor`, `andNot` and `orMany`); the counts and comparisons that build nothing you keep
  (`andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`, `isSubset` and `isEqual`); `has`, `size`, `isEmpty`, `minimum`, `maximum`, iteration in
  ascending order (a promise), `toArray`, `toUint32Array`, `serialize()` and `runOptimize()`.
- **Every id is checked**, and a refusal never repeats the value.
- **It loads as itself.** `store.load(ref, bitmap)` reads a bitmap and never changes it.

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

// Build, change and combine in memory; the bitmap you decoded is mutable.
const wider = new RoaringBitmap([1, 70_000]).addMany(bitmap);
console.log(wider.remove(1), wider.remove(1)); // true false
console.log(wider.minimum(), wider.maximum()); // 5 70000
console.log(new RoaringBitmap().minimum()); // undefined

// Count and compare without keeping a result; neither bitmap changes.
console.log(wider.andCardinality(bitmap), wider.orCardinality(bitmap)); // 2 3
console.log(bitmap.isSubset(wider), wider.isEqual(bitmap)); // true false

try {
  wider.add(-1);
} catch (err) {
  console.log(err.name); // ValidationError
}
```

The example is run by [`tests/docs/roaring-codec-example.test.ts`](../../tests/docs/roaring-codec-example.test.ts).

**Where it differs from the `roaring` package from npm**, each on purpose: `add` and `remove` take exactly one id (a second
argument is an error naming `addMany` or `removeMany`); every id argument throws a `ValidationError` that does not
repeat the value, where `add` of `roaring` accepts a string or `null`; `minimum()` and `maximum()` of an empty set are
`undefined`, where `roaring` answers `0xFFFFFFFF` and `0`, which are real ids; `deserialize` takes a `Uint8Array` and an
optional `{ maxBytes }` and checks the whole buffer, where `roaring`'s takes a format and checks only its own reads;
`serialize` returns a `Uint8Array` and its format argument is optional; and there is no `toJSON`, so
`JSON.stringify(bitmap)` gives `"{}"` and `JSON.stringify([...bitmap])` writes the ids. It is not a `RoaringBitmap32`: do
not pass one to the `roaring` package's methods, which answer wrongly without throwing in JavaScript; decode its
`serialize()` bytes with that package instead.

**What is not public.** The codec itself, its containers and its seam are internal, and a store cannot be given a codec.
The class has no ranges, `rank`, `select`, frozen views or 64-bit ids. No speed claim is made for
it: the figures above are the codec inside a store, and a loop over the class in memory has no store's network reads to
hide a slower combine behind.

## Errors you can see from it

| you see | when | what to do |
|---|---|---|
| `IntegrityError` | a stored chunk fails the structural check: a bad cookie, keys out of order, an offset that is not where the container starts, a container that runs past the buffer, a bitset whose count differs from its header, bytes over the cap | the stored object is damaged or not a bitmap: [`checkConsistency()`](disaster-recovery.md) finds it, and a restore replaces it |
| `ValidationError` | bytes you supply (`RoaringBitmap.deserialize`, a `{ serialized }` or `{ bitmap }` load) are not exactly one well-formed bitmap, with the structural message inside; an id that is not an integer from 0 to 4294967295 | fix the input: the message names the problem |

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
