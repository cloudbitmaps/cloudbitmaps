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
and writes a load through `encodeChunks()`.

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
  tsRoaringCodec.safeDeserialize(bytes, maxBytes, { whole? })
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
  structure). A decoded run container stays a run until it is changed.
- A write (`containerAdd`, `containerRemove`) first `demote`s a run container, so no mutating path edits runs. An array
  at 4,096 values that gains one more becomes a bitset; a bitset that drops to 4,096 or fewer becomes an array
  (`fromWordsCard`).
- The result of combining one pair of containers is an array up to 4,096 values or a bitset above, never a run, whatever
  the pair was. A bitmap-level combine can still hold a run: a key held by one side only keeps that side's container as
  it is (section 7).
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
| `valueScratch` (`Uint16Array`) | starts at 8,192 entries | array results whose size is known only after they are built (`andArrays`, `filterByBits`, `filterByRuns`, `andNotArrays`, `orArrays`) | a kernel writes into it and copies out exactly `n` values (`arrayOfScratch`) |
| `pairScratch` (`Uint16Array`) | starts at 8,192 entries | run-pair results (`andRuns`, `orRuns`, `andNotRuns`) | same |
| `probeWords` (`Uint32Array`) | 2,048 words (one bitset) | the scratch-bitset probe in `andArrays` and `andNotArrays` | all zero between calls: each call clears the bits it set |

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

`iota()` is a lazily built table of 0..65,535 as `u16`s (128 KiB), used by `appendIds` to expand a long run with one
widening copy; it is built on the first long run and kept.

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

Every result is an array up to 4,096 values, a bitset above, or nothing (`null`, and the key is dropped).

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

### Runs

- `andRuns`, `orRuns` (merges touching runs: `s <= end + 1`), `andNotRuns`: one walk over both run lists into
  `pairScratch`, then `fromRunPairs` builds an array (up to 4,096 values) or a bitset from the pairs.
- `bitsetInRuns`: reads only the bitset words each run covers, each masked to the run's ends. A run container of at
  most 4,096 values cannot yield more than an array holds, so its result is written straight to a scratch array of
  positions and copied out: no 8 KiB bitset, no popcount. A larger run container copies the covered words into a fresh
  bitset and counts it once with Harley-Seal (counting each covered word with a 32-bit popcount instead measured the
  same on a chunk whose runs cover about half the words, so the single count stays). The trade: the small branch pays one
  bit-extraction step per result value, which is cheaper than the allocation and the 2,048-word count it replaces
  whenever the result is at most 4,096 values, the only case it is taken for.
- Run against array for `or`, and a run as the first operand of `andNot` with a non-run second operand: the run is
  expanded to words (`toWords`, which it owns), then the other operand's bits are set or cleared.

### Single-container operations

- `containerHas`: array by binary search, bitset by bit test, run by finding the last run starting at or before the value.
- `appendIds(c, out, at, base)`: writes ids plus `base`. An array with `base === 0` is one widening `out.set`; a run
  longer than 48 values (`LONG_RUN`) is one `out.set` from the `iota()` table, then `base` added if nonzero; shorter runs
  are counted out.
- `runCount`: for arrays, counts breaks in consecutive values; for bitsets, counts set bits whose lower neighbour is clear
  (a word-parallel `w & ~((w << 1) | carry)`), skipping words of all ones or none.
- `toRun` for a bitset reads starts and ends word by word and alternates them across words; a run of one value is both at
  once.

### The thresholds and what each trades

| Constant | Value | Where | Trades |
|---|---|---|---|
| `ARRAY_MAX_CARDINALITY` | 4,096 | everywhere a kind is chosen | the format's own array/bitset boundary: array body `2*card` reaches the bitset's 8,192 bytes at 4,096 |
| `GALLOP_SKEW` | 16 | `andArrays`, `andNotArrays` | a larger value gallops less often: better for similar sizes, worse for skewed ones |
| `PROBE_MIN` | 32 | `andArrays` (shorter side), `andNotArrays` (second operand) | a lower value pays the bitset's set-and-clear on pairs a merge finishes sooner; a higher value leaves mid-sized pairs on the slower merge |
| `LONG_RUN` | 48 | `appendIds` | a run shorter than this is counted out; longer is copied from the `iota` table |
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
- **`add` / `remove`.** Binary search of the key list, then `containerAdd` / `containerRemove`. A new key splices in a
  one-value array. Removing a key's last value splices the key out.
