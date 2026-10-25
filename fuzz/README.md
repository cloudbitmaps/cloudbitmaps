# Coverage-guided fuzzing (`.crbm` untrusted-bytes boundary)

Every byte a storage read sees is attacker-controlled (hard invariant 5). We already property-fuzz this boundary with
random bytes ([`tests/core/crbm/fuzz.test.ts`](../tests/core/crbm/fuzz.test.ts)) and forge hostile indexes
deterministically ([`tests/core/crbm/crafted.test.ts`](../tests/core/crbm/crafted.test.ts)); this adds a
**coverage-guided** campaign ([jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) → libFuzzer)
that evolves inputs toward unreached branches and persists a growing corpus.

## Why five targets (the CRC wall)

`CrbmReader.open()` gates the index parser, the extension block and the payload deserialize behind
CRC32C checks (footer, index, extension block, per-chunk payload) — each *before* the code it protects. A
mutational fuzzer cannot satisfy a CRC32C, so a single "read a `.crbm`" target would only ever exercise `open()`'s
pre-CRC validation. So we fuzz the three deep surfaces **directly**, ungated, and keep a fourth target for the
validation front; a fifth drives the public bitmap class on bitmaps that came out of a decode:

| Target | Entry point | Coverage | Runs |
| --- | --- | --- | --- |
| `targets/safe-deserialize.mjs` | the TypeScript codec's safe deserialize (`tsRoaringCodec`) → the structural check → its own container decode (slab, in-place aliasing, run containers), each input read with and without `whole`, then through the public door, `RoaringBitmap.deserialize`, which must accept exactly what the codec accepts as one whole bitmap (an empty buffer excepted), hold it to the consistency check and to a serialize then deserialize that gives an equal bitmap, and refuse the rest with a `ValidationError` | **coverage-guided** through the whole decode (all instrumented JS) | `pnpm fuzz:deser` |
| `targets/crbm-index.mjs` | `parseIndex` **directly** on raw index bytes | **coverage-guided** (pure, branch-dense TS) | `pnpm fuzz:index` |
| `targets/crbm-ext.mjs` | `parseExtension` **directly** on the raw sections of an extension block: the section walk, then the metadata record (UTF-8, JSON, the metadata rules, canonical form), read as cleartext and again as sealed under a key whose every open fails | **coverage-guided** (pure TS) | `pnpm fuzz:ext` |
| `targets/bitmap-ops.mjs` | the public `RoaringBitmap` class on bitmaps a decode produced. An input is a two-byte length, that many bytes of a portable bitmap, then operation bytes: the bitmap bytes go through `RoaringBitmap.deserialize` (what it accepts is the starting set, what it refuses starts an empty one), and each operation byte picks a public method and its arguments (adds, removes and the bulk forms, the in-place combines (`xorInPlace` included), the combines that return a new bitmap (`and`, `or`, `xor`, `andNot`, `orMany`: the result against the model, no operand changed, no change to one reaching another), clone independence, a serialize and deserialize round trip, `runOptimize`, and every refusal) | **coverage-guided** through the kernels, by shapes only a decode produces: run containers, a slab of small containers, a bitset read in place; every answer is held to a plain `Set` and a refused call must leave the bitmap as it was | `pnpm fuzz:ops` |
| `targets/crbm-reader.mjs` | `CrbmReader.open` validation front (+ full chain on valid seeds, with and without an extension block), opened at the default tail, a footer-sized tail, a footer-sized tail with every range read a byte short, and tails at and a byte either side of where the input's footer puts the index, the block's trailer and the block | **coverage-guided** | `pnpm fuzz:crbm` |

