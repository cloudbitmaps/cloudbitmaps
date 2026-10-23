# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The evidence is
`bench/ts-codec-comparison-results.json`: every round of every figure, with the medians, quartiles and verdicts computed
from the rounds (`tests/bench/ts-codec-verdict.test.ts` recomputes them, and looks up every figure of every table below,
the module-load sentence and the per-kind memory differences in the file; the other figures in prose, among them the gate
rows, are not looked up). The instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc bench/ts-codec-engine.cjs --all`, about an
hour), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.22.1 (the before figures, from `a7531fb1`, were taken on v24.18.1: absolute times do not compare across the two runs, and a before/after comparison mixes this branch's codec change with the Node update; the paired ratios inside one run, which are what the gate's verdict uses, do not depend on it). **Every figure in this file is one run of the bench's own `--all`
on the committed tree `c387921b`** (the tree clean; its codec and store code is the code of this branch's head, whose
last kernel change is older), started 2026-10-22 04:46 UTC and ended 05:58 UTC: the reads 04:46 to 05:37, the smallest-first
native measurement 05:37 to 05:53, the write path 05:53 to 05:54, memory 05:54 to 05:55, start-up 05:55 to 05:58 (every
part's own start, end, commit and tree state are in the file, and `tests/bench/ts-codec-verdict.test.ts` holds each to the
run's commit, a clean tree and the run's window). The bench's load gate was off (`TS_ENGINE_ANY_LOAD=1`, recorded in the
file), so every figure carries its own peak load beside it. **The A/A control decides whether a timed cell resolves.**
In that run the per-process cells of the sparse and runs sets had a peak load of 11.0 and 15.3 (something else on the
machine), and eleven bases (cell and way) had a control outside +-2% (one of them also ran at a load of 10.96), so 12 were taken by load and 10 more by control alone. Each of those 22 bases was taken once more, in a run of
those cells alone (the reads only, on the commit `6467779c`, started 05:58 UTC, ended 06:31 UTC, highest load of a kept round 2.33), and
**the re-take replaces the figure**; the first take stays in the cell as `firstTake` and the list of re-takes, with
both takes' figures and the reason, is in `reads.readsRetaken`. A re-take is not repeated: three bases (sparse
`intersect2` and `andNot` in-process, spread8k `iterate` in-process) still have a control outside the band and read
**inconclusive**, and are named so below. The re-takes are one process-and-machine state apart from the rest of the run;
the bases whose first take ran at a load of 6 or more moved by at most 2.7 points (sparse `andNot` per-process -3.5%
against -0.8%, runs `iterate` -1.1% against -3.4%), and the largest moves overall, 11.6 points (sparse `andNot`
in-process, -8.3% to +3.2%, first take at load 2.2), 5.0 (spread8k `iterate` per-process) and 4.9 (spread8k `andNot`
in-process), came at an ordinary load on bases whose control was out of band; the record does not establish why a figure
moves that much, and no first take of any re-taken base was over the bar.
The before figures quoted for comparison are the parent branch's committed ones (`a7531fb1`). Every figure is wall-clock on
one machine, recorded and not asserted.

## How a verdict is computed

A round times the same call on three subjects: native (A), TypeScript and native again (the A/A control, B), in an order
that rotates through the six permutations. A cell's two figures are the median over 31 rounds of `typescript / native - 1`
and of `control / native - 1`, with their quartiles in the file. **Derived verdict** (`bench/lib/codec-verdict.cjs`): the
control's median within +-2% and the TypeScript median at most +5% is `within the 5% bar`; the TypeScript median above +5%
with the control in band is `over the 5% bar`; a control outside +-2% is `inconclusive`, because the machine moved more
than the bar can see. The verdict of an op is the worst of its cells.

Every read cell is measured two ways, and the table gives both:

- **In-process:** the three subjects are three stores in one process. Its limit: core's call sites (the codec calls, the
  combine code) see both the native wrapper and the TypeScript bitmap in the one process, so they may be polymorphic here (whether that explains any gap is not shown) and
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
figures are the cross-check. **In this run they agree on every cell that resolves, mixed `intersect4` included: per-process
+2.9% and in-process +3.5%, both within the bar** (controls -1.3% and -0.5%). That is not what the earlier run of the
same code showed (+0.2% per-process, **+10.2% in-process**), nor the run before the codec change (+13.7% and +8.7%). What
is known: the in-process figure of the same cell moved from +10.2% to +3.5% between two runs of the same code, with its
control in band both times, so the cell's in-process figure carries a spread of at least that size that its control does
not show; its quartiles in this run are [-0.9%, +5.7%] in-process and [-0.4%, +8.0%] per-process. What is not known: why
the earlier run read +10.2% (the explanation that the in-process way has polymorphic call sites that production does not
is unproven, and the file holds evidence against it: an effect on the call sites would be expected to move the native
codec's absolute time too, and in the earlier run native read 2.81 ms in-process and 2.81 ms per-process while the
TypeScript codec read 3.08 and 2.83). The one-codec-per-process figure, which is how the package runs, is the gate's. Three
bases read inconclusive (sparse `intersect2` and `andNot` in-process, controls -4.4% and +3.6%; spread8k `iterate`
in-process, control -2.4%), each after its one re-take; every per-process cell resolves.

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
| Correctness: zero oracle differences | measured so far: none | `tests/roaring`, `tests/bench`, `tests/docs` and the combine and engine files of `tests/core` passed on the head before this round, whose codec and kernel code this round does not touch (189 files, 14,712 tests, 4 skipped; this round adds two tests to `tests/bench`, which run in CI), the oracle, hostile-input and fast-path suites among them; the two codecs wrote the same exported bytes in all 31 write-path rounds |
| Correctness: a week of nightly fuzz with none | **cannot be judged yet** | the week starts at merge. Wiring (read from the workflows): `full-nightly.yml` runs the whole suite, the oracle files included, at 04:00 UTC every day; `fuzz-nightly.yml` fuzzes the four untrusted-bytes targets (`deser`, `crbm`, `index`, `ext`) at 05:00 UTC: the `deser` target fuzzes the TypeScript codec's safe deserialize, and `crbm` reaches it through `CrbmReader.open` on valid seeds, while `index` and `ext` fuzz the parsers beside it, not the codec |
| Hot path: `has` | within the 5% bar per-process in every cell, **with little power on the codec** | per-process worst ts vs native +1.1% (dense), worst control -0.8% (spread8k); in-process worst +0.1%, worst control -1.5%. A call is 512 awaited probes at about 1 us each (0.96 to 1.18 us by cell median per-process native, 0.95 to 1.10 TypeScript), of which the codec's `has` is about 26 to 39 ns native and 8 to 29 ns TypeScript on one chunk (`bench/ts-codec-results.json`, measured earlier): by that arithmetic (derived) the call reaches +5% only when the codec is about 2.2 to 3.3 times slower (the range over the probe times and codec times above) on the probe alone, so a codec up to that much slower would still land within 5% of the call. The per-operation `has` rows are the sensitive figure |
| Hot path: `count` | within the 5% bar, **not informative: no codec call** | per-process worst +1.7% (spread8k), worst control -0.5%; in-process worst +1.0%, worst control +0.5%. The `count` cells make no codec call and still swing by about +-1.7% between the codecs per-process (controls within +-0.5%): that is the instrument's own noise on a ts-vs-native contrast, larger than its control shows. `count` is read from the generation's index; the file records zero codec calls in every cell |
| Hot path: `iterate` | within the 5% bar per-process in every cell; in-process within it on every cell that resolves | per-process worst -0.0% (the codec is not slower in any cell), worst control +1.6%; in-process worst +3.9% (mixed) with the way's verdict inconclusive on one cell (spread8k, control -2.4%). The TypeScript codec is 9% to 12% faster on the spread sets per-process |
| Hot path: `intersect` | **within the 5% bar per-process on every cell; within it in-process on every cell that resolves (sparse two operands is inconclusive, control -4.4%)** | per-process: two operands worst +0.2% (control +1.2%); four operands worst **+3.4% (dense, control +1.1%)**, mixed +2.9% (control -1.3%; before this branch +13.7%), runs +0.6%. In-process mixed four operands reads +3.5% (control -0.5%; before this branch +8.7%; the earlier run of this code read +10.2%, see the read bench). Sparse is faster than native (-40.2% and -37.0% per-process). Native here is the native codec as it ships, in the operand order it is given; the native codec with the smallest-first order is slower on mixed four operands by +7.7% per-process and +8.8% in-process, paired (below). Cells below |
| Hot path: `andNot` (beyond the four the gate names) | **within the 5% bar per-process on every cell; in-process one cell is inconclusive** | worst -0.6% per-process (dense, control +1.7%) and +3.2% in-process (sparse, control +3.6%, inconclusive: its re-take kept the control out of band) |
| Write path: the bulk load no slower | faster (derived), a **warm** figure | 31 interleaved rounds: load -35.6% (control -0.4%). The first load in a **fresh process** is not that: `loadMs` of the cold row, two loads of the mixed set, is +13.1% on TypeScript (control +0.3%; median of 31 processes each), below |
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
| dense | has | 489.4 us | 487.1 us | +1.1% | +0.1% | within the 5% bar | -5.9% | -1.5% | within the 5% bar | 1.96 |
| dense | count | 1.4 us | 1.4 us | -0.1% | -0.5% | within the 5% bar | -0.1% | -0.3% | within the 5% bar | 1.96 |
| dense | iterate | 159.9 ms | 157.7 ms | -0.0% | +0.6% | within the 5% bar | +3.0% | +0.4% | within the 5% bar | 1.96 |
| dense | intersect2 | 84.6 ms | 84.8 ms | +0.2% | +1.2% | within the 5% bar | -1.7% | -1.3% | within the 5% bar | 1.96 |
| dense | intersect4 | 17.9 ms | 18.6 ms | +3.4% | +1.1% | within the 5% bar | +4.1% | +0.0% | within the 5% bar | 1.96 |
| dense | andNot | 84.2 ms | 83.9 ms | -0.6% | +1.7% | within the 5% bar | -0.3% | +0.2% | within the 5% bar | 1.96 |
| sparse | has | 572.1 us | 553.7 us | -2.5% | -0.7% | within the 5% bar | -0.4% | +0.6% | within the 5% bar | 2.33 |
| sparse | count | 1.5 us | 1.5 us | +1.1% | -0.5% | within the 5% bar | +0.5% | +0.1% | within the 5% bar | 2.33 |
| sparse | iterate | 39.2 ms | 38.7 ms | -2.5% | +1.6% | within the 5% bar | +2.4% | +0.7% | within the 5% bar | 2.33 |
| sparse | intersect2 | 3.7 ms | 2.2 ms | -40.2% | +0.6% | within the 5% bar | -41.1% | -4.4% | inconclusive | 2.33 |
| sparse | intersect4 | 3.7 ms | 2.4 ms | -37.0% | -0.4% | within the 5% bar | -32.9% | +1.1% | within the 5% bar | 2.33 |
| sparse | andNot | 41.0 ms | 40.4 ms | -0.8% | +0.3% | within the 5% bar | +3.2% | +3.6% | inconclusive | 2.33 |
| runs | has | 529.2 us | 533.2 us | -1.3% | +0.2% | within the 5% bar | +0.1% | +0.1% | within the 5% bar | 1.99 |
| runs | count | 1.4 us | 1.4 us | +0.4% | +0.5% | within the 5% bar | +1.0% | +0.5% | within the 5% bar | 1.99 |
| runs | iterate | 619.4 ms | 607.8 ms | -3.4% | +1.6% | within the 5% bar | -1.7% | -0.0% | within the 5% bar | 1.99 |
| runs | intersect2 | 410.1 ms | 404.8 ms | -0.6% | -0.4% | within the 5% bar | +1.1% | -0.3% | within the 5% bar | 1.99 |
| runs | intersect4 | 153.8 ms | 154.3 ms | +0.6% | +0.4% | within the 5% bar | +2.2% | -0.0% | within the 5% bar | 1.99 |
| runs | andNot | 256.5 ms | 254.2 ms | -0.6% | +0.2% | within the 5% bar | -0.3% | +0.5% | within the 5% bar | 1.99 |
| mixed | has | 510.4 us | 500.1 us | -2.2% | +0.4% | within the 5% bar | -0.8% | -0.1% | within the 5% bar | 2.01 |
| mixed | count | 1.4 us | 1.4 us | +0.6% | +0.0% | within the 5% bar | +0.4% | +0.1% | within the 5% bar | 2.01 |
| mixed | iterate | 425.8 ms | 426.3 ms | -0.9% | -0.5% | within the 5% bar | +3.9% | +0.5% | within the 5% bar | 2.01 |
| mixed | intersect2 | 116.5 ms | 111.2 ms | -5.4% | -0.7% | within the 5% bar | +0.5% | +0.9% | within the 5% bar | 2.01 |
| mixed | intersect4 | 2.8 ms | 2.9 ms | +2.9% | -1.3% | within the 5% bar | +3.5% | -0.5% | within the 5% bar | 2.01 |
| mixed | andNot | 355.5 ms | 342.5 ms | -2.9% | -1.3% | within the 5% bar | +0.4% | -0.9% | within the 5% bar | 2.01 |
| spread | has | 572.1 us | 562.8 us | -1.7% | -0.7% | within the 5% bar | -0.5% | +0.9% | within the 5% bar | 2.03 |
| spread | count | 1.5 us | 1.5 us | -1.5% | +0.0% | within the 5% bar | +0.3% | -0.1% | within the 5% bar | 2.03 |
| spread | iterate | 331.9 ms | 289.1 ms | -11.7% | -0.4% | within the 5% bar | -11.0% | -0.4% | within the 5% bar | 2.03 |
| spread8k | has | 602.8 us | 552.3 us | -8.2% | -0.8% | within the 5% bar | -0.8% | +0.7% | within the 5% bar | 2.33 |
| spread8k | count | 1.7 us | 1.7 us | +1.7% | -0.2% | within the 5% bar | -0.1% | +0.1% | within the 5% bar | 2.62 |
| spread8k | iterate | 36.1 ms | 32.4 ms | -9.3% | +0.2% | within the 5% bar | -12.7% | -2.4% | inconclusive | 2.33 |
| spread8k | intersect2 | 36.0 ms | 29.2 ms | -17.2% | -1.2% | within the 5% bar | -12.4% | +1.3% | within the 5% bar | 2.62 |
| spread8k | intersect4 | 63.8 ms | 58.0 ms | -9.5% | +0.6% | within the 5% bar | -10.6% | +1.4% | within the 5% bar | 2.62 |
| spread8k | andNot | 67.8 ms | 58.6 ms | -12.9% | -1.2% | within the 5% bar | -11.8% | +1.0% | within the 5% bar | 2.62 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive; the worst control is the
control of the cell where its magnitude is largest, with the sign it was measured with):

| op | cells | worst ts vs native (per-process) | worst control (per-process) | verdict (per-process) | worst ts vs native (in-process) | worst control (in-process) | verdict (in-process) |
|---|---|---|---|---|---|---|---|
| has | 6 | +1.1% | -0.8% | within the 5% bar | +0.1% | -1.5% | within the 5% bar |
| count | 6 | +1.7% | -0.5% | within the 5% bar | +1.0% | +0.5% | within the 5% bar |
| iterate | 6 | -0.0% | +1.6% | within the 5% bar | +3.9% | -2.4% | inconclusive |
| intersect2 | 5 | +0.2% | +1.2% | within the 5% bar | +1.1% | -4.4% | inconclusive |
| intersect4 | 5 | +3.4% | -1.3% | within the 5% bar | +4.1% | +1.4% | within the 5% bar |
| andNot | 5 | -0.6% | +1.7% | within the 5% bar | +3.2% | +3.6% | inconclusive |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and made no codec call (measured, counts in the file):
  it is read from the generation's index, so it is not evidence about the codec.
- `has` is dominated by the store's asynchronous call, about 1 us a probe. The codecs are within a few percent in both
  directions (per-process worst +1.1%). Little power on the codec: see the gate row.
- `iterate` is within the bar in every cell per-process, and in-process in every cell that resolves (spread8k is inconclusive, control -2.4%). TypeScript is 9% to 12% faster on the spread sets per-process.
- **`intersect`, mixed at four operands, the cell that was over the bar: per-process +2.9% (control -1.3%), from +13.7%;
  in-process +3.5% (control -0.5%), from +8.7%.** Both are within the bar. The same code read +0.2% and **+10.2%** in an
  earlier run (see the note under the table of the two ways); this run's figures are the report's, and the spread between
  the two runs is part of what is known about the cell: its per-process quartiles are [-0.4%, +8.0%].
  **What the comparison is against:** the native codec as it ships takes the operands in the order it is given, and so
  does this table's native column. The TypeScript codec takes them smallest-first (`intersectSmallestFirst`, which only it
  sets). That is not the same engine path for the two codecs, so the bench also measured the native codec on the
  smallest-first path (a native-as-shipped, a native-smallest-first and a second native-as-shipped control in the same
  rounds, interleaved in the rotating order, 31 rounds, per process and in-process, in the same `--all` run; and a
  second set of rounds with the TypeScript codec against a smallest-first native, whose control is also on that path).
  The file keeps both under `nativeSmallestFirst`, each with its commit, tree state and times (measured; the two
  effect columns are the median of the paired per-round differences):

  | cell | native as shipped | native, smallest-first | effect of the order on native (control) | ts vs smallest-first native (control) |
  |---|---|---|---|---|
| mixed `intersect2`, per-process | 114.76 ms | 116.48 ms | +1.2% (-0.6%) | -3.1% (+0.3%) |
| mixed `intersect2`, in-process | 112.56 ms | 112.13 ms | +0.1% (+0.4%) | +1.3% (+0.2%) |
| mixed `intersect4`, per-process | 2.84 ms | 3.06 ms | +7.7% (-0.1%) | -3.8% (+0.5%) |
| mixed `intersect4`, in-process | 2.82 ms | 3.06 ms | +8.8% (+1.1%) | -1.4% (+0.9%) |
| spread8k `intersect2`, per-process | 32.35 ms | 32.27 ms | -0.2% (-1.7%) | -5.5% (+0.5%) |
| spread8k `intersect2`, in-process | 35.68 ms | 35.45 ms | -0.9% (-0.9%) | -13.1% (-2.0%) |
| spread8k `intersect4`, per-process | 62.11 ms | 64.26 ms | +2.8% (-0.2%) | -8.7% (-0.1%) |
| spread8k `intersect4`, in-process | 64.39 ms | 65.52 ms | +3.8% (-3.3%) | -12.2% (-1.5%) |

  Derived from the paired medians (not from a ratio across runs): **on mixed four operands the smallest-first order
  slows the native codec by +7.7% per-process (quartiles +5.2% to +10.6%) and +8.8% in-process (+5.5% to +11.4%)**, with
  controls at -0.1% and +1.1%. Why is not measured: ordering native by size changes three things at once (the `size`
  reads, which operand is cloned, and the order of the ANDs), and nothing in the record separates them; the `size` reads
  across the addon boundary are one hypothesis. On the other cells it does not help native either: mixed two operands +1.2% and +0.1%,
  spread8k two operands -0.2% and -0.9%, spread8k four operands +2.8% and +3.8%. The spread8k four-operand in-process
  control is -3.3%, outside the band, so that one cell is inconclusive (as is TypeScript against smallest-first native on spread8k two operands in-process, control -2.02%); no cell shows native gaining from the order beyond
  its control. **The verdict uses the as-shipped native column**, because that is what a user running the native codec
  gets and it is the harder comparison on the cell that matters: against the smallest-first native the TypeScript codec
  reads -3.8% (per-process) and -1.4% (in-process) on mixed four operands. Those two columns come from two runs of rounds
  (the native in the second set is a different set of processes), so only the effect column is paired against native as
  shipped.
- The worst four-operand cell is dense, **+3.4% per-process and +4.1% in-process** (controls +1.1% and +0.0%): within the
  bar and closer to it than mixed. Before this branch it read +3.6% and +3.0%, and it holds one kind, so the new order
  changes which pair meets first but not which kernel runs. Runs reads +0.6% and +2.2% (before +0.5% and +2.9%).
- **What the profile found, and what changed** (measured, one-codec profiles of the chain `clone`, `and`, `and`, `and` on
  one chunk of each kind rotation, TypeScript only, taken while the machine was at a load of 10 to 15, so read the ratios
  and not the microseconds): for a third of the mixed chunks the first step was a run container against a bitset, 3.3 us
  of the 14.0 us the three rotations cost together, and the steps after it filtered the 15,000-value bitset it built.
  Taking the operands smallest-first starts those chunks from the sparse array, so no bitset is built: 14.0 us before,
  10.6 us after (-24%). A kernel change alone, which writes a run-against-bitset result of at most 4,096 values straight to
  an array, did not move the bench's chunks (their runs hold about 30,000 values, the unchanged other branch of the
  kernel; a variant that counted each covered word instead of using the Harley-Seal count measured the same, 3.3 us, and
  was dropped).
- **`andNot` is within the bar per-process on every cell** (worst -0.6%, dense, control +1.7%); in-process the sparse cell
  is inconclusive (+3.2%, control +3.6%), the rest within it (worst +0.4%).
- **Cells that moved up since the committed run of the parent branch (`a7531fb1`) by 2 points or more, with both runs'
  controls in band** (per-process `has` dense +3.5 points; in-process `has` sparse +2.7 and runs +2.7, `intersect2` runs
  +2.5 and mixed +3.0, `iterate` mixed +4.2, `andNot` mixed +2.9; per-process `iterate` spread8k +2.3): none is over the
  bar and none holds a kernel this branch changed except in-process `intersect2` on mixed chunks, which meets run-against-bitset chunks through the one function this branch changed (its other branch does the same work plus one comparison); with the other cells they average -0.2 points over the 66 figures
  (cell and way), so they are read as the spread between two runs. Three more moved up by 2 points or more where one
  run's control was out of band (sparse `andNot` in-process, spread8k `intersect2` per-process and `andNot` in-process).

## The write path (measured; derived verdicts)

A load of 1,000,000 ids over 62,500 chunks, an erasure's rewrite of one id, and an export, each on a fresh store per round,
31 interleaved rounds, with a garbage collection before each timed call, in the same place for every codec (the run refuses
to start without `--expose-gc`, and the file records it). The write path is in-process only (three stores in one process,
the limit above). Load 1.3 at the start, 1.4 at the peak. The verdict is derived: faster when the TypeScript median is below -2%, no slower
when within the control band, slower above it, and inconclusive when the control is out of band.

| op | native | typescript | ts vs native | A/A control | verdict |
|---|---|---|---|---|---|
| load | 183.1 ms | 117.2 ms | -35.6% | -0.4% | faster |
| erase | 195.6 ms | 129.9 ms | -33.8% | +0.3% | faster |
| export | 406.8 ms | 350.5 ms | -14.1% | +0.1% | faster |

The exported bytes were identical between the codecs in every round (measured). These are **warm** figures: the process has
run the code before. The first `load` in a fresh process, which the cold row below measures, is +13.1% on TypeScript.

## Memory (measured)

A store's chunk cache holding every chunk of a data set, each codec in its own fresh process, seven repeats with the order
alternating (native first on even repeats, TypeScript first on odd ones), bytes per cached chunk: the median and, in
brackets, the range. Both codecs show a heap-plus-external figure, so the figure to read is the **difference** between
them, row by row, not either codec's absolute number. The native codec's is small on spread8k (-52, slightly negative) and
1,443 to 4,207 on the other four rows, each of those with a range at most 4 bytes wide, so none is noise around zero; why the
native codec shows heap or external bytes there is not measured. The resident-set growth includes memory V8's counters cannot
see, and it is **unreliable**: it moves with the allocator, and it reads below the heap growth it contains in many
TypeScript repeats (the last column). The heap-plus-external difference is the firmer figure; the resident column is an
order of magnitude. Load 1.4 at the start and 1.7 at the peak.

| data set | chunks | codec | heap+external (median, range) | resident growth (median, range) | resident below heap |
|---|---|---|---|---|---|
| dense | 64 | native | 4207 (4207 to 4207) | 15360 (4864 to 21504) | 0 of 7 |
| dense | 64 | typescript | 13082 (13082 to 13083) | 16640 (11008 to 19456) | 1 of 7 |
| sparse | 256 | native | 1443 (1442 to 1443) | 4224 (3392 to 6464) | 0 of 7 |
| sparse | 256 | typescript | 3911 (3910 to 3912) | 3648 (2496 to 4224) | 5 of 7 |
| runs | 256 | native | 1473 (1470 to 1474) | 2880 (2560 to 3264) | 0 of 7 |
| runs | 256 | typescript | 2503 (2503 to 2503) | 3392 (2816 to 3904) | 0 of 7 |
| mixed | 192 | native | 1823 (1823 to 1823) | 6144 (3669 to 8363) | 0 of 7 |
| mixed | 192 | typescript | 5915 (5914 to 5916) | 7765 (4011 to 8619) | 2 of 7 |
| spread8k | 8192 | native | -52 (-52 to -52) | 3412 (3374 to 3472) | 0 of 7 |
| spread8k | 8192 | typescript | 363 (363 to 363) | 3254 (3224 to 3290) | 0 of 7 |

The cache is bounded by a count of chunks (`maxChunks`), not by bytes, so a byte budget is derived: a cache of N chunks holds
N times the figure for its kind.

- **Heap-plus-external, TypeScript minus native, bytes per chunk (derived):** dense 8,875, sparse 2,468, runs 1,030, mixed
  4,092, spread8k 415. That is the most the TypeScript codec can hold in V8's counters that the native codec's own figure
  does not already hold; it is not the TypeScript codec's absolute figure, and how much of the native codec's memory is
  outside V8's counters altogether is not measured.
- **Resident growth, TypeScript median over native median (derived):** sparse 0.86, runs 1.18, dense 1.08, mixed 1.26,
  spread8k 0.95. On dense, sparse, runs and mixed the two codecs' ranges overlap, so resident growth does not separate them
  there. **On spread8k they do not overlap: every one of the seven TypeScript samples (3,224 to 3,290) is below every native
  one (3,374 to 3,472).** No multiple of the native codec's memory is claimed. The first run reported 1.4 to 3.5 times from
  a single sample per figure with the native codec always measured first in the same process; the repeats above do not bear
  that out. (One-off observation, not reproducible from the file: a first attempt at a 62,500-chunk spread cache gave no
  usable figure because the heap fell during the fill; spread8k above is the row that replaces it.)

## Start-up (measured)

Module load, in a fresh process, median of 31, each run with the three subjects in a rotating order: the native codec's
module (the addon and the codec) 19.5 ms, the TypeScript codec's module 1.1 ms (-94.2%; the control, native again, +0.4%).

A cold row, kept apart from every warmed figure above: a fresh process, a store over a loaded mixed set of 128 chunks, a
first `load` of two segments, then the first 2,000 `has` calls timed one by one, a first full `iterate` and a first
`intersect`; median of 31 processes per subject, in a rotating order, load 1.7 at the start and 1.7 at the end of the part (its rounds carry loads up to 2.27).
Milliseconds, except `firstHasUs`, which is microseconds.

| | native | typescript | ts vs native | A/A control |
|---|---|---|---|---|
| loadMs | 135.02 | 153 | +13.1% | +0.3% |
| firstHasUs | 3076.6 | 3262.3 | +6.6% | +0.4% |
| first10HasMs | 3.747 | 4.033 | +8.3% | +0.3% |
| first1000HasMs | 8.32 | 8.9 | +7.0% | +0.1% |
| next1000HasMs | 1.59 | 1.61 | +1.3% | +0.0% |
| firstIterateMs | 465.91 | 483.88 | +1.5% | +1.5% |
| firstIntersectMs | 136.43 | 132.91 | -2.8% | -0.1% |

`firstIterateMs` has a control at +1.5%, within the band, and its +1.5% is below the bar; `loadMs`, `firstHasUs`,
`first10HasMs` and `first1000HasMs` are above it (+13.1%, +6.6%, +8.3% and +7.0%) with controls near zero. These figures
include the first decode of each chunk; the store's own start-up is expected to be the same for both (inferred). The cold
row builds the facade bundle, which loads the native addon in the TypeScript run too (before its timers start): the
TypeScript cold row is not "a process without the addon", it is the facade a switch of the codec inside today's package
would ship until `roaring` leaves the dependencies.

## Runtimes (measured)

- Node 24.18.1 (the gate row's suites ran on it; the bench run above used v24.22.1): the oracle, hostile-input, pin, TypeScript-codec and fast-path suites pass (inside the 14,712 tests of the gate row above).
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
- Why mixed `intersect4` read +10.2% in-process in an earlier run of this code and +3.5% in this one (per-process +0.2%
  then, +2.9% now), each with its control in band. Not known. The explanation that the in-process way has polymorphic call
  sites in the combine code, which production does not, is unproven, and the earlier file argued against it (native 2.81 ms
  in both ways, the TypeScript codec's time higher in-process only; the change that took the per-process figure from
  +13.7% to +0.2% left the in-process one where it was). The gate's verdict is the per-process one in any case.
- How much a figure moves that its A/A control does not show. The `count` cells make no codec call, yet their
  ts-vs-native figures read between -1.5% and +1.7% per-process with controls within +-0.5%, and mixed `intersect4`'s
  in-process figure moved by 6.7 points between two runs of the same code. A per-process contrast carries about +-2% that
  the control does not see, so a verdict near the 5% line (dense `intersect4`, +3.4% and +4.1%) is read with that in
  mind. The control is the rule for validity, as the bar is for the verdict; neither is a confidence interval.
- A re-take replaces a figure whose control was out of band or whose load was high, and the first take stays in the file.
  Choosing a re-take after seeing a bad control is a selection; the file keeps both takes so the effect of the choice can
  be read (the largest first-take to re-take moves are 11.6, 5.0 and 4.9 points, on bases whose control was out of band at an ordinary load; the bases that ran at load 6 or more moved at most 2.7 points).
