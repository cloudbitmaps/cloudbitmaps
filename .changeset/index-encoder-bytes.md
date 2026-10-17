---
'@cloudbitmaps/core': patch
---

The writer encodes the chunk index straight into one buffer sized to it, where it first built an array of numbers about eight times as large and copied it. The bytes are identical, so no object changes; a load's peak at the footer drops by about 7 MiB at the 65,536 chunks a segment can have (about 0.8 MiB at 8,192).
