# Coverage-guided fuzzing (`.crbm` untrusted-bytes boundary)

Every byte a storage read sees is attacker-controlled (hard invariant 5). We already property-fuzz this boundary with
random bytes ([`tests/core/crbm/fuzz.test.ts`](../tests/core/crbm/fuzz.test.ts)) and forge hostile indexes
deterministically ([`tests/core/crbm/crafted.test.ts`](../tests/core/crbm/crafted.test.ts)); this adds a
**coverage-guided** campaign ([jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) → libFuzzer)
that evolves inputs toward unreached branches and persists a growing corpus.

## Why four targets (the CRC wall)

`CrbmReader.open()` gates the index parser, the format 1.1 extension block and the payload deserialize behind
CRC32C checks (footer, index, extension block, per-chunk payload) — each *before* the code it protects. A
mutational fuzzer cannot satisfy a CRC32C, so a single "read a `.crbm`" target would only ever exercise `open()`'s
pre-CRC validation. So we fuzz the three deep surfaces **directly**, ungated, and keep a fourth target for the
validation front:

| Target | Entry point | Coverage | Runs |
| --- | --- | --- | --- |
| `targets/safe-deserialize.mjs` | the codec's safe deserialize → its structural check → **native** CRoaring portable deserializer | **coverage-guided** over the structural check; black-box beyond it (native C++ isn't instrumentable from JS) | `pnpm fuzz:deser` |
| `targets/crbm-index.mjs` | `parseIndex` **directly** on raw index bytes | **coverage-guided** (pure, branch-dense TS) | `pnpm fuzz:index` |
| `targets/crbm-ext.mjs` | `parseExtension` **directly** on the raw sections of a 1.1 extension block: the section walk, then the metadata record (UTF-8, JSON, the metadata rules, canonical form) | **coverage-guided** (pure TS) | `pnpm fuzz:ext` |
| `targets/crbm-reader.mjs` | `CrbmReader.open` validation front (+ full chain on valid seeds, 1.0 and 1.1) | **coverage-guided** | `pnpm fuzz:crbm` |

The **contract** all four assert: arbitrary bytes either succeed self-consistently or throw a typed
`CloudRoaringError` — never a `RangeError`/`TypeError`, native crash, unbounded allocation, or hang. The two
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
pnpm fuzz:seed              # (re)generate the seed corpus only
```

Each script builds first (including the fuzz-only internals — see below), (re)generates the seed corpus, then
fuzzes. Instrumentation is scoped with `--includes fuzz/build` — a SUBSTRING match against module paths, so it
works from a checkout of any name. Widen it and jazzer instruments dependencies too, which buries the signal;
narrow it to something that matches nothing and coverage guidance silently degrades to black-box fuzzing.

## Fuzz-only internals build

The targets need entry points that aren't public API (notably `parseIndex` and `parseExtension`), and the seed
generator needs the `.crbm` writer for format 1.1 objects. `src/testing/fuzz-support.ts`
re-exports them and is built by `scripts/build.mjs` (esbuild) to **`fuzz/build/`** (git-ignored, never under `dist/`,
never in the package `files`) — so the fuzzer reaches the hand-written parser directly while the published API
stays minimal. Targets fuzz this build; the regression test (below) replays against `src` via vitest — fidelity
rests on `dist ≈ src` (esbuild, no minify, same native addon).

## Corpus & crashes (not committed)

`fuzz/corpus/` (seed + evolved inputs), `fuzz/crashes/` (findings), and `fuzz/build/` are git-ignored. Seeds are
generated deterministically by `fuzz/seed-corpus.cjs` (valid bitmaps/`.crbm` files/index regions spanning every
container type, 1.1 objects and extension-block sections spanning the metadata shapes up to the 1 KiB cap, plus
truncations/flips), so no seed is committed: the only inputs in the repo are the
reproducers below. The nightly workflow caches `fuzz/corpus/` so coverage accretes across runs.

## When a crash is found — the regression loop

1. Minimize it: `jazzer <target> -- -minimize_crash=1 <fuzz/crashes/crash-…>`.
2. Copy the reproducer into `tests/core/crbm/fuzz-corpus/{safe-deserialize,crbm-index,crbm-ext,crbm-reader}/`. A
   reproducer written by hand, for a hostile shape the campaign has not reached, goes in the same place.
3. Fix the bug. [`tests/core/crbm/fuzz-corpus.test.ts`](../tests/core/crbm/fuzz-corpus.test.ts) replays every
   committed reproducer on **every PR** (the campaign itself is nightly-only), so the fix stays locked in.

CI: [`.github/workflows/fuzz-nightly.yml`](../.github/workflows/fuzz-nightly.yml) — nightly + on-demand;
uploads any crash reproducers as an artifact and fails the job.
