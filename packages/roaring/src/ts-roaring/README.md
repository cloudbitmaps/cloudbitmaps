# The TypeScript Roaring codec

`packages/roaring/src/ts-roaring/` is a Roaring bitmap written in TypeScript on typed arrays, with no native addon. It
sits behind core's codec seam (`packages/core/src/core/codec.ts`) and reads and writes the
same portable Roaring bytes as CRoaring (through the `roaring` package, which only the tests and benches load, as the
reference), byte for byte: a `.crbm` generation written through one is read by the other, and the same set written
twice is the same object.

Users of the package: [docs/guide/roaring-codec.md](../../../../docs/guide/roaring-codec.md) says what this codec guarantees, what it costs and how to use its bitmap on its own. The public class over this module's bitmap is [section 13](#13-the-public-class-roaringbitmap).

Where a statement below is about a test, a bench or a workflow rather than the module, it says so.

## Contents

1. [Where it sits](#1-where-it-sits)
2. [The four files](#2-the-four-files)
3. [The data model: keys, containers, and which kind is stored](#3-the-data-model)
4. [Copy-on-write and sharing](#4-copy-on-write-and-sharing)
5. [Scratch buffers](#5-scratch-buffers)
6. [The kernels, pair by pair, and their thresholds](#6-the-kernels)
7. [Bitmap-level operations](#7-bitmap-level-operations)
8. [What it stores and where: memory forms and the wire layout](#8-what-it-stores-and-where)
9. [Worked examples with real bytes](#9-worked-examples)
10. [Every error it raises, and what a caller sees](#10-errors)
11. [What watches it](#11-what-watches-it)
12. [Behaviours worth knowing](#12-behaviours-worth-knowing)
13. [The public class, `RoaringBitmap`](#13-the-public-class-roaringbitmap)
14. [Credits](#14-credits)

## 1. Where it sits

```
  caller of @cloudbitmaps/roaring            ids are u32, [0, 2^32)
        |
        v
  CloudRoaring facade  ---->  SegmentEngine (core, codec-agnostic)
                                   |   builds, combines, caches, decodes chunks only through
                                   v
                           the codec seam                        (core/codec.ts)
                              |                       |
   native codec (tests only) ---+                       +--- THIS MODULE: tsRoaringCodec, the store's codec
   a bitmap class over CRoaring                         TsBitmap -> Container (array | bitset | run)
   (tests/helpers/native-codec.ts)

  An id splits in two 16-bit halves:

        id = 1234567890 = 0x4996_02D2
                           ^^^^ ^^^^
                           |    +-- value (remainder) 722, kept inside one container
                           +------- chunk key 18838, the .crbm chunk index (the 32-bit level)

  segment.<gen>.crbm
     chunk 18838 --> payload = a portable Roaring bitmap of ONE container holding remainders {..., 722, ...}
     chunk     1 --> payload = ...
     (the engine reads and caches whole chunks; a decoded chunk is one TsBitmap with one container)
```

The `.crbm` chunk index is the upper half of the id. Inside one chunk's payload the codec sees only remainders
`0..65535`, so a stored payload has exactly one container, under Roaring container key 0 (`docs/format.md` section 3).
The same class also serves as a general 32-bit bitmap: it holds any number of containers under ascending 16-bit keys,
which is what `fromValues`, `add`, `addMany`, the combines and a whole-bitmap `serialize()` use. The engine decodes a
stored chunk into a one-container `TsBitmap`, combines such bitmaps with `orInPlace` / `andInPlace` / `andNotInPlace`,
and writes a load through `encodeChunks()`. `TsBitmap` and `tsRoaringCodec` are exported from their file so the tests and the
benches can build one; no package entry re-exports either.

**Which codec runs.** The shipped store uses this codec. `flagshipCodec()` in `roaring-codec.ts` returns it unless a
harness has called `setFlagshipCodec(...)`, which is internal: no public entry exports it and a store cannot be
configured with a codec. The native codec (`tests/helpers/native-codec.ts`) exists only in the tests and benches, as the
reference the oracle and the comparisons hold this codec to, and the tests that compare the two flip the switch to it
for the length of one test. Nothing in `packages/` loads CRoaring.

## 2. The four files

| File | What it holds |
|---|---|
| `containers.ts` | The `Container` class (array, bitset, run), the scratch buffers, `optimize`, every single-container operation (`containerHas`, `containerAdd`, `containerRemove`, `containerMax`, `appendIds`) and every pair kernel (`containerAnd`, `containerOr`, `containerAndNot`). |
| `bitmap.ts` | `TsBitmap` (the sorted key list and the container list), id checking, `addMany` / `removeMany` grouping, key-level combines, `clone`, `encodeChunks`, and the exported `tsRoaringCodec`. |
| `wire.ts` | `serializeContainers` (containers to portable bytes) and `decodeContainers` (portable bytes to containers, after the layout check), and the trailing-bytes refusal. |
| `iterator.ts` | `BitmapIterator`, the ascending iterator: a class with its own state, not a generator. |

```
  tsRoaringCodec.safeDeserialize(bytes, maxBytes, { whole?, detached? })
       |  size cap
       v
  wire.decodeContainers --> portable/layout.parsePortableLayout   (the one structural check, which the tests' native codec runs too)
       |  copies bytes the layout vouched for
       v
  TsBitmap { keys[], conts[], size }  <---- bitmap.ts ---->  containers.ts kernels
       |                                                         ^
       +-- serialize() / encodeChunks() --> wire.serializeContainers
       +-- [Symbol.iterator] --> iterator.BitmapIterator
```

## 3. The data model

```
  TsBitmap
    #keys:  [ 0      3      40000 ]     ascending 16-bit keys, no duplicates
    #conts: [ ARRAY  RUN    BITSET ]    one Container per key, never empty
    #size:  total cardinality, kept as containers change (never recounted per call)

  Container { kind, data, off, len, card, shared }

    ARRAY   data: Uint16Array   values data[off, off+len)        len == card, ascending, up to 4,096 values
    BITSET  data: Uint32Array   2,048 words = 65,536 bits        always owns its words; len unused (0)
    RUN     data: Uint16Array   pairs (start, length-1) at data[off + 2i], i < len     len == number of runs
```

`card` is the number of values in every kind.

### Which kind is stored

The stored rule (the same one `docs/format.md` section 3 states, and the one `optimize` implements):

```
  card <= 4096 :  plain body = 2 * card bytes      (array)
  card  > 4096 :  plain body = 8192 bytes          (bitset)
  run body = 2 + 4 * runs bytes

  run     if  2 + 4*runs  <  min(2*card, 8192)     strictly smaller
  array   else if card <= 4096
  bitset  otherwise
```

A tie goes to the plain form: three consecutive values (array body 6, run body 6) and five values in two runs (10 and
10) are arrays. A run body (`2 + 4*runs`) is never a multiple of 4, so it cannot tie with the 8,192-byte bitset.

`optimize(c)` computes the run count (stopping early once it reaches `(plain - 2) / 4`, which already settles that runs
are not smaller), returns a run container when the rule says run (keeping `c` if it already is one), and otherwise
`demote`s: a run container becomes an array or bitset by cardinality, and an array or bitset is returned as it is. The
result depends on the set alone, which is what makes stored bytes a function of membership.

Where a container's kind comes from:

- Built from ids (`fromSortedIds`): an array when the group has at most 4,096 distinct low values, else a bitset.
- Decoded from bytes: whatever kind the bytes say, run containers included (the layout check has already proved the
  structure). A decoded run container stays as it was decoded until a write changes it; a write that adds ids keeps it a
  run only while the run form is still the smaller one (below).
- A write that adds ids (`containerAdd`, `containerAddSorted` for a group of a few, and `containerOr` of a run container with an array) merges them into the run list (a large batch into a thousand or more runs is written through words, below); a group of a few into an array keeps `add`'s capacity rule, so a shared array, or one with no spare room, is copied to up to twice its length on the first id
  and keeps the result a run container while the rule above says run (`runsOrPlain`), otherwise an array or a bitset; a
  removal (`containerRemove`) first `demote`s a run container. An array
  at 4,096 values that gains one more becomes a bitset; a bitset that drops to 4,096 or fewer becomes an array
  (`fromWordsCard`).
- The result of combining one pair of containers is an array up to 4,096 values or a bitset above, except for two runs
  (for every combine: and, or, andNot, xor) and for an `or` of a run with an array. An `and`, `andNot` or `xor` of a run
  with an array gives an array or a bitset. A run container `or`ed with an array stays a run while the run form is the
  smaller one. Two run containers keep a run result while its body, `2 + 4 * runs` bytes, is strictly smaller than the array or
  bitset body (`runsOrPlain`, the same test a write into a run uses), because a run list of a few long intervals is much
  smaller than the 8 KiB bitset it would otherwise be expanded to, and every later `and`, `isSubset` or `intersects` on
  it then walks intervals instead of words. Every run a combine writes is maximal: `andRuns` pieces are separated because
  both inputs' runs are maximal (two values that are next to each other in the result are next to each other in both
  inputs, hence in one run of each, hence in one piece); `andNotRuns` pieces are separated by a run of `b` or by a gap of
  `a`; `orRuns` joins pieces that touch (`s <= end + 1`); `xorRuns` cancels a shared boundary, so touching pieces join.
  The decoder refuses runs that touch or overlap, so this is what lets a combine's result be serialized as it is. A
  bitmap-level combine can also hold a run for a key held by one side only, which keeps that side's container as it is
  (section 7).
- **Who writes a run container, and the rule each keeps.** The decoder (which refuses runs that touch or overlap, so a
  decoded list is maximal), `toRun` (from an array or a bitset, through `optimize`, which `orRunArrayExpand` takes its result from), `runsOrPlain` (the exit of every
  kernel that builds a run list: the run results of `and`, `or`, `andNot` and `xor` of two runs and `orRunArrayWalk` and `orRunIdsWalk`, which build it in `pairScratch`, and `addToRuns`, which `containerAdd` uses on a run, and `addFewToRuns`, which `containerAddSorted` uses, which each allocate their own), and nothing else. Every one of them leaves the runs
  maximal (ascending, no two touching or overlapping, inside 0..65,535) and the container in its smallest kind by the
  rule above. That is what the same-kind run compare in `isEqual` depends on (one set has one list of pairs), and what
  the decoder requires of the bytes a bitmap writes. A new writer of a run container has to keep both, and the property
  test in `tests/roaring/run-writers-canonical.test.ts` drives every writer from arrays, bitsets and runs at the edges 0
  and 65,535 and fails on a result that is not canonical.
- `optimize()` (the bitmap method) re-encodes every container by the rule. `encodeChunks()` optimizes each container
  when it is asked for, on a snapshot, without changing the bitmap's own containers.

## 4. Copy-on-write and sharing

`Container.shared` says another holder can see the container's storage. A write to a shared container copies first;
nothing writes to shared storage.

```
  a = TsBitmap with containers [c0, c1]
  b = a.clone()                      -- b gets the SAME container objects c0, c1; both are flagged shared
                                        (the key list is copied; the containers are not)

  a.add(5)    c0 is shared  -> copy c0's storage, write the copy, a.conts[0] = new Container (shared clear)
  b.add(9)    c0 is still the flagged object -> copy again; neither side ever wrote c0's storage
  b.has(...)  reads c0 / c1 directly; a clone that is only read never pays for a copy
```

What flags a container as shared:

- `clone()` flags every container of the bitmap it is called on, so both sides hold flagged objects.
- `encodeChunks()` takes a snapshot of the key and container lists and flags every container, so a change made to the
  bitmap while the chunks are being read copies a container instead of altering what the chunks will say.
- A decode that puts several small containers in one slab flags those that share it (see section 8).
- The returning combines (`TsBitmap.or`, `xor` and `andNot`, section 7) flag each container only their first operand holds
  that the result keeps by reference; `TsBitmap.and` and the union `orMany` builds flag nothing.

A write that may go in place returns a new `Container` object over the same storage with `shared` clear. That is safe
because a clone or snapshot flagged the object its bitmap held at that moment, so a flagged object never sits beside an
unflagged one over the same storage. The flag is set once and never cleared on an object.

In-place combines follow the same rule. `combineContainers` passes `inPlace = !a.shared`, and a pair combine takes the
in-place path only when the first operand is a bitset that is not shared: its words are then written, not copied, and the
result is a new `Container` object over those same words. In every other case the pair's result is built in fresh
storage. (A key held by one side only is not a pair: the bitmap-level combine keeps `this`'s container by reference,
section 7.)

## 5. Scratch buffers

`containers.ts` keeps three module-scope scratch buffers:

| Buffer | Size | Used by | Rule |
|---|---|---|---|
| `valueScratch` (`Uint16Array`) | starts at 8,192 entries | array results whose size is known only after they are built (`andArrays`, `filterByBits`, `filterByRuns`, `andNotArrays`, `orArrays`, `xorArrays`, and `orManyContainers`, which gathers the values of an all-array key before sorting them) | a kernel writes into it and copies out exactly `n` values (`arrayOfScratch`) |
| `pairScratch` (`Uint16Array`) | starts at 8,192 entries | run-pair results (`andRuns`, `orRuns`, `andNotRuns`, `xorRuns`, `orRunArrayWalk`, which merges an array's values into a run list, and `orRunIdsWalk`, which merges a group of ids into one) | same |
| `probeWords` (`Uint32Array`) | 2,048 words (one bitset) | the scratch-bitset probe in `andArrays`, `andNotArrays`, `andCountArrays` and `intersectsArrays` | all zero between calls: each call clears the bits it set, on every exit (`intersectsArrays` clears them after a hit as well as after a full scan) |

Growth: a request larger than the buffer allocates `max(n, min(2 * length, 65,536))`; the buffer kept for the life of the
process never exceeds 65,536 entries (one container's worth of 16-bit values); a request above that gets a fresh array
that is not kept.

**Why module scope.** A combine's result size is unknown until it is built, so each kernel writes into a buffer first
and then allocates an exact-size result; a buffer reused across calls means no worst-case allocation per combine. It is
safe because the code is single-threaded and a scratch is never held
across a call that could run other code: each kernel fills it and copies out before returning, and no kernel calls
another while it holds one. Each worker thread loads its own module instance and so has its own buffers. The probe bitset
is cleared by walking the values that set it (not by zeroing 2,048 words), so its cost follows the arrays, not the
bitset's size.

## 6. The kernels

The kernel for a pair is chosen by the kinds of the two operands. `containerAnd` is commutative and puts the lower kind
first (array, bitset, run).

```
              and                          or                              andNot (a minus b)
  A  A     merge | gallop | probe       merge while the union fits       gallop | probe | merge
                                         an array, else a bitset
  A  B     filter by bit (keep)         copy the bitset, set bits        filter by bit (drop)
  A  R     walk runs | walk values      runs to words + array bits       walk values (drop)
  B  B     word loop                    word loop                        word loop
  B  R     copy words inside runs       setRange per run                 clearRange per run
  R  R     interval intersection        interval union (touching joins)  interval difference
```

Every result is an array up to 4,096 values, a bitset above, a run container (for two run containers, and for an `or` of
a run with an array, while that is the smaller form), or nothing (`null`, and the key is dropped).

### Exclusive-or: `containerXor`

One kernel per pair, one pass, one count; the result kind follows the same rule as the others.

```
  A  A     one merge that writes each value once and skips a value both hold; a result over 4,096 values is set into words
  B  B     one word loop `x ^ y` (into the first operand's own words when it may be written), one Harley-Seal count
  B  A     the bitset's words (a copy, or its own) with each array value's bit flipped; the count is adjusted per flip
  B  R     the bitset's words with each run's range flipped, then one count
  A  R     the run expanded to words (it owns them), then the array's bits flipped, the count adjusted per flip
  R  R     one walk over the run boundaries of both lists (`xorRuns`); a run result while smaller
```

`xorRuns` treats a run `(start, length - 1)` as a boundary at `start` and one at `start + length`. The boundaries of one
canonical list ascend strictly, so a merge of the two lists sees each position at most twice, and a position both lists
have cancels. What is left alternates open, close, and two pieces that touch (the end of one run is the start of the
other) have already joined because the shared boundary cancelled. The pairs go to `pairScratch` and `runsOrPlain` keeps a run
container while that is the smaller form, else builds the array or bitset.

### Array against array: `andArrays`

Let `small` be the shorter, `big` the longer.

```
  small.len >= 32 and big.len < 16 * small.len     -> scratch-bitset PROBE
  big.len >= 16 * small.len                        -> GALLOP
  otherwise (small.len < 32, similar sizes)        -> branch-free MERGE
```

- **Probe.** If the two arrays' ranges do not overlap (the shorter's last value is below the longer's first, or its first
  is above the longer's last) the result is empty at once. Otherwise the span of `big` between the shorter's first and
  last value is found by two gallops, the shorter's values are set in `probeWords`, `big` is read once over that span,
  and each value's bit is tested. Selection is branch-free (below). The bits are cleared at the end. The threshold of 32
  (`PROBE_MIN`): below it the merge finishes sooner than the bitset's set-and-clear costs; a higher value would leave
  mid-sized pairs on the slower merge.
- **Gallop.** For each value of the shorter, a doubling-step search then a binary search in the longer, resuming from
  where the last one ended, stopping when the longer is exhausted. The skew bound `GALLOP_SKEW = 16`: a larger factor
  gallops less often (better for similar sizes, worse for skewed ones). `skewed(short, long)` is `long >= 16 * short`.
- **Merge.** Two cursors; no branch on the comparison.

**Branch-free selection** means a kernel writes the candidate into the next result slot every time and moves the result
cursor by 0 or 1 from the comparison's outcome (`n += x === y ? 1 : 0; i += x <= y ? 1 : 0; j += x >= y ? 1 : 0`). A
branch on random data mispredicts, and a misprediction costs more than the extra adds. The slot beyond the last hit holds
a stale value that is never read.

### Array minus array: `andNotArrays`

Checks in this order: `b.len >= 16 * a.len` -> gallop each value of `a` in `b`; else `b.len >= 32` -> mark the part of
`b` that lies inside `a`'s span (found by gallops) in `probeWords`, then keep each value of `a` whose bit is clear,
branch-free; else a merge. The 32 here is a floor on the second operand, where `andArrays` puts it on the shorter one.

### Array against bitset and against runs

- `filterByBits(a, b, keep)`: for each value of `a`, test its bit in `b`'s words, branch-free; `keep` flips whether a set
  or a clear bit is kept: `and` calls it with `keep = true`, `andNot` with `keep = false`.
- `filterByRuns(a, b, keep)`: when `keep` and `a.len >= b.len`, walk the runs, skipping the values below each run and
  copying those inside (one step per run and per value). Otherwise walk the values with a run index that advances and never returns to an
  earlier run (it skips the runs a sparse array does not need to visit). Dropping (`andNot`) always takes the value walk.

### Bitsets

`B` against `B` is a 2,048-word loop. The result's cardinality is counted by `popcountWords`, a Harley-Seal
carry-save-adder tree over sixteen words at a time in plain 32-bit integer arithmetic (no `BigInt`), so one word in
sixteen takes a bit count. A bitset that ends at 4,096 or fewer values is converted to an array (`fromWordsCard`).
`orIntoBitset` counts as it sets when the other side is an array (a per-bit test of the old word), and recounts with
`popcountWords` when it ORs words or runs.

`popcountWords` (and the one-word `popcount32`) live in `portable/popcount.ts`, not in `containers.ts`, because the layout
check counts a stored bitset with the same function before any container exists, and `portable/` imports nothing from
`ts-roaring/`.

### How the layout check reads a body

`portable/layout.ts` reads every stored body once and proves its structure (see its header for the rules). The bytes
are not trusted, so the reads are bounds-checked against the buffer's length before a typed
array is made over them. The cost of the check is the loops over every value, so each kind is read the cheapest way its
position allows:

```
  body          where it sits                         how it is checked
  bitset        4-byte aligned in the buffer          Uint32Array over the body, counted in place by popcountWords
                any other offset                      the 8 KiB are copied into a module scratch Uint32Array, then counted
  array         >= 128 values, 2-byte aligned         Uint16Array over the body, four values a step
                shorter, or odd offset, or big-endian two values per u32 through the DataView
  run container >= 64 runs, 2-byte aligned            Uint16Array of (start, length) pairs, one run a step
                shorter, or odd offset, or big-endian one u32 per run through the DataView
```

"Aligned" is the buffer's own `byteOffset` plus the body's offset in it, because a typed array needs a multiple of its
element size. The bit count does not depend on byte order, so a bitset takes the view path on any machine; arrays and runs
need little-endian and take the `DataView` path otherwise. A group of four array values that fails is read again two at a
time so the element an error names is the one the two-at-a-time read names: the check refuses the same bytes, with the same
message, in the same order, at every alignment, and never reads past the buffer it was given.

### The many-way union: `orManyContainers`

`orMany` does not fold `orInPlace`, which would recount all 2,048 words of the accumulator after every input. For each key,
`TsBitmap.orMany` gathers the containers of every input into a list (a `Map` from key to containers, then the keys sorted)
and `orManyContainers` unites the list in one pass:

```
  one container for the key         copied as it is (a run stays a run)
  all arrays, at most 4,096 values  values concatenated into valueScratch, sorted, de-duplicated, copied out
  anything else                     words = the bitsets OR-ed four at a time (the first group of four writes the
                                    accumulator, so no bitset is copied; one to three bitsets copy the first, and
                                    fewer than four left over are OR-ed one at a time), or zeros when there is none;
                                    for each array: set one bit per value
                                    for each run:   setRange per run
                                    popcountWords(words) once; at most 4,096 -> array, else the words are the bitset
```

The count happens once, after the last input. The result is an array or a bitset, never a run (a pair of a run and
an array, or of two runs, can give a run; the many-way union does not try), in storage of its own: a copied container, a fresh array, or a fresh word array. No input container is written,
kept or flagged, so a later write to an input or to the result never reaches the other, and the same bitmap may appear any
number of times in the list.

### Runs

- `andRuns`, `orRuns` (merges touching runs: `s <= end + 1`), `andNotRuns`, `xorRuns`: one walk over both run lists into
  `pairScratch`, then `runsOrPlain` copies the pairs out as a run container when `2 + 4 * runs` is strictly smaller than the
  array or bitset body, else `fromRunPairs` builds an array (up to 4,096 values) or a bitset from them.
- `bitsetInRuns`: reads only the bitset words each run covers, each masked to the run's ends. A run container of at
  most 4,096 values cannot yield more than an array holds, so its result is written straight to a scratch array of
  positions and copied out: no 8 KiB bitset, no popcount. A larger run container copies the covered words into a fresh
  bitset and counts it once with Harley-Seal (counting each covered word with a 32-bit popcount instead measured the
  same on a chunk whose runs cover about half the words, so the single count stays). The trade: the small branch pays one
  bit-extraction step per result value, which is cheaper than the allocation and the 2,048-word count it replaces
  whenever the result is at most 4,096 values, the only case it is taken for.
- Run against array for `or` (`orRunArray`): by one of two ways chosen from the two containers' lengths and
  cardinalities alone (`expandsRunArray`). `orRunArrayWalk` (and `orRunIdsWalk`, its copy over a group of ids for `addMany`, which a test holds to the same container) merges the two into one run list in `pairScratch` without
  expanding to words, which suits a result that stays a run container. `orRunArrayExpand` sets the runs in a new bitset,
  then each value, and takes the canonical container of the result (`optimize`), which suits one that does not; it is
  chosen from 1,024 steps (the runs plus the values) up, when the most runs the result can have (runs plus values) already
  fail the size rule against the plain body of the largest result (`2 * cardMax` bytes up to 4,096 values, else 8,192).
  The choice is a guess about the result, never about its correctness: both ways return the same container, so a wrong
  guess costs time only (the expansion of a union that fills every gap still returns the one run it is).
  One walk takes whichever of the next run and the next value starts first, and joins it to the pair being built when they
  touch or overlap, so the cost is the runs plus the values, with no search or view per value (a per-value search with a
  block copy of the runs between values was tried and was slower for batches of a few hundred ids or more). A value
  already inside what is written adds nothing, and the cardinality is the run container's plus the values that were new,
  so nothing is counted. `runsOrPlain` then keeps a run container (a copy of the pairs) when `2 + 4 * runs` is strictly
  under the plain body, else `fromRunPairs` builds an array or a bitset. A very large batch into many runs, whose result
  is a bitset, pays the merge before it learns that; the expansion to words would have been cheaper there, and gives no
  canonical kind. When the array adds nothing and the caller owns the first operand (`inPlace`, which the bitmap-level
  writers also pass for any run container, since runs are never written in place), the result is the run container itself.
  `containerAdd` on a run container is the same edit for one value (`addToRuns`: extend, join two neighbours, or insert),
  copying only the pairs.
- A run as the first operand of `andNot` with a non-run second operand: the run is expanded to words (`toWords`, which it
  owns), then the other operand's bits are set or cleared.

### Single-container operations

- `containerHas`: array by binary search, bitset by bit test, run by finding the last run starting at or before the value.
- `appendIds(c, out, at, base)`: writes ids plus `base`. An array of 32 values or more with `base === 0` is one
  widening `out.set`, a shorter one is counted out (`SMALL_IDS`: a view over a few values costs more than they do); a run
  container is written run by run: a run of fewer than `LONG_RUN` (48) values is counted out, each id written once with
  `base` added as it goes, and a longer one is one widening copy out of a table of 0 to 65,535 (`iota`, built on the
  first long run and kept), with `base` added over the copied ids where it is not 0.
- `runCount`: for arrays, counts breaks in consecutive values; for bitsets, counts set bits whose lower neighbour is clear
  (a word-parallel `w & ~((w << 1) | carry)`), skipping words of all ones or none.
- `toRun` for a bitset reads starts and ends word by word and alternates them across words; a run of one value is both at
  once.

### Counting without building: `containerAndCard` and `containersIntersect`

Every counting question the bitmap answers (how many ids two bitmaps share, how many either holds, whether they share any,
whether one is inside the other, whether they are equal) comes from one kernel family, the AND count. It writes no result
container, allocates nothing per call and changes neither operand. The family is chosen by the kinds of the pair, as the
building kernels are (`containerAndCard` is commutative and puts the lower kind first):

```
              and count                                       does it intersect (stops at the first shared value)
  A  A     probe | gallop | merge, counting hits           probe | gallop | merge, each stopping at the first hit
  A  B     one bit test per array value                    first set bit found
  A  R     walk runs | binary-search runs per value        walk the runs against the values
  B  B     fused AND and Harley-Seal count                first word whose AND is not zero
  B  R     popcount of the words inside each run           first run whose covered words hold a set bit
  R  R     sum of the overlap of each pair of runs         first pair of runs that overlap
```

- `andCountArrays` is `andArrays` with the output removed: the same probe (the shorter array as bits in `probeWords`,
  the span of the longer between the shorter's ends tested against them, the bits cleared again) when the shorter has at
  least `PROBE_MIN` values and the lengths are within `GALLOP_SKEW`, the same gallop when one is much longer, else the same
  branch-free merge with `n += x === y`. Below `PROBE_MIN` the merge is shorter than the probe's set-and-clear.
- `andCountArrayBitset` is a sum of bit tests; `andCountArrayRuns` walks both lists when the runs number fewer than 16
  times the values, and finds each value's run by binary search when they number 16 times or more; `andCountBitsetRuns` is `bitsInRange` per
  run (the masked popcount of the covered words); `andCountRuns` adds `hi - lo + 1` for each overlapping pair of runs.
- Two bitsets are counted by `popcountAnd`, the Harley-Seal tree of `popcountWords` with each word read as the AND of the
  two operands' words, so nothing is written to a scratch and read back: one pass over 4,096 words, no module state.
  `isEqual` of two bitsets compares their words and does not count; `isSubset` does not count either (section 7). Only
  `isEqual` of two containers of different kinds counts, through the kernel for that pair.
- `containersIntersect` is the early-exit form: each pair kind returns at the first shared value instead of counting
  all of them. Disjoint ranges of two arrays answer after reading only the four end values. `intersectsArrays` chooses as `andCountArrays`
  does (probe from `PROBE_MIN` values when the lengths are within `GALLOP_SKEW`, gallop when one is much longer, else a
  merge), because a pair of similar size that shares nothing is a full scan, so it uses the same exit-free probe as the count.
  The probe pays its set-and-clear even when the first value is shared, so a pair that reaches it first takes up to
  `MERGE_FIRST` (320) merge steps, which find an early shared value (two random sets of a thousand values in a chunk
  usually share one within a few hundred steps, and a merge step costs far less than setting and clearing a thousand
  bits) without setting a bit; the cost is that a pair sharing nothing, with spans that overlap, takes up to 320 extra
  steps before the probe; only a pair that shares nothing that soon goes on to the probe,
  from where the merge stopped. Two bitsets test eight words at a time and stop at the first group with a shared bit; a
  bitset against runs asks `anyBitInRange` per run (stops at the first nonzero masked word, no popcount).

### Subset without counting: `containersSubset`

`isSubset` does not count. `containersSubset(a, b)` answers "is every value of `a` in `b`" by the kinds of the pair and stops
at the first value `b` lacks; no scratch is written and nothing is popcounted. It returns false at once when `a` holds more
values than `b`.

```
  A in A     merge (a value of `a` below the current value of `b` is missing) | gallop when `b` is 16x longer
  A in B     one bit test per value, stop at the first clear bit
  A in R     one walk of the runs against the values
  B in B     OR of the eight words' (x AND NOT y), stop at the first group that is not zero
  B in R     no set bit in the gaps before, between and after the runs (`anyBitInRange` per gap)
  R in A     a run of n values is n consecutive entries of the array (both ascend without repeats), so two compares per run
  R in B     every bit of each run set (`allBitsInRange`, stop at the first word that lacks one)
  R in R     each run inside one run of `b` (maximal runs, so a run of `a` cannot straddle two)
  B in A     the count (`containerAndCard`), taken only for a bitset of 4,096 values or fewer, which no codec result is
```

The bitmap-level operations in section 7 call these. A count is exact: `|A and B|` is the sum over shared keys of
`containerAndCard`, and the other counts are arithmetic on it and the two sizes.

### The thresholds and what each trades

| Constant | Value | Where | Trades |
|---|---|---|---|
| `ARRAY_MAX_CARDINALITY` | 4,096 | everywhere a kind is chosen | the format's own array/bitset boundary: array body `2*card` reaches the bitset's 8,192 bytes at 4,096 |
| `GALLOP_SKEW` | 16 | `andArrays`, `andNotArrays`, `andCountArrays`, `intersectsArrays`, `andCountArrayRuns` | a larger value gallops less often: better for similar sizes, worse for skewed ones |
| `PROBE_MIN` | 32 | `andArrays` and `andCountArrays` (shorter side), `andNotArrays` (second operand) | a lower value pays the bitset's set-and-clear on pairs a merge finishes sooner; a higher value leaves mid-sized pairs on the slower merge |
| `MERGE_FIRST` | 64 | `intersectsArrays` | the merge steps a pair takes before the scratch-bitset probe: a higher value finds an early shared value without setting a bit, and a lower one reaches the probe sooner on a pair that shares nothing |
| `SMALL_IDS` | 32 | `appendIds` | an array shorter than this is counted out; from here `base === 0` is one widening copy |
| `LONG_RUN` | 48 | `appendIds` (runs) | a run of fewer values (counted from its start) is counted out; from here it is one widening copy out of the `iota` table |
| `SMALL_BODY` | 64 | `putU16s` in `wire.ts` | a body of fewer `u16`s is written by a byte loop (little-endian on any machine); from here it is one view and `set` |
| `SCRATCH_KEEP` | 65,536 | `values16`, `pairs16` | the most a scratch keeps for the life of the process |
| `filterByRuns` rule | `a.len >= b.len` | array against runs | runs-first walk wins when values are at least as many as runs; the value walk skips runs a short array does not need |

Thresholds are the values in the code. Which value is fastest on which data was measured by the benches in section 11,
whose output files, not this README, hold the figures.

## 7. Bitmap-level operations

All of these are in `bitmap.ts`.

- **Id checking.** A write of anything that is not an integer from 0 to 4,294,967,295 throws `ValidationError`, whose
  message is core's `refusalOfId` wording and never repeats the value. In this module a read (`has`) answers false and
  `remove` and `removeMany` ignore a bad id; the public class checks every id first and throws instead (section 13). `collect` checks an array with `v >>> 0 !== v` (which is
  exactly an integer in range: NaN, fractions, strings and `null` fail it); a `Uint32Array` needs no check; another
  iterable is read once into a doubling buffer, checked as it goes. Checking happens before any container is touched, so a
  bad id leaves the bitmap unchanged.
- **The combines that return a new bitmap (`TsBitmap.and`, `or`, `xor`, `andNot`).** One static walk of the two key lists
  (the same shape as the in-place combine, which rewrites its own lists) that builds a new bitmap and never writes an
  operand: a key both hold combines into a fresh container (the in-place form of the container kernel is never taken, so no
  operand storage is written), a container only the first operand holds is kept by reference and flagged shared (never for
  `and`, which keeps none), and a container only the second holds is deep-copied in for a union or an exclusive-or. `xor`
  of a pair of containers is `containerXor` (section 6), one pass over the pair; a pair with nothing left drops its key. Building the result as `clone()` followed by an in-place combine
  would flag every container of the first operand for good and make each later write to it copy a container, which is why
  these are separate walks.
- **`add` / `remove`.** Binary search of the key list, then `containerAdd` / `containerRemove`. A new key splices in a
  one-value array. Removing a key's last value splices the key out.
- **`addMany`.** Sorts the ids (in place if the array is the call's own; on a copy if it is the caller's `Uint32Array`),
  groups them by key and, for a key already held, writes a group of one to four ids with `containerAddSorted` (each id
  put into the container it meets, with no container built for the group: a run container is edited by one gallop
  search per id into a single working copy of its run list, a bitset has its bits set, in place unless it is shared, an
  array has each id inserted). A larger group into a run container goes through `groupPath` (which `addMany` asks) to
  `orRunIdsWalk` when the size rule of `orRunArray` sends it to the merge walk (`walksRunIds`): the same merge as
  `orRunArrayWalk`, reading the ids where they are (low 16 bits, duplicates skipped) with no container built for the
  group, and returning the run container itself when the ids add nothing. The rule refuses from 2,047 steps (the runs
  plus the ids) up, because `2 + 4 * steps` then reaches the 8,192-byte plain body at most, so the band is about 5 to
  2,046 ids for a key of one run, fewer for more runs, and fewer again when the result is small enough for the plain body
  to be an array (then the rule refuses from 1,024 steps). Every other larger group (a run container the rule
  sends through words, any other kind of container) is built into a container with `fromSortedIds` and merged with
  `containerOr(before, group, !before.shared || before.kind === RUN)`; a key not held always gets its container from `fromSortedIds`. The key list is searched by `gallopKeys`, resuming from where the last
  group ended. New keys are collected and put in with one pass: pushed after the last key when they all follow it, else
  one merge pass over the key list.
- **`removeMany`.** Same grouping; a container emptied by it is replaced by a sentinel and all emptied keys are dropped in
  one compaction pass.
- **Combines (`orInPlace`, `andInPlace`, `andNotInPlace`).** `#combine` walks both key lists. Where both hold a key it
  calls the pair kernel (a result of `null` drops the key). Where only `this` holds a key, an intersection skips it by
  galloping `this`'s keys; the other operations keep `this`'s container by reference. Where only `that` holds a key, a
  union adds a deep copy (`cloneContainer`); an intersection or difference skips it, galloping `that`'s keys for an
  intersection. `this`'s key list, container list and size are rebuilt. `that` is never changed.
  The order operands meet in is the store's, not this class's: this codec sets `intersectSmallestFirst`, so for an
  intersect of three or more operands the store's `combineChunk` clones the chunk with the fewest values and meets the
  others in ascending size. A mixed chunk (a run container, a bitset and a sparse array) then starts from the sparse
  array, and each later step is a filter of an array through the bitset's bit test or the runs' walk, never a bitset
  built from runs. A pair of operands keeps its order. The cost is one `size` read per operand per chunk. The native
  codec does not set it: sorting by it made the native four-operand mixed intersect about 8% slower (measured, paired
  against native as shipped over 31 rounds: +7.7% with one codec per process, +8.8% in one process, A/A control in
  band), and it did not make native faster on the other intersect cells measured. Why it did not help is not established: the order
  changes the `size` reads (across the addon boundary for native), which operand is cloned and the order of the ANDs
  together.
- **Counting without building (`andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`,
  `isSubset`, `isEqual`).** Each takes another `TsBitmap` (anything else is a `ValidationError`) and changes neither
  bitmap. `andCardinality` walks both key lists like `#combine`'s intersection, galloping over a stretch of keys the
  other side lacks, and sums `containerAndCard` over the keys both hold. The others are arithmetic on it and the two
  sizes:

  ```
    |A or B|     = |A| + |B| - |A and B|
    |A xor B|    = |A| + |B| - 2 |A and B|
    |A andNot B| = |A| - |A and B|
  ```

  `intersects` returns at the first container pair that shares a value (`containersIntersect`). `isSubset` returns false
  at once when `this` is larger than `other`, when a key of `this` is absent from `other`, or when `containersSubset`
  finds a container with a value its partner lacks (no count). `isEqual` compares the sizes and the key lists, then
  each container pair (`containersEqual`): two containers of one kind compare their words, values or run pairs, eight elements a step with the differences OR-ed and one test per group (arrays and runs
  of 512 values or more (a run container counts two values a run, so 256 runs) go through a 32-bit view over the same bytes when both starts fall on a four-byte boundary, two values a step), and stop at the
  first differing group (exact for runs because every run container is canonical: the decoder refuses runs that touch or overlap and
  every writer of a run keeps its runs maximal, so one set has one list of pairs), and only a pair of different kinds falls back to
  `containerAndCard`; it compares membership, not kinds or bytes, so a bitmap
  decoded from run bytes equals the same ids built from an array. The public class exposes all seven (section 13).
- **`clone`.** Section 4.
- **`maximum()`.** The last key times 65,536 plus the last container's largest value (O(1) from the key list, and for a
  bitset a scan from the top word).
- **`toUint32Array()`.** A new ascending `Uint32Array` of exactly `size` ids; the engine adds a base to it in place, so it
  is never a view of the bitmap's storage. `toArray()` wraps it.
- **Iteration.** `BitmapIterator` walks a container in place: an array by index, a run container by run and value, a
  bitset by word and the lowest set bit of what is left of it (`w & -w`, `31 - clz32`). It is a class so a step is one
  method call and one result object, with no suspended generator frame and no 65,536-entry buffer per iterator. It reads
  live storage and takes no snapshot; what a caller may rely on is in section 12.
- **`encodeChunks()`.** Section 4 for the snapshot. Each step optimizes one container and serializes it as a one-container
  bitmap under key 0 (`serializeContainers([0], [c])`), yielding `{ chunkKey, payload, cardinality }`. Nothing is built
  until a chunk is asked for, so a writer can yield between chunks.

## 8. What it stores and where

**Nothing on disk.** The module is in-memory only. The bytes it reads and writes belong to the `.crbm` chunk payload and
to a caller's serialized bitmap; the module never opens a file or an object.

### Decoded forms in memory

| Kind | Held as | Size of the values |
|---|---|---|
| array | `Uint16Array` slice `data[off, off+len)` | 2 bytes per value |
| bitset | its own `Uint32Array(2048)` | 8,192 bytes, whatever the cardinality |
| run | `Uint16Array` pairs at `data[off + 2i]` | 4 bytes per run |

The `Container` object, the key and container lists and the `TsBitmap` add their own overhead, which this README does not
state: the benches record the heap and resident memory of a full chunk cache per codec.

**The slab.** A decode puts the arrays and run containers of one bitmap side by side in a single `Uint16Array` (sized
exactly from the layout), each reading its own `[off, off+len)`, so a run container of a few bytes costs its bytes and
one small object, not a typed array of its own. Containers that share the slab are flagged `shared`. When a bitmap has
exactly one array or run container, that container is the whole slab and owns it.

**Aliasing the private copy.** `decodeContainers` first copies the input with `Uint8Array.prototype.slice` (which always
copies; a Node `Buffer`'s own `slice` is a view) and checks and reads only that copy, so a buffer another thread is still
writing cannot pass the check and then hold different bytes when they are copied into containers. When that copy owns its
whole `ArrayBuffer` on a little-endian machine, a body at a suitably aligned offset is read in place as a typed array over
the copy: a bitset body at a 4-byte-aligned offset, and the single array or run container at a 2-byte-aligned offset,
with no second copy. In a stored chunk payload a bitset body starts at byte 16 and an array body at byte 16, so both
alias; a run container's pairs start at byte 11, which is odd, so they are copied into a typed array.

### The wire layout it reads and writes

Portable Roaring, little-endian throughout (`wire.ts` header; `portable/layout.ts` for the reader's rules):

```
  no run container                         has a run container
  ----------------                         -------------------
  u32  cookie 12346  (bytes 3a 30 00 00)   u32  cookie 12347 | ((count - 1) << 16)   (bytes 3b 30 xx xx)
  u32  container count                     ceil(count/8) bytes of flags, bit i set = container i is a run
  per container: u16 key, u16 card-1       per container: u16 key, u16 card-1
  per container: u32 offset of its body    per container: u32 offset, ONLY when count >= 4 (NO_OFFSET_THRESHOLD)
  bodies, back to back:                    bodies, back to back (same shapes)
     array : card u16 values
     bitset: 2,048 u32 words (8,192 bytes)
     run   : u16 run count, then (u16 start, u16 length-1) per run
```

`serializeContainers` writes the run cookie when any container is a run, otherwise the no-run cookie. The empty bitmap is
the 8-byte header (`3a 30 00 00 00 00 00 00`); the run cookie cannot state a count of zero. At the codec level an empty buffer also decodes
as the empty bitmap (the public `RoaringBitmap.deserialize` refuses one, section 13). A container's kind on the wire is: run if its flag is set, else bitset if `card > 4096`, else array.

A stored chunk payload is the one-container case of this: 16 bytes of header then the body (no run), or an 11-byte header
for the run cookie (cookie, one flag byte, key, `card-1`, then the run count) with no offset field, because under four
containers the run form has none.

## 9. Worked examples

Each checked against the rules above.

**`{5, 7}`: an array, 20 bytes.** Chunk key 0, two values, no runs, so the no-run cookie, with an offset header.

```
  3a 30 00 00        cookie 12346
  01 00 00 00        1 container
  00 00 01 00        key 0, cardinality-1 = 1
  10 00 00 00        body at byte 16
  05 00 07 00        values 5, 7
  = 4 + 4 + 4 + 4 + 4 = 20 bytes  (16 + 2 * card)
```

**`{0..9}`: a run, 15 bytes.** `optimize`: card 10, plain body 20, one run, run body `2 + 4*1 = 6 < 20`, so a run.

```
  3b 30 00 00        cookie 12347, high half 0 = count-1
  01                 flags: container 0 is a run
  00 00 09 00        key 0, cardinality-1 = 9
  01 00              1 run
  00 00 09 00        start 0, length-1 = 9
  = 4 + 1 + 4 + 2 + 4 = 15 bytes  (11 + 4 * runs)
```

Without `optimize`, `serialize()` of the same ids is the array form: 16 + 20 = 36 bytes. `encodeChunks()` and `optimize()`
then `serialize()` give the 15-byte form.

**5,000 ids that do not run: a bitset, 8,208 bytes.** For example every 13th id from 0 (`0, 13, ..., 64987`): 5,000
values, more than 4,096, so the plain body is the 8,192-byte bitset; there are 5,000 runs, `2 + 4*5000` is not below 8,192,
so no run. The payload is the 16-byte header plus 8,192 = 8,208 bytes. (5,000 consecutive ids would instead be one run,
15 bytes.)

**Ties.** `{0, 1, 2}`: array body 6, run body `2 + 4 = 6`, not strictly smaller, so an array: 22 bytes. `{0, 1, 2, 10, 11}`
(five values in two runs): array body 10, run body `2 + 8 = 10`, also an array.

**Two containers, 28 bytes.** `{5, 65536}` serialized as a whole bitmap (no `optimize` needed: both are arrays):

```
  3a 30 00 00  02 00 00 00            cookie, 2 containers
  00 00 00 00  01 00 00 00            key 0 card-1 0 ; key 1 card-1 0
  18 00 00 00  1a 00 00 00            offsets 24 and 26
  05 00        00 00                  bodies: {5}, {0}  (65536 = key 1, remainder 0)
```

**Counting two bitmaps without building one.** `A = {5, 7, 65536, 4294967295}` and `B = {7, 65536, 65537, 4294967295}`.
Both hold keys 0, 1 and 65535, so `andCardinality` meets three container pairs and builds none:

```
  key 0      A: {5, 7}    B: {7}        array / array   -> 1 shared (7)
  key 1      A: {0}       B: {0, 1}     array / array   -> 1 shared (65536)
  key 65535  A: {65535}   B: {65535}    array / array   -> 1 shared (4294967295)
  |A and B| = 3,  |A| = 4,  |B| = 4
  |A or B|     = 4 + 4 - 3     = 5     (5, 7, 65536, 65537, 4294967295)
  |A xor B|    = 4 + 4 - 2 * 3 = 2     (5 and 65537)
  |A andNot B| = 4 - 3         = 1     (5)
  intersects: true at key 0, the first pair, so keys 1 and 65535 are never read
  isSubset(A, B): false  (A is not larger than B, but key 0's container in A holds a value B's lacks)
```

**Splitting an id.** `1234567890`: `1234567890 >>> 16 = 18838` (18838 * 65536 = 1,234,567,168), remainder
`1234567890 & 0xffff = 722`. Chunk key 18838, value 722. `99999`: chunk key 1, value `99999 - 65536 = 34463`.

## 10. Errors

Two typed errors, both from `@cloudbitmaps/core`. Nothing here throws a bare string.

### `IntegrityError` (bytes, never arguments)

Thrown only by decoding. `safeDeserialize` (bitmap.ts) throws it directly for the size cap and for trailing bytes, and
`decodeContainers` throws whatever `parsePortableLayout` (`portable/layout.ts`) throws.

| Raised by | Message gist | Condition |
|---|---|---|
| `safeDeserialize` | `serialized bitmap is NB, exceeds cap MB` | `bytes.length > maxBytes`; refused before any byte is read |
| `safeDeserialize` with `{ whole: true }` -> `trailingBytes` (wire.ts) | `portable roaring: N bytes follow the bitmap's last container, which ends at byte E. One buffer holds one bitmap...` | bytes after the last container; without `whole` they are ignored |
| layout | `the cookie` / `the container count` / `the run-container bitmap` / `the descriptive header` / `the offset header` needs bytes [a, b) of a N-byte buffer | a header field runs past the buffer |
| layout | `unrecognized cookie 0x..., not a portable-format bitmap` | the first four bytes are neither cookie |
| layout | `container keys are not strictly ascending at index i` | keys out of order or repeated |
| layout | `the offset header puts container i at byte S, but it starts at P` | an offset that is not where the container starts |
| layout | `container i (array) needs bytes...` / `(bitmap)` / `(run count)` / `(run)` | a body runs past the buffer |
| layout | `container i (array) is not strictly ascending at or after element e` | array values not strictly ascending |
| layout | `container i (bitmap) holds B values, but its header says C` | bitset popcount differs from the header's cardinality |
| layout | `container i (run) has run r out of order, overlapping or touching the one before` | runs not ascending, or overlapping, or touching (a writer merges touching runs) |
| layout | `container i (run) has run r running past the end of the container` | a run's last value above 65,535 |
| layout | `container i (run) covers V values, but its header says C` | also refuses a run container with no runs |

The input must be a `Uint8Array` (a Node `Buffer` is one): `decodeContainers` calls `Uint8Array.prototype.slice` on it, which
throws `TypeError` on anything that is not a typed array. The caller-facing entry points check the type first
(next section), so the codec does not.

### `ValidationError` (arguments)

| Raised by | Message gist | Condition |
|---|---|---|
| `add`, `addMany`, `fromValues` (`checkedId`, `collect`) | core's `refusalOfId` wording: `an id must be an integer from 0 to 4294967295; got a string`, and so on | an id that is not an integer in range (a BigInt or a Symbol included); the message names the kind of value and never repeats it; `addMany` / `fromValues` throw before changing the bitmap |
| `orInPlace`, `andInPlace`, `andNotInPlace`, `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`, `isSubset`, `isEqual` (`#of`) | `a TypeScript roaring bitmap combines only with another one` | the other operand is not a `TsBitmap` (the seam promises one codec per store, so the engine never does this) |

In this module `has` of a bad id answers false, and `remove` and `removeMany` of a bad id do nothing (`remove` answers
`false`); the public class refuses a bad id in all three.

`containerMax` has one `RangeError` (`a bitset container holds no bits`) for a state the module's own invariants rule out
(a bitset container is never empty); no input reaches it.

### What a caller sees

- **A stored chunk the codec refuses.** The engine decodes through core's `decodeChunkBytes`, which calls
  `safeDeserialize(bytes, maxBitmapBytes)` and then checks `maximum()` is at most 65,535. The `IntegrityError` is not caught
  there; it propagates up the read as an `IntegrityError` naming the problem (the reader of the `.crbm` object treats it
  as a corrupt object; some core paths, such as erasure and the consistency check, inspect `IntegrityError` to decide what
  to do with a bad object).
- **Bytes a caller supplies** (a `{ serialized }` load, or `RoaringBitmap.deserialize`): core's `decodeSerialized` checks the
  value is a `Uint8Array` and under the load cap, calls `safeDeserialize(..., { whole: true })`, and converts the
  `IntegrityError` into `ValidationError`: `<what> is not a valid bitmap: <the message above>`. Those bytes are the
  caller's input, not a corrupt stored object.
- **A bad id in a load.** The engine splits ids itself first and throws `ValidationError` (`an id must be an integer from 0
  to 4294967295; got ...`); the codec's own check is a second line behind it.

## 11. What watches it

Everything here is a test, a workflow or a bench, not part of the module.

- **The oracle against CRoaring** (`tests/roaring/codec-oracle.test.ts`, with the shared helper `tests/helpers/roaring-oracle.ts`).
  Every codec in the helper's `CODECS` list (the native one, which proves the oracle against itself, and this one, the store's) is held
  to three answers: CRoaring through the pinned `roaring` package (contents, operation results, and the bytes it stores
  after `removeRunCompression()` and `runOptimize()`); the stored-byte rule written from `docs/format.md` section 3
  alone (`ruleBytes`); and a plain `Set`. For each case: `fromValues` then `optimize()` then `serialize()` is
  byte-identical to CRoaring's stored bytes and to the rule's; operations give identical contents; stored chunks are the
  same bytes. The generators bias toward container boundaries and run ties, which a uniform random set almost never hits.
- **The hostile-bytes half** (`tests/roaring/codec-oracle-hostile.test.ts`). `safeDeserialize` must throw `IntegrityError`
  exactly when `checkPortableLayout` throws, with `whole: true` must refuse exactly the buffers that hold trailing bytes,
  must refuse over the cap before reading, and must hold the same set CRoaring decodes from every accepted input. Inputs
  are a table of malformed shapes, then real payloads with bytes overwritten, truncated and extended.
- **The oracle pin** (`tests/roaring/oracle-pin.test.ts`). The pinned `roaring` and its bundled CRoaring versions are
  checked, because the bytes CRoaring writes at run ties changed between CRoaring versions; moving the pin is a deliberate
  edit, and the stored-byte rule does not move with a dependency.
- **The codec's own books** (`tests/roaring/ts-roaring.test.ts`): `size` stays the true cardinality through every kind
  change from an empty bitmap, from ids and from a decoded run container; ids refused; operands that are not mixed.
- **Fast paths against a `Set` and against the native codec** (`tests/roaring/ts-roaring-fast.test.ts`,
  `tests/roaring/ts-roaring-fast-paths.test.ts`): every pair of container kinds through every in-place combine, bulk adds
  and removes across many keys, decoded bitmaps whose small containers share a slab, the class iterator, lazy
  `encodeChunks` from a snapshot, the gallop around its skew of 16, the bitset word loops, run edges and word boundaries,
  copy-on-write against every mutator (before, during and with a clone during an `encodeChunks`), a bitmap combined with
  itself, and decodes that must not alias their input (a `Uint8Array`, a `Buffer`, a pooled `Buffer`, a
  `SharedArrayBuffer`, an offset subarray).
- **The small-body loops** (`tests/roaring/small-body-loops.test.ts`): `appendIds` of run containers at every length around the
  old table threshold and with every base, and the bytes of bodies of 0 to 70 values against CRoaring.
- **Run results** (`tests/roaring/run-combine-results.test.ts`): every combine of two run containers is exact, canonical (maximal
  ascending runs) and in its smallest kind, on whole bitmaps against CRoaring, through serialize and decode.
- **The subset kernel** (`tests/roaring/container-subset.test.ts`): `containersSubset` and `containersIntersect` on every pair
  of kinds against a plain set, at the first and last element, and on whole bitmaps against CRoaring.
- **The counting kernels** (`tests/roaring/count-kernels.test.ts`): `containerAndCard` and `containersIntersect` against a
  `Set` for each of the nine ordered pairs of kinds (array, bitset, run on both sides, with the 16-bit kinds stored at an
  offset in a shared slab), over generated sets that pick every branch (few, many, runs, the chunk ends, one side far longer);
  the seven bitmap operations against CRoaring and a `Set` over ids at 2^31 and 0xFFFFFFFF, bitmaps built from ids and
  decoded from run bytes; the identities between the counts and the built union, intersection and difference;
  `isEqual` after `serialize` and `safeDeserialize`; empty bitmaps; a bitmap that is not a `TsBitmap`; the edge sizes of each
  branch (31, 32 and 33 values, and 16 times the values less one, exactly and plus one, for array against array and array
  against runs); and that the probe leaves no scratch bit behind after an intersect test that hits and one that scans to the
  end (a count on an unrelated pair would see it). Each kernel was held by mutating it and watching a test fail.
- **The store's suites on this codec.** This codec is the store's default in every vitest project, so the flavor's,
  core's, the engine's end-to-end and the memory and local-file drivers' suites all run on it. A first test
  (`tests/roaring/codec-switch.test.ts`) fails if this codec is not the one in force. A test that compares the two
  codecs, or needs the native binding, runs under `withNativeCodec` (`tests/helpers/codec-leg.ts`), which puts the native
  codec behind the store for that test alone.
- **Strength and nightly runs.** The oracle's property counts, its small-window subset counts and the hostile-byte
  mutation count are reduced on a pull request and full strength when `CB_TEST_STRENGTH=full`, which the nightly
  full-strength workflow sets (`tests/helpers/strength.ts`: oracle properties 40 reduced, 200 full; subsets 4,096 and
  65,536; mutated payloads 10,000 and 100,000). The nightly workflow also names the two oracle test files among its
  triggers.
- **Fuzz.** Two coverage-guided targets, both in the nightly fuzz matrix. `fuzz/targets/safe-deserialize.mjs`
  (`pnpm fuzz:deser`) feeds adversarial bytes to this codec's `safeDeserialize`, each input read with and without
  `whole`, and a second leg sends each input through `RoaringBitmap.deserialize`; it holds what either accepts to
  `assertConsistentDecode` (a self-consistent bitmap, or a typed `CloudRoaringError`), and what the public door accepts to
  a `serialize` then `deserialize` that gives an equal bitmap. `fuzz/targets/bitmap-ops.mjs` decodes bytes into a
  `RoaringBitmap` and then runs a byte-driven sequence of the class's operations against a `Set` model, so guidance
  reaches the kernels through shapes only a decode produces (run containers, a slab of small containers); every counting
  method is checked there against the model on pairs of the starting bitmap, its clone, itself and small operands, reading no
  input byte, so an input recorded before the counts were added decodes as it did. All of it is
  instrumented JavaScript, so guidance reaches `decodeContainers`, the slab and the aliasing paths after the shared
  structural check (`portable/layout.ts`). The committed reproducers are replayed through the same decoder on every pull
  request (`tests/core/crbm/fuzz-corpus.test.ts`); `fuzz/README.md` describes the targets.
- **The public class** (`tests/roaring/roaring-bitmap*.test.ts`): section 13 lists what each file holds.
- **The paired bench** (`bench/ts-codec-paired.cjs`, recorded, never asserted). A change under this directory is held
  to the store's hot paths by a paired comparison: the codec at the base commit, the codec at the head and the codec at the
  base again as an A/A control, rotated within one run, one subject per process, over the engine bench's cells and the
  write path. Each cell is judged by `bench/lib/paired-verdict.cjs`: the distribution-free 95% interval of the median
  difference between the head and the mean of the base and the control must sit within a fixed 2% bar, with the control
  itself within 2% of the base; every pass is kept and gated, and a round that ends at a load of 6 or more, or in which a figure is both more than 100 times its median and under half on CPU (the machine slept; a slow head burns CPU and is kept), is taken again.
- **The benches** (recorded, never asserted). `bench/ts-codec.cjs` times one operation at a time on one chunk against the
  native codec (`has`, `decode`, `serialize`, `iterate`, `toUint32`, `optimize`, `count`, `clone`, `build`, `addMany`; and,
  or, andNot on six operand pairs; `--memory` adds bytes per decoded chunk by kind). `bench/ts-codec-engine.cjs` compares
  the two codecs through the store: reads (`has`, `count`, `iterate`, `intersect`, `andNot`), the bulk load, an erasure's
  rewrite and an export, the memory of a full chunk cache and start-up, each read cell two ways (three stores in one
  process, three fresh processes) with the native codec timed twice as an A/A control.
  `pnpm bench:ts-codec:check` (`bench/ts-codec.cjs --check`) times nothing: it runs every operation once on both codecs and
  fails if their answers differ or a cell is missing. `pnpm bench:ts-codec-engine:check` runs every part once at tiny scale
  and fails only if the output is malformed, the codecs disagree on an answer, a store ran the wrong codec, the cache was
  not warm, or the two codecs wrote different bytes; it compares no duration with a bound. `bench/README.md` lists both.
  `bench/count-kernels.cjs` times `andCardinality`, `intersects`, `isSubset` and `isEqual` against building the result and
  taking its size, on the five data sets of the engine bench, a tiny-against-runs pair and two disjoint pairs, as a paired
  comparison with a second build as the control; `bench/lib/count-cells.cjs` holds the cells and the stop rule, one decision
  for the family: the four cardinalities and `intersects` call the kernels if `andCardinality` beats build-then-size on
  every group (the median of the 31 rounds of the count against the build is below zero on each), and are otherwise all derived by building then counting. `--gate` prints one `RESULT` line and exits 0 (kept),
  3 (derived) or 4 (the record is incomplete or invalid). Whether a change slows the store's hot paths is the
  paired harness's question (`bench/ts-codec-paired.cjs`), not this one's. `--check` runs every cell once at a tiny scale and
  fails if a count differs from the built result, a cell is missing, or the head does not time the count.

## 12. Behaviours worth knowing

- **Iteration reads live storage; mutating a bitmap while iterating it is not supported.** The iterator holds the key
  list and container list the bitmap had when the iterator was made, and a container's storage as of the step that
  entered it. It takes no snapshot (only `encodeChunks` does), and nothing in the codec seam promises iteration during
  mutation. A caller may rely on this: an iteration of a bitmap that nothing changes yields every id once, ascending, and
  then ends. If a caller does change the bitmap meanwhile, the iterator does not throw and does not read outside the
  storage it holds, but what it yields is unspecified: an id added or removed during the walk may or may not appear, an
  id may be skipped or repeated, and ascending order is not promised. What happens depends on the write: an `add` or
  `remove` splices the lists the iterator holds, so positions shift under it; a combine or an `insertAll` pass may
  replace the bitmap's lists, so the iterator keeps walking the old lists while an unshared bitset's words may already
  have been written in place; `encodeChunks` flags containers shared, so a write after it copies and leaves what the
  iterator holds untouched. To change a bitmap while walking it, collect the ids first (`toUint32Array()`) or iterate a
  `clone()`.
- **A combine can leave a run in the result.** A pair of containers combines into an array or a bitset, except that two run
  containers, and a run container with an array for `or`, keep a run result while it is the smaller form, and a key held by only one side keeps that side's container by
  reference (a union copies the other side's), and that container may be a run. `optimize()` before `serialize()` is what
  makes stored bytes depend on the set alone.
- **`encodeChunks` flags the bitmap's containers shared.** Membership and bytes are untouched; the next write to each
  container then copies it once.
- **`safeDeserialize` copies its input** before checking it, once per decode.
- **Ids above 65,535 inside one chunk.** The codec itself accepts any container keys in a bitmap; a stored chunk is held to
  remainders `0..65535` by core's `maximum()` check after decode, not by this module.

## 13. The public class, `RoaringBitmap`

`packages/roaring/src/bitmap.ts` is a public class around `TsBitmap`. The module's own files stay internal: `TsBitmap`,
`encodeChunks`, `optimize` and the containers are not exported, so the seam is not frozen into the promise.

```
         import { RoaringBitmap } from '@cloudbitmaps/roaring'
                                       |
                 RoaringBitmap  (src/bitmap.ts)  #bitmap: TsBitmap
                    |  checks every argument, then forwards
                    v
                 TsBitmap (this module)  ---->  containers: array | bitset | run
                    ^
   RoaringBitmap.deserialize(bytes) --> core decodeSerialized (type, size cap, copy, layout check, whole)
                                        --> TsBitmap.safeDeserialize(..., { detached: true })
```

**What the shell adds and nothing else.**

- **Ids are checked, and a refusal never repeats the value.** `has`, `add`, `addMany`, `remove`, `removeMany` and the
  constructor throw `ValidationError` for anything that is not an integer from 0 to 4,294,967,295, using core's
  `refusalOfId` (exported from core's main entry, which is outside the stability promise). The check runs before any
  container is touched, so a refused call leaves the bitmap unchanged. `TsBitmap` keeps its own lenient rules for the
  engine: `has` of a bad id answers false and a removal ignores it.
- **`add` and `remove` take one id.** The shell reads `arguments.length` and refuses a second argument with a message that
  names `addMany` or `removeMany`; no rest array is built on the per-id path. `remove` answers whether the id was there.
- **Typed arrays are read safely.** A `Uint32Array` is read in place when it already ascends and sorted on a copy
  otherwise, never changed or kept; one in a `SharedArrayBuffer` is copied first, because it is read twice (the sortedness
  check, then the build) and another thread could write between the reads. A `Uint8Array`, `Uint8ClampedArray` or
  `Buffer` passed as ids is refused: each byte would be read as an id.
- **The statics and `xorInPlace`.** `RoaringBitmap.and`, `or`, `xor` and `andNot` check both operands, call the matching
  `TsBitmap` static and wrap the result. `orMany` checks every element first (so nothing is combined when one is refused),
  then calls `TsBitmap.orMany` (the many-way union above): the result's containers are its own and unflagged, and no
  operand is written or flagged. `xorInPlace` is one in-place combine
  (the same walk as `orInPlace`, with `containerXor` per shared key, a container only the operand holds copied in): a
  bitset nobody else can see is written in place, and a bitmap xor-ed with itself is empty.
- **Operands are branded.** `andInPlace`, `orInPlace`, `andNotInPlace`, `xorInPlace`, the statics and a bitmap passed to `addMany` or `removeMany`
  are recognised by the class's private field, so one from a second installed copy of the package is refused rather than
  read through members it does not share. `addMany(bitmap)` is `orInPlace` and `removeMany(bitmap)` is `andNotInPlace`.
- **The counts and comparisons.** `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality` and `intersects`
  check the operand with the brand, then answer through one switch (`COUNT_BY_KERNELS`, in `src/count-route.ts`): `true`
  calls the codec's counting members above, `false` builds the combination with the matching `TsBitmap` static and reads
  its `size` (or `isEmpty` for `intersects`). The switch is `true`: the count bench's record
  (`bench/count-kernels-results.json`) has the count's median below the build's on every data set and
  its gate prints `RESULT kept`; the speed of each answer against native is in the generated table of the API reference. Both routes give the same answers and change neither operand, and the test
  suite runs once on each (`tests/roaring/roaring-bitmap-counts.kernels.test.ts` and `.derived.test.ts`, one shared
  suite). `isSubset` and `isEqual` always call their codec members. A non-bitmap operand is a `ValidationError` for all
  seven, `isSubset` included.
- **`minimum()`, `maximum()` are `undefined` when empty.** `minimum` reads the first container's smallest value
  (`containerMin`, beside `containerMax`); neither scans.
- **`clear()`** drops the key and container lists. A container a clone shares is left to the clone, so it does not copy.
- **`runOptimize()`** runs `optimize` (each container in its smallest form; a run only where strictly smaller than the plain
  body) and answers whether any container is a run afterwards (`hasRunContainer`), not whether anything changed.

**The detached decode.** The store's chunk decode reads a bitset in place as a view over the private copy of the input and
puts the arrays and runs of a multi-container decode in one slab. That is free for a one-container chunk and a hazard for a
long-lived public bitmap: one decoded from 300 MB and then reduced by `andInPlace` to a few containers would keep the
whole input alive. `RoaringBitmap.deserialize` passes `detached: true`, which gives every bitset, array and run its own
storage and no slab, so the copy of the input is garbage when the call returns. The store's decode does not pass the flag
and keeps its aliasing. The price is one more copy of the live data at decode.

**The one door for bytes.**

| Step | Where | Refusal |
|---|---|---|
| second argument is `undefined` or an object whose only key is `maxBytes` | the shell | a format argument, any other key, a bad `maxBytes` |
| a zero-length or detached `Uint8Array` | the shell | an empty buffer is not a bitmap |
| length over `maxBytes` when it is lower than the cap | the shell | before any byte is read |
| type, the 537,403,396-byte cap, one copy of the input, the layout check, one whole bitmap | core's `decodeSerialized` | converted to `ValidationError`, `<what> is not a valid bitmap: <reason>`, with no container key |

Core's own rule that an empty buffer is the empty bitmap stays for a store load, where an empty object means nothing was
stored; the public door refuses it because a failed or truncated upload would otherwise become "no ids".

**Errors the class raises.** Only `ValidationError`, never `IntegrityError` (that is for a stored object that is damaged),
and one `RangeError` that is the runtime's own, from `toArray` or `toUint32Array` on a bitmap too large to allocate.

| Raised by | Condition |
|---|---|
| the constructor, `add`, `addMany`, `has`, `remove`, `removeMany` | an id that is not an integer from 0 to 4294967295; a constructor or `addMany` argument that is not an iterable (a string included) |
| `add`, `remove` | more than one argument |
| the constructor | a `Uint8Array`, `Uint8ClampedArray` or `Buffer` |
| `andInPlace`, `orInPlace`, `andNotInPlace`, `xorInPlace`, `RoaringBitmap.and`, `or`, `xor`, `andNot`, `orMany`, `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`, `isSubset`, `isEqual` | an operand (for `orMany`, any element, or a list that is not an iterable) that is not a `RoaringBitmap` of this copy of the package; nothing is combined |
| `deserialize` | not a `Uint8Array`; empty or detached; over the cap or `maxBytes`; not one well-formed bitmap; a second argument other than `undefined` or `{ maxBytes }`; a `maxBytes` outside 0 to the cap |
| `serialize` | an argument other than `undefined` or `'portable'` |

**What watches it.**

- `tests/roaring/roaring-bitmap.test.ts`: every method against CRoaring (through `roaring`), the stored-byte rule and a
  plain `Set`, on generators biased to container boundaries, run ties, and ids at 2^31 and at 0xFFFFFFFF.
- `tests/roaring/roaring-bitmap-algebra.test.ts`: the statics and `xorInPlace` against CRoaring on every pair of the oracle's
  shapes (ids at 2^31 and 0xFFFFFFFF included) and on random container shapes; the laws (commutativity, associativity, `a xor a`
  empty, `andNot` against `and` with a complement over the universe of the test, `orMany` equal to the fold of `or`,
  `xorInPlace` equal to `xor`, absorption); that a result never changes when an operand later does and an operand never changes
  when the result does, under every mutator, including a container only the second operand holds and `orMany` of one bitmap or
  of the same bitmap twice; that a result keeps neither a decoded operand nor its input alive, `orMany`'s own result included;
  and each refusal.
- `tests/roaring/roaring-bitmap-counts.kernels.test.ts` and `tests/roaring/roaring-bitmap-counts.derived.test.ts`: the seven
  counts and comparisons against CRoaring on every pair of the oracle's shapes (ids at 2^31 and 0xFFFFFFFF, empty, a bitmap
  against itself and its clone) and on random container shapes, the identities against the returning forms
  (`andCardinality(a, b) == and(a, b).size`, `intersects == andCardinality > 0`, `isSubset(a, b) == andNot(a, b).isEmpty`,
  `isEqual` symmetric and equal to element-wise equality), that no operand or earlier clone changes, and each refusal, once with
  each route of the switch; the suite also proves, for each of the seven methods, which route a run took (the combination it built, if any, and whether it called its codec member), and every pair of its shapes runs again with run containers on either side or both.
- `tests/roaring/fuzz-count-reproducers.test.ts`: the committed `bitmap-ops` reproducers for the counts: two start from an
  array, a bitset and a run and call every count; the third has no bitmap bytes and asks every counting method to take a
  value that is not a bitmap. The target's check fires on a wrong answer from the first two and on a non-bitmap operand
  that a method accepts.
- `tests/roaring/ts-bitmap-sharing.test.ts`: at the codec level, which containers each static flags shared and which container
  objects it hands back (`and` and the union `orMany` builds flag nothing; `or`, `xor` and `andNot` flag exactly the containers
  only the first operand holds, and keep those objects; a container only the second operand holds is always a copy; no pair
  kernel returns an operand's object).
- `tests/roaring/roaring-bitmap.property.test.ts`: round trips, `clone` independence under every mutator and across
  generations of clones, ascending iteration, and a load of a bitmap writing what a load of its ids writes.
- `tests/roaring/roaring-bitmap-refusals.test.ts` and `tests/roaring/errors-carry-no-id.test.ts`: each refusal, the
  bitmap unchanged after it, and no message carrying an id, a bound or a container key.
- `tests/roaring/roaring-bitmap-deserialize.test.ts`: the door's table of inputs and the hostile shapes from the codec's
  hostile-bytes test, run through the public door.
- `tests/roaring/roaring-bitmap-retention.test.ts`: decodes a multi-container bitmap, reduces it, drops the input and checks
  the heap falls, with a control that decodes without `detached` and does not.
- The fuzz targets (section 11) and, on every build, `pnpm smoke`: the class from the main entry is one object under ESM and
  `require()`, and it works. The package's main entry also loads the store's in-process backends and their Node builtins,
  so the class runs where the package runs.

## 14. Credits

The Roaring Bitmap format and its algorithms are the work of Daniel Lemire and colleagues. See
[roaringbitmap.org](https://roaringbitmap.org/) and the [Roaring format specification](https://github.com/RoaringBitmap/RoaringFormatSpec),
which defines the portable bytes this module reads and writes. The papers the implementation follows:

- S. Chambi, D. Lemire, O. Kaser, R. Godin, "Better bitmap performance with Roaring bitmaps", *Software: Practice and
  Experience* 46(5), 2016. [arXiv:1402.6407](https://arxiv.org/abs/1402.6407)
- D. Lemire, G. Ssi-Yan-Kai, O. Kaser, "Consistently faster and smaller compressed bitmaps with Roaring", *Software:
  Practice and Experience* 46(11), 2016. [arXiv:1603.06549](https://arxiv.org/abs/1603.06549)
- D. Lemire, O. Kaser, N. Kurz, L. Deri, C. O'Hara, F. Saint-Jacques, G. Ssi-Yan-Kai, "Roaring Bitmaps: Implementation
  of an Optimized Software Library", *Software: Practice and Experience* 48(4), 2018.
  [arXiv:1709.07821](https://arxiv.org/abs/1709.07821)

CRoaring, through the `roaring` package, is the test oracle: the tests compare this codec's contents, results and stored
bytes with it.
