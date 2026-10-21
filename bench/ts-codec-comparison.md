# The TypeScript codec against the native one: the comparison for the decision to switch

Every figure carries a label: **measured** (taken by a run named here), **derived** (computed from measured figures by the
rule stated beside it) or **expected** (what the code is expected to do, not taken). The raw figures are
`bench/ts-codec-comparison-results.json`; the instrument is `bench/ts-codec-engine.cjs` (`node --expose-gc
bench/ts-codec-engine.cjs --all`), with `bench/ts-codec.cjs` for the per-operation figures.

Machine: Apple M3 Pro, 11 cores, macOS, Node v24.18.1, taken on the tree of `f16ee472` (the stack of fast paths plus the
engine bench), the bench's own edits being the only difference. The 1-minute load average was 1.5 to 3.3 for every figure
(each row says its own), against the bar of 6. Every figure is wall-clock on one machine, recorded and not asserted.

## How a verdict is computed

Three stores share one backend: native (A), TypeScript and native again (the A/A control, B). Every round times the same
call on all three, in an order that rotates through the six permutations. A cell's two figures are the median over 31
rounds of `typescript / native - 1` and of `control / native - 1`. **Derived verdict:** the control's median within +-2%
and the TypeScript median at most +5% is `within the 5% bar`; the TypeScript median above +5% with the control in band is
`over the 5% bar`; a control outside +-2% is `inconclusive`, because the machine moved more than the bar can see. The
verdict of an op is the worst of its cells. A store's calls were counted per codec in one untimed pass: every cell's
TypeScript store ran only the TypeScript codec and every native store only the native one (measured, zero failures).

## Gate rows

| gate row | verdict | evidence |
|---|---|---|
| Correctness: zero oracle differences | measured so far: none | the oracle, hostile-input, pin, TypeScript-codec and fast-path suites pass on Node 24.18.1 (14 files, 1,558 tests); the two codecs wrote the same exported bytes in all 45 write-path rounds |
| Correctness: a week of nightly fuzz with none | **cannot be judged yet** | the week starts at merge. Wiring (read from the workflows): `full-nightly.yml` runs the whole suite, the oracle files included, at 04:00 UTC every day; `fuzz-nightly.yml` fuzzes the four untrusted-bytes targets (`deser`, `crbm`, `index`, `ext`) at 05:00 UTC, all of them on the native deserializer: no fuzz target runs the TypeScript codec yet, so the week's fuzz evidence for it is the property tests' |
| Hot path: `has` | inconclusive | the spread cell's control is +2.3%, outside the band; every other cell is within the bar |
| Hot path: `count` | within the 5% bar | |
| Hot path: `iterate` | inconclusive | |
| Hot path: `intersect` | **over the 5% bar** | sparse and mixed cells, below |
| Hot path: `andNot` (beyond the four the gate names) | inconclusive | |
| Write path: the bulk load no slower | faster (derived) | below |
| Install: works on every package manager with nothing configured | **cannot be judged yet** | measured at the switch, when `roaring` leaves the dependencies; the TypeScript codec has no install step of its own (expected) |
| In-region calibration | **cannot be judged yet** | prepared, not run: see the commands in the pull request and `bench/README.md` |

## The read bench (measured; derived verdicts)

`has` is 512 probes per call, `count` one call, `iterate` a full stream, `intersect2` and `intersect4` an intersection of
two and of four segments of the data set, `andNot` one segment less another. Data sets: dense (32 chunks of 32,768 ids),
sparse (256 chunks of 1,000), runs (128 chunks of 150 runs), mixed (128 chunks, the three kinds in turn), spread (a million
ids over 62,500 chunks of 16: the largest load the research used) and spread8k (the same shape over 8,192 chunks). The
62,500-chunk set takes seconds per combine, so it is timed on `has`, `count` and `iterate` only and the combines run on
8,192 chunks. Figures are the median per call of 31 interleaved rounds.

