# Playbooks

Runnable, end-to-end walkthroughs for one job each, on invented data, ending in the limits and the errors you may see.

A guide explains a part of the library; a playbook walks one job from the first load to the last read. Every code block on
a playbook page is run by the repo's tests, in order, as one program against the package sources on `MemoryStorage`
(no network, no Docker, no build step), and the output shown under a block is what that run prints, compared exactly. A
change that breaks a page fails CI. The pages are also compiled under `strict` with the other documentation samples.

To follow one, install `@cloudbitmaps/roaring`, copy a page's blocks in order into one TypeScript file and run it with
your TypeScript runner as an ES module, which allows the top-level `await` the blocks use. Each page says what it does not claim: a playbook on `MemoryStorage` shows what the calls do, not what a bucket
costs or how long it takes. For that, see [the cost guide](../guide/cost.md) and [the benchmarks](../benchmarks.md).

| Playbook | What it does | What it uses | Size |
|---|---|---|---|
| [Sets of integers without a store: the standalone RoaringBitmap](roaring-bitmap.md) | Builds, combines, counts, serializes and loads sets of 32-bit ids in memory | `RoaringBitmap`, `deserialize`, `store.load` of a bitmap | M |
| [Audience segments from a warehouse, end to end](audience-segments.md) | Seeds segments from an export, refreshes them, composes and counts a campaign audience, pages through it to send | `store.load` with a guard, `intersect`, `union`, `andNot`, `exclude`, `materializeMany`, `pin`, `everyNth` | M |
| [Feature flags, rollouts and experiment cohorts by user set](feature-flags.md) | Checks a flag per request, flips it by a load, rolls out by percentage and expires an experiment | `has`, `unionInto`, a hash recipe, `setRetention`, `retireExpired` | M |
| [Dedup against what you have already processed, by day](dedup-seen-sets.md) | Drops ids a batch pipeline has seen, over a window of day buckets that expire | `andNot`, `unionInto`, `allowAbsentOperands`, `setRetention`, `retireExpired` | M |
| [Who may see what: permission sets per resource and group](permissions.md) | Checks access, revokes by a load, removes a person everywhere and shreds a tenant | `has`, `unionInto`, `pin`, `subjectReport`, `eraseSubject`, `eraseNamespace`, encryption | M |

More are planned: [the roadmap](../ROADMAP.md) lists them.