The **contract** all five assert: arbitrary bytes either succeed self-consistently or throw a typed
`CloudRoaringError` — never a `RangeError`/`TypeError`, crash, unbounded allocation, or hang. The
targets that decode a bitmap also hold what they accept to `assertConsistentDecode` (in
`packages/roaring/src/testing/fuzz-codec.ts`): it iterates strictly ascending, and its `size` and `has` agree with
what it iterates. That catches a structurally broken decode — containers or values out of order, a cardinality
that disagrees with the bits — which is well-behaved memory until something trusts it, so a memory-safety
contract alone would pass it. It is still **not** semantic correctness (a well-formed decode of the wrong ids is
the `Set`-oracle property tests' job). An escape is a finding; libFuzzer writes the reproducer under
`fuzz/crashes/`.

## Run

```sh
pnpm fuzz:install           # once per clone: installs jazzer into fuzz/ (kept out of the root dependency graph)
pnpm fuzz:deser             # 60s default; FUZZ_SECONDS=600 pnpm fuzz:deser for longer
pnpm fuzz:index
pnpm fuzz:ext
pnpm fuzz:crbm
pnpm fuzz:ops
pnpm fuzz:seed              # (re)generate the seed corpus only
```

Each script builds first (including the fuzz-only internals — see below), (re)generates the seed corpus, then
fuzzes. Instrumentation is scoped with `--includes fuzz/build` — a SUBSTRING match against module paths, so it
works from a checkout of any name. Widen it and jazzer instruments dependencies too, which buries the signal;
narrow it to something that matches nothing and coverage guidance silently degrades to black-box fuzzing.

## Fuzz-only internals build

The targets need entry points that aren't public API (notably `parseIndex` and `parseExtension`), and the seed
generator needs the `.crbm` writer for objects with an extension block. `packages/core/src/testing/fuzz-core.ts`
re-exports them and is built by `scripts/build.mjs` (esbuild) to **`fuzz/build/`** (git-ignored, never under `dist/`,
never in the package `files`) — so the fuzzer reaches the hand-written parser directly while the published API
stays minimal. Targets fuzz this build; the regression test (below) replays against `src` via vitest — fidelity
rests on `dist ≈ src` (esbuild, no minify).

## Corpus & crashes (not committed)

`fuzz/corpus/` (seed + evolved inputs), `fuzz/crashes/` (findings), and `fuzz/build/` are git-ignored. Seeds are
generated deterministically by `fuzz/seed-corpus.cjs` (valid bitmaps/`.crbm` files/index regions spanning every
container type, objects with an extension block and its sections spanning the metadata shapes up to the 1 KiB cap, plus
truncations/flips), so no seed is committed: the only inputs in the repo are the
reproducers below. The nightly workflow caches `fuzz/corpus/` so coverage accretes across runs.

## When a crash is found — the regression loop

1. Minimize it: `jazzer <target> -- -minimize_crash=1 <fuzz/crashes/crash-…>`.
2. Copy the reproducer into `tests/core/crbm/fuzz-corpus/{safe-deserialize,bitmap-ops,crbm-index,crbm-ext,crbm-reader}/` (a bitmap-decoder reproducer goes in
   `safe-deserialize/` and is replayed through both decoders and the public door; one found by `bitmap-ops` goes in `bitmap-ops/`). A
   reproducer written by hand, for a hostile shape the campaign has not reached, goes in the same place.
3. Fix the bug. [`tests/core/crbm/fuzz-corpus.test.ts`](../tests/core/crbm/fuzz-corpus.test.ts) replays every
   committed reproducer on **every PR** (the campaign itself runs nightly and weekly, never as a per-PR gate), so the
   fix stays locked in.

The campaign itself never runs in the per-PR suite, so
[`tests/scripts/fuzz-wiring.test.ts`](../tests/scripts/fuzz-wiring.test.ts) holds its wiring to itself there: each
`fuzz:*` script runs a target that exists over the corpus it seeds, each target has a script and a nightly matrix
entry, and every name a target imports from the fuzz build is one its source exports. The seed generator refuses to
write an extension-block seed the parser does not read back.

CI: [`.github/workflows/fuzz-nightly.yml`](../.github/workflows/fuzz-nightly.yml) — nightly (10 minutes a target)
and weekly (a 60-minute deep soak), plus on demand, and 60 seconds a target on a pull request that edits the workflow;
uploads any crash reproducers as an artifact and fails the job.
