---
'@cloudbitmaps/core': patch
---

The writer encodes the chunk index straight into one buffer sized to it, where it first built an array of numbers about eight times as large and copied it. The bytes are identical, so no object changes; the transient the footer held drops from about 4.5 to 7 MiB to about 0.6 to 0.7 MiB at the 65,536 chunks a segment can have, and by about 0.6 to 0.9 MiB at 8,192 (measured).
