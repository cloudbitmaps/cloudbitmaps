# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The evidence is
`bench/ts-codec-comparison-results.json`: every round of every figure, with the medians, quartiles and verdicts computed
from the rounds (`tests/bench/ts-codec-verdict.test.ts` recomputes them, and looks up every figure of every table below,
the module-load sentence and the per-kind memory differences in the file; the other figures in prose, among them the gate
rows, are not looked up). The instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc bench/ts-codec-engine.cjs --all`, about an
hour), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.18.1. **The read figures are one full `--reads` run on the committed tree**
`3c5fc796` (the parent's bench; this branch's codec and store changes), the tree clean, holding the machine's heavy-work
lock throughout, on a quiet machine: the highest load seen in any cell of that run, per-process or in-process, is
under 6 (the table's last column is the per-process peak, 2.4 to 3.2). The bench's load gate was off
(`TS_ENGINE_ANY_LOAD=1`, recorded in the file) so the figures carry their own load. **Four figures** (dense `andNot`,
runs `count` and spread8k `iterate` in-process, and spread8k `iterate` per-process) had an A/A control outside +-2% and are
the figures of a re-take of that cell alone, which read inside it; the runs `intersect4` per-process control stayed outside
(+2.4%, +2.8% in the re-take), so that cell is inconclusive and keeps the first run's figure. The file records the
composition in `readsRetaken`. The write path, memory and start-up are not re-measured: this branch changes no code they
run, and they are the parent branch's committed figures (loads 3.2 to 3.4, 2.8 and 2.8). The before figures quoted for
comparison are the parent branch's committed ones (`a7531fb1`). Every figure is wall-clock on one machine, recorded and
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
figures are the cross-check. **They disagree on one cell, mixed `intersect4`: per-process +0.2% (within the bar), in-process
+10.2% (over it; controls -0.6% and -0.2%).** Before this branch the cell read +13.7% and +8.7%. The in-process figure is
the one with polymorphic call sites in the combine code (both codecs in one process), which the per-process figure does
not have; this report does not know how much of the in-process gap is that (inferred, not isolated). Elsewhere: runs
`intersect4` per-process has a control at +2.4% and is inconclusive where in-process is within the bar.

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
| Hot path: `has` | within the 5% bar per-process in every cell, **with little power on the codec** | per-process worst ts vs native +1.0% (sparse), worst control +1.5% (spread8k); in-process worst -0.0%, worst control +1.2%. A call is 512 awaited probes at about 1 us each (0.96 to 1.09 us by cell median), of which the codec's `has` is about 26 to 39 ns native and 8 to 29 ns TypeScript on one chunk (`bench/ts-codec-results.json`, measured earlier): by that arithmetic (derived) the call reaches +5% only when the codec is about 2.4 times (sparse) to 2.9 times (dense) slower on the probe alone, so a codec up to that much slower would still land within 5% of the call. The per-operation `has` rows are the sensitive figure |
| Hot path: `count` | within the 5% bar, **not informative: no codec call** | per-process worst +2.0%, worst control -0.7%; in-process worst +0.4%, worst control +0.8%. `count` is read from the generation's index; the file records zero codec calls in every cell |
| Hot path: `iterate` | within the 5% bar in both ways | per-process worst +1.2%, worst control +1.9%; in-process worst +1.0%, worst control -1.6%. The TypeScript codec is 11% to 16% faster on the spread sets |
| Hot path: `intersect` | **within the 5% bar per-process on every cell that resolves; over it in-process on one (mixed, four operands)** | per-process: two operands worst +0.5% (control +1.0%); four operands worst +2.9% (dense, control +0.3%), **mixed +0.2%** (control -0.6%; before this branch +13.7%), runs +1.4% with its control at +2.4%, so inconclusive. **In-process mixed four operands reads +10.2%** (control -0.2%; before +8.7%), so the two ways disagree on that cell: see the read bench. Sparse is faster than native (-40.3% and -36.0% per-process). Native here is the native codec as it ships, in the operand order it is given; the native codec with the smallest-first order is slower (below). Cells below |
| Hot path: `andNot` (beyond the four the gate names) | **within the 5% bar on every cell** | worst +2.4% per-process (dense, control +1.1%) and +0.1% in-process; sparse -4.8% and -7.9% |
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
| dense | has | 492.2 us | 489.1 us | -0.2% | -1.2% | within the 5% bar | -2.6% | +0.7% | within the 5% bar | 2.49 |
| dense | count | 1.4 us | 1.4 us | +0.0% | -0.7% | within the 5% bar | -1.0% | +0.2% | within the 5% bar | 2.49 |
| dense | iterate | 164.3 ms | 164.0 ms | +0.4% | -1.6% | within the 5% bar | +0.9% | -0.6% | within the 5% bar | 2.49 |
| dense | intersect2 | 86.9 ms | 85.2 ms | -1.0% | -1.0% | within the 5% bar | +0.1% | +1.3% | within the 5% bar | 2.49 |
| dense | intersect4 | 18.1 ms | 18.7 ms | +2.9% | +0.3% | within the 5% bar | +3.3% | -0.9% | within the 5% bar | 2.49 |
| dense | andNot | 84.7 ms | 85.5 ms | +2.4% | +1.1% | within the 5% bar | -1.4% | +0.5% | within the 5% bar | 2.49 |
| sparse | has | 564.7 us | 562.2 us | +1.0% | -0.3% | within the 5% bar | -0.1% | -0.8% | within the 5% bar | 2.83 |
| sparse | count | 1.5 us | 1.5 us | +0.5% | +0.3% | within the 5% bar | +0.4% | +0.5% | within the 5% bar | 2.83 |
| sparse | iterate | 39.5 ms | 38.7 ms | -1.1% | +1.9% | within the 5% bar | +1.0% | -0.8% | within the 5% bar | 2.83 |
| sparse | intersect2 | 3.7 ms | 2.2 ms | -40.3% | +0.4% | within the 5% bar | -39.9% | +0.5% | within the 5% bar | 2.83 |
| sparse | intersect4 | 3.7 ms | 2.3 ms | -36.0% | -0.5% | within the 5% bar | -33.4% | +0.1% | within the 5% bar | 2.83 |
| sparse | andNot | 41.5 ms | 39.8 ms | -4.8% | -1.8% | within the 5% bar | -7.9% | +0.2% | within the 5% bar | 2.83 |
| runs | has | 537.5 us | 532.6 us | -2.5% | +0.0% | within the 5% bar | -1.8% | -0.4% | within the 5% bar | 2.42 |
| runs | count | 1.4 us | 1.4 us | +0.3% | +0.1% | within the 5% bar | -0.2% | -0.5% | within the 5% bar | 2.42 |
| runs | iterate | 617.1 ms | 603.5 ms | -1.6% | +1.3% | within the 5% bar | -0.1% | -1.6% | within the 5% bar | 2.42 |
| runs | intersect2 | 404.4 ms | 399.2 ms | -1.4% | -0.0% | within the 5% bar | -0.5% | -0.7% | within the 5% bar | 2.42 |
| runs | intersect4 | 150.9 ms | 153.3 ms | +1.4% | +2.4% | inconclusive | +2.8% | -0.7% | within the 5% bar | 2.42 |
| runs | andNot | 253.9 ms | 253.9 ms | +0.5% | +1.4% | within the 5% bar | +0.1% | +0.2% | within the 5% bar | 2.42 |
| mixed | has | 512.2 us | 500.4 us | -1.5% | +0.1% | within the 5% bar | -2.5% | -1.0% | within the 5% bar | 2.75 |
| mixed | count | 1.4 us | 1.4 us | +2.0% | +0.3% | within the 5% bar | -0.2% | -0.1% | within the 5% bar | 2.75 |
| mixed | iterate | 430.7 ms | 442.5 ms | +1.2% | +0.1% | within the 5% bar | +0.0% | -0.6% | within the 5% bar | 2.75 |
| mixed | intersect2 | 114.0 ms | 114.2 ms | +0.5% | +1.0% | within the 5% bar | -2.0% | -0.7% | within the 5% bar | 2.75 |
| mixed | intersect4 | 2.8 ms | 2.8 ms | +0.2% | -0.6% | within the 5% bar | +10.2% | -0.2% | over the 5% bar | 2.75 |
| mixed | andNot | 355.1 ms | 351.8 ms | -0.6% | -1.0% | within the 5% bar | +0.1% | -0.1% | within the 5% bar | 2.75 |
| spread | has | 572.7 us | 570.0 us | +0.4% | -0.1% | within the 5% bar | -0.2% | +0.6% | within the 5% bar | 3.15 |
| spread | count | 1.5 us | 1.5 us | -2.3% | -0.1% | within the 5% bar | -0.2% | +0.8% | within the 5% bar | 3.15 |
| spread | iterate | 330.4 ms | 292.4 ms | -11.5% | +0.4% | within the 5% bar | -11.7% | +0.7% | within the 5% bar | 3.15 |
| spread8k | has | 603.7 us | 553.7 us | -7.8% | +1.5% | within the 5% bar | -0.0% | +1.2% | within the 5% bar | 2.43 |
| spread8k | count | 1.7 us | 1.7 us | +1.8% | +0.3% | within the 5% bar | +0.3% | +0.2% | within the 5% bar | 2.43 |
| spread8k | iterate | 38.9 ms | 33.2 ms | -15.5% | -1.4% | within the 5% bar | -11.5% | -1.6% | within the 5% bar | 2.44 |
| spread8k | intersect2 | 36.5 ms | 30.0 ms | -18.5% | +0.8% | within the 5% bar | -11.5% | -1.7% | within the 5% bar | 2.43 |
| spread8k | intersect4 | 65.3 ms | 58.6 ms | -10.0% | -1.7% | within the 5% bar | -9.5% | +1.4% | within the 5% bar | 2.43 |
| spread8k | andNot | 67.2 ms | 58.1 ms | -13.6% | +0.7% | within the 5% bar | -17.8% | -0.5% | within the 5% bar | 2.43 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive; the worst control is the
control of the cell where its magnitude is largest, with the sign it was measured with):

| op | cells | worst ts vs native (per-process) | worst control (per-process) | verdict (per-process) | worst ts vs native (in-process) | worst control (in-process) | verdict (in-process) |
|---|---|---|---|---|---|---|---|
| has | 6 | +1.0% | +1.5% | within the 5% bar | -0.0% | +1.2% | within the 5% bar |
| count | 6 | +2.0% | -0.7% | within the 5% bar | +0.4% | +0.8% | within the 5% bar |
| iterate | 6 | +1.2% | +1.9% | within the 5% bar | +1.0% | -1.6% | within the 5% bar |
| intersect2 | 5 | +0.5% | +1.0% | within the 5% bar | +0.1% | -1.7% | within the 5% bar |
| intersect4 | 5 | +2.9% | +2.4% | inconclusive | +10.2% | +1.4% | over the 5% bar |
| andNot | 5 | +2.4% | -1.8% | within the 5% bar | +0.1% | -0.5% | within the 5% bar |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and made no codec call (measured, counts in the file):
  it is read from the generation's index, so it is not evidence about the codec.
- `has` is dominated by the store's asynchronous call, about 1 us a probe. The codecs are within a few percent in both
  directions (per-process worst +1.0%). Little power on the codec: see the gate row.
- `iterate` is within the bar in every cell in both ways. TypeScript is 11% to 16% faster on the spread sets.
- **`intersect`, mixed at four operands, the cell that was over the bar: per-process +0.2% (control -0.6%), from +13.7%;
  in-process +10.2% (control -0.2%), from +8.7%.** The gate verdict is the per-process one, which is within the bar; the
  in-process figure is over it and is reported as measured (see the note under the table of the two ways).
  **What the comparison is against:** the native codec as it ships takes the operands in the order it is given, and so
  does this table's native column. The TypeScript codec takes them smallest-first (`intersectSmallestFirst`, which only it
  sets). That is not the same engine path for the two codecs, so the table above also has the native codec on the same
  smallest-first path, measured per process and in-process, 31 rounds each, controls in band (native on the same path
  as the control; `TS_ENGINE_NATIVE_SMALLEST_FIRST=1`, a measurement knob in `bench/lib/codec-engine.cjs`):

  | cell | native as shipped | native, smallest-first | ts vs native as shipped | ts vs native, smallest-first (control) |
  |---|---|---|---|---|
  | mixed `intersect4`, per-process | 2.81 ms | 3.07 ms (+9.0%) | +0.2% | -6.5% (-0.3%) |
  | mixed `intersect4`, in-process | 2.81 ms | 3.09 ms (+10.0%) | +10.2% | -2.9% (-0.2%) |
  | mixed `intersect2`, per-process | 113.99 ms | 116.02 ms (+1.8%) | +0.5% | -3.8% (-1.5%) |
  | spread8k `intersect4`, per-process | 65.28 ms | 64.19 ms (-1.7%) | -10.0% | -6.6% (-0.2%) |
  | spread8k `intersect2`, per-process | 36.46 ms | 32.04 ms (-12.1%) | -18.5% | -4.6% (+0.5%) |

  (measured; the ts-vs-native columns are the median of the paired per-round differences, the others medians of the cell.)
  For mixed four operands the smallest-first order **slows the native codec by 9% to 10%**, because its `size` is a call
  across the addon boundary per operand per chunk and its combine is fast in any order, so it is held out of the order on
  the evidence, not withheld from an optimisation. On the spread sets it changes native by -12% (two operands, per-process)
  to +2.5% (in-process): the per-process two-operand figure is one cell and the in-process one does not repeat it, so it is
  not claimed. **The verdict uses the as-shipped native column**, because that is what a user running the native codec
  gets, and it is the harder comparison on mixed four operands (it is the one that reads +10.2% in-process); the
  smallest-first columns would read the cell as -6.5% and -2.9%.
- The worst four-operand cells besides mixed are runs, +1.4% (control +2.4%, inconclusive) and dense, +2.9%; neither holds
  mixed kinds, so the new order changes which pair meets first but not which kernel runs. Before this branch they read +0.5%
  and +3.6%.
- **What the profile found, and what changed** (measured, one-codec profiles of the chain `clone`, `and`, `and`, `and` on
  one chunk of each kind rotation, TypeScript only, taken while the machine was at a load of 10 to 15, so read the ratios
  and not the microseconds): for a third of the mixed chunks the first step was a run container against a bitset, 3.3 us
  of the 14.0 us the three rotations cost together, and the steps after it filtered the 15,000-value bitset it built.
  Taking the operands smallest-first starts those chunks from the sparse array, so no bitset is built: 14.0 us before,
  10.6 us after (-24%). A kernel change alone, which writes a run-against-bitset result of at most 4,096 values straight to
  an array, did not move the bench's chunks (their runs hold about 30,000 values, the unchanged other branch of the
  kernel; a variant that counted each covered word instead of using the Harley-Seal count measured the same, 3.3 us, and
  was dropped).
- **`andNot` is within the bar on every cell:** worst +2.4% per-process (dense, control +1.1%) and +0.1% in-process.

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
- Whether the in-process mixed `intersect4` figure (+10.2%, per-process +0.2%) is the polymorphic call sites in the
  combine code or the codec: the per-process way has monomorphic call sites, as production has, and reads within the bar;
  the in-process gap is expected to be the instrument (inferred), and is reported, not explained away.
