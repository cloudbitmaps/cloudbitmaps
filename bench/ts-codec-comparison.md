# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The evidence is
`bench/ts-codec-comparison-results.json`: every round of every figure, with the medians, quartiles and verdicts computed
from the rounds (`tests/bench/ts-codec-verdict.test.ts` recomputes them, and looks up every figure of every table below,
the module-load sentence and the per-kind memory differences in the file; the other figures in prose, among them the gate
rows, are not looked up). The instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc bench/ts-codec-engine.cjs --all`, about an
hour), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.18.1. **The figures are the first of two full `--all` runs on the same
committed tree** `ee5f0597015d3db0b1c97dbaff9e0ce7f1c18a5a` (the codec of this branch merged with the bench of its parent;
the file and this report were committed after it), the tree clean, holding the machine's heavy-work lock throughout. That
run started 2026-10-21T16:37:57Z and ended 17:34:17Z. **The dense set's cells are the second run's** (started
17:34:58Z, ended 18:42:27Z), because the first run's dense cells peaked at a load of 6.84, above the 6 the rule names, so
they are not used. The second run's other cells are not kept either: the runs, mixed, spread and spread8k sets peaked at
6.2 to 8.5 in it (other sessions were using the machine), and a third run was refused by the bench's own load gate at
11.3. In the composite no read cell peaked at 6 or more: the highest load in any cell, per-process or in-process, is 5.33
(mixed), and the dense cells, from the second run, peaked at 3.83. The write path, memory and start-up are the first
run's (loads 3.2 to 3.4, 2.8 and 2.8). The file records the composition in `readsRetaken`. The before figures quoted for
comparison are the parent branch's committed ones (`8a5839f1`). Every figure is wall-clock on one machine, recorded and
not asserted.

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
  TypeScript one included. The TypeScript process reads generations its own codec wrote, where the in-process stores read
  the native writer's; the chunk bytes are expected to be identical (the oracle suite holds the stored bytes to CRoaring's
  canonical encoding), and the bench does not compare them.

**The gate verdict of a cell is the per-process one**, because it is the one that looks like production; the in-process
figures are the cross-check. They agree on every cell that is over the bar. Where they differ, the table shows both
verdicts: in-process, sparse `intersect2` (control -2.4%), sparse `andNot` (control +2.5%) and spread `has` (control
+3.1%) are inconclusive where per-process is within the bar; per-process, sparse `intersect4` (control -3.2%) and runs
`andNot` (control -2.5%) are inconclusive where in-process is within it; spread8k `intersect2` and `andNot` are
inconclusive both ways. The two ways were taken at different times in each cell's life, so a control that sits just
outside the band in one is probably machine drift, not a property of the cell (inferred, not tested).

A store's calls were counted per codec in one untimed pass over the stores that were timed, with their caches dropped
first (a warm read calls methods of the cached bitmaps, not the codec's own functions, so the decode and the combine are
what show which codec a store holds): every TypeScript subject ran only the TypeScript codec and every native one only the
native codec, in both ways (measured, zero failures). `count` made no codec call at all in any cell, in either way
(measured: the counts are in the file). No timed round made a storage call, in-process or per-process (measured: the file
keeps the counts, all empty; a counter that saw a cold store's first reads, 40 calls over the six data sets, shows that it
sees calls), so every cell ran on a warm cache.

## Gate rows

| gate row | verdict (the per-process one) | evidence |
|---|---|---|
| Correctness: zero oracle differences | measured so far: none | `tests/roaring`, `tests/bench` and `tests/docs` pass on this tree (169 files, 14,410 tests, 4 skipped), the oracle, hostile-input and fast-path suites among them; the two codecs wrote the same exported bytes in all 31 write-path rounds |
| Correctness: a week of nightly fuzz with none | **cannot be judged yet** | the week starts at merge. Wiring (read from the workflows): `full-nightly.yml` runs the whole suite, the oracle files included, at 04:00 UTC every day; `fuzz-nightly.yml` fuzzes the four untrusted-bytes targets (`deser`, `crbm`, `index`, `ext`) at 05:00 UTC, all of them on the native deserializer: no fuzz target runs the TypeScript codec yet, so the week's fuzz evidence for it is the property tests' |
| Hot path: `has` | within the 5% bar per-process in every cell, **with little power on the codec** | per-process worst ts vs native +1.8% (spread8k), worst control -1.0%; in-process worst +0.7%, worst control +3.1% (spread, inconclusive). A call is 512 awaited probes at about 1 us each (0.96 to 1.09 us by cell median), of which the codec's `has` is about 26 to 39 ns native and 8 to 29 ns TypeScript on one chunk (`bench/ts-codec-results.json`, measured earlier): by that arithmetic (derived) the call reaches +5% only when the codec is about 2.4 times (sparse) to 2.9 times (dense) slower on the probe alone, so a codec up to that much slower would still land within 5% of the call. The per-operation `has` rows are the sensitive figure |
| Hot path: `count` | within the 5% bar, **not informative: no codec call** | per-process worst +1.0%, worst control -0.9%; in-process worst +1.2%, worst control -0.7%. `count` is read from the generation's index; the file records zero codec calls in every cell |
| Hot path: `iterate` | within the 5% bar in both ways | per-process worst +1.4%, worst control -2.0%; in-process worst +2.1%, worst control -1.9%. The TypeScript codec is 10% to 12% faster on the spread sets |
| Hot path: `intersect` | **over the 5% bar on one cell** | per-process: two operands worst +1.4% (dense; before this branch +22.8%, sparse), the op inconclusive only because spread8k's control reads -5.5%; four operands worst **+13.7%** (mixed; before this branch +48.3%, the earlier round of this branch +17.2%), the control -1.5%; in-process +8.7% at four operands. Sparse is faster than native (-40.2% and -38.5% per-process). A second run on the same tree read mixed four operands +18.8% per-process (control +0.1%) and +10.1% in-process, taken at a load of 6.35 and so not used for a verdict: both runs put the cell over the bar. Cells below |
| Hot path: `andNot` (beyond the four the gate names) | **within the 5% bar on every cell that resolves** | sparse: -2.1% per-process (control -0.7%; the earlier round of this branch +6.3%, the parent's +4.5%) and +1.1% in-process (control +2.5%, inconclusive). The op reads inconclusive because the controls of runs (-2.5%) and spread8k (+2.3%) are out of band. A second run on the same tree read sparse -1.0% per-process with a control at +2.3% (inconclusive), at a load of 3.79 |
| Write path: the bulk load no slower | faster (derived), a **warm** figure | 31 interleaved rounds: load -34.9% (control -0.2%). The first load in a **fresh process** is not that: `loadMs` of the cold row, two loads of the mixed set, is +12.7% on TypeScript (control +0.5%; median of 31 processes each), below |
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
| dense | has | 493.6 us | 485.1 us | -2.4% | -0.5% | within the 5% bar | -2.9% | -0.0% | within the 5% bar | 3.83 |
| dense | count | 1.4 us | 1.4 us | +0.5% | -0.9% | within the 5% bar | -0.4% | -0.1% | within the 5% bar | 3.83 |
| dense | iterate | 160.1 ms | 161.0 ms | +1.4% | -1.7% | within the 5% bar | +2.0% | +0.2% | within the 5% bar | 3.83 |
| dense | intersect2 | 82.6 ms | 84.4 ms | +1.4% | +1.1% | within the 5% bar | +0.6% | -1.2% | within the 5% bar | 3.83 |
| dense | intersect4 | 17.9 ms | 18.4 ms | +3.6% | -0.1% | within the 5% bar | +3.0% | -0.3% | within the 5% bar | 3.83 |
| dense | andNot | 83.7 ms | 84.2 ms | +0.2% | +1.2% | within the 5% bar | +0.2% | +0.1% | within the 5% bar | 3.83 |
| sparse | has | 548.6 us | 531.0 us | -2.6% | +0.8% | within the 5% bar | -3.0% | -0.4% | within the 5% bar | 4.67 |
| sparse | count | 1.5 us | 1.5 us | -0.8% | -0.5% | within the 5% bar | -0.1% | +0.1% | within the 5% bar | 4.67 |
| sparse | iterate | 38.4 ms | 38.1 ms | -0.7% | +1.5% | within the 5% bar | +2.1% | -1.9% | within the 5% bar | 4.67 |
| sparse | intersect2 | 3.6 ms | 2.2 ms | -40.2% | +0.9% | within the 5% bar | -40.2% | -2.4% | inconclusive | 4.67 |
| sparse | intersect4 | 3.7 ms | 2.4 ms | -38.5% | -3.2% | inconclusive | -34.3% | +0.3% | within the 5% bar | 4.67 |
| sparse | andNot | 40.9 ms | 39.6 ms | -2.1% | -0.7% | within the 5% bar | +1.1% | +2.5% | inconclusive | 4.67 |
| runs | has | 527.4 us | 518.5 us | -1.9% | -0.6% | within the 5% bar | -2.6% | -0.5% | within the 5% bar | 4.98 |
| runs | count | 1.4 us | 1.4 us | +1.0% | -0.1% | within the 5% bar | +0.1% | -0.1% | within the 5% bar | 4.98 |
| runs | iterate | 605.0 ms | 609.9 ms | -0.6% | +0.6% | within the 5% bar | +0.1% | +0.1% | within the 5% bar | 4.98 |
| runs | intersect2 | 401.7 ms | 393.2 ms | -1.4% | +1.3% | within the 5% bar | -1.4% | -0.2% | within the 5% bar | 4.98 |
| runs | intersect4 | 152.2 ms | 151.2 ms | +0.5% | -0.8% | within the 5% bar | +2.9% | -0.1% | within the 5% bar | 4.98 |
| runs | andNot | 255.1 ms | 251.6 ms | -0.4% | -2.5% | inconclusive | +0.3% | -0.6% | within the 5% bar | 4.98 |
| mixed | has | 501.6 us | 486.7 us | -3.0% | -1.0% | within the 5% bar | -2.7% | +0.5% | within the 5% bar | 5.33 |
| mixed | count | 1.4 us | 1.4 us | -0.2% | -0.3% | within the 5% bar | +1.2% | +0.6% | within the 5% bar | 5.33 |
| mixed | iterate | 432.4 ms | 423.2 ms | -0.5% | +0.2% | within the 5% bar | -0.3% | -0.1% | within the 5% bar | 5.33 |
| mixed | intersect2 | 114.7 ms | 110.4 ms | -3.3% | -2.0% | within the 5% bar | -2.5% | -0.4% | within the 5% bar | 5.33 |
| mixed | intersect4 | 2.7 ms | 3.1 ms | +13.7% | -1.5% | over the 5% bar | +8.7% | +1.2% | over the 5% bar | 5.33 |
| mixed | andNot | 352.3 ms | 348.9 ms | -0.8% | -0.2% | within the 5% bar | -2.5% | +0.8% | within the 5% bar | 5.33 |
| spread | has | 556.8 us | 568.1 us | +1.3% | -0.1% | within the 5% bar | +0.7% | +3.1% | inconclusive | 4.43 |
| spread | count | 1.5 us | 1.5 us | +1.0% | -0.6% | within the 5% bar | +0.1% | +0.5% | within the 5% bar | 4.43 |
| spread | iterate | 299.9 ms | 263.6 ms | -12.2% | -0.5% | within the 5% bar | -10.4% | -0.0% | within the 5% bar | 4.43 |
| spread8k | has | 512.8 us | 524.8 us | +1.8% | +0.3% | within the 5% bar | -2.5% | -1.1% | within the 5% bar | 3.89 |
| spread8k | count | 1.6 us | 1.7 us | +0.8% | +0.2% | within the 5% bar | -0.2% | -0.7% | within the 5% bar | 3.89 |
| spread8k | iterate | 32.6 ms | 29.0 ms | -11.7% | -2.0% | within the 5% bar | -10.0% | -0.1% | within the 5% bar | 3.89 |
| spread8k | intersect2 | 32.2 ms | 25.7 ms | -20.9% | -5.5% | inconclusive | -12.8% | +2.6% | inconclusive | 3.89 |
| spread8k | intersect4 | 54.4 ms | 47.7 ms | -11.1% | +0.1% | within the 5% bar | -10.1% | -1.5% | within the 5% bar | 3.89 |
| spread8k | andNot | 58.8 ms | 53.5 ms | -9.6% | +2.2% | inconclusive | -15.4% | -3.9% | inconclusive | 3.89 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive; the worst control is the
control of the cell where its magnitude is largest, with the sign it was measured with):

| op | cells | worst ts vs native (per-process) | worst control (per-process) | verdict (per-process) | worst ts vs native (in-process) | worst control (in-process) | verdict (in-process) |
|---|---|---|---|---|---|---|---|
| has | 6 | +1.8% | -1.0% | within the 5% bar | +0.7% | +3.1% | inconclusive |
| count | 6 | +1.0% | -0.9% | within the 5% bar | +1.2% | -0.7% | within the 5% bar |
| iterate | 6 | +1.4% | -2.0% | within the 5% bar | +2.1% | -1.9% | within the 5% bar |
| intersect2 | 5 | +1.4% | -5.5% | inconclusive | +0.6% | +2.6% | inconclusive |
| intersect4 | 5 | +13.7% | -3.2% | over the 5% bar | +8.7% | -1.5% | over the 5% bar |
| andNot | 5 | +0.2% | -2.5% | inconclusive | +1.1% | -3.9% | inconclusive |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and made no codec call (measured, counts in the file):
  it is read from the generation's index, so it is not evidence about the codec.
- `has` is dominated by the store's asynchronous call, about 1 us a probe. Per-process the codecs are within a few percent
  in both directions (worst +1.8%, spread8k); in-process spread `has` has a control at +3.1% and is inconclusive. Little
  power on the codec: see the gate row.
- `iterate` is within the bar in every cell in both ways. TypeScript is 10% to 12% faster on the spread sets.
- **`intersect` after this branch's changes:** sparse is -40.2% and -38.5% per-process (two and four operands; before this
  branch +22.8% and +27.3%), and mixed at two operands is within the bar (-3.3%). **Mixed at four operands is still over
  the bar: +13.7% per-process and +8.7% in-process (controls -1.5% and +1.2%), down from +48.3% before this branch and
  +17.2% after its first round.** A second full run on the same tree read it at +18.8% per-process and +10.1% in-process
  (controls +0.1% and -0.2%), at a load of 6.35, so it is not used for the verdict; both runs agree the cell is over.
  What this branch's kernels fixed (measured, one-codec profiles): sparse four-operand intersection was 92% array-array
  merge, now a scratch bitset read branch-free over the shorter array's span; arrays against bitsets and runs select
  without a branch or walk the runs; and `clone`, which deep-copied every container before the first `and`, now shares the
  containers until a write (about 1.0 to 1.3 us of the 5 us a mixed chunk costs). **What remains in mixed four operands
  (measured, a one-codec profile of the chain `clone`, `and`, `and`, `and` on one chunk of each kind rotation, TypeScript
  against native in us):** 3.3 against 2.4 for dense, sparse, runs, dense; 4.4 against 2.7 for sparse, runs, dense,
  sparse; 7.4 against 2.4 for runs, dense, sparse, runs. The run-against-bitset step costs about 3.4 us in TypeScript
  (it allocates and fills 2,048 words, then counts all of them) against about 0.2 us in the native codec, and
  bitset-against-sparse about 1.7 us against 0.6 us. The candidates that would close it: a run-against-bitset kernel that
  ANDs only the words each run covers and writes an array directly when the result is small, and intersecting the
  operands smallest-first in the store's `combineChunk`, which is shared code and would change the native path as well.
- **`andNot` on sparse is within the bar:** -2.1% per-process (control -0.7%) and +1.1% in-process (control +2.5%,
  inconclusive), against +6.3% before this branch's second round. Two arrays of similar size now go through the scratch
  bitset like the intersection (a one-codec profile of the call: 7.6 us before, 3.9 us after, native 2.9 us). The `andNot`
  op as a whole reads inconclusive because runs (control -2.5%) and spread8k (control +2.3%) are out of band.

## The write path (measured; derived verdicts)

A load of 1,000,000 ids over 62,500 chunks, an erasure's rewrite of one id, and an export, each on a fresh store per round,
31 interleaved rounds, with a garbage collection before each timed call, in the same place for every codec (the run refuses
to start without `--expose-gc`, and the file records it). The write path is in-process only (three stores in one process,
the limit above). Load 3.2 at the start, 3.4 at the peak. The verdict is derived: faster when the TypeScript median is below -2%, no slower
when within the control band, slower above it, and inconclusive when the control is out of band.

| op | native | typescript | ts vs native | A/A control | verdict |
|---|---|---|---|---|---|
| load | 173.0 ms | 112.8 ms | -34.9% | -0.2% | faster |
| erase | 190.5 ms | 128.9 ms | -32.7% | -0.4% | faster |
| export | 393.0 ms | 350.8 ms | -10.7% | -0.3% | faster |

The exported bytes were identical between the codecs in every round (measured). These are **warm** figures: the process has
run the code before. The first `load` in a fresh process, which the cold row below measures, is +12.7% on TypeScript.

## Memory (measured)

A store's chunk cache holding every chunk of a data set, each codec in its own fresh process, seven repeats with the order
alternating (native first on even repeats, TypeScript first on odd ones), bytes per cached chunk: the median and, in
brackets, the range. Both codecs show a heap-plus-external figure, so the figure to read is the **difference** between
them, row by row, not either codec's absolute number. The native codec's is small on spread8k (-52, slightly negative) and
1,434 to 4,204 on the other four rows, each of those with a range under 4 bytes wide, so none is noise around zero; why the
native codec shows heap or external bytes there is not measured. The resident-set growth includes memory V8's counters cannot
see, and it is **unreliable**: it moves with the allocator, and it reads below the heap growth it contains in many
TypeScript repeats (the last column). The heap-plus-external difference is the firmer figure; the resident column is an
order of magnitude. Load 2.8 throughout.

| data set | chunks | codec | heap+external (median, range) | resident growth (median, range) | resident below heap |
|---|---|---|---|---|---|
| dense | 64 | native | 4204 (4204 to 4207) | 15872 (5376 to 18944) | 0 of 7 |
| dense | 64 | typescript | 13078 (13078 to 13078) | 15872 (8960 to 19200) | 3 of 7 |
| sparse | 256 | native | 1434 (1433 to 1434) | 4480 (3264 to 4736) | 0 of 7 |
| sparse | 256 | typescript | 3901 (3900 to 3902) | 2688 (1600 to 3712) | 7 of 7 |
| runs | 256 | native | 1460 (1460 to 1462) | 2816 (2304 to 3264) | 0 of 7 |
| runs | 256 | typescript | 2495 (2495 to 2495) | 3136 (2432 to 3456) | 1 of 7 |
| mixed | 192 | native | 1815 (1815 to 1815) | 7765 (5717 to 9643) | 0 of 7 |
| mixed | 192 | typescript | 5906 (5905 to 5907) | 4693 (4352 to 8363) | 5 of 7 |
| spread8k | 8192 | native | -52 (-52 to -52) | 3414 (3334 to 3450) | 0 of 7 |
| spread8k | 8192 | typescript | 362 (362 to 362) | 3254 (3190 to 3304) | 0 of 7 |

The cache is bounded by a count of chunks (`maxChunks`), not by bytes, so a byte budget is derived: a cache of N chunks holds
N times the figure for its kind.

- **Heap-plus-external, TypeScript minus native, bytes per chunk (derived):** dense 8,874, sparse 2,467, runs 1,035, mixed
  4,091, spread8k 414. That is the most the TypeScript codec can hold in V8's counters that the native codec's own figure
  does not already hold; it is not the TypeScript codec's absolute figure, and how much of the native codec's memory is
  outside V8's counters altogether is not measured.
- **Resident growth, TypeScript median over native median (derived):** sparse 0.60, runs 1.11, dense 1.00, mixed 0.60,
  spread8k 0.95. On dense, sparse, runs and mixed the two codecs' ranges overlap, so resident growth does not separate them
  there. **On spread8k they do not overlap: every one of the seven TypeScript samples (3,190 to 3,304) is below every native
  one (3,334 to 3,450).** No multiple of the native codec's memory is claimed. The first run reported 1.4 to 3.5 times from
  a single sample per figure with the native codec always measured first in the same process; the repeats above do not bear
  that out. (One-off observation, not reproducible from the file: a first attempt at a 62,500-chunk spread cache gave no
  usable figure because the heap fell during the fill; spread8k above is the row that replaces it.)

## Start-up (measured)

Module load, in a fresh process, median of 31, each run with the three subjects in a rotating order: the native codec's
module (the addon and the codec) 19.2 ms, the TypeScript codec's module 1.1 ms (-94.2%; the control, native again, -0.1%).

A cold row, kept apart from every warmed figure above: a fresh process, a store over a loaded mixed set of 128 chunks, a
first `load` of two segments, then the first 2,000 `has` calls timed one by one, a first full `iterate` and a first
`intersect`; median of 31 processes per subject, in a rotating order, load 2.8 at the start and 2.8 at the peak.
Milliseconds, except `firstHasUs`, which is microseconds.

| | native | typescript | ts vs native | A/A control |
|---|---|---|---|---|
| loadMs | 135.53 | 152.66 | +12.7% | +0.5% |
| firstHasUs | 3012.2 | 3201.6 | +7.0% | +0.3% |
| first10HasMs | 3.683 | 3.985 | +8.3% | +0.2% |
| first1000HasMs | 8.22 | 8.8 | +7.1% | +0.2% |
| next1000HasMs | 1.57 | 1.58 | +0.6% | +0.0% |
| firstIterateMs | 469.73 | 481.45 | +2.3% | -1.8% |
| firstIntersectMs | 139.1 | 132.54 | -4.6% | -1.1% |

`firstIterateMs` has a control at -1.8%, within the band, and its +2.3% is below the bar; `loadMs`, `firstHasUs`,
`first10HasMs` and `first1000HasMs` are above it (+12.7%, +7.0%, +8.3% and +7.1%) with controls near zero. These figures
include the first decode of each chunk; the store's own start-up is expected to be the same for both (inferred). The cold
row builds the facade bundle, which loads the native addon in the TypeScript run too (before its timers start): the
TypeScript cold row is not "a process without the addon", it is the facade a switch of the codec inside today's package
would ship until `roaring` leaves the dependencies.

## Runtimes (measured)

- Node 24.18.1: the oracle, hostile-input, pin, TypeScript-codec and fast-path suites pass (inside the 14,410 tests of the gate row above).
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
- Whether the one remaining over-the-bar cell (`intersect4` on mixed) is the codec or the instrument: its control sat
  within +-1.5% in both ways in both runs and the per-process and in-process figures agree (+13.7% and +8.7%; +18.8% and
  +10.1% in the second run), so it is expected to be the codec; a kernel for the run-against-bitset step, or smallest-first
  operand order in the store, and a re-run settle it.