| data set | op | native | typescript | ts vs native | A/A control | verdict | load |
|---|---|---|---|---|---|---|---|
| dense | has | 484.6 us | 472.5 us | -2.5% | +0.3% | within the 5% bar | 1.69 |
| dense | count | 1.4 us | 1.4 us | -0.4% | -0.1% | within the 5% bar | 1.64 |
| dense | iterate | 154.7 ms | 155.5 ms | +1.8% | +0.2% | within the 5% bar | 2.1 |
| dense | intersect2 | 86.1 ms | 86.3 ms | +0.2% | +0.6% | within the 5% bar | 2.42 |
| dense | intersect4 | 18.7 ms | 19.1 ms | +2.4% | +0.4% | within the 5% bar | 2.3 |
| dense | andNot | 86.6 ms | 84.7 ms | -1.7% | -0.2% | within the 5% bar | 2.3 |
| sparse | has | 533.8 us | 529.2 us | -0.7% | +0.1% | within the 5% bar | 2.1 |
| sparse | count | 1.5 us | 1.5 us | +0.3% | +0.3% | within the 5% bar | 2.09 |
| sparse | iterate | 35.6 ms | 34.9 ms | +0.5% | +1.5% | within the 5% bar | 2 |
| sparse | intersect2 | 3.6 ms | 4.6 ms | +25.6% | -1.5% | over the 5% bar | 1.92 |
| sparse | intersect4 | 3.6 ms | 4.9 ms | +34.2% | +1.7% | over the 5% bar | 1.92 |
| sparse | andNot | 40.8 ms | 41.2 ms | +5.8% | +3.9% | inconclusive | 1.94 |
| runs | has | 536.5 us | 518.9 us | -5.0% | +1.4% | within the 5% bar | 1.94 |
| runs | count | 1.4 us | 1.4 us | -0.6% | +0.1% | within the 5% bar | 2.11 |
| runs | iterate | 589.9 ms | 611.2 ms | +4.1% | +2.4% | inconclusive | 2.02 |
| runs | intersect2 | 427.3 ms | 423.6 ms | -0.7% | +0.4% | within the 5% bar | 1.7 |
| runs | intersect4 | 159.2 ms | 160.1 ms | +1.2% | +0.5% | within the 5% bar | 1.5 |
| runs | andNot | 268.0 ms | 270.1 ms | +0.3% | -0.5% | within the 5% bar | 1.6 |
| mixed | has | 501.8 us | 495.2 us | -1.7% | +0.5% | within the 5% bar | 1.5 |
| mixed | count | 1.4 us | 1.4 us | -1.0% | -0.3% | within the 5% bar | 1.5 |
| mixed | iterate | 423.0 ms | 418.5 ms | -0.5% | +1.9% | within the 5% bar | 1.46 |
| mixed | intersect2 | 113.2 ms | 113.4 ms | -0.1% | +0.1% | within the 5% bar | 1.51 |
| mixed | intersect4 | 3.0 ms | 4.2 ms | +43.4% | -1.2% | over the 5% bar | 1.51 |
| mixed | andNot | 350.5 ms | 347.2 ms | -1.2% | +0.5% | within the 5% bar | 1.59 |
| spread | has | 539.9 us | 542.9 us | +0.5% | +2.3% | inconclusive | 1.47 |
| spread | count | 1.5 us | 1.5 us | +0.1% | +0.3% | within the 5% bar | 1.47 |
| spread | iterate | 330.6 ms | 292.4 ms | -11.7% | +0.9% | within the 5% bar | 2.44 |
| spread8k | has | 544.8 us | 543.2 us | -0.3% | +0.8% | within the 5% bar | 2.36 |
| spread8k | count | 1.6 us | 1.6 us | +0.4% | +0.6% | within the 5% bar | 2.57 |
| spread8k | iterate | 36.2 ms | 32.3 ms | -10.3% | -1.5% | within the 5% bar | 2.57 |
| spread8k | intersect2 | 36.5 ms | 32.7 ms | -12.6% | -3.3% | inconclusive | 2.44 |
| spread8k | intersect4 | 63.0 ms | 60.0 ms | -6.3% | +3.4% | inconclusive | 2.41 |
| spread8k | andNot | 70.4 ms | 63.0 ms | -9.1% | +1.1% | within the 5% bar | 2.29 |

Per op (derived: the worst of its cells; a cell whose control is out of band is inconclusive):

| op | cells | worst ts vs native | worst control | verdict |
|---|---|---|---|---|
| has | 6 | +0.5% | +2.3% | inconclusive |
| count | 6 | +0.4% | +0.6% | within the 5% bar |
| iterate | 6 | +4.1% | +2.4% | inconclusive |
| intersect2 | 5 | +25.6% | +3.3% | over the 5% bar |
| intersect4 | 5 | +43.4% | +3.4% | over the 5% bar |
| andNot | 5 | +5.8% | +3.9% | inconclusive |

What the table says, in the order of the gate:

