---
'@cloudbitmaps/tools': patch
---

`estimateCost` and `groundedReport` refuse a key they do not take at every level of their input, a segment `count` that is not a whole number, and a workload whose cost is not a finite number of dollars.
