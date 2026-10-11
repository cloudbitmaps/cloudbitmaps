---
'@cloudbitmaps/tools': patch
---

`estimateCost` and `groundedReport` refuse a key they do not take at every level of their input, and a workload whose cost is not a finite number of dollars. `estimateCost` also refuses a segment `count` that is not a whole number.