- **`addMany`.** Sorts the ids (in place if the array is the call's own; on a copy if it is the caller's `Uint32Array`),
  groups them by key, builds one container per group with `fromSortedIds`, and for a key already held does
  `containerOr(before, group, !before.shared)`. The key list is searched by `gallopKeys`, resuming from where the last
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
  band), and it did not make native faster on the other intersect cells measured. Why is not measured: the order
  changes the `size` reads (across the addon boundary for native), which operand is cloned and the order of the ANDs
  together.
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
the 8-byte header (`3a 30 00 00 00 00 00 00`); the run cookie cannot state a count of zero. An empty buffer also decodes
as the empty bitmap. A container's kind on the wire is: run if its flag is set, else bitset if `card > 4096`, else array.

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
| `orInPlace`, `andInPlace`, `andNotInPlace` (`#of`) | `a TypeScript roaring bitmap combines only with another one` | the other operand is not a `TsBitmap` (the seam promises one codec per store, so the engine never does this) |

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
- **The store's suites on this codec.** Every suite runs on this codec by default. A vitest project, `ts-codec`, re-runs
  the flavor's, core's, the engine's end-to-end and the memory and local-file drivers' suites with the switch pinned to
  this codec (`tests/setup-codec-ts.ts`); a first test (`tests/roaring/codec-switch.test.ts`) fails if this codec is not
  the one in force, and the setup fails a test in which the native codec ran when it was not meant to. A test that
  compares the two, or needs the native binding, runs under `withNativeCodec`, and one that cannot run on this codec
  skips itself with `codecLeg()`.
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
  reaches the kernels through shapes only a decode produces (run containers, a slab of small containers). All of it is
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
- **A combine can leave a run in the result.** A pair of containers combines into an array or a bitset, never a run, but a
  key held by only one side keeps that side's container by reference (a union copies the other side's), and that
  container may be a run. `optimize()` before `serialize()` is what makes stored bytes depend on the set alone.
- **`encodeChunks` flags the bitmap's containers shared.** Membership and bytes are untouched; the next write to each
  container then copies it once.
- **`safeDeserialize` copies its input** before checking it, once per decode.
- **Ids above 65,535 inside one chunk.** The codec itself accepts any container keys in a bitmap; a stored chunk is held to
  remainders `0..65535` by core's `maximum()` check after decode, not by this module.

## 13. The public class, `RoaringBitmap`

`packages/roaring/src/bitmap.ts` is a public class around `TsBitmap`. The module's own files stay internal: `TsBitmap`,
`encodeChunks`, `optimize` and the containers are not exported, so the seam is not frozen into the promise.

```
  import ... from '@cloudbitmaps/roaring/bitmap'      import ... from '@cloudbitmaps/roaring'
            |                                                   |
            +-------------------- one class ------------------+
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
- **Operands are branded.** `andInPlace`, `orInPlace`, `andNotInPlace` and a bitmap passed to `addMany` or `removeMany`
  are recognised by the class's private field, so one from a second installed copy of the package is refused rather than
  read through members it does not share. `addMany(bitmap)` is `orInPlace` and `removeMany(bitmap)` is `andNotInPlace`.
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
| `andInPlace`, `orInPlace`, `andNotInPlace` | an operand that is not a `RoaringBitmap` of this copy of the package |
| `deserialize` | not a `Uint8Array`; empty or detached; over the cap or `maxBytes`; not one well-formed bitmap; a second argument other than `undefined` or `{ maxBytes }`; a `maxBytes` outside 0 to the cap |
| `serialize` | an argument other than `undefined` or `'portable'` |

**What watches it.**

- `tests/roaring/roaring-bitmap.test.ts`: every method against CRoaring (through `roaring`), the stored-byte rule and a
  plain `Set`, on generators biased to container boundaries, run ties, and ids at 2^31 and at 0xFFFFFFFF.
- `tests/roaring/roaring-bitmap.property.test.ts`: round trips, `clone` independence under every mutator and across
  generations of clones, ascending iteration, and a load of a bitmap writing what a load of its ids writes.
- `tests/roaring/roaring-bitmap-refusals.test.ts` and `tests/roaring/errors-carry-no-id.test.ts`: each refusal, the
  bitmap unchanged after it, and no message carrying an id, a bound or a container key.
- `tests/roaring/roaring-bitmap-deserialize.test.ts`: the door's table of inputs and the hostile shapes from the codec's
  hostile-bytes test, run through the public door.
- `tests/roaring/roaring-bitmap-retention.test.ts`: decodes a multi-container bitmap, reduces it, drops the input and checks
  the heap falls, with a control that decodes without `detached` and does not.
- The fuzz targets (section 11) and, on every build, `pnpm smoke`: the `./bitmap` entry is walked for `node:*` specifiers,
  bundled for a runtime-neutral platform and loaded in a context with web globals only, and the class from the main entry
  and from `./bitmap` is one object under ESM and `require()`. `tests/arch` fires planted inputs at that gate both ways.

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
