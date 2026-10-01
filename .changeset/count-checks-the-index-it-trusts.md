---
"@cloudbitmaps/core": minor
"@cloudbitmaps/roaring": minor
---

An open refuses an index that is not internally consistent: an entry whose payload runs into the index, and an
encrypted entry too short for its nonce and tag, now throw `IntegrityError` where `count()` summed them and returned,
which pre-`1.0` is a minor bump. `count()` still answers from the index without decoding a payload, so a corrupt index
that is internally consistent still yields a wrong count; the guide, the API reference, `SECURITY.md` and the TSDoc
say so. The user-facing entries are in the root `CHANGELOG.md`, under `[Unreleased]`: `Breaking` and `Fixed`.
