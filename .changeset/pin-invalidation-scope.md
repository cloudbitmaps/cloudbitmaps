---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': patch
---

`EngineDeps.sharesInvalidationsWith` (new, optional and opt-in): an engine built with it shares the other engine's invalidations and requests in flight, so an invalidation reaches a pinned read, or a combine with a pinned operand, already running, which then caches nothing more of what it began reading before it; engines over one chunk cache built without it share nothing, and a read running on one can write stale chunks back after the other invalidates. A pinned stream looks its pin up again after its store invalidates its segment, and fails with `NotFoundError` once its object is gone, so it keeps the erasure's in-flight bound. A read dropped without closing it is held by nothing in the engine.
