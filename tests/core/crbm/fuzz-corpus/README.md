# Fuzz crash-reproducer corpus

Committed reproducers for bugs in the untrusted-bytes boundary: found by the coverage-guided fuzz campaign
(`pnpm fuzz:*`, [`fuzz/README.md`](../../../../fuzz/README.md)), or written by hand for a hostile shape it has not
reached. [`../fuzz-corpus.test.ts`](../fuzz-corpus.test.ts) replays every file here on **every PR**, so a fixed
bug stays fixed. A reproducer passes when it is refused with a typed error or decodes self-consistently.

- `safe-deserialize/` — raw serialized-bitmap inputs, replayed through the roaring codec's safe deserialize.
- `crbm-index/` — raw `.crbm` index-region bytes, replayed through `parseIndex`.
- `crbm-ext/` — raw sections of an extension block, replayed through `parseExtension`.
- `crbm-reader/` — whole `.crbm` objects, replayed through the full `open → getChunk → safeDeserialize` chain.

To add one: minimize the `fuzz/crashes/…` artifact, drop the bytes into the matching subdirectory (any
filename), and fix the bug.

The hand-written ones in `safe-deserialize/` are portable-roaring payloads the native deserializer accepts and
the structural check in the roaring codec's safe deserialize refuses: containers or values out of order or listed twice,
runs overlapping or running past their container, a run container with no runs, and a bitset whose header
cardinality disagrees with its bits. In `crbm-reader/`, `chunk-containers-out-of-order.crbm` is a whole `.crbm`, with valid
checksums, whose chunk payload lists its containers out of order, and `payload-runs-into-block.crbm` an object
that flags an extension block, with valid checksums, whose last payload runs into that block. The ones in `crbm-ext/` are
metadata sections whose JSON parses but is refused: a key listed twice (`JSON.parse` keeps the last, so only the
canonical-form check catches it) and the key `__proto__`.
