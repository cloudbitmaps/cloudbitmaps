/**
 * `@cloudbitmaps/core/node`: the drivers that need a Node builtin, kept off the main entry so the main entry, and every
 * module it reaches, imports none and loads where no builtin exists (a V8 isolate).
 *
 * The local-filesystem backend (`node:fs`, `node:path`), the in-memory backend (`node:crypto`, for the SHA-256 a
 * write reports) and the in-process AES-256-GCM cipher and keystore (`node:crypto`). `@cloudbitmaps/roaring`
 * re-exports the two backends and the keystore by name; an application imports them from there.
 *
 * Internal, like the main entry: outside the stability promise, listed in `cloudbitmaps.internalEntries`.
 */

// The two SDK-free backends: each states its location once, so the objects and the pointer cannot be
// mismatched. Their cloud siblings ship in their own packages, where the SDK does.
export { LocalFsStorage, MemoryStorage } from './drivers/backends';
export type { LocalFsStorageOptions, MemoryStorageOptions } from './drivers/backends';

// The default in-process AES-256-GCM implementation of `Aead` and the keystore over it (`node:crypto`). The
// crypto-free pair the `.crbm` reader takes (`CrbmCrypto`, `aadFor`) is exported by the main entry, and the keystore
// port (`IKeystore`, `Aead`) by `@cloudbitmaps/core/driver-kit`.
export { NodeAead, InProcessKeystore } from './drivers/crypto';
export type { InProcessKeystoreOptions } from './drivers/crypto';
