# Encryption at rest

Encrypting segments, and erasing one by destroying its key.

## Encryption at rest + crypto-shred

Encrypt the Storage `.crbm` objects so a leaked bucket reveals **neither ids nor cardinality** (payloads *and* the
chunk index are encrypted; the object's segment name + generation are still visible in its key, and its byte
size still implies a rough upper bound on size — no padding), and support **crypto-shred** — GDPR "right to
erasure" that works even on immutable/backed-up storage. Encryption is **opt-in**: pass a *keystore* and it's
on; omit it and everything stays cleartext.

You hold one root key — a **KEK** (32 bytes) — and bring it yourself (BYOK); there's **no required cloud
dependency**. Each segment gets its own random **DEK** that's wrapped under your KEK and stored in the registry;
the Storage chunks + index are AES-256-GCM-encrypted with the DEK, under an AAD bound to `(segment, generation)`.

```ts
import { CloudRoaring, InProcessKeystore, LocalFsStorage } from '@cloudbitmaps/roaring';

// Your KEK(s) — load from your secrets manager; keyId-aware so you can rotate without re-encrypting data.
const keystore = new InProcessKeystore({
  keys: { '2026-06': loadKekFromSecrets() }, // each value is a 32-byte Uint8Array
  activeKeyId: '2026-06',
  // recoveryKeyId: 'offline-escrow',         // optional: also wrap under an offline recovery KEK
});

const backend = new LocalFsStorage('./.cloudbitmaps');
// The keystore is wired once, on the store, and applies to both the load and the read.
const store = new CloudRoaring({ storage: backend, encryption: { keystore } });

// Load encrypted (the DEK is minted + wrapped into the registry on the first publish; later loads reuse it):
await store.load({ segment: 'pii' }, ids);

// Read encrypted — the backend carries the wrapped DEK in its registry; the store unwraps and decrypts transparently:
await store.segment('pii').count(); // works; without the keystore this throws KeyUnavailableError
```

Every later write to that segment reuses its DEK: a reload through `store.load` (on a store wired with the
keystore —
loading a cleartext generation onto an encrypted segment is refused with `KeyUnavailableError`, because that
would let a later crypto-shred over-attest), an `*Into` verb on a store wired with the keystore, and the erasure
rewrite. To enforce encryption everywhere, set `encryption: { required: true }` on the store — any cleartext write/read then throws.

**A segment's encryption is decided at its first generation, and cannot be switched later.** Wiring a keystore
does not retroactively encrypt a segment that already has a cleartext generation: that load stays cleartext, and
with `encryption: { required: true }` it is refused with a `ValidationError` rather than silently downgraded. The reason
is that one segment cannot be half-encrypted — a pin of a superseded cleartext generation, once its reader is
reopened, would find bytes its key cannot open, and `destroySegment` would attest that shredding one DEK made every copy unreadable
while the older cleartext objects stay readable from any of them. The same rule from the other side: publishing
an encrypted generation onto a segment whose row carries no key material is refused, because the only two silent
outcomes are an unreadable generation or an over-attesting audit trail.

So **to encrypt data that is already stored, load it into a new segment with the keystore wired and drop the old
one** (`dropSegment`, or `destroySegment` if the old segment was itself encrypted). This matters because a
keystore is wired on the *store*, so it is in scope for every segment that store touches — including the ones
you meant to leave cleartext.

### Crypto-shred (erase a segment / namespace)

```ts
import { destroySegment, eraseNamespace } from '@cloudbitmaps/roaring';

// Free functions over the registry half of the backend. Irreversible — name the exact segment as confirmation:
const one = await destroySegment({ segment: 'pii' }, { registry: backend.registry }, { confirmSegment: 'pii' });
// one.reason is 'cleartext' for a segment with no key to shred: nothing changed (see below).

// or a whole namespace, with one result per segment — inspect them:
const { destroyed } = await eraseNamespace('tenant-42', { registry: backend.registry }, {
  confirmNamespace: 'tenant-42',
});
for (const r of destroyed) if (!r.destroyed) console.warn(r.segment, r.reason); // still holds data
```

`eraseNamespace` lists the whole namespace before it destroys anything, and holds that listing in memory, so it stops
at the ceiling every other fleet scan keeps: `maxScanSegments`, default 250,000. A namespace over it throws
`BudgetExceededError` with **nothing erased**; pass a higher `maxScanSegments` when the namespace really is that
large and the memory is there.

This deletes the segment's wrapped DEK from the registry (a `destroyed` tombstone). The encrypted Storage objects
are left in place — but with the key gone they're **permanently unreadable, everywhere, including backups**. The
segment then reads as empty to a store that opens it afresh, and the tombstone is a fence: a load refuses a
destroyed segment, so a load racing an erasure cannot resurrect it. A store that
already had the segment open is another matter: these are free functions over the registry, so they invalidate no
store, and one that holds the unwrapped key keeps decrypting with it until it re-resolves the segment — within
`cache.genTtlMs` (default 2 s) on a store with a registry and a positive TTL — or until `store.invalidate(ref)` is
called on it ([erasure](erasure.md#subject-access--erasure-gdpr-art-15--17) has the table). To also reclaim the storage, use
`dropSegment` ([retention](retention.md#retention-ttl-and-pruning--what-exists-and-what-doesnt)), which crypto-shreds an
encrypted segment *and* deletes its objects.

**A cleartext segment has no key to shred.** `destroySegment` on one changes nothing and returns
`{ destroyed: false, cryptoShredded: false, reason: 'cleartext' }` rather than throwing, and `eraseNamespace` leaves
such segments as they are and reports each the same way. `allowCleartext: true` tombstones them anyway, which
stops them resolving but leaves their bytes readable in the bucket; `dropSegment` is the call that deletes them.

### ⚠️ Read this before you turn on encryption — key management

- **The KEK is the one thing to back up.** It's 32 bytes — store it in your secrets manager (Vault, AWS Secrets
  Manager, 1Password, an HSM) with versioning, exactly like a database password. The encrypted data and the
  wrapped DEKs are useless without it.
- **If you lose every KEK for a segment, its at-rest bytes are gone — by design.** There is no backdoor (that's
  the whole point — a leaked bucket has no backdoor either). This is also what makes crypto-shred *work*.
- **But it's usually not catastrophic:** CloudBitmaps segments are almost always **derived data** (audience /
  membership sets built from your primary datastore), so a lost KEK means **load it from source into a new
  segment** (`store.load()` with the new keystore), not permanent business-data loss. The lost segment itself
  cannot be reloaded: its row still carries the key material that is gone, so a load onto it throws
  `KeyUnavailableError`.
- **Rotate, don't lose.** Add a new KEK, point `activeKeyId` at it, and **keep the old KEK** — old segments keep
  decrypting with no data re-encryption. Use a **recovery KEK** (kept offline) so losing the active one isn't
  fatal.
- **KMS/Vault.** The default is dependency-free in-process BYOK. `IKeystore` is the interface a KMS or Vault
  adapter would implement; none ships, and encryption never forces a cloud dependency on you.
