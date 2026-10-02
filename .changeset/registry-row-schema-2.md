---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

Registry rows are schema 2: every row a registry writes is stamped 2, a reader takes 1 and 2, and a 0.11 process
refuses a schema-2 row, so every 0.11 process must stop before the first 0.12 write and there is no downgrade. The
record gains an optional `summary` of its current generation, and a row a registry creates has a token carrying a
random 128-bit incarnation id, drawn from the new `Entropy` seam. The user-facing entries are in the root
`CHANGELOG.md`, under `[Unreleased]`: `Breaking`, `Added` and `Changed`.
