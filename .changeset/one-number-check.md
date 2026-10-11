---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

Numbers an option or argument takes are refused by one rule and worded one way (`<name> must be an integer of at least 1; got <value>`), as safe integers. The retry policy refuses a fractional `maxAttempts` and a `maxDelayMs` below `baseDelayMs`; a fractional `maxScanSegments` is refused.
