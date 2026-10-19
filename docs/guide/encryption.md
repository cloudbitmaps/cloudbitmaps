# Encryption at rest

Encryption is opt-in: pass a keystore and segments are encrypted; omit it and everything stays cleartext. This page
covers turning it on, erasing a segment or a namespace by destroying its key, and why the rules are what they are.

What it protects: the `.crbm` objects are encrypted (payloads, the chunk index and any metadata), and so is the
registry row's summary of the current generation, so a leaked bucket reveals no ids and none of your metadata.
Sizes still leak, because nothing is padded: an object's byte size bounds the set's size, and gives the exact id count
of a set that fits one chunk stored as an array (up to 4,096 ids in one 65,536-id range); its chunk index's length,
which the footer keeps in the clear, bounds the number of chunks it holds
([the format, section 8](../format.md#8-encryption-at-rest)). The segment name and generation are still visible in each
object's key. It also supports
**crypto-shred**: GDPR "right to erasure" that works even on immutable or backed-up storage.

## Before you encrypt

Read these first. They are the traps.

- **Lose the key and the data is gone.** You hold one root key, a **KEK** of 32 bytes, and bring it yourself. If you
  lose every KEK for a segment, its at-rest bytes are unrecoverable, by design: there is no backdoor, which is also
  what makes crypto-shred work. Keep the KEK in your secrets manager (Vault, AWS Secrets Manager, an HSM) with
  versioning, like a database password. The encrypted data and the wrapped keys are useless without it.
- **Encryption is decided at a segment's first generation and cannot be switched.** Wiring a keystore does not
  encrypt a segment that already has a cleartext generation. To encrypt data that is already stored, load it into a
  new segment with the keystore wired, then drop the old one (`dropSegment`, or `destroySegment` if the old segment
  was itself encrypted).
- **The keystore applies to every segment the store touches**, including the ones you meant to leave cleartext. It is
  wired on the store, not on a segment. Use a separate store for cleartext segments, or set
  `encryption: { required: true }` so a cleartext write or read throws.
- **Back up the keystore with your data.** [The disaster-recovery guide](disaster-recovery.md#encryption--dr) covers
  what a restore needs.
- **A lost key is usually not a business loss.** Segments are almost always derived data, so you load it again from
  source into a new segment. The lost segment itself cannot be reloaded: its row still carries the key material that
  is gone, so a load onto it throws `KeyUnavailableError`.

## Turn it on

Each segment gets its own random **DEK**, wrapped under your KEK and stored in the registry. The chunks and the index
are AES-256-GCM-encrypted with the DEK, under associated data that binds each blob to its namespace, segment,
generation and purpose (a chunk and its key, the index, the metadata or the summary).

```ts
import { CloudRoaring, InProcessKeystore, LocalFsStorage } from '@cloudbitmaps/roaring';

// Your function: reads the 32-byte KEK from your secrets manager.
declare function loadKekFromSecrets(): Uint8Array;
// Your function: yields the ids to load.
declare const ids: Iterable<number>;

const keystore = new InProcessKeystore({
  keys: { '2026-06': loadKekFromSecrets() }, // each value is a 32-byte Uint8Array
  activeKeyId: '2026-06',
  // recoveryKeyId: 'offline-escrow',         // optional: also wrap under an offline recovery KEK
});

const backend = new LocalFsStorage('./.cloudbitmaps');
// The keystore is wired once, on the store, and applies to both the load and the read.
const store = new CloudRoaring({ storage: backend, encryption: { keystore } });

// The DEK is minted and wrapped into the registry on the first publish; later loads reuse it.
await store.load({ segment: 'pii' }, ids);

// The store unwraps the key and decrypts on read. Without the keystore this throws KeyUnavailableError.
await store.segment('pii').count();
```

Every later write to that segment reuses its DEK: a reload through `store.load` on a store wired with the keystore,
an `*Into` verb on such a store, and the erasure rewrite. Loading a cleartext generation onto an encrypted segment is
refused with `KeyUnavailableError`, before anything is written. A cleartext first load that the segment's first
encrypted load overtakes after its object is written is refused at its publish instead, as `superseded`, and its
cleartext object is deleted. With `encryption: { required: true }`, any cleartext write or read throws. An erasure reads a cleartext
segment's current generation, so on such a store it is refused: `eraseSubject` lists the segment as an `error:` entry
whatever id it erases, and `subjectReport` throws `KeyUnavailableError`, so run them from a store that can read every
segment in scope. A cleartext object left under a tombstone, or a first load's object on a segment with no generation
yet, is still searched and deleted.

**Rotate keys without re-encrypting data.** Add a new KEK, point `activeKeyId` at it, and keep the old KEK: old
segments keep decrypting. Use a **recovery KEK**, kept offline, so that losing the active one is not fatal.

**KMS and Vault.** The default is dependency-free, in-process, bring-your-own-key. `IKeystore` is the interface a KMS
or Vault adapter would implement; none ships, and encryption never forces a cloud dependency on you. It is exported by
`@cloudbitmaps/core/driver-kit`, with `WrappedDek`, `Aead` and `AeadSealed`, the types its methods name.

## Erase a segment or a namespace (crypto-shred)

Destroying a segment's wrapped key removes it from the segment's current registry row. Every copy of the encrypted
objects, backups and WORM copies included, is then unreadable once no retained copy of that row still holds the
wrapped key, or once every KEK that wrapped it is destroyed ([disaster recovery](disaster-recovery.md#encryption--dr)).
Neither call can be undone through the library (a registry restore to a point before it can), so each makes you name
the exact segment or namespace as confirmation.

```ts
import { destroySegment, eraseNamespace } from '@cloudbitmaps/roaring';

// Free functions over the backend's registry.
const one = await destroySegment({ segment: 'pii' }, { registry: backend.registry }, { confirmSegment: 'pii' });
// one.reason is 'cleartext' for a segment with no key to shred: nothing changed (see below).

// Or a whole namespace, with one result per segment. Inspect them:
const { destroyed } = await eraseNamespace('tenant-42', { registry: backend.registry }, {
  confirmNamespace: 'tenant-42',
});
for (const r of destroyed) if (!r.destroyed) console.warn(r.segment, r.reason); // still holds data
```

What happens: the call deletes the segment's wrapped DEK from its current registry row and leaves a `destroyed`
tombstone. The encrypted objects stay in the bucket, and nothing that opens the segment through that row can read
them; any retained earlier copy of the row (a noncurrent version, a backup) still holds the wrapped DEK until your
storage expires it. The segment reads as empty to a store that opens it
afresh, and a load refuses a destroyed segment, so a load racing an erasure cannot bring it back. To also reclaim the
storage, use `dropSegment` ([retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt)): it
crypto-shreds an encrypted segment and deletes its objects.

- **A store that already has the segment open keeps decrypting** until it re-resolves the segment. These are free
  functions over the registry, so they invalidate no store. That takes at most `cache.genTtlMs` (default 2 s) on a
  store with a registry, or until you call `store.invalidate(ref)` on it. [Erasure](erasure.md#find-an-id-and-erase-it) has the table.
- **A cleartext segment has no key to shred.** `destroySegment` on one changes nothing and returns
  `{ destroyed: false, cryptoShredded: false, reason: 'cleartext' }` instead of throwing. `eraseNamespace` leaves such
  segments as they are and reports each the same way. `allowCleartext: true` tombstones them anyway, which stops them
  resolving but leaves their bytes readable in the bucket, and the call emits a `segment.tombstone` audit event for each
  tombstone it writes, which says so (`objectsReadable: true`) and is not an erasure receipt. `dropSegment` is the call
  that deletes them.
- **`destroySegment` reports why it did nothing.** `reason` is `'cleartext'` for a segment with no key, `'absent'` for no
  row, and `'already'` for a tombstone.
- **A shred that throws `TransientError` may have landed.** A shred that gets no answer reads the row back, and
  reports the shred as done when the row shows its own tombstone. When that read fails too, it throws the
  `TransientError`, and the segment may already be destroyed. A re-run then answers
  `{ destroyed: true, cryptoShredded: false, reason: 'already' }` and emits no `segment.erase`, because the tombstone
  does not record which call wrote it or that it was a crypto-shred. If the re-run answers `'already'` for a segment
  you had not destroyed before, record its crypto-shred yourself, with the error. `eraseNamespace` reports that
  segment as `failed: …` with `destroyed: false`, and a retention sweep reports it as `retired` with a `fault` and
  `cryptoShredded: true` and emits no `segment.erase` for it. When the sweep cannot read the row afterwards either,
  its entry is `skipped` with a reason that says the tombstone may have landed. The same holds for a cleartext
  destroy, whose re-run emits no `segment.tombstone`.
- **`eraseNamespace` returns one `DestroyResult` per segment** and records per-segment faults instead of throwing:
  `reason: 'contended'` or `` `failed: ...` ``, with `destroyed: false`, means the segment still holds data. Inspect
  them. A `maxScanSegments` that is not a whole number of at least 1 throws `ValidationError`.
- **`eraseNamespace` shreds eight segments at a time.** Each segment still has its own read and compare-and-swap, and
  a fault in one is recorded against it and stops no other. `destroyed` is in the order the registry listed the segments, which is unspecified and differs between backends (match entries by `segment`), whichever segment
  finishes first; the `segment.erase` events are emitted as each segment finishes, so their order is not the
  listing's, and `namespace.erase` comes last.
- **`eraseNamespace` lists the whole namespace before it destroys anything**, and holds the listing in memory, so it
  stops at the ceiling every fleet scan keeps: `maxScanSegments`, default 250,000. A namespace over it throws
  `BudgetExceededError` with nothing erased. Pass a higher `maxScanSegments` when the namespace really is that large.

## What an encrypted read costs

When an encrypted segment's read opens a generation's object (a cold open, or one after the reader cache let the
segment go), it asks your keystore to unwrap the key and reads the object's tail from storage. The two do not depend
on each other, so an open that starts from the object (`iterate`, a combine, a pin) sends them together and takes the
longer of the two, not the sum. Nothing from the tail is read before the key opens it: the tail's bytes stay untrusted
until the footer has been held to the row's summary and the index has been decrypted.

If the keystore fails, the read raises the keystore's error (`KeyUnavailableError`, or whatever your keystore throws,
`TransientError` included) even when the object is also missing. An open that sent its tail early (every one but a
`has()`'s first) has already sent that GET, so it is billed once for each attempt, and its answer is dropped: with the
default read retry, a keystore that keeps throwing `TransientError` bills up to four tail reads for one read. A cold
open waiting for the key holds up to the reader's first tail read, a fixed 256 KiB, of the object's tail. A store with no keystore
sends no tail read for an encrypted row.

The tail read of an encrypted row is not sized from the row's summary, as a cleartext row's is: the summary is sealed
under the key, so sizing from it would send the tail read after the key, which is the wait the overlap removes for an open that starts from the object (a cold `has()` waits for the key first either way). A
segment whose index is longer than the 256 KiB tail read (tens of thousands of chunks) therefore costs one range read
for the index after the tail read, where the same cleartext segment costs none.

A `has()` asks for the segment's version first, and the version needs the key, because the row's summary is sealed under
it. Its first open therefore waits for the key before it opens the object, with nothing to overlap; an open it makes
again after a failed one overlaps like the others.

## What is sealed where

Each piece of a segment is stored in one place, in the clear or sealed under the segment's key (AES-256-GCM, with the
segment's namespace and name, the generation, the blob's purpose and, for a chunk, its key bound into the
authenticated data, so a blob cannot be moved to another segment, another generation or another purpose):

| What | Where | Encrypted segment |
|---|---|---|
| the ids: each chunk's payload | the generation's object | sealed |
| the chunk index, and with it the id count and chunk count | the generation's object | sealed. The footer's count fields are zero, but the index's length is in the clear and bounds the chunk count (8 to 13 bytes an entry as written today), and the payload sizes still bound the id count |
| your metadata for the generation | the object's extension block | sealed, bound to its own purpose |
| the current generation's id count, object size, footer checksum, tail size and metadata | the registry row's summary | sealed: fixed-width numbers, then the metadata, so the length reveals only the metadata's size, never how many digits the count has |
| the data key | the registry row, wrapped under each KEK | wrapped; removed by a crypto-shred |
| the namespace and segment name | the object's key and the registry row | clear |
| the random write id (`cbwid`) | each generation object's metadata, and an Azure Blob registry row's | clear |
| the pointer, status, retention and residency policy, timestamps, token and `pointerId`, any key id, leases, and the ledger of known generations (each generation's number and its object's footer checksum) | the registry row | clear |
| the object's footer (format version, flags, generation, index offset and length, checksum) | the generation's object | clear |

On a **cleartext** segment the object's metadata and the row's summary are in the clear, like everything else in that
object and row.

Three things follow:

- **Whether an encrypted object has a metadata block is not authenticated.** Removing the block takes no key, because
  the block is an optional region before the index, and a reader that finds none reads none. The block's content is
  authenticated, and so is the row's sealed summary, which says there was metadata. An object that disagrees with the
  row about it is one someone with write access to the bucket changed.
- **A sealed summary moved to another generation's row does not open.** The summary names its generation and is sealed
  for it, so a copy placed on a row that names another generation fails its authentication.
- **A crypto-shred removes the summary with the key.** It could not be opened again, and a clear copy would outlive the
  segment on its tombstone, so the shred clears both.

**An error message can name what the seal hides.** An `IntegrityError` names the chunk it refused, by its key (the high
16 bits of the ids it holds), and a count mismatch gives the two counts, on an encrypted segment as on a cleartext one.
The key comes from the index, which opens only under the segment's key, but a chunk's stored bytes are checked against
their CRC32C before they are authenticated, so anyone who can change the object, or a storage fault, can make a read
raise an error that names a sealed chunk key. A count mismatch is raised only after both counts authenticated. A short
read of a range, which names a byte range taken from the sealed index, is raised before authentication. Treat these
messages as carrying what the seal hides.

## How it stays correct

[Each chunk is sealed with a fresh random 96-bit nonce](correctness.md#seal-count), and a repeated nonce stays
negligibly likely below about 2³² seals under one key, a limit nothing counts and far past any realistic workload. A
segment's encryption [is decided at its first generation, so a segment is never
half-encrypted](correctness.md#never-half-encrypted): a load onto a cleartext segment stays cleartext, or is refused
with `encryption: { required: true }`, and an encrypted generation is never published onto a row with no key material.
The seal count, and why a half-encrypted segment is refused either way round, are in [How encryption stays
correct](correctness.md#how-encryption-stays-correct).
