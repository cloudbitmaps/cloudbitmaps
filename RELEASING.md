# Releasing CloudBitmaps

New versions of all five packages — `@cloudbitmaps/core`, `@cloudbitmaps/roaring`, and the
`@cloudbitmaps/s3` · `/gcs` · `/azure-blob` driver packages — are published by an **automated, tokenless,
human-gated** pipeline — you never run `npm publish` by hand. This is the map to that pipeline, which lives in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

All five packages release **in lockstep**: one version number, one tag, everything published together —
`core`, the `roaring` flavor, and the `s3` / `gcs` / `azure-blob` driver packages. Each of the four depends on
`core`, and `pnpm -r publish` walks the workspace in topological order so `core` lands first. Nothing in the
workflow names a package: it globs `packages/*/package.json` and filters `./packages/**`, and the one count
it does carry (`EXPECTED_PACKAGES`) is asserted against the real number of manifests by
[`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts).

**Adding a package is still not free**, and most of the cost is not in this file. Its **name must be
bootstrapped** before the tokenless pipeline can publish it at all (see
[Bootstrapping a name](#bootstrapping-a-name)); the rest is a checklist of the places that enumerate the
driver packages by hand, which lives in
[CONTRIBUTING → Adding a storage driver package](CONTRIBUTING.md#adding-a-storage-driver-package). Every one
of them fails loudly in `pnpm lint`, `pnpm typecheck` or `pnpm smoke` long before a publish step, which is
the right direction for it to fail in — but it is an edit, not nothing.

## Table of contents

- [TL;DR — cutting a release](#tldr--cutting-a-release)
- [What the automation does](#what-the-automation-does)
- [Why tokenless](#why-tokenless)
- [One-time setup](#one-time-setup)
- [Bootstrapping a name](#bootstrapping-a-name)
- [Manual / break-glass release](#manual--break-glass-release)
- [Troubleshooting](#troubleshooting)

## TL;DR — cutting a release

1. **Land everything on `main`** with the gate green and `CHANGELOG.md` updated.
2. **Bump EVERY package version** to the new number in one commit — every `packages/*/package.json`. They
   must all match the tag exactly; the workflow globs `packages/*/package.json` and refuses the release if
   any one disagrees, so a missed package costs a failed run rather than a partial publish.
3. **Tag and push:** `git tag v0.1.0 && git push origin v0.1.0`.
4. **Approve the deployment** — the run pauses on the `release` environment. Open the run → _Review
   deployments_ → approve `release`.
5. It publishes all five packages, tokenlessly, with a signed provenance attestation. `pnpm -r publish`
   walks the workspace in topological order, so `core` lands before the four that depend on it.

The approval prompt is the last point at which a release can be stopped. Nothing reaches npm before it.

## What the automation does

A pushed `v*.*.*` tag (or a manual dispatch) starts one gated job that, in order:

- **Re-runs the entire gate** against the exact commit being published — `lint · lint:arch · format:check ·
  typecheck · test · audit · build · smoke`. A green `main` is necessary but not sufficient; the tagged commit
  is re-verified from scratch on a clean runner with `--frozen-lockfile`. The **dependency audit** is repeated
  here rather than trusted from CI because it is the one gate whose verdict changes with *no commit at all*: an
  advisory published after `main` went green makes the same tree newly vulnerable.
- **Refuses a mistagged release** — every publishable package's `version` must equal the tag, or the run fails.
- **Refuses a still-private package.** `pnpm publish` *silently skips* a package with `"private": true` and
  exits 0, so a real publish attempt would otherwise produce a fully green run that published nothing. No
  package carries `private` today — only the workspace ROOT manifest does, and that is never published — so
  this guards against it being re-introduced rather than being a launch step still to clear.
- **Refuses a name the registry does not have, and a version it already does.** Both produce a *partial*
  release of a family that ships in lockstep, and neither is visible in the log. A brand-new package name has
  no Trusted Publisher and this pipeline is tokenless, so `pnpm -r publish` would publish the packages that
  do exist — immutably — and then fail on the new one. And a version already on the registry is *skipped*
  by pnpm with exit 0, so a re-run reports success having published nothing for that package. Two read-only
  registry probes catch both before anything irreversible happens. **Adding a package to the family means
  bootstrapping its name first** — see [Bootstrapping a name](#bootstrapping-a-name).
- **Refuses to publish without release notes** — `scripts/changelog-section.cjs` must find a non-empty section
  for the tag. The notes are *used* later, by the `github-release` job; they are *checked* here, before the
  publish, because that is the last moment a missing section is still a two-line edit rather than a permanent
  gap next to an immutable tarball.
- **Leak-scans the packed tarballs** (`pnpm leak-scan:tarballs`) — the built `.tgz` for each package is packed,
  unpacked and scanned. This is a different surface from the everyday `pnpm leak-scan`: `dist/` is gitignored,
  so the tracked-file and history modes structurally cannot see the bytes a consumer downloads, and the
  sourcemaps carry every `src` comment verbatim via `sourcesContent`. Set the optional `LEAK_SCAN_EXTRA` repo
  secret to include the private needle list and run in strict snapshot mode; without it the scan still fails on
  credentials, private keys, real email addresses and absolute local paths. The run prints which mode it chose.
- **Publishes tokenlessly with provenance**, then the attestation is verifiable on npm.

**The ordering is the design, not an accident.** Everything above the publish is recoverable; the publish is
not — an npm tarball is immutable outside a 72-hour unpublish window. So every check that can still be *fixed*
runs before the one step that cannot be undone. (The inverse mistake has already been made here once: the
GitHub Release object was briefly created before the publish it describes had succeeded, and a run produced a
release for a version that never reached npm.
[`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts) now asserts this ordering.)

