# Fuzz crash-reproducer corpus

Committed reproducers for bugs in the untrusted-bytes boundary: found by the coverage-guided fuzz campaign
(`pnpm fuzz:*`, [`fuzz/README.md`](../../../../fuzz/README.md)), or written by hand for a hostile shape it has not
reached. [`../fuzz-corpus.test.ts`](../fuzz-corpus.test.ts) replays every file here on **every PR**, so a fixed
bug stays fixed. A reproducer passes when it is refused with a typed error or decodes self-consistently.

- `safe-deserialize/` — raw serialized-bitmap inputs, replayed through the native codec's safe deserialize, through the TypeScript codec's and through `RoaringBitmap.deserialize`.
- `bitmap-ops/` — `[u16 n][n bytes of a portable bitmap][operation bytes]` inputs of the `bitmap-ops` target, replayed through the same code the target runs: the bitmap bytes through `RoaringBitmap.deserialize`, then the operations against a plain `Set`. The eleven here are hand-written: runs with a bitset and arrays combined, a slab of small containers, ids at the top of the id space, refused bytes followed by operations, no bitmap bytes at all, and three that run the combines that return a new bitmap: one `and` on decoded runs, one `orMany` on a slab of small containers, and one on a bitset, an array and a run together that runs ten such steps (`and`, `or`, `xor`, `andNot` and `orMany`, each twice, against operands of 40 ids, with a second operand that holds keys the first lacks, in the middle of the first's keys and past its last) followed by `orInPlace`, `andNotInPlace` and `xorInPlace`, each twice, and `xorInPlace` against itself; and two that run the counts and comparisons from a decode that holds an array, a bitset and a run container together (one of 9,103 ids, one of exactly 20,000, the most the target keeps whole), the first running five of the steps that return a new bitmap and four in-place combines, the second three and two (each step checks every count against the starting bitmap, its clone, itself and a small operand); and one with no bitmap bytes that asks every counting method to take a value that is not a bitmap and requires each to refuse it.
- `crbm-index/` — raw `.crbm` index-region bytes, replayed through `parseIndex`.
- `crbm-ext/` — raw sections of an extension block, replayed through `parseExtension`.
- `crbm-reader/` — whole `.crbm` objects, replayed through the full `open → getChunk → safeDeserialize` chain.

To add one: minimize the `fuzz/crashes/…` artifact, drop the bytes into the matching subdirectory (any
filename), and fix the bug.

`safe-deserialize/empty-buffer.bin` (no bytes: the public door refuses it where a store load reads the empty bitmap) and `one-bitmap-then-a-stray-byte.bin` (a whole bitmap and one byte more: refused as one bitmap by the door) hold the door's two edges. The hand-written ones in `safe-deserialize/` are portable-roaring payloads CRoaring's deserializer accepts and
the structural check in the roaring codec's safe deserialize refuses: containers or values out of order or listed twice,
runs overlapping or running past their container, a run container with no runs, and a bitset whose header
cardinality disagrees with its bits. In `crbm-reader/`, `chunk-containers-out-of-order.crbm` is a whole `.crbm`, with valid
checksums, whose chunk payload lists its containers out of order, and `payload-runs-into-block.crbm` an object
that flags an extension block, with valid checksums, whose last payload runs into that block. The ones in `crbm-ext/` are
metadata sections whose JSON parses but is refused: a key listed twice (`JSON.parse` keeps the last, so only the
canonical-form check catches it) and the key `__proto__`.
