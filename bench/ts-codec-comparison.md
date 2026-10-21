# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The evidence is
`bench/ts-codec-comparison-results.json`: every round of every figure, with the medians, quartiles and verdicts computed
from the rounds (`tests/bench/ts-codec-verdict.test.ts` recomputes them, and looks up every figure of the tables below in
the file). The instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc bench/ts-codec-engine.cjs --all`, about an
hour), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.18.1. The write path, memory and start-up figures come from one `--all`
run on the committed tree `3912bc0a2bc9ba6d87eee6afbaeae9ed26b6579b` (the bench; the file and this report were committed
after it), the tree clean. The read cells were then taken a second time, alone, on the same bench code, because another
process on the machine may have overlapped the first run's reads (the lock that keeps the machine to one heavy job was
removed once by another job); the first reads are not kept, and the file says so. The spread8k cells were taken a third time, alone, after a second
overlap of the lock was reported during the second take, and replace the second take's. The 1-minute load average, which includes
the bench's own processes, was 2.3 to 4.7 for the read cells (no round reached 6, and each row below says its cell's
highest), 3.1 for the write path, 3.0 for memory and 2.9 for start-up. Every figure is wall-clock on one machine, recorded
and not asserted.

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
| Correctness: zero oracle differences | measured so far: none | the oracle, hostile-input, pin, TypeScript-codec and fast-path suites pass on Node 24.18.1 (14 files, 1,558 tests); the two codecs wrote the same exported bytes in all 31 write-path rounds |
| Correctness: a week of nightly fuzz with none | **cannot be judged yet** | the week starts at merge. Wiring (read from the workflows): `full-nightly.yml` runs the whole suite, the oracle files included, at 04:00 UTC every day; `fuzz-nightly.yml` fuzzes the four untrusted-bytes targets (`deser`, `crbm`, `index`, `ext`) at 05:00 UTC, all of them on the native deserializer: no fuzz target runs the TypeScript codec yet, so the week's fuzz evidence for it is the property tests' |
| Hot path: `has` | within the 5% bar, **with little power on the codec** | per-process worst ts vs native +2.2% (spread), worst control +1.3%; in-process worst +0.4%, worst control -2.2% (inconclusive: mixed). A call is 512 awaited probes at about 1 us each, of which the codec's `has` is about 26 to 39 ns native and 8 to 29 ns TypeScript on one chunk (`bench/ts-codec-results.json`, measured earlier): a codec two to three times slower on the probe alone would still land within 5% of the call. The per-operation `has` rows are the sensitive figure |
| Hot path: `count` | within the 5% bar, **not informative: no codec call** | per-process worst +1.4%, worst control +1.0%; in-process worst +0.5%, worst control -0.6%. `count` is read from the generation's index; the file records zero codec calls in every cell |
| Hot path: `iterate` | within the 5% bar per-process (in-process: inconclusive) | per-process worst +0.1%, worst control -1.7%; in-process worst +2.9%, worst control -3.2% (sparse, inconclusive). The TypeScript codec is 10% to 13% faster on the spread sets |
| Hot path: `intersect` | **over the 5% bar** | per-process: two operands worst +22.8% (sparse), four operands worst +48.3% (mixed), the controls of the over cells within +0.9%; in-process +24.4% and +44.3%. Cells below |
| Hot path: `andNot` (beyond the four the gate names) | within the 5% bar per-process, **at the bar** | sparse: +4.5% per-process (control -0.4%), 0.5 points under the bar; +6.1% in-process with a control at +3.3% (inconclusive). An earlier `--all` run, not kept, read +6.5% in both ways with the controls in band: the cell sits at the bar and neither a pass nor a failure should be read from it |
| Write path: the bulk load no slower | faster (derived), a **warm** figure | 31 interleaved rounds: load -34.8% (control -0.2%). The first load in a **fresh process** is not that: `loadMs` of the cold row, two loads of the mixed set, is +13.4% on TypeScript (control -0.3%; median of 31 processes each), below |
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
| dense | has | 496.3 us | 496.5 us | +0.7% | +1.3% | within the 5% bar | -2.1% | -0.4% | within the 5% bar | 3.57 |
| dense | count | 1.4 us | 1.4 us | -0.1% | -0.4% | within the 5% bar | +0.2% | +0.1% | within the 5% bar | 3.57 |
| dense | iterate | 157.9 ms | 156.5 ms | -2.3% | -1.7% | within the 5% bar | +2.3% | -0.8% | within the 5% bar | 3.57 |
| dense | intersect2 | 84.3 ms | 84.4 ms | -2.9% | -1.9% | within the 5% bar | +1.1% | +1.9% | within the 5% bar | 3.57 |
| dense | intersect4 | 17.9 ms | 18.3 ms | +3.1% | +0.4% | within the 5% bar | +3.1% | +0.1% | within the 5% bar | 3.57 |
| dense | andNot | 83.8 ms | 83.0 ms | +0.3% | +1.2% | within the 5% bar | +0.5% | -1.5% | within the 5% bar | 3.57 |
| sparse | has | 547.7 us | 530.0 us | -2.9% | +0.1% | within the 5% bar | +0.4% | +1.3% | within the 5% bar | 2.94 |
| sparse | count | 1.5 us | 1.5 us | -0.5% | -0.2% | within the 5% bar | +0.5% | +0.3% | within the 5% bar | 2.94 |
| sparse | iterate | 37.7 ms | 37.3 ms | +0.1% | +1.3% | within the 5% bar | +1.9% | -3.2% | inconclusive | 2.94 |
| sparse | intersect2 | 3.6 ms | 4.4 ms | +22.8% | +0.0% | over the 5% bar | +24.4% | -0.3% | over the 5% bar | 2.94 |
| sparse | intersect4 | 3.7 ms | 4.6 ms | +27.3% | +0.9% | over the 5% bar | +31.3% | +1.9% | over the 5% bar | 2.94 |
| sparse | andNot | 41.5 ms | 43.4 ms | +4.5% | -0.4% | within the 5% bar | +6.1% | +3.3% | inconclusive | 2.94 |
| runs | has | 532.1 us | 516.0 us | -1.7% | +0.7% | within the 5% bar | -2.4% | -0.4% | within the 5% bar | 4.66 |
| runs | count | 1.3 us | 1.4 us | +1.4% | +1.0% | within the 5% bar | -0.4% | -0.6% | within the 5% bar | 4.66 |
| runs | iterate | 607.5 ms | 597.1 ms | -2.4% | +0.9% | within the 5% bar | -2.3% | -0.0% | within the 5% bar | 4.66 |
| runs | intersect2 | 401.0 ms | 394.8 ms | -1.2% | +0.5% | within the 5% bar | -1.6% | -1.6% | within the 5% bar | 4.66 |
| runs | intersect4 | 149.5 ms | 151.1 ms | +1.9% | +1.1% | within the 5% bar | -2.0% | +0.2% | within the 5% bar | 4.66 |
| runs | andNot | 250.5 ms | 251.6 ms | +0.6% | +0.8% | within the 5% bar | -0.7% | +0.9% | within the 5% bar | 4.66 |
| mixed | has | 495.8 us | 481.7 us | -2.6% | +0.3% | within the 5% bar | -3.7% | -2.2% | inconclusive | 3.43 |
| mixed | count | 1.4 us | 1.4 us | +0.0% | +0.1% | within the 5% bar | -0.1% | -0.6% | within the 5% bar | 3.43 |
| mixed | iterate | 432.2 ms | 425.9 ms | -1.5% | -0.9% | within the 5% bar | +2.9% | +0.4% | within the 5% bar | 3.43 |
| mixed | intersect2 | 112.2 ms | 113.1 ms | +3.5% | -0.4% | within the 5% bar | +1.5% | -0.8% | within the 5% bar | 3.43 |
| mixed | intersect4 | 2.7 ms | 4.0 ms | +48.3% | +0.3% | over the 5% bar | +44.3% | +0.9% | over the 5% bar | 3.43 |
| mixed | andNot | 347.0 ms | 348.8 ms | +0.0% | +0.2% | within the 5% bar | -0.4% | -0.2% | within the 5% bar | 3.43 |
| spread | has | 549.4 us | 567.1 us | +2.2% | +0.6% | within the 5% bar | -1.9% | -0.2% | within the 5% bar | 3.56 |
| spread | count | 1.5 us | 1.5 us | +1.0% | +0.3% | within the 5% bar | +0.2% | +0.0% | within the 5% bar | 3.56 |
| spread | iterate | 297.3 ms | 257.3 ms | -13.0% | +0.5% | within the 5% bar | -11.6% | +0.2% | within the 5% bar | 3.56 |
| spread8k | has | 515.0 us | 526.2 us | -2.0% | -0.3% | within the 5% bar | -1.9% | +0.5% | within the 5% bar | 3.75 |
| spread8k | count | 1.6 us | 1.7 us | +0.9% | -0.3% | within the 5% bar | -0.2% | -0.3% | within the 5% bar | 3.75 |
| spread8k | iterate | 32.7 ms | 29.4 ms | -9.8% | +0.6% | within the 5% bar | -12.3% | -0.9% | within the 5% bar | 3.75 |
| spread8k | intersect2 | 31.4 ms | 25.9 ms | -16.9% | +0.2% | within the 5% bar | -9.3% | +1.9% | within the 5% bar | 3.75 |
| spread8k | intersect4 | 53.9 ms | 48.6 ms | -6.8% | -0.3% | within the 5% bar | -10.7% | -3.2% | inconclusive | 3.75 |
| spread8k | andNot | 60.3 ms | 55.1 ms | -8.2% | -0.4% | within the 5% bar | -11.1% | +0.7% | within the 5% bar | 3.75 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive; the worst control is the
control of the cell where its magnitude is largest, with the sign it was measured with):

| op | cells | worst ts vs native (per-process) | worst control (per-process) | verdict (per-process) | worst ts vs native (in-process) | worst control (in-process) | verdict (in-process) |
|---|---|---|---|---|---|---|---|
| has | 6 | +2.2% | +1.3% | within the 5% bar | +0.4% | -2.2% | inconclusive |
| count | 6 | +1.4% | +1.0% | within the 5% bar | +0.5% | -0.6% | within the 5% bar |
| iterate | 6 | +0.1% | -1.7% | within the 5% bar | +2.9% | -3.2% | inconclusive |
| intersect2 | 5 | +22.8% | -1.9% | over the 5% bar | +24.4% | +1.9% | over the 5% bar |
| intersect4 | 5 | +48.3% | +1.1% | over the 5% bar | +44.3% | -3.2% | over the 5% bar |
| andNot | 5 | +4.5% | +1.2% | within the 5% bar | +6.1% | +3.3% | inconclusive |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and made no codec call (measured, counts in the file):
  it is read from the generation's index, so it is not evidence about the codec.
- `has` is dominated by the store's asynchronous call, about 1 us a probe. Per-process every cell is within the bar and the
  codecs are within a few percent in both directions; in-process one cell (mixed) has a control outside the band and is
  inconclusive. Little power on the codec: see the gate row.
- `iterate` is within the bar in every cell per-process; in-process, sparse has a control at -3.2% and is inconclusive.
  TypeScript is 10% to 13% faster on the spread sets in both ways.
- **`intersect` is over the bar on three cells in both ways:** sparse (+22.8% and +27.3% per-process for two and four
  operands) and mixed (+48.3% at four operands). These cells are the cheap ones (3 to 5 ms for a call), so the codec's share
  is largest. The per-operation bench puts the sparse and skewed combines among the TypeScript codec's slower rows. The
  cause was not investigated here; the figures are the finding. The other `intersect` cells are within the bar or faster,
  except spread8k `intersect4` in-process, which is -10.7% with a control at -3.2% and so inconclusive.
- **`andNot` on sparse is at the bar:** +4.5% per-process (within, by 0.5 points), +6.1% in-process with a control at +3.3%
  (inconclusive), and +6.5% in both ways in an earlier run that is not kept.

## The write path (measured; derived verdicts)

A load of 1,000,000 ids over 62,500 chunks, an erasure's rewrite of one id, and an export, each on a fresh store per round,
31 interleaved rounds, with a garbage collection before each timed call, in the same place for every codec (the run refuses
to start without `--expose-gc`, and the file records it). The write path is in-process only (three stores in one process,
the limit above). Load 3.1. The verdict is derived: faster when the TypeScript median is below -2%, no slower when within the
control band, slower above it, and inconclusive when the control is out of band.

| op | native | typescript | ts vs native | A/A control | verdict |
|---|---|---|---|---|---|
| load | 172.6 ms | 112.7 ms | -34.8% | -0.2% | faster |
| erase | 189.6 ms | 128.1 ms | -32.4% | +0.1% | faster |
| export | 395.2 ms | 350.4 ms | -11.2% | +0.2% | faster |

The exported bytes were identical between the codecs in every round (measured). These are **warm** figures: the process has
run the code before. The first `load` in a fresh process, which the cold row below measures, is +13.4% on TypeScript.

## Memory (measured)

A store's chunk cache holding every chunk of a data set, each codec in its own fresh process, seven repeats with the order
alternating (native first on even repeats, TypeScript first on odd ones), bytes per cached chunk: the median and, in
brackets, the range. The native codec's own allocations are invisible to V8's counters, so its heap-plus-external figure is
near zero (and can be slightly negative); the resident-set growth is the figure that includes them, and it is **unreliable**:
it moves with the allocator, and it reads below the heap growth it contains in many TypeScript repeats (the last column).
The heap-plus-external column is the only firm figure for the TypeScript codec; the resident column is an order of magnitude.

| data set | chunks | codec | heap+external (median, range) | resident growth (median, range) | resident below heap |
|---|---|---|---|---|---|
| dense | 64 | native | 4204 (4204 to 4206) | 10496 (7168 to 16384) | 0 of 7 |
| dense | 64 | typescript | 13078 (13078 to 13078) | 12288 (9984 to 17152) | 4 of 7 |
| sparse | 256 | native | 1434 (1433 to 1434) | 4288 (3136 to 4544) | 0 of 7 |
| sparse | 256 | typescript | 3901 (3900 to 3902) | 3200 (2432 to 4288) | 5 of 7 |
| runs | 256 | native | 1460 (1460 to 1461) | 2368 (2112 to 3456) | 0 of 7 |
| runs | 256 | typescript | 2495 (2495 to 2495) | 3200 (2432 to 4032) | 1 of 7 |
| mixed | 192 | native | 1815 (1815 to 1815) | 7936 (4864 to 8875) | 0 of 7 |
| mixed | 192 | typescript | 5906 (5905 to 5906) | 8789 (4779 to 9643) | 3 of 7 |
| spread8k | 8192 | native | -52 (-52 to -52) | 3396 (3386 to 3432) | 0 of 7 |
| spread8k | 8192 | typescript | 363 (363 to 363) | 3222 (3204 to 3284) | 0 of 7 |

The cache is bounded by a count of chunks (`maxChunks`), not by bytes, so a byte budget is derived: a cache of N chunks holds
N times the figure for its kind. The TypeScript codec holds 363 (spread8k) to 13,078 (dense) bytes of V8 heap per chunk that
the native codec holds outside the heap. By resident growth the ratio of the TypeScript median to the native median is 0.75
(sparse) to 1.35 (runs) across every row (dense 1.17, mixed 1.11, spread8k 0.95), and the ranges overlap in every row:
resident growth does not separate the codecs, and no multiple of the native codec's memory is claimed. The first run
reported 1.4 to 3.5 times from a single sample per figure with the native codec always measured first in the same process;
the repeats above do not bear that out. (One-off observation, not reproducible from the file: a first attempt at a
62,500-chunk spread cache gave no usable figure because the heap fell during the fill; spread8k above is the row that
replaces it.)

## Start-up (measured)

Module load, in a fresh process, median of 31, each run with the three subjects in a rotating order: the native codec's
module (the addon and the codec) 19.2 ms, the TypeScript codec's module 1.1 ms (-94.3%; the control, native again, +0.2%).

A cold row, kept apart from every warmed figure above: a fresh process, a store over a loaded mixed set of 128 chunks, a
first `load` of two segments, then the first 2,000 `has` calls timed one by one, a first full `iterate` and a first
`intersect`; median of 31 processes per subject, in a rotating order, load 2.9. Milliseconds, except `firstHasUs`, which is
microseconds.

| | native | typescript | ts vs native | A/A control |
|---|---|---|---|---|
| loadMs | 134.53 | 152.22 | +13.4% | -0.3% |
| firstHasUs | 3039.2 | 3193.7 | +4.6% | -0.5% |
| first10HasMs | 3.713 | 3.966 | +6.8% | -0.5% |
| first1000HasMs | 8.27 | 8.77 | +6.3% | -0.1% |
| next1000HasMs | 1.58 | 1.58 | +0.6% | +0.0% |
| firstIterateMs | 464.35 | 484.45 | +4.0% | -2.5% |
| firstIntersectMs | 135.88 | 131.72 | -2.6% | +0.3% |

`firstIterateMs` has a control at -2.5%, outside the band: its +4.0% is not resolved. These figures include the first decode
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
- Whether the over-the-bar cells (`intersect` on sparse and mixed) are the codec or the instrument: the control resolved
  them (it sat within +-2% in each, in both ways), and the per-process figures, which look like
  production, agree with the in-process ones, so they are expected to be the codec; a fix and a re-run settle it.
