# Changesets

This directory holds unreleased change descriptions. `pnpm changeset` adds one; `pnpm version:packages`
consumes every file here, bumps all five manifests, and deletes them.

**Changesets is used here as a version bumper and nothing else.** Two of its defaults are deliberately off,
and both would be regressions if switched on:

- **`"changelog": false`.** This project keeps **one curated root `CHANGELOG.md`** in Keep-a-Changelog form,
  and `scripts/changelog-section.cjs` extracts a single version's section from it for the GitHub Release
  notes — so the release body and the changelog cannot drift, because the tag just quotes the file. Letting
  changesets generate five per-package changelogs would leave the root file unmanaged, split the source of
  truth in two, and point the release notes at the half that is no longer written by hand. The curated split
  also exists for a measured reason: the `0.10.0` release body came to 119,450 characters against GitHub's
  120,000 limit, which is only checked *after* the tag is pushed.

  **So a changeset's body is not published anywhere.** Write the user-facing entry under `[Unreleased]` in
  the root `CHANGELOG.md`, in the same change. The changeset file exists to carry the *bump type*.

- **`changeset publish` is not used.** Publishing goes through `.github/workflows/release.yml`, which is
  tokenless (OIDC against a Trusted Publisher), provenance-signed, gated on a human approval, and carries
  pre-flight probes that refuse an unbootstrapped name or a version already on the registry — because
  `pnpm publish` *silently skips* a version that is already there and exits 0. Those guards are the reason
  a partial release has not happened; `changeset publish` has none of them.

## `"fixed"` is a glob on purpose

`[["@cloudbitmaps/*"]]` rather than the five names written out. All five packages ship in **lockstep** — one
version across the family — and `tests/index.test.ts` enforces that by reading the package list off the
filesystem. A hand-kept list in this file would be the one copy that does *not* re-derive, so a sixth package
would silently version on its own. The glob covers it on the day it is created, and changesets warns if the
pattern matches nothing at all.

## Adding one

```
pnpm changeset          # pick the bump type; every package moves together
```

Choose the bump for the **family**, since they are fixed together. Pre-`1.0`, a breaking change is a minor.
