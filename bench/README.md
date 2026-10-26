# `bench/` — the measurements behind every published number

Everything in this directory **measures**; nothing here is a test. The distinction matters because the two are
held to different standards:

- A **test** asserts something that must be true on every machine, and runs in CI on every pull request.
- A **measurement** produces a number that depends on the machine, the network and the cloud. It is run by hand,
  its output is committed as a results file, and a published figure is then checked against that file — so the
  number on the site cannot drift from the run that produced it, and cannot improve without a new run.

The deterministic parts of these harnesses — the ones that hold on any machine — are pulled out and gated in CI
by [`tests/bench/`](../tests/bench). What stays here is the part that cannot be.

For what each published number means, how it was measured, and what it does *not* establish, read
[`docs/benchmarks.md`](../docs/benchmarks.md). This file is the map of the code that produces them.

## Contents

- [The harnesses](#the-harnesses)
- [The results files, and what reads them](#the-results-files-and-what-reads-them)
- [Real-cloud calibration](#real-cloud-calibration)
- [`lib/`](#lib)
- [Adding a harness](#adding-a-harness)

## The harnesses

| file | measures | run with | writes | in CI? |
|---|---|---|---|---|
| `run.cjs` | The read-cost curve against one Redis-HA cluster (`ONE_REDIS_HA_CLUSTER`), and where they cross — computed from the **shipped** estimator (`estimateCost`, from `@cloudbitmaps/tools`) at the default rates, so the chart cannot drift from the library's own arithmetic. | `pnpm bench` (builds first); `pnpm bench:check` to verify | `crossover.svg`, `results.json`, the chart inside `site/benchmarks.html`, and the chart and stats table inside `docs/benchmarks.md` (between `BENCH` markers) | yes — `pnpm bench:check` fails if a file it writes is not what the built estimator gives, and `tests/bench/anchors.test.ts` holds its figures to the estimator |
| `sizing.cjs` | A small, a medium and a large deployment — illustrative workloads, labelled as such — priced by the **shipped** estimator (`estimateCost`, from `@cloudbitmaps/tools`) at the default pricing, against the Redis that would hold each one's data, so the page cannot quote a bill the library would not. | `pnpm bench:sizing` (builds first) | the `SIZING` regions of `docs/guide/sizing.md`, `docs/guide/cost.md`, `docs/guide/why-cloudbitmaps.md` and `README.md`, and the explainer's two charts in `bench/`, each in a light and a dark file | yes — `pnpm bench:sizing:check` fails if a region or a chart is not what the generator draws from the estimator; on a marker it would not check; outside the regions of a page whose figures are generated, on a digit but in the names it lists, on a number word from two up but in the phrases it lists, on a share's sign and any character but plain ASCII, `§` and `—`, on HTML, an image or a code fence, which could hide one, and on a share, a multiple or an amount in words, in the spellings it knows; and on an entity GitHub decodes in any page it writes. It is a check against drift, not a bar to a figure written on purpose in a form it has never seen. `tests/bench/sizing-check.test.ts` holds the check itself to failing |
| `range-counts.cjs` | The storage requests the engine makes of the object store for a cold intersect and a cold `andNot`, by the size of a deployment's chunks and by how much two segments share and where it sits in each object, **counted by running the built engine** over the in-memory backend. Nothing is measured on a cloud: the counts are what the code makes, and the cost figures built from them are labelled expected. | `pnpm bench:range-counts` (builds first; about 25 seconds) | `range-counts.json` | yes, `pnpm bench:range-counts:check` counts again and fails if the file is not what the engine makes |
| `materialize-many-counts.cjs` | The requests of a refresh-shaped `store.materializeMany` call, and of the same outputs as one `*Into` call each with scratch segments, **counted** by wrapping the storage driver and the registry of the in-memory backend and counting every call, by kind. Three shapes: `small` (20 operands, 100 outputs), `refresh` (100 operands of 200,000 ids, 1,000 outputs) and `target` (100 operands of 3,000,000 ids over 1,500 chunks, 1,000 outputs of about 5 MB, the batch only, at 256 MiB and at 2 GiB: some ten minutes and a few gigabytes, so it is committed and recounted on demand with `--check --shape target`). Nothing is measured on a cloud and no time is recorded. | `pnpm bench:materialize-many-counts` (builds first; about 55 seconds for both shapes) | `materialize-many-counts.json` | yes, `pnpm bench:materialize-many-counts:check` recounts `small` (about 8 seconds) and `--check --all` both, and `tests/docs/materialize-many-figures.test.ts` holds the guide's and the changelog's figures to the file |
| `expected-figures.cjs` | Writes `expected-figures.json`: the figures the engine is expected to cost (a cold intersect's, `andNot`'s and `iterate`'s GETs and dollars, the Redis line in cold intersects a second, a spread layout's bytes), derived from `range-counts.json`, `results.json` and the **built** estimator's prices. `--check` (`pnpm bench:expected-figures:check`, after the build) fails if the committed file is not what that gives. Nothing in it is measured on a cloud. |
| `scale.cjs` | A fleet of up to 100,000 segments on local disk: retained heap as the fleet grows (the memory bound), the `O(total)` cost of enumerating it, and chunk-skipping on two large segments. | `pnpm bench:scale` (heavy); `SCALE_FLEETS=1000,10000` for a quick pass | `scale-results.json`, and the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` | no — too slow and too machine-dependent |
| `soak.cjs` | The loaded store under **sustained** mixed load — point reads, combines with `exclude` lists, and re-loads — watching post-GC heap *and* external memory (typed arrays' backing stores) for creep over time. A run with no combines or no re-loads is reported inconclusive, never a pass. The creep band for each axis is 15% of its first-third median plus a 1 MiB floor; the external floor is kept at 1 MiB because the recorded external series is bimodal (2.6 to 3.9 MiB sample to sample) and its creep measure spans -0.85 to +0.60 MiB over the sub-runs of the committed record (+0.17 in CI), so a tighter floor would trip honest runs; a ramp of about 60% of the baseline passes and about 80% fails. | `pnpm soak` (`SOAK_INJECT=1` to persist) | `soak-results.json` | yes, inside `pnpm rss-gate` (see `scripts/`) |
| `encoding.cjs` | Encoded size of the same ids under roaring against a fixed array, a fixed bitset and a fixed run-length encoding — the evidence behind the site's claim that roaring's advantage is choosing a representation *per chunk*. | `pnpm bench:encoding` | `encoding-results.json` | no |
| `resolution-heap.cjs` | The heap the resolution cache's entries take, against the bytes the cache counts for them, for four row shapes (cleartext and encrypted, with no metadata and with 300 bytes of it): one `.crbm` source at the default reader-cache settings, filled through the built package with a resolution for each of 8,192 segments, its heap read after a forced GC with them held and once they are cleared. It reaches into the source's private caches to clear them. Depends on the Node version and the machine: recorded, not asserted. | `pnpm run build && node --expose-gc bench/resolution-heap.cjs` (a few seconds); `RESOLUTION_HEAP_INJECT=1` to persist | `resolution-heap-results.json` | no: it never re-measures in CI. `pnpm bench:sizing:check` holds the sizing guide's range to the results file |
| `event-loop.cjs` | `store.load()` of 1M ids spread across the id space onto in-memory storage, through the built package, 20 trials each in a fresh process: the load's wall time and the longest single event-loop stall, with the store's yielding clock and with a clock that yields nothing. Records the CPU, Node version, commit and the load average before and after, so a busy machine is visible in the evidence. Wall-clock and machine-dependent: recorded, not asserted. | `pnpm bench:event-loop` (builds first; wants an idle machine); `EVENT_LOOP_INJECT=1` to persist; `pnpm bench:event-loop:check` to verify | `event-loop-results.json` | yes — `pnpm bench:event-loop:check` fails if the guide's event-loop section, or the two source comments quoting the same run, differ from the results file. It never re-measures, because CI hardware is not the hardware that measured |
| `index-encoder.cjs` | What the writer's chunk-index encoding holds while it runs: an array of numbers beside the index, against one buffer sized to the index, over entries held live, each in a fresh process, after forced major collections, at 8,192 and 65,536 chunks and two entry shapes (the heap test's own, and a synthetic wide one). Machine-dependent: recorded in `docs/benchmarks.md`, not asserted | `node bench/index-encoder.cjs [--shape load\|wide] [chunks ...]` (needs no build) | stdout only | no — it never writes a file and nothing compares it with the docs |
| `load-input.cjs` | `store.load()` of the same set from ids (a plain array, and through an async generator), from `{ bitmap }` and from `{ serialized }`, onto in-memory storage, through the built package, 5 trials each in a fresh process: five sets, among them a 12M-member sparse set in 65,536 chunks and one container layout at 10 % and at 90 % density, which a path with per-id work pays nine times for and a path without it does not. Records the wall time, the longest event-loop stall, and that every input wrote the same bytes. Wall-clock and machine-dependent: recorded, not asserted; that no per-id code runs is asserted on every pull request by `tests/roaring/load-no-per-id.test.ts`, which counts calls. | `pnpm bench:load-input` (builds first; wants an idle machine); `LOAD_INPUT_INJECT=1` to persist; `pnpm bench:load-input:check` to verify | `load-input-results.json`, not yet recorded | yes — `pnpm bench:load-input:check` fails if the loading guide's "How fast a bitmap loads" figures differ from the results file, or quote any figure while there is none. It never re-measures |
| `ts-codec.cjs` | The TypeScript Roaring codec against the native one, one operation at a time on one chunk: `has`, `decode`, `serialize`, `iterate`, `toUint32`, `optimize`, `count`, `clone`, `build`, `addMany` on dense, sparse and run chunks, and `and`, `or`, `andNot` on six operand pairs (dense/dense, sparse/sparse, run/run, sparse/dense, run/dense, skewed 64/4,000). Median nanoseconds per call over 11 interleaved rounds (the codec that goes first alternates) after a 300 ms warm-up per codec by time, each cell in its own child process so earlier cells cannot shape the TypeScript codec's inline caches, every result stored where V8 cannot drop it, with the highest 1-minute load average seen beside each figure; it refuses to time while the load is 6 or more. `count` is 256 reads per call, reported per read. **There is no cold-process figure here: every figure is a warmed codec, and this bench has no cold-process figure.** The optimizing tier is not confirmed (a natives-syntax check sees the cell's closure, not the codec functions it calls). `TS_CODEC_SRC_DIR` benches the TypeScript codec from another commit's `packages/roaring/src` copy, which is how `ts-codec-results-before.json` was taken. With `--memory`, the bytes each decoded chunk holds, by kind. It bundles the codec sources itself, so it needs no build. Wall-clock and machine-dependent: recorded, not asserted. | `pnpm bench:ts-codec` (needs `node --expose-gc`, which the script passes); `TS_CODEC_INJECT=1` to persist | `ts-codec-results.json` | yes — `pnpm bench:ts-codec:check` times nothing: it runs every operation once on both codecs and fails if their answers differ or a cell is missing |
| `ts-codec-engine.cjs` | The TypeScript Roaring codec against the native one **through the store**: `seg.has`, `seg.count()`, a full `iterate()`, `intersect` of two and of four operands and `andNot` on `CloudRoaring` over `MemoryStorage` with a warm cache, on six data sets (dense, sparse, runs, mixed, a million ids over 62,500 chunks, and the same shape over 8,192 chunks, the only one of the two that is combined); the bulk load, an erasure's rewrite and an export of the 62,500-chunk set, with a collection before each timed call; the heap, external and resident memory of a full chunk cache, each codec in a fresh process, seven repeats in alternating order; and a fresh process's module load and first 2,000 `has` calls (a cold row, kept apart). Every read cell is measured **two ways**: *in-process*, three stores (native, TypeScript, native again as the **A/A control**) in one process in an order that rotates through the six permutations, and *per-process*, the same three as three fresh processes with one codec each, so the call sites see one codec and the heap holds one store, as in production. A cell reports the median of at least 31 paired differences for each, with the quartiles and every round, and its verdict (the per-process one) is computed by `lib/codec-verdict.cjs`: within the 5% bar only when the control's median is within +-2% and the TypeScript median is at most +5%, over the bar when it is above, inconclusive when the control is out of band. A figure is taken only while the 1-minute load is under 6, and every round carries the load. The stores that were timed are counted per codec (a store that ran the wrong codec fails), and the storage calls during the timed rounds are counted, in-process and per-process (a warm cache makes no object read). Each part of a run records its start and end time, the commit and whether the tree was clean. The in-process figures share a process, so the call sites there are polymorphic and the heap carries both caches; the per-process figures share the machine, not a process; the report and the script's header say what each cannot see. The codec switch is flipped by `bench/lib/codec-engine.cjs`, which bundles the sources; nothing under `packages/` is touched. Wall-clock and machine-dependent: recorded, not asserted. | `node --expose-gc bench/ts-codec-engine.cjs --all` (builds nothing; about an hour on an idle machine; `--reads`, `--reads-in-process`, `--reads-per-process`, `--write`, `--memory`, `--startup` run one part, `--only=<text>` keeps the cells whose "<data set> <op>" contains the text). Environment: `TS_ENGINE_RESULTS` (the file `--all` writes), `TS_ENGINE_ROUNDS` (rounds of a read cell, at least 31), `TS_ENGINE_TRACE` (progress on standard error), `TS_ENGINE_ANY_LOAD=1` (turns the load gate off and records `anyLoad: true` in the file's rules). `TS_ENGINE_NATIVE_SMALLEST_FIRST=1` (a measurement knob: every native subject asks for the smallest-first intersect order, as the TypeScript codec does) and `TS_ENGINE_FAIRNESS=1` (the second subject of each cell is the native codec with that order, against native as shipped); `--all` sets each for a child of its own and writes the two measurements, on the intersect cells of the mixed and spread8k sets, under `nativeSmallestFirst`, each with its commit, tree state and times, and the main figures do not use either. `--only=<a>|<b>` keeps the cells containing either text. `--check-scale` and the `--child-*` flags are the script running itself in a fresh process | `ts-codec-comparison-results.json`, the evidence behind `ts-codec-comparison.md`: every round of every figure, with the medians and verdicts computed from them | yes — `pnpm bench:ts-codec-engine:check` runs every part once on tiny data (reads both ways, the write path, start-up, and the memory pass, whose output it parses) and fails only if the output is malformed, the codecs disagree on an answer, a store ran the wrong codec, the cache was not warm or the two codecs wrote different bytes. It compares no duration with any bound; `tests/bench/ts-codec-verdict.test.ts` holds the verdict rule to its boundaries and the committed file to the rule |
| `ts-codec-paired.cjs` | A change under `packages/roaring/src/ts-roaring/` against the store's hot paths and write path, **paired**: the codec at the base commit (the merge base with `origin/main`, or `PAIRED_BASE`), the codec of the working tree and the base codec a second time as an A/A control, one subject per process, in an order that rotates through the six permutations, 31 rounds. Cells: `seg.has`, `count()`, a full `iterate()`, `intersect` of two and four operands and `andNot` on dense, sparse, runs, mixed and a million-id spread set, a bulk `load` of 1,000,000 ids over 62,500 chunks and an `eraseSubject` of one id (each in a fresh process, after one untimed round), the codec's own operations one call at a time (`--ops`: `has`, `decode` warm and `decode first`, the first call of a fresh process, which is the cold decode the store's warm read cells never reach, `serialize`, `iterate`, `toUint32`, `optimize`, `count`, `clone`, `build`, `addMany`, `removeMany`, and `and`, `or`, `andNot` on six operand pairs, on dense, sparse and run chunks and a 128-container bitmap, and `and new`, `or new`, `xor new` and `andNot new` on the same six pairs: the combine that returns a new bitmap, timed on the bitmap class's static where the codec has one and, for a base that has none, on a clone and an in-place combine, or for `xor` the three passes it derives from). Each run **appends a pass** to the results file (its time, base and head commits, machine and the load at the start and the end of every round), never replacing an earlier one; a pass with an inconclusive cell is recorded and taken again (`PAIRED_RETAKES`, default 2). A cell's verdict (`lib/paired-verdict.cjs`, pure, so another bench can import it, held to its boundaries by a test) is rule `median-interval-v2`: per round the head is compared with the mean of the base and the control, the cell reports the distribution-free 95% interval of the median of those differences, and it is within when the interval's upper end is at most the fixed 2% bar, slower when its lower end is above 2%, faster when its upper end is below -2%, and inconclusive otherwise, or whenever the control's median differs from the base by more than 2%. The gate reads every pass, so a later green pass never erases a "slower": a cell judged slower in any pass fails unless that pass carries an `explained` note, and a cell still inconclusive in the last pass is published only with its bound, in an `unresolved` note on that pass quoting it (`--gate` applies the gate to the file; a run exits 3 on a slower and 4 on any other failure of the record, and 2 when it gives up: more rounds set aside for load or as slept than twice the rounds it wants, a load that never settles, or a run started wrongly. Exit 2 records nothing, not even the parts already measured, so a run that gave up leaves no pass behind; take it again). Every subject must give the same answer for a cell. **The load rule:** the machine is waited for before a round, the load average is recorded at the start and at the end of every round, and a round that ends at a load of 6 or more is not kept: it is stored under the cell's `discarded` and taken again, so no kept round ended at a load of 6 or more (`PAIRED_ANY_LOAD=1` turns the rule off and the pass records it, and the summary says so). **The sleep rule:** a machine that sleeps turns a call of milliseconds into one of minutes, and a head that is really slow in some rounds looks the same in wall time, but a slow head burns CPU and a sleeping machine does not. So every child times each span in wall time and in CPU time (`process.cpuUsage()` deltas that bracket the same span: the CPU read comes before the wall start and after the wall end, so the wall span holds no CPU read, and each child makes one untimed CPU read before its first span), and a subject's figure in a round counts as slept only when it is more than 100 times that subject's median in the cell and less than half of its wall time was on CPU. A round with a slept figure in any cell is not kept: it is stored under the cell's `slept`, each such round with its evidence (for every slept figure, the cell, the subject, the wall figure and the CPU figure), and taken again. The numbers come from the record: the largest ordinary round on file is 11.95 times its cell's median (the first pass, `sparse count`, the control, `rounds[8]`, the ninth round), the second and third passes reach 5.1 times, and every sleep on file is at least 1,116 times its median and hit the base, the head and the control alike. The pass records the rule it was taken under (`sleepRule`: `factor` 100, `maxOnCpu` 0.5) and only a pass that records it is read by it; the first three passes carry no CPU figures and are read exactly as stored. The gate re-checks every recorded slept round against its own evidence and refuses a cell whose slept rounds fall on the head two or more times and more often than on the base and the control together, unless the cell carries an `explained` note (take the cell again); one head-only slept round is set aside without a refusal because the backstop needs two, which is accepted because a single off-CPU head round over 100 times the median is a sleep or a deschedule far more often than a slowdown. Each pass states the highest load its kept rounds ended at, how many rounds it discarded for load and how many as slept. Every duration in a pass is milliseconds with the decimals of its instrument's resolution (six for the cells measured in whole nanoseconds, seven for the per-operation cells, measured to a tenth of a nanosecond), recorded as `"unit": "ms"`, so no run of twelve digits can occur in a duration. Wall-clock and machine-dependent: recorded, not asserted. | `pnpm bench:ts-codec-paired` (needs `node --expose-gc`; expected, not yet measured, at about 90 minutes for one pass of 31 rounds on an idle machine (the first pass took 41 for the reads and the write path; the per-operation cells are 80 warmed cells at about 0.35 s over three subjects and 31 rounds, about 43); `--reads`, `--write`, `--ops` run one part, `--only=<a>|<b>` keeps the read cells containing either text, `--only-ops=<text>` the per-operation cells, `--gate` judges the file without measuring); environment `PAIRED_BASE`, `PAIRED_WORKDIR`, `PAIRED_RESULTS`, `PAIRED_RETAKES`, `PAIRED_ROUNDS` (at least 31), `PAIRED_ANY_LOAD=1`, `PAIRED_SMOKE=1` (a few rounds at a tiny scale through the whole pipeline into the scratch file `PAIRED_RESULTS` names; the gate refuses such a pass) | `ts-codec-paired-results.json`, every pass, each with every round of every figure (`[order, base, head, control, loadAtStart, loadAtEnd]`, schema 2; the first pass is recorded under the earlier rule and its older layout), the rounds set aside for load or as slept (the latter with their evidence), and the medians, intervals and verdicts computed from them, the base and head commits, the machine and the tree's state | `pnpm bench:ts-codec-paired:check` runs every part once at a tiny scale and fails only if the output is malformed or the subjects disagree on an answer; it needs the history to extract the base and compares no duration with any bound, and CI runs it after the build, beside the other benches' checks. `tests/bench/ts-codec-paired-verdict.test.ts` holds the rule, the gate and the load rule to their boundaries and the committed file to the rule each pass records, and `tests/bench/codec-ops.test.ts` holds the per-operation cells to their list and to one answer on both codecs |
| `count-kernels.cjs` | Each counting operation of the TypeScript codec's bitmap (`andCardinality`, `orCardinality`, `andNotCardinality`, `xorCardinality`, `intersects`, `isSubset` true and false, `isEqual`) against the work it replaces: building the combination with the in-place operations and taking its size (the xor's baseline is composed of the three in-place operations, because the codec has no in-place xor). Cells are `<group> <operation>` over eight groups: the five data sets of `lib/codec-data.cjs` (dense, sparse, runs, mixed, spread8k, each as segments 0 and 1), eight values against one chunk of 150 runs (the per-value run search), and two disjoint pairs (evens against odds over 1,000 values, and 1,000 each in 256 chunks) that only `andCardinality` and `intersects` are timed on. It is the paired comparison of `ts-codec-paired.cjs` with other subjects: the build, the count, and the build again as the control, one subject per process, in an order rotating through the six permutations, 31 rounds, judged by `lib/paired-verdict.cjs` (bar 2%, the control within 2%), with its load rule and its sleep rule applied by the same code. A count is kept only if it is `faster than the bar` on every group (`lib/count-cells.cjs`, `decisionsOf`); `--gate` prints each operation's decision. It does not judge the store's hot paths: that is `ts-codec-paired.cjs` against the same commit. Each run appends a pass to the results file, never replacing an earlier one, and takes a pass with an inconclusive cell again (`COUNT_RETAKES`, default 2). Wall-clock and machine-dependent: recorded, not asserted. Expected, not yet measured: about 45 minutes for one pass on an idle machine. | `pnpm bench:count-kernels` (needs `node --expose-gc`, which the script passes); `--only=<a>\|<b>` keeps the cells containing either text, `--gate` judges the file without measuring; environment `COUNT_RESULTS`, `COUNT_ROUNDS` (at least 31), `COUNT_RETAKES`, `COUNT_ANY_LOAD=1`, `COUNT_SMOKE=1` (3 rounds at a tiny scale into the scratch file `COUNT_RESULTS` names; the gate refuses such a pass) | `count-kernels-results.json` (written by the run; not yet recorded), every pass, each with every round of every cell and its verdict | yes: `pnpm bench:count-kernels:check` runs every cell once at a tiny scale and fails if a count differs from the build or a cell is missing; it times nothing against any bound. `tests/bench/count-kernels-cells.test.ts` holds the cell list, the stop rule and, once committed, the record to the rule |
| `bitmap-api.cjs` | The public `RoaringBitmap` class (imported from `@cloudbitmaps/roaring`) against the pinned `roaring` package and, where the codec has a counterpart, the codec's own call, on dense, sparse, runs, mixed and spread8k: build (array, `Uint32Array`, `addMany`, per-id `add`), `has`, the four combines returning and in place, the first operand's next write after a returning `or`, `xor` or `andNot`, `andCardinality`, `orCardinality`, `isSubset`, `isEqual`, `intersects`, `serialize`, `deserialize`, `runOptimize`, iteration, `toUint32Array`, `toArray`, `orMany` of 8 and 64, `clone` and a write after it, the first call of a fresh process, and `store.load(ref, { bitmap })` against the serialize and checked decode it makes. One subject per process, four per round (the package, the class, the class again as the A/A control, the codec), rotated orders, 31 rounds, the paired bench's load rule and sleep rule from `lib/paired-verdict.cjs`. A figure is the median of the class's time over the package's in the same round with its 95% interval; the control must be within 2% or the table marks the cell. The count cells: `andCardinality` and `orCardinality` against the package and against build-then-count (the codec's combine, then its size), and `isSubset` and `isEqual` (both answering true, a full scan) and `intersects` against the package, on a pair that meets at its first shared container and on a disjoint pair that is walked in full. Whether the count kernels ship is the count bench's decision (`count-kernels.cjs --gate` ends with `RESULT kept` or `RESULT derived`), read and never recomputed here: a pass records the route the build ran (`environment.countRoute`) and the decision it was taken under (`environment.countResult`), and the gate refuses a pass whose route is not that decision's. Every sleep and load rule is the paired bench's, applied to the load part as well. A pass is complete only when it holds every cell of the full run; a pass from `--only`, a part of the run or a smoke run is marked `partial`, is kept, and is never the pass the table or the stop rules are judged on (the gate exits 5 when the record holds passes and none is complete). Each run appends a pass, never replacing one. Wall-clock and machine-dependent: recorded, not asserted. Expected, not yet measured: about 70 minutes for one pass. | `pnpm bench:bitmap-api` (builds first; `node --expose-gc`); `--steady`, `--cold`, `--load` run one part (a partial pass), `--only=<a>\|<b>` (a partial pass), `--gate` (exit 4 for a problem, 5 when no pass is complete); environment `BITMAP_API_RESULTS`, `BITMAP_API_ROUNDS` (at least 31), `BITMAP_API_RETAKES`, `BITMAP_API_ANY_LOAD=1`, `BITMAP_API_SMOKE=1` (a few rounds at a tiny scale into the scratch file `BITMAP_API_RESULTS` names; the gate refuses such a pass) | `bitmap-api-results.json`, every pass with every round of every cell | yes: `pnpm bench:bitmap-api:check` runs every cell once at a tiny scale from the built package and fails if the output is malformed or the subjects disagree; `tests/bench/bitmap-api-cells.test.ts` holds the cells to one answer on all three subjects |
| `calibrate-aws.cjs` | Against a **real** object store: load throughput (single-part and multipart), cold intersect latency, and what a single-bucket topology actually costs per request. It spends money — see [below](#real-cloud-calibration). | `pnpm calibrate:aws` | one evidence file per finished real run, `calibration/<runId>.json`; a real run that does not finish writes `calibration/<runId>.partial.json`, and a rehearsal `calibrate-aws-rehearsal.json`, both of which git ignores. `--suite large` writes the same three kinds of file for the [large suite](#the-large-suite), its evidence under `calibration/large/` and its rehearsal to `calibrate-aws-rehearsal-large.json` | its guards, via `tests/bench/calibrate-guards.test.ts`, and how it discards a sample that meets a transient fault, via `tests/bench/calibrate-samples.test.ts` |
| `calibrate-cloudshell.sh` | The same calibration, run from AWS CloudShell inside the region, against the **published** packages installed from npm; with `CR_CALIBRATE_CODEC=native` or `typescript`, against stores bundled from the clone's own sources with the store package's internal codec switch set to that codec ([how](#the-codec-comparison-in-region)). | `bash bench/calibrate-cloudshell.sh` | `~/<runId>.json` in CloudShell, which belongs in `calibration/`, or `~/<runId>.partial.json` for a run that did not finish; the large suite's land in `~/bench/calibration/large/` and belong in `calibration/large/` | no |
| `check-elasticache-prices.cjs` | Holds the estimator's on-demand catalogue, and the reserved prices `sizing.cjs` prices Redis with, to a downloaded AWS price list, node by node and on each node's full key. | `node bench/check-elasticache-prices.cjs <offer.json>`, by hand whenever the cited price list version moves | nothing: it exits non-zero, naming every node that disagrees | no: it needs the price list, a 2 MB download from AWS. CI tests its reader, `tests/bench/elasticache-prices.test.ts` |

## The results files, and what reads them

Each is committed and regenerated only by its harness. The last column says what checks each one — and where a
figure is published from it with no check behind it, the row says that too.

| file | written by | read by |
|---|---|---|
| `results.json` | `run.cjs` | `scripts/site-figures.cjs`, which checks the site's money figures against it |
| `range-counts.json` | `range-counts.cjs` | `sizing.cjs`, which prices a cold intersect at the range requests it holds for each deployment's chunks, and `pnpm bench:range-counts:check`. Counted from the engine, not measured on a cloud |
| `materialize-many-counts.json` | `materialize-many-counts.cjs` | `tests/docs/materialize-many-figures.test.ts`, which holds the guide's and the changelog's figures for a refresh-shaped batch to it. Counted from the library, not measured on a cloud |
| `expected-figures.json` | `expected-figures.cjs` | `scripts/site-figures.cjs`, which holds the pages to these figures and reads the file, so the tests and the site gate need no build, and `pnpm bench:expected-figures:check`. Expected, not measured |
| `bill-as-data-grows.svg`, `where-each-costs-less.svg` | `sizing.cjs` | `docs/guide/why-cloudbitmaps.md`, as images, for readers in the light theme. `pnpm bench:sizing:check` compares each with what `sizing.cjs` draws now, byte for byte, like the page's generated regions, so a chart cannot drift from the estimator |
| `bill-as-data-grows-dark.svg`, `where-each-costs-less-dark.svg` | `sizing.cjs` | the same page, through `<picture>`, for readers in the dark theme: the same charts in the dark palette, checked the same way |
| `crossover.svg` | `run.cjs` | `docs/benchmarks.md`, as an image. The site does **not** read this file: `run.cjs` inlines its own copy of the chart into `site/benchmarks.html`, where the page's colour tokens resolve so the chart follows light and dark |
| `scale-results.json` | `scale.cjs` | `scripts/site-replay.cjs`, which holds `demo.html`'s figures to it, and `scale.cjs` itself: `pnpm bench:scale:render` renders the at-scale table in `docs/benchmarks.md` and `site/benchmarks.html` from it, and `pnpm bench:scale:check` fails in CI if either copy is not what it renders |
| `ts-codec-results.json` | `ts-codec.cjs` | nothing: wall-clock, recorded, not asserted (`pnpm bench:ts-codec:check` runs the operations, not this file) |
| `ts-codec-paired-results.json` | `ts-codec-paired.cjs --all` | `tests/bench/ts-codec-paired-verdict.test.ts`, which recomputes every median, interval and verdict of every pass from its rounds by the rule the pass records, and applies the gate to every pass: a conclusive slower in any pass, a kept round that ended at a load of 6 or more, or a cell left open in the last pass without a note quoting its bound fails it. Wall-clock, recorded, not asserted. The first pass also holds an `import` block, which timed the module load and an esbuild bundle of the class from the flavor's separate `./bitmap` entry against the main entry; that entry has since been removed, so the cell no longer runs and the block is kept as the record of that pass |
| `bitmap-api-results.json` | `bitmap-api.cjs --all` | `tests/bench/bitmap-api-table.test.ts`, which applies the gate to every pass (every stored figure recomputed from its rounds, the load rule, the round floor, the sleep rule, the cell inventory, the route against the count bench's decision) and holds the generated regions of the API reference and the codec page to the record (a figure, the commit, the Node version, the round count, the load line, the words "close to native" in every spelling on every public page, and every method above 10 times native, the cold rows included). Each of those checks is fired at a planted lying record or page. While it holds no complete pass the pages say the table is not measured |
| `ts-codec-comparison-results.json` | `ts-codec-engine.cjs --all` | `ts-codec-comparison.md`, written by hand from it: every figure there is labelled measured, derived or expected. `tests/bench/ts-codec-verdict.test.ts` recomputes every median, quartile and verdict in the file from the rounds beside it, and looks every figure of every table of the report, its module-load sentence and its per-kind memory differences up in it. Wall-clock, recorded, not asserted |
| `ts-codec-comparison.md` | by hand, from `ts-codec-comparison-results.json` and `ts-codec-results.json` | nothing: the report for the decision on switching codecs, every figure labelled measured, derived or expected, with the machine, the load and the commit, and the rows the gate cannot judge yet |
| `bitmap-api-table.cjs` | the "against native" regions of `docs/guide/api-reference.md` and `docs/guide/roaring-codec.md`, between `BITMAP_API:TABLE` markers, from `bitmap-api-results.json` (`pnpm bench:bitmap-api:table`; `--check` in CI; it reads the count bench's decision live, scans every public page for the phrase, and exits 5 when no pass is complete) | `tests/bench/bitmap-api-table.test.ts` |
| `ts-codec-results-before.json` | `ts-codec.cjs` with `TS_CODEC_SRC_DIR` | nothing: the same bench run on the TypeScript codec of the parent branch (58fd21c2), the "before" column of the speed-up table |
| `soak-results.json` | `soak.cjs` | `scripts/site-figures.cjs`, against the combine count and external-memory creep `site/benchmarks.html` quotes |
| `event-loop-results.json` | `event-loop.cjs` | `event-loop.cjs --check`, against the guide's "What blocks the event loop, and where to run it" section and the figures quoted in `packages/core/src/core/cooperative.ts` and `packages/roaring/src/system-clock.ts` |
| `resolution-heap-results.json` | `resolution-heap.cjs` | `sizing.cjs`, which publishes the range of its heap-to-counted multiples, and the Node version that measured them, in the `SIZING:RESOLUTIONS` region of `docs/guide/sizing.md`, and `pnpm bench:sizing:check`, which holds the page to it. Measured, not derived |
| `encoding-results.json` | `encoding.cjs` | `scripts/site-figures.cjs`, against the sizes `site/flavors/roaring.html` quotes |
| `rss-gate-results.json` | `scripts/rss-gate.sh` | `scripts/site-figures.cjs` — the hard RSS ceiling on the benchmarks page |
| `calibration/` | `calibrate-aws.cjs`: one evidence file per real run, beside that run's report. The directory has [its own README](calibration/README.md), which lists every run; the large suite's runs live in `calibration/large/`, which has [one of its own](calibration/large/README.md) and which these gates do not read | `tests/docs/calibration-reports.test.ts`, against each run's report and the benchmarks page's section on the latest run; `scripts/site-figures.cjs`, against the site's single-bucket figures |

A rehearsal writes `calibrate-aws-rehearsal.json` instead, which git ignores — it has the same shape as a real
run's file, so under an evidence name it would be one `git add` from being committed as the evidence.
Both write every fractional number to nine decimals: below a nanosecond for a time in milliseconds and a billionth of
a dollar for a cost. A ratio's binary tail runs to 17 digits, and one of exactly 12 is a run the leak scan refuses.

## Real-cloud calibration

`calibrate-aws.cjs`'s default suite measures three things that need a real object store rather than local disk; its
[large suite](#the-large-suite) measures combines at larger sizes. The benchmarks page publishes the default suite's three:

1. **Load throughput** — ids/s and bytes/s into a bucket through `store.load()`, the whole write path, for
   objects that fit one PUT and objects large enough to upload multipart. **Paid** by the in-region run,
   [`2026-10-13-b329d`](calibration/2026-10-13-b329d.md), from AWS CloudShell in `us-east-1`, on the published `0.21.0`.
2. **Cold intersect latency** — wall-clock for a chunk-skipping `A ∩ B` that has to fetch from the object store.
   **Paid** by the same in-region run, [`2026-10-13-b329d`](calibration/2026-10-13-b329d.md).
3. **The single-bucket bill** — the registry pointer lives in the same bucket as the data, so resolving a
   generation costs an object GET and advancing one costs a conditional PUT. **Paid** by the same in-region run,
   [`2026-10-13-b329d`](calibration/2026-10-13-b329d.md). Every run, with its report, is listed in
   [`calibration/`](calibration/README.md). A request count, and so the bill for
   requests, does not depend on where the client is, with one exception: an intersect
   slower than the pointer refresh reads each pointer again. The harness's timed store turns the pointer refresh
   off (`cache.genTtlMs: 0`). Bytes read out of the region are billed as transfer, which the harness counts and
   does not price.

### The stages

A run is a sequence of stages. Each records the requests it made, by class and by kind of read, beside the bound the
projection gave it and the exact count the engine is expected to make when nothing races it, from the layout alone
(`lib/calibrate-stages.cjs` holds both). A stage that misses its expected count says so on the console and in the
file under `expectedMissed`, and the run carries on, because a count that differs is a finding.

| stage | what it does | requests it is expected to make |
|---|---|---|
| `load` | 20 single-part and 5 multipart (two-part) loads through `store.load()`, each recording its own requests | per segment's first load: 2 PUT-class and 3 GET; a multipart object swaps its PUT for a create, its parts and a complete |
| `intersect` | 40 cold intersects over the calibration layout (100 shared chunks packed at keys 0 to 99), each on a fresh store | 4 + 2r GET each: both pointers, both tails, and r chunk range requests from each operand, where r is what the engine makes of the layout, counted by running it over the in-memory backend (`lib/range-counts.cjs`) before anything is created |
| `spread` | 10 segments of the same overlap with the shared chunks spread uniformly over each segment's chunks from a fixed seed, and 40 cold intersects | the same 4 + 2r, with r counted for this layout, so a difference in latency is the layout's |
| `sweep` | segments sharing 1,000 chunks (10 intersects) and 2,000 (5), `CR_CALIBRATE_SWEEP` to change the list | 4 + 2r each, with r counted for each k |
| `warm` | the calibration pairs again on one store that trusts its pointers and holds every chunk it read; a priming pass first | the priming pass reads each segment once (a pointer, a tail, the shared chunks); a warm intersect makes none, **and a stage in which one does fails** |
| `pointReads` | three phases, each with its own count and the store it ran on: `count()` on 10 segments (a first read); `has()` of one id in every shared chunk of each, on the store `count()` resolved, each segment opened first (no chunk cached); and the same pairs once more, each on a fresh store (a first read); then the open-segment reads repeated warm | `count()` first read: a pointer, exactly 1; each segment opened by a `has()` that reads no chunk: one tail read; `has()` on an open segment: exactly one chunk read; `has()` first read: a pointer, a tail and a chunk, exactly 3; warm: none, which fails the stage if not. A cold phase that differs is recorded under `expectedMissed` and the run carries on |
| `andNot` | 10 calls of one calibration segment against 10 others, each on a fresh store | 2 + 2 x 10 + the chunk range requests the engine makes of the include operand and of each exclude where it overlaps it, counted by running the call over the in-memory backend |
| `steadyLoad` | 18 loads of one small segment (1,000 ids, different each generation) through `store.load()` at `keep: 12`, each recording its own requests by class (PUT, GET, HEAD, LIST, DELETE), its bytes and its time | by kind of load, S3's request shape: the first load 2 PUT-class + 3 GET; the loads up to generation 12, which collect nothing, 2 + 2; a load that deletes by name 2 + 5 and a delete (8 requests); the load at generation 16, which lists, 3 + 6 and a delete (10). Before it creates anything the harness runs the installed engine in memory to see whether its load reads the pointer after its collection's last delete, and records the answer as `measured.readsRowAfterCollect`; an engine that does not is held to one GET fewer for each load that collects, and so is evidence with no answer, written by a harness that held its loads to those counts. A load that differs fills `expectedMissed`. The stage runs last |

**Depth.** A count of requests does not say how many ran at once, so the meter also keeps the requests in flight, their
peak, and the sum of every request's own time (sent to answered; a request is timed to its headers, so a chunk is about
the whole request and the 256 KiB tail is without its body). Each cold intersect and each `andNot` call starts its peak
afresh and records `peakInFlight`, `meanInFlight` (the summed request time over the wall time) and `rounds`: its
requests times its wall time over the summed request time, which is how many it waited for one after another. The stage
record carries their medians as `medianPeakInFlight`, `medianMeanInFlight` and `medianRounds`, beside `modelRounds`, the
engine's model of 2 + the rounds a window that opens 4 ranges wide and widens to 32 takes over r ranges (`windowRounds`
in `lib/calibrate-stages.cjs`, stepped at an even latency from the engine's two constants), for a pointer, a tail and
the window. A peak of 64 is the full window, 32 range requests held ahead of each operand; rounds above the model with a
mean in flight well under that is a slow request holding the window. In flight counts requests the library issued, including any waiting for a free socket, so a mean or a peak above the
client's sockets (`maxSockets`, which the record carries: what the run's client held, read back from its agents, 128 by default, as the library's built client has) means requests queued, a wait the rounds model, which assumes no limit, does not count.
The run of 2026-10-13 held at most 11 requests in flight against 128 sockets, and its rounds sit above the model.

`andNot` reads every chunk of the segment it filters, as ranges, since any of them can survive, and each exclude only where it
overlaps, so what it costs scales with the include operand and not with the size of the exclude list.

### A sample that meets a transient fault is discarded, and run again

The workload's client makes one attempt per request and every timed store has its own retry off, so no retry's backoff
can sit inside a latency sample and every count stays exact. On its own, that would let one transient fault anywhere
in a run's requests (up to about 94,900 GET-class and 567 PUT-class at the default workload) fail the whole run, and a
partial run is not evidence. One in-region run failed on a single transient connection fault after about 86,300
requests; at that rate a run of this size would finish about a third of the time. So a **sample** that fails with a
transient fault is **discarded**, never retried inside ([`lib/calibrate-samples.cjs`](lib/calibrate-samples.cjs)):

- **What a sample is.** One cold intersect (in `intersect`, `spread` and `sweep`), the warm stage's priming pass, one
  cold point read (`count()` as a first read, `has()` on a store that has resolved the segment, `has()` as a first read), and one `andNot`
  call. A warm read makes no request, so it cannot meet a fault, and one that does make a request fails its stage.
- **What a load is not.** A load is never discarded: a write that failed transiently may still have landed, its object
  or its pointer with only the answer lost, so the same load run again is a reload, which makes more requests than the
  first load the projection bounds. A load that meets a transient fault fails the run. The loads are
  about half a percent of a run's requests.
- **What counts as transient.** The library's `TransientError`, which the S3 driver raises for a throttle, a 5xx or a
  dropped or timed-out connection, or anything the installed SDK's own retry would have retried (its
  `isThrottlingError`, `isTransientError` and `isServerError`), anywhere in the error's causes. That takes in every
  5xx, 501 included, and a 403 refusing a skewed clock that the SDK has corrected, both of which the SDK retries
  itself. Never a wrong answer, another 403, a 404, an integrity failure, or the interrupt gate refusing a send.
- **Discarded whole, then run again from the start.** The failed attempt is abandoned. Its other requests still
  answer, since a cold intersect keeps its window of chunk reads in flight, so the harness waits until nothing is in
  flight and nothing new has been sent for a second, and counts all of it against the discard; a request still
  unanswered after 30 s fails the run. The wait watches a request until its headers arrive, not its body, so a body
  that stalls past the second lets the failed sample's next reads land in the sample run again; that sample then
  misses its expected count, and the run is refused as evidence rather than publishing a wrong figure. The sample then
  runs from the start, from a state the failed attempt left nothing cached in: a cold intersect, a first read, an
  `andNot` call and the priming pass on a store of their own, a first `count()` on its store after telling the store to
  forget that segment, and a `has()` on an open segment on the same store, which the failed chunk read left with the
  segment open and nothing cached. A test holds each re-run to the requests of the read it replaced.
- **Bounded.** At most three discards a run and two a stage. One more transient fault fails the run, with the fault
  under `error`.
- **Projected.** The projection allows three discarded samples, each at the bound of the costliest sample the run
  makes: at the default workload, a cold intersect sharing 2,000 chunks, 4,006 GET-class. The finished run holds each
  stage's kept samples to its bound and the discards together to that allowance.
- **Recorded.** Each stage's `discarded` lists its discards: which sample (`of`, `sample`), the error's `name`, the
  `cause` at the bottom of it, the transport `code` beneath it, the SDK's `attempts` and `httpStatus` where it has them,
  its message, how long the attempt ran, and the `requests` it made. Those requests are in the stage's `requests` and
  in the bill, since they were billed, and out of what the stage is held to: its expected count is checked against
  its requests less its discards'. The console says `DISCARDED` for each. The run records `discards`, its count and
  its bounds, and a stage a failure cut short under `discards.unfinished`. The run's `error` records a fault the same
  way: the SDK's HTTP handler gives a request error whose code is `ECONNRESET`, `EPIPE` or `ETIMEDOUT` one name, its
  timeout error's, and the code kept under the rename is what says which it was.
- **And the figures.** `lib/calibration-figures.cjs` treats a run with discards within the harness's bounds as
  evidence. Every latency and request-count figure comes from the samples each stage kept, held to its expected count
  exactly; the bill counts the discarded samples too, since they were billed. The run's report has to state how many
  it discarded (`N discarded samples`), and the count it states is held to the evidence. A run that met more faults
  than the bounds allow did not finish, and is refused like any partial run.

A rehearsal can show it: `CR_CALIBRATE_FAULT_GETS=1200,40000 pnpm calibrate:aws --rehearse` fails the 1,200th and the
40,000th GetObject the workload's client sends, once each, as a reset socket fails one, and `1200:denied` fails it as a
403 instead, which is not transient and fails the run. The harness refuses the variable in every other mode, and the
rehearsal's file lists each request it failed, and how, under `injectedFaults`. The integration lane runs the
harness through such a rehearsal on a small workload (`tests/integration/calibrate-rehearsal.test.ts`), so it needs
the packages built.

### It spends money, so it is hard to run by accident

| mode | what it does |
|---|---|
| `pnpm calibrate:aws` | **Projection only.** Prints the worst-case request count and dollar cost. Touches nothing, reads no credentials. |
| `pnpm calibrate:aws --rehearse` | The workload, the metering, teardown and signal handling, against the MinIO in `docker-compose.yml` (`docker compose up -d minio`). Free — and so none of the money guards run. `CR_CALIBRATE_FAULT_GETS` fails the GetObject requests it lists once each, to rehearse a discard. |
| `pnpm calibrate:aws --run` | The real thing. Refuses unless the region, a spend ceiling and a typed confirmation are each set. |
| `pnpm calibrate:aws [--rehearse] --cleanup <runId>` | Removes a run's bucket after a kill that nothing could catch. It checks the account pin as a run does, and refuses a bucket holding anything the harness did not write. |

A real run needs, separately:

```
CR_CALIBRATE_REGION=us-east-1          # never guessed, and us-east-1 only: the one region it has prices for
CR_CALIBRATE_MAX_USD=0.05              # checked before the run AND during it
CR_CALIBRATE_CONFIRM=yes-spend-money   # a typo must not spend money
CR_CALIBRATE_EXPECT_ACCOUNT=<12 digits> # optional: refuses to run in any other account
```

It then prints the account — **last four digits only**, enough to recognise, not enough to be worth pasting — and
waits ten seconds so you can Ctrl-C before anything is created. The default workload's projection, which is an upper
bound, is under four and three-fifths cents with every discard it allows, so a ceiling of five cents holds it; `pnpm
calibrate:aws` prints each stage's bound, the allowance for discards and the total before anything is created.

### The guards

Most live in [`lib/calibrate-guards.cjs`](lib/calibrate-guards.cjs) as pure functions, each with a test that
plants the bug it exists for and fails unless the guard stops it; teardown's pass and page bounds are held by their
constants and the source text:

- **The spend ceiling is validated before it is compared.** `Number('abc')` is `NaN`, and every comparison
  against `NaN` is false — so a malformed ceiling, compared as it comes, silently *removes* the bound.
- **An explicit `0` means zero.** A helper that maps a falsy size to the default hands someone shrinking a run the
  full workload.
- **Only a clean 404 means "the bucket does not exist".** `HeadBucket` answers **403** for a bucket you own but
  cannot list, and in `us-east-1` `CreateBucket` on a bucket you already own returns **200 OK** — so reading 403
  as absent would run the workload inside a real bucket of yours and then delete it on teardown.
- **The projection covers every stage, and every run checks each one.** One table (`STAGES`) names the stages and one
  function bounds each, and a test fails when the harness runs a stage the table does not name, or the table names one
  the harness never runs, so a stage cannot spend money the ceiling never saw. The finished run is held to each
  stage's bound as well as to the total, so a stage that overspent is named. It counts both operands of an intersect, and
  its retry bound must match the publish loop in `packages/core/src/core/publish.ts`: a test reads the loop's number out of the source and
  fails if they differ, because a retyped number can be wrong. A load, `store.load()` of a new segment, checks that its
  generation number is free and lists nothing when it is, since it has nothing to collect (up to twice when the check
  finds the number taken, to number past the object and to collect, and once more it writes the row to record the window
  it kept; on S3 a listing and that write bill at the PUT rate), and reads
  the pointer twice with nothing racing it, up to six when the check finds the number taken, twice more for each publish
  attempt it loses, and fifteen times at most (fourteen at the default `keep` over two strays, fifteen at `keep: 0`, which
  deletes both): sixteen GET-class requests with the check, the bound the projection uses. A test drives each count through the real registry code, so a projection allowing one
  read per attempt fails it. The workload's client makes one attempt per request, and every attempt teardown's client
  may make is allowed for, so no SDK retry can fall outside it either. A sample discarded after a transient fault was
  billed too, so the projection allows every discard a run may make, at the costliest sample's bound, and a plan that
  names no bound on discards is refused rather than projected without them. After teardown, the run compares what it
  actually issued against what it projected, each stage's kept samples against its bound and its discards against the
  allowance, and flags itself if it went over.
- **A segment is loaded once.** The projection bounds a segment's first load. A reload of a row with a summary
  opens nothing and makes at most six GET-class requests under four lost races, and at most eight when it collects, inside that bound;
  one of a row with none that also lists to collect also opens the current generation's index, and makes at most eleven. The harness claims each name before it loads (`firstLoads`) and
  refuses a repeat before sending anything. The steady-load stage claims its one segment for its first load and loads it
  again through the same helper, each later load bounded as a load is.
- **The steady-load stage needs an engine that collects by name.** At `keep: 12` a load collects by name, and an
  engine that lists on every load makes other requests, so a run on it would spend its bill and then fail its own
  evidence. Before anything is created the harness loads 17 generations over the in-memory backend
  (`collectsByName`, `lib/range-counts.cjs`) and refuses, exit code 2, an installed library that does not delete by name
  once the window is full, list on the 16th generation and nothing else. The check reads what the engine does, not its
  version string, so a rehearsal of this checkout passes before the release is cut.
- **A warm read that makes a request fails the stage.** Its count is not recorded and compared afterwards: the stage
  throws, the run keeps what it had finished and exits non-zero. Each warm store trusts its pointer for an hour and
  holds more chunks than the default cache, so the zero depends on neither the clock nor the cache size.
- **Evidence is write-once.** A real run's results go to a file named by its run id, and the harness refuses —
  before it reads any credentials, and before it even loads the library — to overwrite one that exists: a second
  run under a published run's id would replace the file its figures are checked against. The id is checked before
  anything uses it, because it names the bucket and the file: a real date, then a label, with none of the suffixes
  S3 keeps for its own kinds of bucket. Nothing is replaced at the end either: a run whose file appeared while it
  ran, or a retry whose partial name is taken, writes `<runId>.<start>.partial.json` beside it and says so.
- **The workload fits one teardown listing.** Teardown lists 1,000 object versions a pass and each segment leaves
  two, so a run loads at most 500 segments, counting every stage's. A run of 1,510 segments would leave 20 versions behind after three passes.
- **Teardown empties only a bucket the harness made.** It aborts every upload and deletes every version of every key
  it lists, and `--cleanup` points it at a bucket by name. So before it touches anything it lists every upload and
  every page of versions, up to ten pages, and refuses and reports a bucket holding any key outside `calib/`, the
  store's prefix, rather than empty it. `--cleanup` checks `CR_CALIBRATE_EXPECT_ACCOUNT` as a run does.
- **Teardown cannot hang.** Its requests time out, 5 s to connect and 30 s to answer, and are retried; the SDK waits
  for ever by default. The workload's requests have no timeout, since a timed request must not be cut short: its
  client sets none, and its store is built with `readTimeoutMs: 0`, stated rather than left to the S3 package's
  default, so a change of that default cannot add one.
- **It runs only where it has prices.** Every run is priced at `us-east-1`'s rates, so a run anywhere else would
  record the wrong bill and check its ceiling against the wrong one. It is refused until a pricing profile for that
  region exists.
- **Error text is redacted.** AWS puts the caller's ARN, account id and all, in an AccessDenied message, so ARNs are
  removed and account ids masked in everything the harness prints and records.
- **Only `NoSuchBucket` means teardown has nothing left to remove.** An abort retried after its first answer was
  lost gets back a 404 `NoSuchUpload`, so a teardown that read *any* 404 as "already gone" would skip deleting the
  objects and the bucket, and report nothing. An abort that finds its upload gone is simply done, and only S3's own
  `NoSuchBucket` counts as removed.
- **Teardown's delete passes are bounded.** `DeleteObjects` reports a key it could not delete inside a 200, where no
  retry sees it, so a key that can never be deleted would keep an unbounded listing loop running — and billing.
  After three passes, what is left is reported as a leftover, and the projection covers every listing those passes
  make.

**Ctrl-C stops the work, then tears down.** A signal handler replaces Node's default exit, so a handler that only
logs leaves the workload running. This one first stops the workload's client, so every later request fails before it
is sent, and waits up to 30 s for the requests already sent to answer (`interruptGate` and `stopThenTearDown`, in
[`lib/calibrate-process.cjs`](lib/calibrate-process.cjs)). Only then does it tear down: a teardown that lists the
bucket while loads are still writing leaves the bucket behind, because a PUT that lands after the listing is not in
it. Waiting also lets a `CreateBucket` still in flight land before teardown looks for the bucket; if a request is
still unanswered after 30 s, teardown goes ahead, and a bucket it then cannot find is reported as one that may yet
appear, with the `--cleanup` line. The handler writes the results, every phase it had finished and the cost, marked
`interrupted`, with anything teardown left under `leftovers`, and a request that failed meanwhile under `error`. It
exits 130, unless the workload had finished and only teardown was left, when the run keeps its own exit code. A
second signal warns instead of killing the process mid-delete. The handler is armed before the bucket is created, so
an interrupt during creation tears down too, and a signal during `--cleanup` waits for the cleanup it interrupts.

A hang-up (a closed terminal, a dropped session) is handled the same way, with one more step. Node opens its
stdout and stderr on first use, and on macOS opening one on a terminal that has hung up never returns. A handler
whose first line of output is stderr's first use blocks there, before any teardown, so the harness opens both
streams at startup and writes nothing more to a terminal once it hangs up. Output to a pipe or a file carries on,
since a log still has a reader. The harness stops on a hang-up by design, `nohup` included, so to keep a run going
after the terminal closes, run it inside `tmux` or `screen`. A supervisor that sends SIGKILL soon after SIGTERM, as
`docker stop` does after 10 s, can kill it during the 30 s wait; give it longer, or run `--cleanup` afterwards.

The gate is tested against a local server that answers slowly, the stop-drain-teardown order with stand-ins, the
hang-up on a real pseudo-terminal that is then closed, and the whole path by interrupting rehearsals. Each ended with the bucket gone and the results written: eleven interrupted during the loads, three during the intersects, four by closing the terminal, and a cleanup interrupted mid-delete, which finished and exited 130. A cleanup was also pointed at a bucket holding someone else's upload, and at one whose foreign key sat on a second page of 1,002 objects; each was refused with nothing touched.

### What a run records, so its numbers cannot be misread

- **How far away the client was.** Ten trivial requests give a round-trip floor, recorded raw and labelled
  `in-region` below 30 ms or `REMOTE — latency below is network-dominated` above it (a rehearsal says `local
  container`). From outside the region, latency measures the internet. The line keeps another continent out, not
  a neighbouring region, so the raw floor is kept for a reader who wants a stricter one.
- **Every attempt, and only one per request.** The meter counts each attempt the SDK makes, retries included.
  The workload's client is pinned to a single attempt, and the timed intersects run with the store's own read
  retry off — so the request count is exact, and no retry's backoff hides inside a latency sample. A sample that
  meets a transient fault is not retried either: it is discarded whole and run again
  ([above](#a-sample-that-meets-a-transient-fault-is-discarded-and-run-again)), and a fault past the bound, or in a
  load, fails the run, keeping every phase it had finished. The latency figures are therefore from fault-free
  samples: on that path they match what a consumer with default settings sees, whose worst case adds up to three SDK
  attempts for each of the store's four, with backoff. Teardown and `--cleanup` keep the SDK's retries, on a second
  client metered into the same bill: a transient failure there would otherwise leave the bucket behind.
- **Cold reads only, and a count the network cannot move.** Each intersect gets a fresh store, so no cache can
  answer it, and the store's timed pointer refresh is off (`cache.genTtlMs: 0`). On the default 2 s refresh, an
  intersect slower than that reads each pointer again, which adds GETs to the 6 an intersect of this shape makes,
  so a count taken on the default would describe the network. A test drives the real engine on a slow clock to prove each pointer is read once.
- **Exact content.** Every pair of segments shares a planned set of ids, so each intersect must return precisely
  that set — the count *and* the sum — or the run refuses to report a latency.
- **The published shape.** 500,000-id segments spanning ~2,000 chunks with 100 shared, so the run tests the "100
  of 2,000 chunks" claim itself; plus dense segments of ~12 MiB so multipart is actually exercised.
- **Each stage's own requests, and each load's.** A load makes pointer reads that the meter files with an intersect's,
  so a run's totals cannot be divided between stages afterwards. Every stage records its requests as it makes them,
  every load records its own, and `lib/calibration-figures.cjs` prices each load from its record and refuses a file
  whose stages do not add up to what was billed. It also refuses a file for what the run reports as wrong itself:
  anything teardown left behind, a missed expected count, a stage whose requests are not the ones it expected, and a
  shell that ran in another region than the bucket's. Latency is labelled in-region only when the floor is under the
  line and the shell's region is the bucket's.
- **Chunk reads and the tail read, separately.** Measured request by request, a cold intersect reads exactly 100
  chunks per operand (about 516 bytes each) plus one 256 KiB read from the end of each object, which fetches the
  footer and index in a single round trip. They are reported apart: the chunk count is the proportional part and
  the tail read is a fixed cost per operand, and a single "fraction fetched" would describe neither.
- **The SDK that sent the requests.** `measured.sdk` holds the versions of `@aws-sdk/client-s3` and of the HTTP handler
  under it, read from what is installed (a CloudShell run installs the latest and deletes the scratch directory once the
  results are copied out), with `maxSockets`, the socket limit the workload's client had, read back from its agents after
  the run, and `maxSocketsSource`, which says where it came from. The harness gives that client 128, the limit the library
  gives the client it builds (`CR_CALIBRATE_MAX_SOCKETS` overrides it: a positive integer of at most 1024; the run is refused before anything is created if the handler does not take the limit), by setting `maxSockets` on the
  SDK handler's own agents and changing nothing else about it; teardown's client keeps the SDK's default of 50. A value that
  could not be read back is `null`. Runs before the harness set it (up to run `2026-10-04-73668`) record 50, the SDK's default, as they
  ran with. The limit bounds how many requests can really be in flight: an `andNot` widens its window from 8 keys to 32 and fetches every exclude of a key in the same round as its include, so
  on its first shared keys it can want more than the limit, and its latency is read against that.
- **What it measured.** The package version, the harness commit (marked `-dirty` when the harness had uncommitted
  edits, since the commit alone would name a harness that did not run), the Node version, and how the timed stores
  were built.

### Running it in the region

```
# in AWS CloudShell, in the region being measured
git clone https://github.com/cloudbitmaps/cloudbitmaps && cd cloudbitmaps
CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.05 bash bench/calibrate-cloudshell.sh
```

The workload's client has 128 sockets, as the library's built client does; `CR_CALIBRATE_MAX_SOCKETS=<n>` sets another
limit, and the script echoes the one asked for before it installs anything.

Before it installs anything the script refuses three things: a `CR_CALIBRATE_REHEARSE` that is not unset, empty, `0` or
`1` (any other value would take the run that spends money); a shell with no `AWS_REGION`, which CloudShell exports; and
a `CR_CALIBRATE_REGION` that is not that region, since a floor under 30 ms cannot tell a neighbouring region from this
one. The shell's region is recorded with the results as `network.clientRegion`. The release measured is the one this
clone's `packages/roaring/package.json` names, which its expected counts were written for;
`CR_CALIBRATE_PACKAGE_VERSION` overrides it, and the script prints the version before it installs. Run it from a clone
of the release you are measuring: the steady-load stage is held to the counts of an engine that collects by name, and
the harness refuses an installed library that does not, before it creates anything.

The script installs Node 22 if CloudShell's is older, installs the **published** `@cloudbitmaps/roaring` and
`@cloudbitmaps/s3` into a scratch directory, with `@cloudbitmaps/tools` of the same release for the prices the run is
billed at, and runs the harness against those — so the figures describe what a consumer installs, not a build of this
checkout. A finished run's results land in `~/<runId>.json`, and an
interrupted one's in `~/<runId>.partial.json`, which is not evidence; the large suite's land under
`~/bench/calibration/large/` instead. A name already taken in `~` is left alone,
and this run's copy goes beside it with a timestamp, still a `.partial.json` if it was one. The script runs the
harness as a job of its own and passes on every signal that would stop it: a Ctrl-C, a closed CloudShell tab or a
`kill` reaches the harness exactly once, and the results are copied out only after it has stopped, with SIGPIPE
from a reader that has gone, such as a `tee`, ignored while they are. Were the harness run in the foreground, a
SIGTERM or a hang-up would stop the script at once, delete the scratch directory under the harness mid-teardown and
copy nothing, and a SIGTERM to the script alone would never reach the harness at all. A job of its own may write to
the terminal only while `tostop` is off, as it is by default, so a terminal with it set is refused before anything is installed. Commit a finished run's file as
`bench/calibration/<runId>.json` (a large-suite run's as `bench/calibration/large/<runId>.json`), with its report — [`calibration/`](calibration/README.md) says how. `CR_CALIBRATE_REHEARSE=1` runs the same install path against local MinIO, to test the script; its
results land in `~/calibrate-aws-rehearsal.json`.

### The large suite

`--suite large` (or `CR_CALIBRATE_SUITE=large`; `CR_CALIBRATE_SUITE` is `default` or `large`, and a run that names two
different suites is refused) measures combines on operands of about a million, five million and ten million ids, which
the default suite's layout cannot hold. It is a suite of its own: its own table of stages, its own bound, its own exact
expected counts and its own evidence directory, so the default suite's stages, projection, evidence and report gates are
the same whether or not this suite has ever run. The default suite's workload settings (`CR_CALIBRATE_SEGMENTS`,
`CR_CALIBRATE_READS` and the rest) are refused under it by name, since a run that ignored one would measure something
other than the setting says.

**The shapes.** Two operand segments a size, each of about 1,500 chunks, 20 % of their ids shared, laid out by
`planLayout` at the stride that gives that many chunks: `floor(1500 x 65536 / n)`, which is 98, 19 and 9.

| ids an operand | chunks | shared chunks | an operand's object | parts at 8 MiB |
|---|---|---|---|---|
| 1,000,000 | 1,497 | 300 | 2.04 MB, array containers | one PUT |
| 5,000,000 | 1,450 | 290 | 10.04 MB, array containers | 2 |
| 10,000,000 | 1,374 | 275 | 11.29 MB, bitset containers | 2 |

The object sizes are what the engine writes for those ids (counted in memory before anything is created), and the parts
follow from them. No container is a run, so a run-heavy operand is not measured.

**The stages**, in run order, each size in turn. `R` is `CR_CALIBRATE_LARGE_READS` (default 40, the published run's
count) and `I` is `CR_CALIBRATE_LARGE_INTOS` (default 5).

| stage | what it does | requests it is expected to make |
|---|---|---|
| `largeLoad` | the 6 operand segments through `store.load()` | a first load each, as the default suite's `load` stage: a multipart object swaps its PUT for a create, its parts and a complete |
| `largeIntersect` | `R` uncached intersects of the two operands, each on a fresh store | a pointer and a tail an operand and the ranges of the shared chunks: 6, 8 and 10 GET |
| `largeUnion` | `R` uncached unions | the ranges of every chunk of both operands: 8, 24 and 26 GET |
| `largeAndNot` | `R` uncached `andNot`s, one segment against one | the include's every chunk and the exclude's shared ones: 7, 16 and 18 GET |
| `largeInto` | `I` calls each of `intersectInto`, `unionInto` and `andNotInto`, on a fresh store, onto a destination segment of its own per verb | the read's GETs and the destination's load: the first call a first load, the repeats loads of a segment that has a generation, which make one request fewer. The output's parts follow its size: a union of 3.67, 18.07 and 20.32 MB is one PUT, then 3 parts; an `andNot` of 1.63, 8.03 and 9.03 MB is one PUT, one PUT, then 2 parts |

Each read is drained a chunk at a time (`batches()`), with every id counted and summed: it must be exactly the ids the
layout says. The default suite's reads are drained one id at a time (`for await`), so **the large suite's latencies are
not comparable with the default suite's**: they time a different way of consuming a stream, as well as other operands.
An `*Into` call must publish exactly the cardinality the layout says.

**Counted, not restated.** The expected counts are what the real engine makes of these layouts, counted over the
in-memory backend before anything is created (`lib/large-counts.cjs`), as the default suite counts its ranges. Each stage
is held to its exact count in both classes, PUT-class and GET-class, and a stage that differs is recorded under
`expectedMissed`. A rehearsal against MinIO runs the same loads and reads through the S3 driver, so a wrong table fails
it. At the default plan the stages are expected to make 169 PUT-class and 5,652 GET-class requests: $0.0031 at
`us-east-1` on-demand prices, with the bucket's own requests left out (**derived** from the counts; the suite's first run on S3, [`2026-10-07-88cd3`](calibration/large/2026-10-07-88cd3.json), made them exactly).

**The bound.** The ceiling is checked against the most the suite can request, which for a cold read is the pointer, the
tail and one more request an operand, and the range requests of the chunks it needs. A range is bounded by bytes, not
by chunks: two neighbouring range requests either have more than the gap between them, or would together span more than
the read cap, and a chunk is far smaller than the difference, so a read of an object of `B` bytes makes at most
`ceil(B / 256 KiB) + 1` range requests, 9, 40 and 45 for the three operands. Bounding by chunks would put the same plan
at more than twenty times the byte bound, and over the ceiling. The two constants are literal copies in
`lib/calibrate-large-stages.cjs` (neither is exported from a package, and none becomes one), each held by a test to its
source, and by the harness, before it creates anything, to the installed packages' own text (a CloudShell run measures the
published packages, which another release's constants could differ in, and is refused if they do); a property test holds the engine to the cap over random selective layouts and over layouts built to approach it,
and fails against a cap of half its size. A load's bound is the default suite's, with the parts its object can take. At
the default plan the bound is 663 PUT-class and 28,973 GET-class requests with every discard the run allows, which a
sample discarded part-way through an `*Into`'s upload is held to as well as one discarded in a read, $0.0149, and
the ceiling stays five cents. The per-sample ceiling check and the end-of-run `PROJECTION EXCEEDED` check work as they
do for the default suite.

**Rehearse it, then run it.** `node bench/calibrate-aws.cjs --suite large` prints the projection: the layouts, each
stage's bound and exact expected requests, and the bound priced. `node bench/calibrate-aws.cjs --rehearse --suite large`
runs the suite against MinIO (about a minute), writes `calibrate-aws-rehearsal-large.json`, and holds every stage to its
counts. A real run is the same command with `--run` and the guards above, or `CR_CALIBRATE_SUITE=large bash
bench/calibrate-cloudshell.sh` from CloudShell, which validates the suite name before it installs anything and copies
the evidence out of `bench/calibration/large/` to the same path under `~`, so that it is committed beside the large
suite's runs and never the default suite's. `CR_CALIBRATE_LARGE_READS` and `CR_CALIBRATE_LARGE_INTOS` size the plan.

**What the machine needs.** A rehearsal or a run prints the memory available and the disk free in the home directory
once, as `free -m` and `df -h ~` do, and refuses to start, before it imports the library or creates anything, below 768
MiB of memory or 256 MiB of disk. The harness holds no operand on disk: ids stream from a generator into the load. On a
platform with no figure for the memory available (macOS), the machine's total stands in and the line says so.
`CR_CALIBRATE_LARGE_MIN_MEMORY_MB` and `CR_CALIBRATE_LARGE_MIN_DISK_MB` raise a floor, never lower one.

**Evidence** goes under `calibration/large/`, one file a finished run, partials and rehearsals ignored by git as the
default suite's are. `evidenceFiles` and the report gates list `calibration/` without descending into it, so a large run
is never the default suite's latest evidence, and `tests/bench/calibrate-large.test.ts` holds that, and the large
evidence's own gate, which is proven on a rehearsal's file and holds each committed run, the first of which is [`2026-10-07-88cd3`](calibration/large/2026-10-07-88cd3.json).

**What it will not show.** One storage class in one region (`us-east-1`), one client, cold reads on fresh stores, and the
harness's own socket limit; array-only and bitset-only containers; one task at a time, and `keep` left at its default for
the destinations. Latencies from different CloudShell sessions are not comparable.

### What it does not measure

The default suite's scope is the three measurements above, on one workload shape. Still owed, and **not** in this harness yet:

- **The `*Into` verbs and a union at the default suite's size.** The [large suite](#the-large-suite) measures them, on
  operands of a million to ten million ids; the default suite's operands hold 500,000.
- **Other shapes of combine** — an intersect of more than two operands, or an `andNot` with a different include
  operand. This suite measures two operands, and one include operand against ten excluded.
- **Lambda.** CloudShell is a long-lived shell inside the region; a function's cold start and initialisation are
  a separate figure, which needs a run from inside a function.
- **A steady load at another `keep`.** The steady-load stage runs at `keep: 12`, with a first load, 12 reloads, 4 loads that
  delete by name and one that lists; the requests at a `keep` of 1 or 64, of a multipart or an encrypted segment, are not measured.

### What the rehearsal cannot cover

MinIO is not AWS. A rehearsal proves the stages, the metering, the teardown order, the probe, the end-of-run
projection check and the signal handling. It never reaches the money guards — the region, the confirmation, the
spend ceiling and the account pin — which is why the ceiling's are pure functions with their own tests. It cannot
rehearse emptying a versioned bucket or aborting an in-flight multipart upload on a real account, and it does not
reproduce `us-east-1` answering 200 OK to `CreateBucket` on a bucket you own. Those paths first meet reality on a
real run — which is why the probe refuses anything that is not a clean 404.

### The codec comparison, in region

`CR_CALIBRATE_CODEC=native|typescript` makes `calibrate-aws.cjs` (and `lib/range-counts.cjs`, which counts what it expects) take `CloudRoaring` and `S3Storage` from one bundle of the checkout's sources with the store package's internal codec switch set, instead of the installed published packages; unset, nothing changes. `native` is the same bundle with the native codec, so a pair of runs differs by the codec and nothing else. The counts it expects (the large suite's too) and the large suite's engine-constant check come from that same bundle, so nothing is counted or checked against another engine than the one under test. Any other value is refused by `calibrate-cloudshell.sh` before it copies or installs anything. A run records the codec in `measured.codec` of its evidence file. From CloudShell, in a clone of the branch (the clone's own version is not on npm yet, so name a published release for the packages the cost model comes from):

```
export CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.05 CR_CALIBRATE_PACKAGE_VERSION=<latest published release>
CR_CALIBRATE_CODEC=native     CR_CALIBRATE_RUN_ID=codec-native-1 bash bench/calibrate-cloudshell.sh
CR_CALIBRATE_CODEC=typescript CR_CALIBRATE_RUN_ID=codec-typescript-1 bash bench/calibrate-cloudshell.sh
```

Compare the two evidence files: the request counts of every stage are identical (the harness already holds each stage to the counts the engine makes), and the latencies (`p50`, `p95`, `p99` of the cold intersects, the load throughput) side by side. A pair of runs is one sample of a noisy network: a difference smaller than the spread between two runs of the same codec is not a difference. Run the pair again, in the other order, before reading one.

## `lib/`

| file | what it is |
|---|---|
| `lib/codec-engine.cjs` | The store with a choice of Roaring codec, for the benches that compare the two: bundles the sources of the roaring facade (and the S3 driver, when asked) with esbuild into one CommonJS module, so the facade, the store package's internal codec switch and both codecs are one copy of each, sets the switch, and returns the exports. Core is inlined through the roaring package's `tsconfig.json` paths, so every package in the bundle shares one copy of it; the native addon and the cloud SDK stay external. `bundleText` is the one esbuild call, for the engine and for the single-codec modules the start-up figures load. `packageFor` is what the calibration harness calls: the installed published package when `CR_CALIBRATE_CODEC` is unset, the bundle's otherwise, and `bundledSources` the bundle's text, which the large suite's engine-constant check reads in place of the installed packages' entry files. The harness reaches the library packages only through `packageFor` (`tests/bench/calibrate-codec.test.ts` holds that by text). Bench only; no variable or export in `packages/` serves it. |
| `lib/codec-verdict.cjs` | The rule that turns the engine bench's paired rounds into a verdict (`verdictOf`, `worstOf`, `writeVerdictOf`), the medians, quartiles and signed worst, and `cellFrom`, which derives a cell's figures from its rounds. Pure. |
| `lib/paired-verdict.cjs` | The rule that judges the paired bench: `judge` and `cellOf` (the head against the mean of the base and the A/A control, round by round; the distribution-free 95% interval of the median of those differences, from `medianInterval`; a control median past +-2% making the cell inconclusive; the fixed 2% bar; a figure that is not a positive number malformed), `gateProblems` (the gate over every pass: a slower in any pass, a kept round that ended at a load of 6 or more, a cell left open without a note quoting its bound; a recorded slept round whose evidence fails, a pass that holds slept rounds without recording its sleep rule, and a cell whose slept rounds fall mostly on the head; a pass recorded before the sleep rule is read exactly as stored), `keepRound` (the load rule), `sleptFigure`, `sleepEvidence` and `collectRounds` (the sleep rule), `nsToMs` and `figurePlaces` (the unit) and `worstPaired`. `legacyVerdictOf` keeps the earlier rule so the first recorded pass can be recomputed. Pure, so another bench can import it (the count kernels judge a count against a build with their own bar); `tests/bench/ts-codec-paired-verdict.test.ts` fires it at its boundaries.
| `lib/codec-ops.cjs` | The per-operation cells of the codec (`opCells`, built on `storedBytesOf`, which the native codec writes so every subject decodes the same bytes), a cell being `{ name, unit, cold, make(codec) }` over the codec seam alone, with `digest` (a result as a string two subjects can be compared by), `measureSteady` (warm by time, then one batch, nanoseconds per operation) and `measureCold` (the first call). The paired bench's `--ops` part times them, and another paired bench can import them for its own cells. `tests/bench/codec-ops.test.ts` holds the list and the agreement of both codecs. | |
| `lib/codec-data.cjs` | The engine bench's data sets: seeded ids of the dense, sparse, run, mixed and spread shapes (`idsOf`). Pure. |
| `lib/count-cells.cjs` | The cells of `count-kernels.cjs`: the eight operand-pair groups, each counting operation beside the building path it replaces (`operationsOf`, over any codec's bitmaps), the stop rule (`decisionsOf`: an operation is kept only if it is faster than the bar on every group it was timed on). Pure but for the codec it is handed. `tests/bench/count-kernels-cells.test.ts` holds it. |
| `lib/bitmap-api-cells.cjs` | The cells of `bitmap-api.cjs` and its three subjects (`nativeApi`, `oursApi`, `internalApi`): every cell, the data, the digest each subject's answer is compared by (the bytes of a serialization compared as bytes), and `inventory`, the list of cells a complete pass holds. `tests/bench/bitmap-api-cells.test.ts` holds it. |
| `lib/bitmap-api-count.cjs` | The count kernels' decision, read from the last line of `count-kernels.cjs --gate` (`kept`, `derived`, `invalid`, or `unavailable` when no such line ends the output). `tests/bench/bitmap-api-count.test.ts` holds it. |
| `lib/bitmap-api-pages.cjs` | The public pages the phrase check reads: the two that carry the table and every other. |
| `lib/bitmap-api-verdict.cjs` | What a pass of `bitmap-api.cjs` says: `cellOf` (the ratio to the package, its interval, the control's band), the stop rules (`groupsOf`: within 3 times; `overShipBar`: above 10 times) `fresh` and the other recomputations a printed figure comes from, the inventory of a complete pass and `gateProblems`. Reuses the median, interval, load rule and sleep rule (`collectRounds`, `sleptProblems`) of `lib/paired-verdict.cjs`. `tests/bench/bitmap-api-verdict.test.ts` fires it at its boundaries. |
| `lib/bitmap-api-table.cjs` | The generated table and the check of a page against the record (`render`, `problemsOf`). `tests/bench/bitmap-api-table.test.ts` holds it. |
| `lib/aws-meter.cjs` | Counts every request the AWS SDK sends, as middleware — every attempt, retries included, read from the attempt count the SDK's retry loop records, and including requests the library never reports, like a multipart upload's parts. Classifies by **billing class**, not HTTP verb (a `LIST` bills like a `PUT`, twelve and a half times a `GET`), and splits `GetObject` by the shape of its `Range` header so chunk reads and the tail read can be told apart. An unrecognised command is counted as a paid read, never as free. A `HeadObject` names its object's size and sends no body, so it adds no bytes read. |
| `lib/calibrate-guards.cjs` | The guards above, plus the planned id layouts (`planLayout`, `planSweepLayout`, `layoutIds`), the account mask and the redaction of error text (`maskAccount`, `redact`), what LEFTOVERS says last (`leftoversHint`), which file each kind of run writes and what makes a usable run id (`resultsFile`, `stampOf`, `EVIDENCE_DIR`, `checkRunId`, `checkCleanupId`), the workload's bounds and the one priced region (`checkWorkload`, `MAX_SEGMENTS`, `checkRunRegion`), how the timed and the warm stores are built (`TIMED_STORE`, `warmStore`, `STORE_PREFIX`), how many attempts each of the two S3 clients makes (`clientConfigs`), and what teardown counts as done, what it refuses and how long it waits (`bucketIsGone`, `uploadIsGone`, `TEARDOWN_PASSES`, `foreignKeys`, `MAX_LISTING_PAGES`, `ADMIN_TIMEOUTS`). Pure functions, so each can be tested against the bug it exists for. |
| `lib/calibrate-large-stages.cjs` | The large suite's table of stages (`LARGE_STAGES`), its shapes (`planLargeLayout`, `largeStride`), the most each stage can request, with each range bounded by the object's bytes (`projectLarge`, `rangeCap`) and the exact requests the engine is expected to make (`expectedLarge`), the literal copies of the engine's coalescing constants and the driver's part size, which a test holds to their source and the harness holds to the installed packages' own (`constantsIn`, `checkEngineConstants`), which suite a run is and where it was named (`resolveSuite`, `suiteFrom`), the knobs (`resolveLargeKnobs`, `refuseDefaultKnobs`) and the floors the machine must meet (`checkResources`, `resolveFloors`). Pure, so each can be tested against the bug it exists for. |
| `lib/calibrate-large.cjs` | The large suite's stages: the loads, the uncached intersects, unions and `andNot`s and the `*Into` calls, run through the harness's own meter, discard ledger, load helper and ceiling check, each read held to exactly the ids the layout says. Also its projection-only report (`projectionLines`). |
| `lib/calibrate-large-resources.cjs` | What the machine has for the large suite, and the installed engine's text to check its constants against (`installedSources`): the memory available (`/proc/meminfo`'s `MemAvailable`, the machine's total where there is no such figure) and the disk free in the home directory, and the one line a run prints about them. |
| `lib/large-counts.cjs` | Counts the large suite's requests by running the real engine over the in-memory backend: the operands' object sizes, each cold read's pointers, tails and ranges, and each `*Into` call repeated onto one destination, with its parts and PUT-class requests. The engine's module is passed in, so a test counts the source. |
| `lib/calibrate-process.cjs` | How a run stops and what it leaves behind: the gate that stops the workload's client and waits for what it sent before teardown (`interruptGate`, `stopThenTearDown`), what a failure records, its name, its code and its message, and what a signal exits with (`faultOf`, `failureOf`, `describeFault`, `exitCodeAfterSignal`), the SDK's own classes of retryable fault (`sdkFaultClasses`), the terminal's streams opened at startup and silenced on a hang-up (`holdTerminal`, `silenceTerminal`), results written without ever replacing a file (`writeResultsFile`), and the harness commit, marked when dirty (`harnessRef`). Kept apart from the pure guards so each can be driven in a test. |
| `lib/calibrate-samples.cjs` | The timed samples that survive a transient fault: what counts as one (`transientFault`), the ledger every timed sample runs through, which discards a failed one whole, records it beside its stage and runs it again, at most three a run and two a stage (`discardLedger`, `DISCARDS_PER_RUN`, `DISCARDS_PER_STAGE`), the wait for a failed sample's requests to answer (`quiesce`), a stage's requests with and without its discards (`keptRequests`, `discardedRequests`), and a rehearsal's injected faults (`parseFaultGets`, `injectFaults`). |
| `lib/calibrate-spread.cjs` | The spread layout: the calibration overlap with its shared chunks at keys spread uniformly over each segment, from a fixed seed, so the bytes between two shared chunks are chunks an intersect never wants. A pure function (`planSpread`, `spreadIds`) whose placement is reproducible and whose overlap, as a count and a sum, is known exactly. |
| `lib/calibrate-stages.cjs` | The one table of the calibration run's stages (`STAGES`), the most each can request and the most one of its samples can (`projectStages`, the pre-flight projection and the end-of-run check, with its allowance for discarded samples; `sampleBounds`) and the exact requests the engine is expected to make for each (`expectedReads`), plus the sweep list (`parseSweep`) and the steady-load stage's window, number of loads and the requests of each kind of load (`STEADY_KEEP`, `STEADY_LOADS`, `STEADY_LOAD_REQUESTS`, `steadyKind`). A stage the harness runs that is not in the table fails its test. |
| `lib/expected-figures.cjs` | Computes the figures the engine is expected to cost (and reads the committed `expected-figures.json`), from `range-counts.json` and the shipped estimator's prices: a cold intersect's GETs and dollars, the `andNot`'s and the `iterate`'s, and the bytes a spread layout reads. Nothing in it is measured on a cloud; `scripts/site-figures.cjs` holds every page that quotes one of them to the strings it gives. |
| `lib/range-counts.cjs` | Counts the requests of one cold read by running the real engine (and asks it, in memory, whether it collects by name at `keep: 12`, `collectsByName`): builds the layout on `MemoryStorage`, reads it through the built library, and counts what the storage driver and the registry were asked. Used by `range-counts.cjs` for the cost model and by the calibration harness, which counts the layout it is about to load before it spends anything, so what it expects of a real run is what the engine does on the same ids. It restates none of the planner's rules. |
| `lib/sizing-pages.cjs` | Which generated `SIZING` regions live on which page, and which charts `sizing.cjs` draws: one list, read by `sizing.cjs`, which writes them, and by `scripts/site-figures.cjs`, which leaves exactly those regions to `pnpm bench:sizing:check` and refuses any other `SIZING` marker |
| `lib/resolution-heap-range.cjs` | The range `sizing.cjs` publishes for the heap a filled resolution cache's entries take against the bytes it counts for them (`heapRange`): the Node major version and the lowest and highest multiple in `resolution-heap-results.json`, to one decimal. It refuses a file with no Node version it can read, no shapes, or a shape without a positive, finite multiple, since no gate runs the harness that writes it. Held to that by `tests/bench/resolution-heap-range.test.ts`. |
| `lib/sizing-markers.cjs` | The one reader of `SIZING` markers, for `sizing.cjs` and `scripts/site-figures.cjs` alike, so the two agree on where every region begins and ends: each takes every comment shaped like a marker for one, so a page quotes none, and refuses a malformed one |
| `lib/log-chart.cjs` | The log–log chart `sizing.cjs` draws its two charts with, in the crossover chart's style, once for each theme: a card and palette of its own, every line and region named in words, and in-plot text ringed in the card's colour. It refuses rather than draws a point outside the axes, a label past the card's edge, within a third of an em of another label, across a line or a marker's dot, or on the wrong side of the region it names, and an axis from zero |
| `lib/elasticache-prices.cjs` | ElastiCache's reserved prices for every catalogue node type, and the one reader of AWS's price list they are held to: each node on its full key, `NodeUsage:<type>`, and a key that matches none or several refused |
| `lib/calibration-figures.cjs` | Every figure a calibration run lets the project publish, derived from the run's evidence, the pricing profile and the library's own constants — and a refusal for evidence that does not reconcile with itself. `tests/docs/calibration-reports.test.ts` holds the latest run's report and the benchmarks page to it as it stands, each earlier report to the model recorded for it, and `scripts/site-figures.cjs` takes the site's single-bucket figures from it. |
| `lib/remove-all.cjs` | Takes markup out of a page's text for the gates that read what a reader sees (`scripts/site-figures.cjs`, `scripts/site-replay.cjs`, `calibration-figures.cjs` and the docs tests): a replace repeated until nothing matches, since removing one comment or tag can join the text around it into another |

## Adding a harness

- **Open with a header that says why it exists** — what claim it measures and what would be wrong without it.
  Every file here does, and it is the part a later reader most needs.
- **Write a results file, not only a log line.** A measurement that is not recorded does not exist: a figure
  measured on every pull request is still owed if its numbers go to a container's stdout and nowhere else.
- **Gate any figure you publish.** A number that reaches the site is checked against its results file by
  `scripts/site-figures.cjs`; add it there, or the page can drift from the run. A calibration run's figures come
  out of `lib/calibration-figures.cjs`, which the run's report, the benchmarks page and the site all share.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
