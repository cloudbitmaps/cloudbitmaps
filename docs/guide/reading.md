# Reading in depth

Freshness after a publish, and paging through a segment.

## Read staleness after a publish

**Read staleness after a publish is bounded.** With a registry wired, a long-running store re-resolves each
segment's current generation on a short TTL (`cache.genTtlMs`, default **2000 ms**), so reads are **bounded
eventually-consistent**: after a load publishes a new generation, a reader may serve the prior one for up to the
TTL, then converges — no restart needed. Tune it down for fresher reads, up to trade a little staleness for fewer
registry reads. **An outage of the registry stretches the bound.** A refresh that fails with a transient fault
(throttling, a 5xx, a dropped connection) keeps serving the generation the reader holds, and retries 500 ms later
(or after the TTL, if that is shorter), so it converges within one retry of the registry answering. A refresh that
fails with anything else, such as an access denial or a row that will not parse, is not ridden out: the `has`,
`count`, `iterate` or combine that meets it throws that error, and the next read resolves the segment afresh. `0` turns the timed refresh off: the store then re-resolves a segment only when its reader cache
evicts it, when a read has to fetch from a generation a sweep deleted, or when it is invalidated — by this store's
own `load`, `rollback`, `eraseSubject` or `*Into` writes, or by `store.invalidate(ref)` — so another process's
publish reaches it with no bound at all. The cache is keyed by
generation, so a new generation is never served from stale decoded chunks. Within one read op — one `count`, one
`intersect` — the generation is resolved **once**, before any chunk is fetched, and every chunk is a whole,
checksum-verified chunk of one generation, so a load landing mid-call never tears a chunk. A long call can still
read its later chunks from another generation — if it straddles a TTL boundary, the reader cache evicts the segment
mid-call, a sweep collects the generation it was reading, or the store invalidates the segment — and its answer then
describes two instants ([generation bookkeeping](loading.md#generation-bookkeeping-what-a-load-leaves-behind) says when); `seg.pin()` holds one.
Without a registry, a store finds the generation by listing the bucket when it opens a segment, and keeps it until
the reader cache evicts that segment, a read finds it swept, or it is invalidated (single-process/local use).

### Page through a segment

`iterate` and every combine take a range: `after` and `through` yield only the ids in `(after, through]`, and fetch
only the chunks the range overlaps. That is keyset paging: each page asks for the ids after the last one the page
before it ended on, so no page walks from the first id. Give each page both bounds. The per-op budget is charged once,
before the first fetch, for every chunk in the range, so a page with `after` alone is charged to the end of the
segment however early it stops. A combine also fetches ahead: it starts `concurrency` chunk keys at once (8 by
default) and one more each time it yields a key's ids, on every segment it reads, so a page that stops early has
already fetched up to `concurrency` keys past the one holding its last id; those chunks land in the chunk cache, where the next
page usually finds them. `iterate` fetches one chunk at a time and nothing ahead.

```ts
// All three are loaded segments (see loading): an operand that names no segment is refused.
await store.load({ segment: 'active-30d' }, activeIds);
await store.load({ segment: 'zone-eu' }, euIds);
await store.load({ namespace: 'suppression', segment: 'global-opt-out' }, optOutIds);

// The audience is held at one generation for the whole send; the zone and the opt-out list are read live, page by
// page, so an opt-out that lands mid-send applies to the pages after it.
const audience = await store.segment('active-30d').pin();
const zone = store.segment('zone-eu');
const optOut = store.segment('global-opt-out', { namespace: 'suppression' });

// One streamed pass finds the window ends: every 1,000th id, then the end of the id space.
const ends: number[] = [];
let n = 0;
for await (const id of audience.iterate()) if (++n % 1_000 === 0) ends.push(id);
ends.push(4_294_967_295);

// Each window is an independent page, so workers can take them in any order. The first leaves `after` out, which
// is the only way to include id 0.
let after: number | undefined;
for (const through of ends) {
  const page: number[] = [];
  for await (const id of audience.intersect([zone], { after, through, exclude: [optOut] })) page.push(id);
  await send(page);
  after = through;
}
```

The range applies to every operand and every `exclude`, and a pinned operand is read at its pin. Each bound is an
integer in `0..4294967295`, or the stream throws `ValidationError` when first read. `after >= through` reads nothing,
so a cursor that reaches the end of its window needs no special case. A pinned read fails with `NotFoundError`, rather
than reading a newer generation, for any chunk it must fetch from a generation that has since been collected; chunks it
already cached still answer. A pin is never re-resolved, so the TTL rule below does not size `keep` for it: keep more
generations than the loads that can land on the segment while the job runs (`store.load` keeps 1 by default). An
erasure collects the generation it rewrote whatever `keep` says.
