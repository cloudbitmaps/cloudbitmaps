# Releasing CloudRoaring

New versions of `@cloudbitmaps/core` and `@cloudbitmaps/roaring` are published by an **automated, tokenless,
human-gated** pipeline — you never run `npm publish` by hand. This is the map to that pipeline, which lives in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

The two packages release **in lockstep**: one version number, one tag, both published together. `roaring`
depends on `core`, and `pnpm -r publish` walks the workspace in topological order so `core` lands first.

## Table of contents

- [TL;DR — cutting a release](#tldr--cutting-a-release)
- [What the automation does](#what-the-automation-does)
- [Why tokenless](#why-tokenless)
- [One-time setup](#one-time-setup)
- [First publish (bootstrap)](#first-publish-bootstrap)
- [Manual / break-glass release](#manual--break-glass-release)
- [Troubleshooting](#troubleshooting)

## TL;DR — cutting a release

1. **Land everything on `main`** with the gate green and `CHANGELOG.md` updated.
2. **Bump both package versions** to the new number in one commit (`packages/core/package.json` and
   `packages/roaring/package.json` — they must match exactly, and the workflow enforces it).
3. **Tag and push:** `git tag v0.1.0 && git push origin v0.1.0`.
4. **Approve the deployment** — the run pauses on the `release` environment. Open the run → _Review
   deployments_ → approve `release`.
5. It publishes both packages, tokenlessly, with a signed provenance attestation.

The approval prompt is the last point at which a release can be stopped. Nothing reaches npm before it.

## What the automation does

A pushed `v*.*.*` tag (or a manual dispatch) starts one gated job that, in order:

- **Re-runs the entire gate** against the exact commit being published — `lint · lint:arch · format:check ·
  typecheck · test · build · smoke`. A green `main` is necessary but not sufficient; the tagged commit is
  re-verified from scratch on a clean runner with `--frozen-lockfile`.
- **Refuses a mistagged release** — every publishable package's `version` must equal the tag, or the run fails.
- **Refuses a still-private package.** `pnpm publish` *silently skips* a package with `"private": true` and
  exits 0, so before launch a real publish attempt would otherwise produce a fully green run that published
  nothing at all. The workflow fails loudly instead. Clearing `private` is what makes the release commit real.
- **Publishes tokenlessly with provenance**, then the attestation is verifiable on npm.

Every `uses:` is pinned to a full commit SHA, so a moved tag can't inject code. Dependabot bumps the SHA and
the human-readable version comment together, monthly.

## Why tokenless

There is **no `NPM_TOKEN`** anywhere — not in the repo, not in Actions secrets, not on a laptop. npm
authenticates the publish directly from this workflow's GitHub **OIDC identity** ("Trusted Publishing").

That matters for three reasons:

- **There is no secret to leak.** A long-lived publish token is the single highest-value credential a library
  repo holds: it can ship arbitrary code to every consumer. The safest version of it is one that doesn't exist.
- **It survives a compromised dependency.** A malicious postinstall in CI can read environment secrets. It
  cannot mint an OIDC token bound to this workflow and environment.
- **It's what makes the npm hardening usable.** Each package is set to *"require two-factor authentication and
  disallow tokens"*, which **rejects an automation-token publish outright**. Token auth and that setting are
  mutually exclusive; Trusted Publishing isn't a token, so it passes. Choosing the token model would have meant
  silently dropping the hardening — the trap this pipeline is built to avoid.

This mirrors the sibling projects (`onadiet`, `babystack`), which use the same tokenless + gated model.

## One-time setup

Configured once, outside this file; documented here so the pipeline can be rebuilt or audited.

**npm** — per published package (`@cloudbitmaps/core`, `@cloudbitmaps/roaring`):

- Account-level 2FA enabled — ideally a passkey or hardware key. Once tokens are gone, the account is the root
  of trust.
- Publishing access set to **"Require two-factor authentication and disallow tokens"**.
- A **Trusted Publisher** bound to repo `cloudbitmaps/cloudbitmaps`, workflow `release.yml`, environment
  `release`, action `npm publish`.

> **Bootstrap: the package must exist before you can bind a publisher to it.** A Trusted Publisher is a
> per-package setting, so there is nothing to configure until the name is on the registry. The sibling projects
> (`onadiet`, `babystack`) both hit this and both solved it the same way: **publish the first version manually
> with interactive 2FA, then bind the publishers, then every release after that is automated.** See
> [First publish](#first-publish-bootstrap) — it is a one-time step, not a permanent token.

**GitHub:**

- A **`release` environment** with the maintainer as a **required reviewer** — that reviewer is the approval
  gate; without it the publish job runs unpaused. Restrict deployments to protected branches and tags.
- `main` **branch-protected**: PRs required, force-pushes and deletions blocked.
- Account 2FA.

## First publish (bootstrap)

**One time only, and only because a Trusted Publisher cannot be bound to a package that does not exist yet.**

A manual publish carries **no provenance attestation** — provenance attests to a *workflow* identity, and a
laptop has none. Left there, the **launch artifact** would be the single unattested tarball, which sits badly
against a project whose supply-chain story is the point. So the bootstrap uses a **throwaway prerelease** to
create the names, and the real `0.1.0` still ships through the gated, attested pipeline.

The cost is one prerelease sitting on the registry forever, and a short window where it is what `npm i`
resolves — see the note below.

> [!IMPORTANT]
> **`--tag rc` is not optional, and it is also not sufficient.** `npm publish` defaults `--tag` to `latest`
> *unconditionally* — check `npm config get tag` — and it is **not** semver-aware. "Prereleases aren't installed
> by default" is a property of *range resolution*, and it only holds while `latest` points somewhere else. On a
> package's **first** publish there is nothing else for it to point at.
>
> Passing `--tag rc` states the intent and is what the automation asserts. But a registry may *also* point
> `latest` at a first publish regardless — verified against a real registry, where it does — and there is no
> undo: npm refuses to remove the `latest` tag. So the honest position is that the prerelease may briefly be
> what a plain `npm i @cloudbitmaps/roaring` serves, and **the fix is to finish the remaining steps promptly**,
> because the real `0.1.0` claims `latest` and the window closes. `pnpm release:bootstrap` reports which of the
> two happened rather than guessing.

**The sequence** (each step gates the next — this order is not incidental):

1. **Repo public first.** The GitHub repo must exist and be public before publishing, so the packages'
   `repository`/`homepage` links resolve and provenance has a public source to attest to.
2. **Cut the prerelease commit** — set both packages to `0.1.0-rc.0` and remove `"private": true`
   (that flag is the accidental-publish guard; clearing it is what makes any publish real).
3. **Publish it manually**, with interactive 2FA. Use the guarded helper rather than typing this by hand — it
   verifies every precondition below *before* the irreversible step, and requires `--confirm`:

   ```sh
   npm login                            # interactive 2FA — npm's own auth, not something pnpm wraps
   pnpm release:bootstrap               # dry run: checks everything, publishes nothing
   pnpm release:bootstrap --confirm
   ```

   Equivalent by hand, if you'd rather:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm -r --filter './packages/**' publish --access public --tag rc
   ```

   Both names now exist on the registry, with **no `latest` tag**. This tarball is unattested, by design —
   nobody installs it.
4. **Do the [one-time setup](#one-time-setup)** — now that the packages exist, bind a Trusted Publisher to each
   and set publishing access to *require 2FA and disallow tokens*. From here a token publish is impossible.
5. **Create the GitHub `release` environment** with yourself as required reviewer.
6. **Ship the real release**: bump both to `0.1.0`, commit, `git tag v0.1.0 && git push origin v0.1.0`. The
   workflow runs the full gate, pauses for your approval, and publishes **tokenlessly with provenance**.

After step 6 the manual path is never used again except as [break-glass](#manual--break-glass-release).

## Manual / break-glass release

Only if the pipeline is down and a release genuinely cannot wait. Requires npm ≥ 11.5.1 and your **interactive
npm 2FA** — automation tokens are disallowed by design, so there is no unattended fallback, deliberately.

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm lint:arch && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm -r --filter './packages/**' publish --access public
git push --follow-tags
```

Note this path publishes **without provenance** (there is no workflow identity to attest to), so prefer the
automated flow. This exists so a broken pipeline never blocks a critical security fix.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `tag v0.1.0 does not match <pkg> version …` | The two package versions and the tag disagree. Fix the manifests, delete and re-push the tag. |
| `… still has "private": true` | Expected before launch. The release commit that clears `private` is what makes a publish real. |
| Publish rejected: token not permitted | Something re-introduced token auth. The packages disallow tokens; the workflow must authenticate via OIDC. |
| `npm error unable to authenticate` on a fresh package | The Trusted Publisher binding is missing or its repo/workflow/environment don't match exactly. |
| The run never pauses for approval | The `release` environment has no required reviewer — the gate is the reviewer, not the environment. |
| Provenance missing on the published package | `id-token: write` was dropped, or the job ran on a self-hosted runner. Provenance needs a GitHub-hosted runner's OIDC identity. |
| `npm i @cloudbitmaps/roaring` serves a prerelease | `latest` landed on the bootstrap version — either because `--tag` was omitted (`npm publish` defaults to `latest` and is not semver-aware) or because the registry assigned it to the package's first version anyway. **Do not chase `npm dist-tag rm … latest`** — npm refuses to remove `latest`. Ship the real release; it claims `latest` and closes the window. |
| `EUSAGE: Automatic provenance generation not supported for provider: null` | Something is asking for provenance outside CI. Provenance needs a workflow's OIDC identity, so it is opt-in at the call site (`--provenance`, in `release.yml` only) and deliberately **not** set via `publishConfig.provenance`, which cannot be overridden from the CLI or the environment and made every manual publish impossible. |
| `bootstrap-publish: … already exists on the registry` | Working as intended — the bootstrap is one-time. Ship the version by tag through the pipeline instead. |
| A publish logs `PUT 200` but `npm view` 404s for minutes | npm ACKs on the write path and serves reads from a replica that lags — **measured at ~7 minutes** for a brand-new package. The publish succeeded. Confirm with `npm access get status <pkg>`, which reads the authoritative API; `npm view --prefer-online` only defeats npm's *local* cache, not the replica. The bootstrap waits this out rather than reporting a failure. |
