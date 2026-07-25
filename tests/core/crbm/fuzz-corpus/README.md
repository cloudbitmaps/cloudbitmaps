# Fuzz crash-reproducer corpus (T3 regression guard)

Committed reproducers for bugs found by the coverage-guided fuzz campaign (`pnpm fuzz:*`,
[`fuzz/README.md`](../../../../fuzz/README.md)). [`../fuzz-corpus.test.ts`](../fuzz-corpus.test.ts) replays
every file here on **every PR**, so a fixed bug stays fixed.

- `safe-deserialize/` — raw serialized-bitmap inputs, replayed through `SafeBitmap.safeDeserialize`.
- `crbm-index/` — raw `.crbm` index-region bytes, replayed through `parseIndex`.
- `crbm-reader/` — whole `.crbm` objects, replayed through the full `open → getChunk → safeDeserialize` chain.

To add one: minimize the `fuzz/crashes/…` artifact, drop the bytes into the matching subdirectory (any
filename), and fix the bug. Empty subdirectories mean the campaign has found nothing outstanding.
