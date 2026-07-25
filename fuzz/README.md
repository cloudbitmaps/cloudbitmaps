# Coverage-guided fuzzing (`.crbm` untrusted-bytes boundary)

Test-strategy **T3** (``). Every byte a
cold read sees is attacker-controlled (invariant 5 / finding S1). We already property-fuzz this boundary with
random bytes ([`tests/core/crbm/fuzz.test.ts`](../tests/core/crbm/fuzz.test.ts)) and forge hostile indexes
deterministically ([`tests/core/crbm/crafted.test.ts`](../tests/core/crbm/crafted.test.ts)); this adds a
**coverage-guided** campaign ([jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) → libFuzzer)
that evolves inputs toward unreached branches and persists a growing corpus.

## Why three targets (the CRC wall)

`CrbmReader.open()` gates the index parser and the payload deserialize behind three CRC32C checks (footer,
index, per-chunk payload) — each *before* the code it protects. A mutational fuzzer cannot satisfy a CRC32C, so
a single "read a `.crbm`" target would only ever exercise `open()`'s pre-CRC validation. So we fuzz the two deep
surfaces **directly**, ungated, and keep a third target for the validation front:

| Target | Entry point | Coverage | Runs |
| --- | --- | --- | --- |
| `targets/safe-deserialize.mjs` | `SafeBitmap.safeDeserialize` → **native** CRoaring portable deserializer | black-box (native C++ isn't instrumentable from JS) | `pnpm fuzz:deser` |
| `targets/crbm-index.mjs` | `parseIndex` **directly** on raw index bytes | **coverage-guided** (pure, branch-dense TS) | `pnpm fuzz:index` |
| `targets/crbm-reader.mjs` | `CrbmReader.open` validation front (+ full chain on valid seeds) | **coverage-guided** | `pnpm fuzz:crbm` |

The **contract** all three assert: arbitrary bytes either succeed self-consistently or throw a typed
`CloudRoaringError` — never a `RangeError`/`TypeError`, native crash, unbounded allocation, or hang. This is
memory-safety/liveness, **not** semantic correctness (a wrong-but-well-formed decode is the `Set`-oracle
property tests' job). An escape is a finding; libFuzzer writes the reproducer under `fuzz/crashes/`.

## Run

```sh
pnpm fuzz:deser             # 60s default; FUZZ_SECONDS=600 pnpm fuzz:deser for longer
pnpm fuzz:index
pnpm fuzz:crbm
pnpm fuzz:seed              # (re)generate the seed corpus only
```

Each script builds first (including the fuzz-only internals — see below), (re)generates the seed corpus, then
fuzzes. Instrumentation is scoped with `--includes cloud-roaring/fuzz/build`; **run from a checkout named
`cloud-roaring`**, or adjust the include, or coverage guidance silently degrades to black-box.

## Fuzz-only internals build

The targets need entry points that aren't public API (notably `parseIndex`). `src/testing/fuzz-support.ts`
re-exports them and is built by a dedicated `tsup` entry to **`fuzz/build/`** (git-ignored, never under `dist/`,
never in the package `files`) — so the fuzzer reaches the hand-written parser directly while the published API
stays minimal. Targets fuzz this build; the regression test (below) replays against `src` via vitest — fidelity
rests on `dist ≈ src` (tsup, no minify, same native addon).

## Corpus & crashes (not committed)

`fuzz/corpus/` (seed + evolved inputs), `fuzz/crashes/` (findings), and `fuzz/build/` are git-ignored. Seeds are
generated deterministically by `fuzz/seed-corpus.cjs` (valid bitmaps/`.crbm` files/index regions spanning every
container type, plus truncations/flips), so nothing binary lives in the repo. The nightly workflow caches
`fuzz/corpus/` so coverage accretes across runs.

## When a crash is found — the regression loop

1. Minimize it: `jazzer <target> -- -minimize_crash=1 <fuzz/crashes/crash-…>`.
2. Copy the reproducer into `tests/core/crbm/fuzz-corpus/{safe-deserialize,crbm-index,crbm-reader}/`.
3. Fix the bug. [`tests/core/crbm/fuzz-corpus.test.ts`](../tests/core/crbm/fuzz-corpus.test.ts) replays every
   committed reproducer on **every PR** (the campaign itself is nightly-only), so the fix stays locked in.

CI: [`.github/workflows/fuzz-nightly.yml`](../.github/workflows/fuzz-nightly.yml) — nightly + on-demand;
uploads any crash reproducers as an artifact and fails the job.