The workflow also declares `concurrency: cancel-in-progress: false` — the opposite of CI. Cancelling a build is
free; cancelling a release part-way through leaves npm holding a half-published family — some of the five
packages up, the rest not — that cannot be taken back.

Every `uses:` is pinned to a full commit SHA, so a moved tag can't inject code. Dependabot bumps the SHA and
the human-readable version comment together, monthly. The npm upgrade the OIDC publish needs is pinned to a
**floor** (`npm@^11.5.1`), not `@latest`, so a regression in a same-morning npm release can't break a release
with nothing in our diff to point at.

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

**npm** — per published package (`@cloudbitmaps/core`, `@cloudbitmaps/roaring`, `@cloudbitmaps/s3`,
`@cloudbitmaps/gcs`, `@cloudbitmaps/azure-blob`). **A newly created package name starts with none of this**,
so the hardening below is part of first-publishing one, not an afterthought:

- Account-level 2FA enabled — ideally a passkey or hardware key. Once tokens are gone, the account is the root
  of trust.
- Publishing access set to **"Require two-factor authentication and disallow tokens"**.
- A **Trusted Publisher** bound to repo `cloudbitmaps/cloudbitmaps`, workflow `release.yml`, environment
  `release`, action `npm publish`.

> **Bootstrap: the package must exist before you can bind a publisher to it.** A Trusted Publisher is a
> per-package setting, so there is nothing to configure until the name is on the registry: **publish the
> first version manually with interactive 2FA, then bind the publisher, then every release after that is
> automated.** This is not only a launch step — it applies to **every package ever added to the family**.
> See [Bootstrapping a name](#bootstrapping-a-name).

**GitHub:**

- A **`release` environment** with the maintainer as a **required reviewer** — that reviewer is the approval
  gate; without it the publish job runs unpaused. Restrict deployments to protected branches and tags.
- `main` **branch-protected**: PRs required, force-pushes and deletions blocked.
- Account 2FA.

## Bootstrapping a name

**Every package name has to be created by hand once, because a Trusted Publisher cannot be bound to a package
that does not exist yet.** This ran at launch for `@cloudbitmaps/core` and `@cloudbitmaps/roaring`, and it
runs again **every time a package is added to the family** — the storage split added `@cloudbitmaps/s3`,
`/gcs` and `/azure-blob` to a workspace whose other two packages were already on npm.

> [!WARNING]
> **Do this before tagging, not after.** The release pipeline is tokenless: it authenticates by OIDC against
> a per-package Trusted Publisher, which a brand-new name does not have. `pnpm -r publish` walks the
> workspace topologically and stops at the first failure, so tagging with an unbootstrapped name in the tree
> publishes `@cloudbitmaps/core` at the new version — immutably, outside a 72-hour window — and then dies
> before the flagship. The family ships in lockstep; that leaves one package of five on the registry with no
> way back. `release.yml` now refuses the tag rather than starting, but the refusal is a backstop for this
> procedure, not a replacement for it.

A manual publish carries **no provenance attestation** — provenance attests to a *workflow* identity, and a
laptop has none. So the bootstrap creates the name at a **throwaway prerelease** and the real version still
ships through the gated, attested pipeline. `pnpm release:bootstrap` derives that prerelease from the family
version (`0.10.0` → `0.10.0-rc.0`), publishes under `--tag rc`, and puts the manifests back afterwards.

That indirection is not fastidiousness. Publishing the real version by hand would burn it: `pnpm publish`
**silently skips** a version already on the registry and exits 0, so the pipeline would then skip that
package on the real tag and report a green release having published nothing for it.

> [!IMPORTANT]
> **`--tag rc` is not optional, and it is also not sufficient.** `npm publish` defaults `--tag` to `latest`
> *unconditionally* — check `npm config get tag` — and it is **not** semver-aware. "Prereleases aren't installed
> by default" is a property of *range resolution*, and it only holds while `latest` points somewhere else. On a
> package's **first** publish there is nothing else for it to point at.
>
> Passing `--tag rc` states the intent and is what the automation asserts. But a registry may *also* point
> `latest` at a first publish regardless — verified against a real registry, where it does — and there is no
> undo: npm refuses to remove the `latest` tag. So the honest position is that the prerelease may briefly be
> what a plain `npm i <name>` serves, and **the fix is to finish the remaining steps promptly**, because the
> real version claims `latest` and the window closes. `pnpm release:bootstrap` reports which of the two
> happened rather than guessing.

**The sequence** (each step gates the next — this order is not incidental):

1. **Repo public first.** The GitHub repo must exist and be public before publishing, so the packages'
   `repository`/`homepage` links resolve and provenance has a public source to attest to. (Done, at launch.)
2. **Land the new package on `main`**, with its version matching the rest of the family. Nothing to clear:
   packages carry no `private` flag.
3. **Create the names**, with interactive 2FA. The helper publishes **only the names the registry lacks** and
   skips the ones it has, so it is safe to run against a family that is already published:

   ```sh
   npm login                            # interactive 2FA — npm's own auth, not something pnpm wraps
   pnpm release:bootstrap               # dry run: checks everything, publishes nothing
   pnpm release:bootstrap --confirm
   ```

   It reports each name it created, and verifies the dist-tag landed. Confirm with
   `npm access get status <name>` rather than `npm view` — `npm view` reads a replica that lags for minutes
   after a first publish (see the troubleshooting table), so a 404 there proves nothing either way.
4. **Bind a Trusted Publisher to each new name** and set its publishing access to *require 2FA and disallow
   tokens* — the [one-time setup](#one-time-setup), per package. **Until this is done the tokenless pipeline
   still cannot publish that name**, so creating the name is only half the job.
5. **Create the GitHub `release` environment** with yourself as required reviewer. (Done, at launch.)
6. **Ship the real release** by tag — the normal [TL;DR](#tldr--cutting-a-release) flow. The workflow runs the
   full gate, re-probes the registry, pauses for your approval, and publishes **tokenlessly with provenance**.

Outside this procedure the manual path is never used, except as
[break-glass](#manual--break-glass-release).

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
| `tag vX.Y.Z does not match <pkg> version …` | A package version and the tag disagree. Every package releases in lockstep, so all five must equal the tag. Fix the manifests, delete and re-push the tag. |
| `… still has "private": true` | Someone added `private` to a package manifest. Only the workspace root is private; every package under `packages/` publishes. |
| Publish rejected: token not permitted | Something re-introduced token auth. The packages disallow tokens; the workflow must authenticate via OIDC. |
| `npm error unable to authenticate` on a fresh package | The Trusted Publisher binding is missing or its repo/workflow/environment don't match exactly. |
| The run never pauses for approval | The `release` environment has no required reviewer — the gate is the reviewer, not the environment. |
| Provenance missing on the published package | `id-token: write` was dropped, or the job ran on a self-hosted runner. Provenance needs a GitHub-hosted runner's OIDC identity. |
| `npm i @cloudbitmaps/s3` fails to resolve `@cloudbitmaps/core@^0.10.0` | **Expected, and it is why the bootstrap window is time-sensitive.** The bootstrap rewrites only the MISSING packages' versions to `-rc.0`; `packages/core/package.json` keeps the real version, so pnpm rewrites the rc tarballs' `workspace:^` dependency to `^0.10.0` — a version the registry will not have until the real release. The rc tarballs exist to create the NAME so a Trusted Publisher can bind to it; they are not installable and are not meant to be. Ship the real version promptly. |
| `npm i @cloudbitmaps/roaring` serves a prerelease | `latest` landed on the bootstrap version — either because `--tag` was omitted (`npm publish` defaults to `latest` and is not semver-aware) or because the registry assigned it to the package's first version anyway. **Do not chase `npm dist-tag rm … latest`** — npm refuses to remove `latest`. Ship the real release; it claims `latest` and closes the window. |
| `EUSAGE: Automatic provenance generation not supported for provider: null` | Something is asking for provenance outside CI. Provenance needs a workflow's OIDC identity, so it is opt-in at the call site (`--provenance`, in `release.yml` only) and deliberately **not** set via `publishConfig.provenance`, which cannot be overridden from the CLI or the environment and made every manual publish impossible. |
| `bootstrap-publish: every package already exists on the registry` | Working as intended — there is nothing to create. Ship the version by tag through the pipeline instead. |
| `<pkg> does not exist on the registry` during a release | A package was added to the workspace without bootstrapping its name. The tokenless pipeline cannot create a name. Run `pnpm release:bootstrap`, bind the Trusted Publisher, then re-tag. The guard fired *before* anything was published, which is the point. |
| `<pkg>@<version> is already on the registry` during a release | That version was published before — most likely by hand. pnpm would skip it silently and the run would go green having published nothing for it. Bump the version. |
| A publish logs `PUT 200` but `npm view` 404s for minutes | npm ACKs on the write path and serves reads from a replica that lags — **measured at ~7 minutes** for a brand-new package. The publish succeeded. Confirm with `npm access get status <pkg>`, which reads the authoritative API; `npm view --prefer-online` only defeats npm's *local* cache, not the replica. The bootstrap waits this out rather than reporting a failure. |
