---
'@cloudbitmaps/core': minor
'@cloudbitmaps/roaring': minor
---

The numbers core and the store's admin calls check, apart from the few the CHANGELOG lists, are refused by one rule and worded one way (`<name> must be an integer of at least 1; got <value>`), as safe integers. The retry policy refuses a fractional `maxAttempts` and a `maxDelayMs` below `baseDelayMs`; a fractional `maxScanSegments` is refused.