- `count` is answered in about 1.4 us in every cell by both codecs and the attribution pass shows no codec call at all:
  it is read from the generation's index, so it is not evidence about the codec (measured).
- `has` is dominated by the store's asynchronous call, about 1 us a probe, and the codecs are within a few percent in
  both directions; one cell (spread) has a control above +-2% and is inconclusive. The cells that could be judged are
  within the bar.
- `iterate` is within the bar wherever the control resolves it, and TypeScript is 10% to 12% faster on the spread sets.
- **`intersect` is over the bar on three cells:** sparse (+25.6% and +34.2% for two and four operands) and mixed (+43.4%
  at four operands). These cells are the cheap ones (3 to 5 ms for a call), so the codec's share is largest. The
  per-operation bench puts the sparse and skewed combines among the TypeScript codec's slower rows. The cause was not
  investigated here; the figures are the finding. Everywhere else `intersect` is within the bar or faster.
- `andNot` on sparse is +5.8% with a control at +3.9%: inconclusive, not a pass.

## The write path (measured; derived verdicts)

A load of 1,000,000 ids over 62,500 chunks, an erasure's rewrite of one id, and an export, each on a fresh store per round,
15 interleaved rounds, load 2.19. The verdict is derived: faster when the TypeScript median is below -2%, no slower when
within the control band, slower above it, and inconclusive when the control is out of band.

| op | native | typescript | ts vs native | A/A control | verdict |
|---|---|---|---|---|---|
| load | 189.8 ms | 124.9 ms | -34.2% | -0.6% | faster |
| erase | 204.2 ms | 128.6 ms | -36.9% | -0.3% | faster |
| export | 397.5 ms | 368.9 ms | -7.6% | +0.8% | faster |

The exported bytes were identical between the codecs in every round (measured).

## Memory (measured)

Heap plus external memory per decoded chunk, by kind, from `bench/ts-codec.cjs --memory` (20,000 chunks held after a
forced collection), in bytes. The native codec's own allocations are invisible to V8's counters, which is why its
heap-plus-external figure is near zero; the resident-set growth is the figure that includes them.

| kind | native heap+external | typescript heap+external | native resident | typescript resident |
|---|---|---|---|---|
| dense | 91 | 8,605 | 8,583 | 11,899 |
| sparse | 89 | 2,465 | 2,068 | 2,963 |
| run | 89 | 1,051 | 670 | 2,365 |

A store's chunk cache holding every chunk of a data set, in a fresh process per codec (bytes per cached chunk):

| data set | codec | heap+external | resident growth |
|---|---|---|---|
| sparse, 256 chunks | native | 1,444 | 6,464 |
| sparse, 256 chunks | typescript | 3,910 | 2,880 |
| mixed, 128 chunks | native | 2,493 | 4,992 |
| mixed, 128 chunks | typescript | 6,671 | 4,352 |

The cache is bounded by a count of chunks (`maxChunks`), not by bytes, so a byte budget is derived: a cache of N chunks
holds N times the figure for its kind. By resident growth the TypeScript codec holds 1.4 times (dense) to 3.5 times (run)
what the native codec holds per decoded chunk, and less on the sparse cache row, where resident growth is noisy (a
resident-set delta also moves with the allocator). A 62,500-chunk spread cache gave no usable figure (heap fell during
the fill), so it is not reported.

## Start-up (measured)

Module load, in a fresh process, median of 15: the native codec's module (the addon and the codec) 20.3 ms, the
TypeScript codec's module 1.7 ms.

A cold row, kept apart from every warmed figure above: a fresh process, a store over a loaded mixed set of 128 chunks, the
first 2,000 `has` calls timed one by one, then a first full `iterate` and a first `intersect`; median of 11 processes per
codec, load 2.1.

| | native | typescript |
|---|---|---|
| first `has` | 3.13 ms | 3.25 ms |
| first 10 `has` | 3.79 ms | 4.02 ms |
| first 1,000 `has` | 8.33 ms | 8.88 ms |
| next 1,000 `has` | 1.57 ms | 1.60 ms |
| first `iterate` | 465.7 ms | 491.0 ms |
| first `intersect` | 137.1 ms | 137.2 ms |

(These include the first decode of each chunk; the store's own start-up is the same for both.)

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
  Locally, `bench/range-counts.cjs --check` makes the same request counts under both codecs (measured), so identical
  counts in region are expected.
- Whether the over-the-bar `intersect` cells are the codec or the instrument: the control resolved them (it sat within
  +-2% in each), so they are expected to be the codec; a fix and a re-run settle it.
