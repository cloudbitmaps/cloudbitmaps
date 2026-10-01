# Encryption at rest

Encryption is opt-in: pass a keystore and segments are encrypted; omit it and everything stays cleartext. This page
covers turning it on, erasing a segment or a namespace by destroying its key, and why the rules are what they are.

What it protects: the `.crbm` objects are encrypted (payloads and the chunk index), so a leaked bucket reveals
neither ids nor cardinality. The segment name and generation are still visible in each object's key, and an object's
byte size still implies a rough upper bound on the set's size, because there is no padding. It also supports
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
are AES-256-GCM-encrypted with the DEK, under data bound to `(segment, generation)`.

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
refused with `KeyUnavailableError`. With `encryption: { required: true }`, any cleartext write or read throws.

**Rotate keys without re-encrypting data.** Add a new KEK, point `activeKeyId` at it, and keep the old KEK: old
segments keep decrypting. Use a **recovery KEK**, kept offline, so that losing the active one is not fatal.

**KMS and Vault.** The default is dependency-free, in-process, bring-your-own-key. `IKeystore` is the interface a KMS
or Vault adapter would implement; none ships, and encryption never forces a cloud dependency on you.

## Erase a segment or a namespace (crypto-shred)

Destroying a segment's wrapped key makes its encrypted objects permanently unreadable, everywhere, backups included.
Both calls are irreversible, so each makes you name the exact segment or namespace as confirmation.

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

What happens: the call deletes the segment's wrapped DEK from the registry and leaves a `destroyed` tombstone. The
encrypted objects stay in the bucket but can no longer be read. The segment reads as empty to a store that opens it
afresh, and a load refuses a destroyed segment, so a load racing an erasure cannot bring it back. To also reclaim the
storage, use `dropSegment` ([retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt)): it
crypto-shreds an encrypted segment and deletes its objects.

- **A store that already has the segment open keeps decrypting** until it re-resolves the segment. These are free
  functions over the registry, so they invalidate no store. That takes at most `cache.genTtlMs` (default 2 s) on a
  store with a registry, or until you call `store.invalidate(ref)` on it. [Erasure](erasure.md#find-an-id-and-erase-it) has the table.
- **A cleartext segment has no key to shred.** `destroySegment` on one changes nothing and returns
  `{ destroyed: false, cryptoShredded: false, reason: 'cleartext' }` instead of throwing. `eraseNamespace` leaves such
  segments as they are and reports each the same way. `allowCleartext: true` tombstones them anyway, which stops them
  resolving but leaves their bytes readable in the bucket. `dropSegment` is the call that deletes them.
- **`destroySegment` reports why it did nothing.** `reason` is `'cleartext'` for a segment with no key, `'absent'` for no
  row, and `'already'` for a tombstone.
- **`eraseNamespace` returns one `DestroyResult` per segment** and records per-segment faults instead of throwing:
  `reason: 'contended'` or `` `failed: ...` ``, with `destroyed: false`, means the segment still holds data. Inspect
  them. A `maxScanSegments` that is not a finite number of at least 1 throws `ValidationError`.
- **`eraseNamespace` lists the whole namespace before it destroys anything**, and holds the listing in memory, so it
  stops at the ceiling every fleet scan keeps: `maxScanSegments`, default 250,000. A namespace over it throws
  `BudgetExceededError` with nothing erased. Pass a higher `maxScanSegments` when the namespace really is that large.

## How it stays correct

**A segment is never half-encrypted.** A segment's encryption is decided at its first generation. Wiring a keystore
does not retroactively encrypt a segment that already has a cleartext generation: that load stays cleartext, and
with `encryption: { required: true }` it is refused with a `ValidationError` instead of silently downgraded. The
reason is that one segment cannot be half-encrypted. A pin of a superseded cleartext generation, once its reader is
reopened, would find bytes its key cannot open. And `destroySegment` would attest that shredding one DEK made every
copy unreadable, while the older cleartext objects stay readable from any of them.

The same rule from the other side: publishing an encrypted generation onto a segment whose row carries no key
material is refused. The only two silent outcomes there are an unreadable generation or an audit trail that claims too
much.
