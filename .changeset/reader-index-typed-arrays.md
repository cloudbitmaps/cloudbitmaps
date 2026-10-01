---
"@cloudbitmaps/core": patch
"@cloudbitmaps/roaring": patch
---

A reader's memory bound now counts what its parsed index retains. The reader counted 160 B per index entry and the
heap held 186–200 B; it now holds the index as typed arrays, 20 B per entry, and reports exactly that. Parsing an
index is also about four times faster under plain Node. The user-facing entry is in the root `CHANGELOG.md`, under `[Unreleased]`:
`Fixed`.
