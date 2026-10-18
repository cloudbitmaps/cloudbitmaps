---
'@cloudbitmaps/core': patch
---

An erasure's collection under a tombstone, and the retention sweep's collection of a tombstone it purges, are held to the row they worked from: if the name was purged and loaded again before the collection read the row, it throws `WriteConflictError` and deletes nothing of the new row. A re-creation inside the one round trip before a delete remains a window.
