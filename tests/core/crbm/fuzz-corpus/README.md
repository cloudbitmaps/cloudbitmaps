# Fuzz crash-reproducer corpus

Committed reproducers for bugs in the untrusted-bytes boundary: found by the coverage-guided fuzz campaign
(`pnpm fuzz:*`, [`fuzz/README.md`](../../../../fuzz/README.md)), or written by hand for a hostile shape it has not
reached. [`../fuzz-corpus.test.ts`](../fuzz-corpus.test.ts) replays every file here on **every PR**, so a fixed
bug stays fixed. A reproducer passes when it is refused with a typed error or decodes self-consistently.

- `safe-deserialize/` — raw serialized-bitmap inputs, replayed through `SafeBitmap.safeDeserialize`.
- `crbm-index/` — raw `.crbm` index-region bytes, replayed through `parseIndex`.
- `crbm-reader/` — whole `.crbm` objects, replayed through the full `open → getChunk → safeDeserialize` chain.

To add one: minimize the `fuzz/crashes/…` artifact, drop the bytes into the matching subdirectory (any
filename), and fix the bug.

The hand-written ones in `safe-deserialize/` are portable-roaring payloads the native deserializer accepts and
the structural check in `SafeBitmap.safeDeserialize` refuses: containers or values out of order or listed twice,
runs overlapping or running past their container, a run container with no runs, and a bitset whose header
cardinality disagrees with its bits. The one in `crbm-reader/` is a whole `.crbm`, with valid checksums, whose
chunk payload lists its containers out of order.
