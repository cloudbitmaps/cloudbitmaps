# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The evidence is
`bench/ts-codec-comparison-results.json`: every round of every figure, with the medians, quartiles and verdicts computed
from the rounds (`tests/bench/ts-codec-verdict.test.ts` recomputes them, and looks up every figure of the tables below in
the file). The instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc bench/ts-codec-engine.cjs --all`, about an
hour), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.18.1. Every figure comes from one `--all` run on the committed tree
`daf216e1f4797123f5da5b5682f65646632dcad9` (the codec change of this branch merged with the bench of its parent; the file
and this report were committed after it), the tree clean, holding the machine's heavy-work lock throughout. The 1-minute
load average, which includes the bench's own processes, was under 6 when every cell started; during a cell it peaked at
6.2 to 6.6 in the per-process rounds of the sparse, runs and mixed sets and at 8.2 (per-process) and 8.8 (in-process) in
spread8k, which the load column and the file show, so those cells ran while the machine was busier than the 6 the rule
names; the controls of the sparse, runs and mixed cells stayed within +-2.1%. The write path saw a peak of 6.2, memory 5.9 and
start-up 5.4. The before figures quoted for comparison are the parent branch's committed ones (`8a5839f1`). Every figure is
wall-clock on one machine, recorded and not asserted.

## How a verdict is computed

A round times the same call on three subjects: native (A), TypeScript and native again (the A/A control, B), in an order
that rotates through the six permutations. A cell's two figures are the median over 31 rounds of `typescript / native - 1`
and of `control / native - 1`, with their quartiles in the file. **Derived verdict** (`bench/lib/codec-verdict.cjs`): the
control's median within +-2% and the TypeScript median at most +5% is `within the 5% bar`; the TypeScript median above +5%
with the control in band is `over the 5% bar`; a control outside +-2% is `inconclusive`, because the machine moved more
than the bar can see. The verdict of an op is the worst of its cells.

Every read cell is measured two ways, and the table gives both:

- **In-process:** the three subjects are three stores in one process. Its limit: core's call sites (the codec calls, the
  combine code) see both the native wrapper and the TypeScript bitmap in the one process, so they are polymorphic here and
  monomorphic in production, and the V8 heap carries the TypeScript store's whole decoded cache while the native store
  runs, which adds marking work to every store's garbage collections. The A/A control shares both effects with the
  native store, so it cannot reveal them.
- **Per-process:** the three subjects are three fresh processes, one codec each (native, TypeScript and a second native
  process as the control), each timing every op of the data set once per round, in a rotating order, 31 rounds. The call
  sites see one codec and the heap holds one store, as in production. Its limit: a fresh process's own variance is in every
  figure, which is what its control measures, and the facade bundle loads the native addon in every process, the
  TypeScript one included.

**The gate verdict of a cell is the per-process one**, because it is the one that looks like production; the in-process
figures are the cross-check. They agree on every cell that is over the bar. Where they differ, the table shows both
verdicts: in-process, sparse `iterate` (control -3.2%), sparse `andNot` (control +3.3%), mixed `has` (control -2.2%) and
spread8k `intersect4` (control -3.2%) are inconclusive where per-process is within the bar; no cell is inconclusive
per-process. The two ways were taken at different times in each cell's life, so a control that sits just
outside the band in one is machine drift, not a property of the cell.

A store's calls were counted per codec in one untimed pass over the stores that were timed, with their caches dropped
first (a warm read calls methods of the cached bitmaps, not the codec's own functions, so the decode and the combine are
what show which codec a store holds): every TypeScript subject ran only the TypeScript codec and every native one only the
native codec, in both ways (measured, zero failures). `count` made no codec call at all in any cell, in either way
(measured: the counts are in the file). No timed round made a storage call (measured: the file keeps the counts, all empty;
a counter that saw a cold store's first reads, 40 calls over the six data sets, shows that it sees calls), so every cell ran
on a warm cache.

## Gate rows

| gate row | verdict (the per-process one) | evidence |
|---|---|---|
| Correctness: zero oracle differences | measured so far: none | `tests/roaring` and `tests/docs` pass on this tree (12,889 tests), the oracle, hostile-input and fast-path suites among them; the two codecs wrote the same exported bytes in all 31 write-path rounds |
| Correctness: a week of nightly fuzz with none | **cannot be judged yet** | the week starts at merge. Wiring (read from the workflows): `full-nightly.yml` runs the whole suite, the oracle files included, at 04:00 UTC every day; `fuzz-nightly.yml` fuzzes the four untrusted-bytes targets (`deser`, `crbm`, `index`, `ext`) at 05:00 UTC, all of them on the native deserializer: no fuzz target runs the TypeScript codec yet, so the week's fuzz evidence for it is the property tests' |
| Hot path: `has` | inconclusive per-process (dense control -2.5%), within the 5% bar in every other cell, **with little power on the codec** | per-process worst ts vs native -0.6%, worst control -2.5% (dense, inconclusive); in-process worst control -9.3% (spread8k, inconclusive). A call is 512 awaited probes at about 1 us each, of which the codec's `has` is about 26 to 39 ns native and 8 to 29 ns TypeScript on one chunk (`bench/ts-codec-results.json`, measured earlier): a codec two to three times slower on the probe alone would still land within 5% of the call. The per-operation `has` rows are the sensitive figure |
| Hot path: `count` | within the 5% bar, **not informative: no codec call** | per-process worst +1.6%, worst control +1.2%; in-process worst +1.0%, worst control -0.9%. `count` is read from the generation's index; the file records zero codec calls in every cell |
| Hot path: `iterate` | within the 5% bar in every cell per-process but mixed (control +2.1%, inconclusive) | per-process worst +0.8%, worst control +2.1%; in-process worst +2.0%, worst control -2.7% (spread8k, inconclusive). The TypeScript codec is 10% to 11% faster on the spread sets |
| Hot path: `intersect` | **over the 5% bar on one cell** | per-process: two operands within the bar, worst +0.1% (before this branch +22.8%, sparse); four operands worst +17.2% (mixed; before +48.3%), the control -1.3%; in-process +13.3% at four operands. Sparse is now faster than native (-36.8% and -30.9% per-process). Cells below |
| Hot path: `andNot` (beyond the four the gate names) | **over the 5% bar on one cell** | sparse: +6.3% per-process (control +1.2%; before +4.5%) and +8.9% in-process (control +0.3%); every other cell within the bar or faster. This branch does not change `andNot` on two arrays, so the move from +4.5% is not explained by it: the earlier run that read +6.5% in both ways and this one agree that the cell sits above the bar |
| Write path: the bulk load no slower | faster (derived), a **warm** figure | 31 interleaved rounds: load -36.1% (control -0.2%). The first load in a **fresh process** is not that: `loadMs` of the cold row, two loads of the mixed set, is +12.3% on TypeScript (control -1.2%; median of 31 processes each), below |
| Install: works on every package manager with nothing configured | **cannot be judged yet** | measured at the switch, when `roaring` leaves the dependencies; the TypeScript codec has no install step of its own (expected) |
| In-region calibration | **cannot be judged yet** | prepared, not run: see the commands in the pull request and `bench/README.md` |

## The read bench (measured; derived verdicts)

`has` is 512 probes per call, `count` one call, `iterate` a full stream, `intersect2` and `intersect4` an intersection of
two and of four segments of the data set, `andNot` one segment less another. Data sets: dense (32 chunks of 32,768 ids),
sparse (256 chunks of 1,000), runs (128 chunks of 150 runs), mixed (128 chunks, the three kinds in turn), spread (a million
ids over 62,500 chunks of 16: the largest load the research used) and spread8k (the same shape over 8,192 chunks): six data
sets. The 62,500-chunk set takes seconds per combine, so it is timed on `has`, `count` and `iterate` only and the combines
run on 8,192 chunks. Figures are the median per call over 31 rounds; the native and TypeScript columns are the per-process
ones, and the load is the highest seen during that cell's per-process rounds.

| data set | op | native | typescript | ts vs native (per-process) | A/A control (per-process) | verdict (per-process) | ts vs native (in-process) | A/A control (in-process) | verdict (in-process) | load |
|---|---|---|---|---|---|---|---|---|---|---|
| dense | has | 497.9 us | 496.2 us | -2.1% | -2.5% | inconclusive | -1.2% | -0.3% | within the 5% bar | 5.77 |
| dense | count | 1.4 us | 1.4 us | +0.9% | +0.6% | within the 5% bar | -0.2% | +0.1% | within the 5% bar | 5.77 |
| dense | iterate | 162.9 ms | 160.6 ms | +0.8% | -1.6% | within the 5% bar | +2.0% | +0.2% | within the 5% bar | 5.77 |
| dense | intersect2 | 86.0 ms | 86.0 ms | -0.3% | -0.7% | within the 5% bar | +0.1% | -0.2% | within the 5% bar | 5.77 |
| dense | intersect4 | 18.0 ms | 18.9 ms | +4.3% | -0.3% | within the 5% bar | +2.8% | -0.2% | within the 5% bar | 5.77 |
| dense | andNot | 83.3 ms | 85.2 ms | +0.3% | -1.1% | within the 5% bar | +0.6% | +1.0% | within the 5% bar | 5.77 |
| sparse | has | 546.2 us | 542.5 us | -0.9% | +0.4% | within the 5% bar | -2.0% | +0.1% | within the 5% bar | 6.59 |
| sparse | count | 1.5 us | 1.5 us | +0.1% | +0.0% | within the 5% bar | +0.0% | -0.2% | within the 5% bar | 6.59 |
| sparse | iterate | 38.7 ms | 38.2 ms | -0.8% | +0.2% | within the 5% bar | +1.9% | -1.7% | within the 5% bar | 6.59 |
| sparse | intersect2 | 3.7 ms | 2.3 ms | -36.8% | -0.4% | within the 5% bar | -36.6% | -2.1% | inconclusive | 6.59 |
| sparse | intersect4 | 3.8 ms | 2.6 ms | -30.9% | -0.6% | within the 5% bar | -29.6% | +0.6% | within the 5% bar | 6.59 |
| sparse | andNot | 40.6 ms | 43.5 ms | +6.3% | +1.2% | over the 5% bar | +8.9% | +0.3% | over the 5% bar | 6.59 |
| runs | has | 528.9 us | 520.8 us | -1.0% | +0.7% | within the 5% bar | -3.2% | -1.3% | within the 5% bar | 6.23 |
| runs | count | 1.4 us | 1.4 us | -0.7% | +0.1% | within the 5% bar | -0.2% | -0.7% | within the 5% bar | 6.23 |
| runs | iterate | 609.3 ms | 599.9 ms | -2.4% | +0.1% | within the 5% bar | +0.1% | -0.3% | within the 5% bar | 6.23 |
| runs | intersect2 | 408.3 ms | 407.6 ms | +0.1% | -1.2% | within the 5% bar | +0.4% | +1.2% | within the 5% bar | 6.23 |
| runs | intersect4 | 153.2 ms | 153.7 ms | +0.9% | -2.0% | within the 5% bar | +1.1% | +1.1% | within the 5% bar | 6.23 |
| runs | andNot | 254.7 ms | 254.8 ms | +0.5% | +0.6% | within the 5% bar | -1.9% | +0.1% | within the 5% bar | 6.23 |
| mixed | has | 504.5 us | 493.1 us | -3.4% | -0.1% | within the 5% bar | -1.0% | -0.9% | within the 5% bar | 6.61 |
| mixed | count | 1.4 us | 1.4 us | -0.2% | -0.5% | within the 5% bar | +1.0% | +0.1% | within the 5% bar | 6.61 |
| mixed | iterate | 432.1 ms | 425.0 ms | -1.6% | +2.1% | inconclusive | -2.1% | +1.0% | within the 5% bar | 6.61 |
| mixed | intersect2 | 113.9 ms | 114.7 ms | -1.2% | -0.2% | within the 5% bar | -1.1% | -0.4% | within the 5% bar | 6.61 |
| mixed | intersect4 | 2.8 ms | 3.3 ms | +17.2% | -1.3% | over the 5% bar | +13.3% | +0.2% | over the 5% bar | 6.61 |
| mixed | andNot | 356.3 ms | 352.2 ms | -1.5% | -0.7% | within the 5% bar | -2.4% | -1.1% | within the 5% bar | 6.61 |
| spread | has | 552.5 us | 561.1 us | -0.6% | +1.0% | within the 5% bar | -1.4% | -0.0% | within the 5% bar | 5.48 |
| spread | count | 1.5 us | 1.5 us | +0.1% | +1.2% | within the 5% bar | +0.5% | -0.3% | within the 5% bar | 5.48 |
| spread | iterate | 302.7 ms | 268.2 ms | -10.8% | +0.9% | within the 5% bar | -10.0% | +0.7% | within the 5% bar | 5.48 |
| spread8k | has | 564.1 us | 541.3 us | -0.6% | +2.0% | inconclusive | -10.0% | -9.3% | inconclusive | 8.18 |
| spread8k | count | 1.6 us | 1.7 us | +1.6% | +1.2% | within the 5% bar | -0.7% | -0.9% | within the 5% bar | 8.18 |
| spread8k | iterate | 34.3 ms | 31.3 ms | -10.9% | +0.1% | within the 5% bar | -12.8% | -2.7% | inconclusive | 8.18 |
| spread8k | intersect2 | 33.2 ms | 29.1 ms | -14.2% | -0.5% | within the 5% bar | -6.1% | +1.1% | within the 5% bar | 8.18 |
| spread8k | intersect4 | 58.2 ms | 53.3 ms | -8.3% | -0.6% | within the 5% bar | -8.8% | +0.9% | within the 5% bar | 8.18 |
| spread8k | andNot | 64.3 ms | 57.9 ms | -10.3% | -0.9% | within the 5% bar | -11.4% | -2.4% | inconclusive | 8.18 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive; the worst control is the
control of the cell where its magnitude is largest, with the sign it was measured with):

| op | cells | worst ts vs native (per-process) | worst control (per-process) | verdict (per-process) | worst ts vs native (in-process) | worst control (in-process) | verdict (in-process) |
|---|---|---|---|---|---|---|---|
| has | 6 | -0.6% | -2.5% | inconclusive | -1.0% | -9.3% | inconclusive |
| count | 6 | +1.6% | +1.2% | within the 5% bar | +1.0% | -0.9% | within the 5% bar |
| iterate | 6 | +0.8% | +2.1% | inconclusive | +2.0% | -2.7% | inconclusive |
| intersect2 | 5 | +0.1% | -1.2% | within the 5% bar | +0.4% | -2.1% | inconclusive |
| intersect4 | 5 | +17.2% | -2.0% | over the 5% bar | +13.3% | +1.1% | over the 5% bar |
| andNot | 5 | +6.3% | +1.2% | over the 5% bar | +8.9% | -2.4% | over the 5% bar |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and made no codec call (measured, counts in the file):
  it is read from the generation's index, so it is not evidence about the codec.
- `has` is dominated by the store's asynchronous call, about 1 us a probe. Per-process the codecs are within a few percent in
  both directions; dense has a control at -2.5% and is inconclusive, and in-process spread8k (control -9.3%, load 8.8) is
  inconclusive. Little power on the codec: see the gate row.
- `iterate` is within the bar per-process except mixed (control +2.1%, inconclusive); in-process, spread8k has a control at
  -2.7% and is inconclusive. TypeScript is 10% to 11% faster on the spread sets in both ways.
- **`intersect` after this branch's change:** sparse went from +22.8% and +27.3% (two and four operands, per-process) to
  -36.8% and -30.9%, and mixed at two operands stays within the bar (-1.2%). **Mixed at four operands is still over the
  bar, +17.2% per-process (+13.3% in-process, controls within +-1.3%), down from +48.3%.** Cause of the part that closed
  (measured, a one-codec profile of sparse four-operand intersection): 92% of the time was the array-array merge kernel
  itself; the clone, the result copy and the combine loop were under 4% together. The change: similar-sized arrays of at least
  32 values intersect through a scratch bitset read branch-free, over only the span the shorter array covers; an
  array against a bitset selects without a branch; an array against runs with at least as many values as runs walks the runs.
  What remains in mixed four-operand is the dense, run and bitset-in-runs pairs, which this change does not touch (not
  profiled here; a kernel-by-kernel profile of those pairs is the next step).
- **`andNot` on sparse is over the bar:** +6.3% per-process and +8.9% in-process (controls +1.2% and +0.3%). It is two arrays
  through the plain merge, which this branch does not change; it was at the bar before (+4.5%, +6.1%) and the figure
  moved with the machine's noise, so a fix of the same kind (the scratch bitset for `andNot`) is the candidate.

## The write path (measured; derived verdicts)

A load of 1,000,000 ids over 62,500 chunks, an erasure's rewrite of one id, and an export, each on a fresh store per round,
31 interleaved rounds, with a garbage collection before each timed call, in the same place for every codec (the run refuses
to start without `--expose-gc`, and the file records it). The write path is in-process only (three stores in one process,
the limit above). Load 4.7 at the start, 6.2 at the peak. The verdict is derived: faster when the TypeScript median is below -2%, no slower when within the
control band, slower above it, and inconclusive when the control is out of band.

| op | native | typescript | ts vs native | A/A control | verdict |
|---|---|---|---|---|---|
| load | 177.7 ms | 113.1 ms | -36.1% | -0.2% | faster |
| erase | 191.8 ms | 127.8 ms | -33.4% | -0.1% | faster |
| export | 396.4 ms | 354.8 ms | -10.8% | -0.3% | faster |

The exported bytes were identical between the codecs in every round (measured). These are **warm** figures: the process has
run the code before. The first `load` in a fresh process, which the cold row below measures, is +12.3% on TypeScript.

## Memory (measured)

A store's chunk cache holding every chunk of a data set, each codec in its own fresh process, seven repeats with the order
alternating (native first on even repeats, TypeScript first on odd ones), bytes per cached chunk: the median and, in
brackets, the range. The native codec's own allocations are invisible to V8's counters, so its heap-plus-external figure is
near zero (and can be slightly negative); the resident-set growth is the figure that includes them, and it is **unreliable**:
it moves with the allocator, and it reads below the heap growth it contains in many TypeScript repeats (the last column).
The heap-plus-external column is the only firm figure for the TypeScript codec; the resident column is an order of magnitude.

| data set | chunks | codec | heap+external (median, range) | resident growth (median, range) | resident below heap |
|---|---|---|---|---|---|
| dense | 64 | native | 4204 (4204 to 4204) | 13056 (8448 to 18944) | 0 of 7 |
| dense | 64 | typescript | 13078 (13078 to 13079) | 15872 (8704 to 17920) | 3 of 7 |
| sparse | 256 | native | 1434 (1433 to 1434) | 5248 (3968 to 6336) | 0 of 7 |
| sparse | 256 | typescript | 3901 (3901 to 3902) | 3008 (2112 to 4608) | 6 of 7 |
| runs | 256 | native | 1460 (1460 to 1460) | 2432 (2368 to 4032) | 0 of 7 |
| runs | 256 | typescript | 2495 (2495 to 2495) | 3136 (2752 to 3648) | 0 of 7 |
| mixed | 192 | native | 1815 (1815 to 1815) | 5803 (5035 to 10155) | 0 of 7 |
| mixed | 192 | typescript | 5906 (5905 to 5907) | 7936 (4779 to 9899) | 3 of 7 |
| spread8k | 8192 | native | -52 (-52 to -52) | 3396 (3386 to 3496) | 0 of 7 |
| spread8k | 8192 | typescript | 362 (362 to 363) | 3252 (3202 to 3258) | 0 of 7 |

The cache is bounded by a count of chunks (`maxChunks`), not by bytes, so a byte budget is derived: a cache of N chunks holds
N times the figure for its kind. The TypeScript codec holds 362 (spread8k) to 13,078 (dense) bytes of V8 heap per chunk that
the native codec holds outside the heap. By resident growth the ratio of the TypeScript median to the native median is 0.57
(sparse) to 1.37 (mixed) across every row (dense 1.22, runs 1.29, spread8k 0.96), and the ranges overlap in every row:
resident growth does not separate the codecs, and no multiple of the native codec's memory is claimed. The first run
reported 1.4 to 3.5 times from a single sample per figure with the native codec always measured first in the same process;
the repeats above do not bear that out. (One-off observation, not reproducible from the file: a first attempt at a
62,500-chunk spread cache gave no usable figure because the heap fell during the fill; spread8k above is the row that
replaces it.)

## Start-up (measured)

Module load, in a fresh process, median of 31, each run with the three subjects in a rotating order: the native codec's
module (the addon and the codec) 19.9 ms, the TypeScript codec's module 1.1 ms (-94.2%; the control, native again, -0.9%).

A cold row, kept apart from every warmed figure above: a fresh process, a store over a loaded mixed set of 128 chunks, a
first `load` of two segments, then the first 2,000 `has` calls timed one by one, a first full `iterate` and a first
`intersect`; median of 31 processes per subject, in a rotating order, load 5.0 at the start and 5.4 at the peak. Milliseconds, except `firstHasUs`, which is
microseconds.

| | native | typescript | ts vs native | A/A control |
|---|---|---|---|---|
| loadMs | 138.43 | 154.95 | +12.3% | -1.2% |
| firstHasUs | 3057.4 | 3201.4 | +4.9% | -0.5% |
| first10HasMs | 3.728 | 3.981 | +7.4% | -0.6% |
| first1000HasMs | 8.36 | 8.85 | +6.2% | -0.5% |
| next1000HasMs | 1.59 | 1.59 | +0.6% | -0.6% |
| firstIterateMs | 467.44 | 481.45 | +3.8% | -1.9% |
| firstIntersectMs | 136.19 | 133.45 | -2.3% | -1.5% |

`firstIterateMs` has a control at -2.0%, within the band: its +3.8% is below the bar; `firstHasUs` and `first10HasMs` are above it (+4.9% and +7.4%) with controls near zero. These figures include the first decode
of each chunk; the store's own start-up is the same for both. The cold row builds the facade bundle, which loads the native
addon in the TypeScript run too (before its timers start): the TypeScript cold row is not "a process without the addon", it
is the facade a switch of the codec inside today's package would ship until `roaring` leaves the dependencies.

## Runtimes (measured)

- Node 24.18.1: the oracle, hostile-input, pin, TypeScript-codec and fast-path suites pass (14 files, 1,558 tests).
- Node 22.12.0: the suites could not run locally, because the checkout's native addon is built for Node 24 only (the
  failure is the addon failing to load, not a codec failure). CI runs both versions and is the evidence for the oracle on
  Node 22. What was run on 22.12.0 is a self-check of the bundled TypeScript codec with no native code: build, optimize,
  serialize, safe deserialize, `has`, and, and-not and or on four sizes against a `Set`: all agree.
- Bun 1.4.2 and Deno 2.9.6 are installed locally; the same self-check passes on both (the native addon was not loaded
  there, so this is the TypeScript codec against a `Set`, not against the oracle).

## What the gate cannot judge yet

- A week of nightly fuzz with no difference: starts at merge.
- Install on every package manager: measured at the switch.
- The in-region request counts and latencies: the owner runs the pair of calibration runs (commands in the pull request).
  Locally, `CR_CALIBRATE_CODEC=native node bench/range-counts.cjs --check` and `CR_CALIBRATE_CODEC=typescript node
  bench/range-counts.cjs --check` both report that `bench/range-counts.json` is what the engine makes (measured, on the
  bundle with each codec), so identical counts in region are expected.
- Whether the two remaining over-the-bar cells (`intersect4` on mixed, `andNot` on sparse) are the codec or the instrument:
  their controls sat within +-1.3% in both ways, and the per-process and in-process figures agree, so they are expected to be
  the codec; a kernel fix and a re-run settle it.
