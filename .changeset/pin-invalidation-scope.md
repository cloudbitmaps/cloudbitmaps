---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': patch
---

`EngineDeps.sharesInvalidationsWith` (new, optional): engines over one chunk cache share their invalidations, so an invalidation reaches a pinned read, or a combine with a pinned operand, already running, which then caches nothing more of what it began reading before it. A read dropped without closing it is held by nothing in the engine.
