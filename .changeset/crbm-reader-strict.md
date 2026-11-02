---
'@cloudbitmaps/core': minor
---

The `.crbm` reader refuses an object that carries bytes no release writes: a non-zero footer `reserved2` or `keyId`, a non-zero `indexTag` on a cleartext object, a non-zero preamble byte 6 or 7, bytes between the index and the footer, a gap between payloads or after the last one, and bytes after a stored chunk's bitmap.
