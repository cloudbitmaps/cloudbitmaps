# Releasing CloudBitmaps

New versions of all six packages — `@cloudbitmaps/core`, `@cloudbitmaps/roaring`, the
`@cloudbitmaps/s3` · `/gcs` · `/azure-blob` driver packages and `@cloudbitmaps/tools` — are published by an **automated, tokenless,
human-gated** pipeline — you never run `npm publish` by hand. This is the map to that pipeline, which lives in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

All six packages release **in lockstep**: one version number, one tag, everything published together —
`core`, the `roaring` flavor, the `s3` / `gcs` / `azure-blob` driver packages and the `tools` package. Each of the
five depends on `core`, and `pnpm -r publish` walks the workspace in topological order so `core` lands first. None of the
workflow's steps names a package: they glob `packages/*/package.json` and filter `./packages/**`, and the one
count the workflow carries (`EXPECTED_PACKAGES`) is asserted against the real number of manifests by
[`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts).

**Adding a package is not free**, and most of the cost is not in this file. Its **name must be
bootstrapped** before the tokenless pipeline can publish it at all (see
[Bootstrapping a name](#bootstrapping-a-name)); the rest is a checklist of the places that enumerate the
driver packages by hand, which lives in
[CONTRIBUTING → Adding a storage driver package](CONTRIBUTING.md#adding-a-storage-driver-package). The checklist
says what fails when each place is missed: most fail a local gate long before a publish step, and a few fail
nothing at all, so those are an edit to remember rather than one a gate will ask for.

## Table of contents

- [TL;DR — cutting a release](#tldr--cutting-a-release)
- [The version bump](#the-version-bump)
- [What the automation does](#what-the-automation-does)
- [A manual run](#a-manual-run)
- [Why tokenless](#why-tokenless)
- [One-time setup](#one-time-setup)
- [Bootstrapping a name](#bootstrapping-a-name)
- [Manual / break-glass release](#manual--break-glass-release)
- [Troubleshooting](#troubleshooting)

## TL;DR — cutting a release

`main` is protected and squash-merged, so the version bump reaches it through a pull request like any other
change, and the tag goes on the commit that pull request makes on `main`.

1. **Land everything on `main`** with the gate green, each change's entry under `## [Unreleased]` in
   `CHANGELOG.md`, and a [changeset](#the-version-bump) per change that needs one.
2. **On a `chore/release-<version>` branch, bump every version with one command** — `pnpm version:packages`. It runs
   `changeset version`, which moves all six `packages/*/package.json` together and deletes the changesets it
   consumed, then refreshes the lockfile. They must all match the tag exactly;
   the workflow globs `packages/*/package.json` and refuses the release if any one disagrees, so a missed
   package costs a failed run rather than a partial publish.
3. **Cut the changelog section.** Rename `## [Unreleased]` to `## [<version>] — <YYYY-MM-DD>`, the version the
   manifests now carry, and open a new, empty `## [Unreleased]` above it. The release notes are that section:
   `scripts/changelog-section.cjs` quotes it, and refuses a tag with no `## [<version>]` heading, or an empty
   one, before anything is published. Then update every version the site, the READMEs and `docs/` state:
   `tests/docs/version-claims.test.ts` names each one that still disagrees with the manifests.
4. **Open the pull request, and squash-merge it** once the gate is green and it is approved.
5. **Tag the merge commit and push the tag**, once its CI run on `main` is green. Tag it by SHA, so a pull
   request that lands after it cannot take the tag instead: `gh pr view <number> --json mergeCommit -q
   .mergeCommit.oid` prints it, then `git fetch origin && git tag v<version> <sha> && git push origin
   v<version>`.
6. **Approve the deployment** — the run waits on the `release` environment before its job starts. Open the
   run → _Review deployments_ → approve `release`.
7. The job re-runs the gate and the audit, checks the tag and that no package is private, probes the registry,
   checks the notes and leak-scans the tarballs, and only then publishes all six packages, tokenlessly, with a
   signed provenance attestation. `pnpm -r publish` walks the workspace in topological order, so `core` lands
   before the four that depend on it. A second job then creates the GitHub Release, with that changelog section
   as its notes.

The approval comes first: nothing in the job runs until it is given, and nothing reaches npm before it.
After it, every check in [What the automation does](#what-the-automation-does) can still refuse the run; the
publish step is the one that cannot be taken back.

## The version bump

`pnpm version:packages` is the whole bump:

```
changeset version            # all six manifests move together
pnpm install --lockfile-only # the lockfile follows the manifests
```

**Changesets is used here as a version bumper and nothing else**, and two of its defaults are deliberately
off. The reasoning lives in [`.changeset/README.md`](.changeset/README.md); the short version:

- **It generates no changelogs** (`"changelog": false`). This project keeps one curated root `CHANGELOG.md`
  and `scripts/changelog-section.cjs` quotes a single version's section into the GitHub Release notes, so the
  two cannot drift. Per-package generated changelogs would split that source of truth and leave the root file
  — the one the release notes are read from — unmanaged. **So write the user-facing entry under
  `[Unreleased]` yourself, in the same change as the code.** A changeset carries the bump *type*, not the
  prose.
- **`changeset publish` is not used.** Publishing stays in `release.yml`, which is tokenless, provenance-
  signed, human-gated, and carries pre-flight probes that `changeset publish` does not have — including the
  one that refuses a version already on the registry, because `pnpm publish` silently skips it and exits 0.

All six packages are a **`fixed` group**, matched by the glob `@cloudbitmaps/*` rather than named
individually, so a sixth package is covered on the day it is created rather than the day someone remembers
this file. `tests/index.test.ts` enforces lockstep independently, reading the package list off the
filesystem, and it fails if any one manifest lags a bump.

Adding a changeset:

```
pnpm changeset
```

Pre-`1.0`, a breaking change is a **minor** bump. Choose the bump for the family, since they move together.

## What the automation does

A pushed `v*.*.*` tag starts one job in the `release` environment. It waits for the approval before any step
runs, and then, in order (a run started by hand skips some of these; see [A manual run](#a-manual-run)):

- **Re-runs the gate that governs the artifact** against the exact commit being published — `lint ·
  lint:arch · format:check · typecheck · test · audit · build · api:surface:check · smoke`. A green `main` is necessary but not
  sufficient; the tagged commit is re-verified from scratch on a clean runner with `--frozen-lockfile`.
  It is not literally every check CI runs. The `build & test` job's checks of the site and the benchmark pages
  against their sources (`site:replay:check`, `bench:scale:check`, `site:figures`, `site-classes.py`,
  `site-links.py`, `bench:sizing:check`, `bench:check`), its tracked-tree `leak-scan` and its fuzz lockfile check
  stay in CI, because they guard the site, the docs and the tracked tree rather than what goes in the tarball.
  CI's other jobs do guard the artifact — integration against the emulators, the smoke test on the Node floor,
  the Lambda smoke, the RSS ceiling and the native addon on three operating systems — and they are not re-run
  here either: the tag goes on a `main` commit whose CI run is green, which is why the TL;DR tags the merge
  commit and waits for that run. The tarball's own `leak-scan` DOES run here. The **dependency audit** is repeated
  here rather than trusted from CI because it is the one gate whose verdict changes with *no commit at all*: an
  advisory published after `main` went green makes the same tree newly vulnerable.
- **Refuses a mistagged release** — every publishable package's `version` must equal the tag, or the run fails.
- **Refuses a still-private package.** `pnpm publish` *silently skips* a package with `"private": true` and
  exits 0, so a real publish attempt would otherwise produce a fully green run that published nothing. No
  package carries `private` — only the workspace ROOT manifest does, and that is never published — so this
  guards against one being added.
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
runs before the one step that cannot be undone. (Creating the GitHub Release before its publish succeeds would
announce a version that never reached npm;
[`tests/ci/release-workflow.test.ts`](tests/ci/release-workflow.test.ts) asserts this ordering.)

A second job, `github-release`, runs only after a tag push whose publish job succeeded, and creates the GitHub
Release with the same changelog section as its notes. It holds the file's one `contents: write`, which the
publish job does not have.

The workflow also declares `concurrency: cancel-in-progress: false` — the opposite of CI. Cancelling a build is
free; cancelling a release part-way through leaves npm holding a half-published family — some of the six
packages up, the rest not — that cannot be taken back.

Every `uses:` is pinned to a full commit SHA, so a moved tag can't inject code. Dependabot bumps the SHA and
the human-readable version comment together, monthly. The npm upgrade the OIDC publish needs is pinned to a
**floor** (`npm@^11.5.1`), not `@latest`, so a regression in a same-morning npm release can't break a release
with nothing in our diff to point at.

## A manual run

_Actions → Release → Run workflow_ starts the same job by hand, on the ref you pick, with one input, `dryRun`,
which defaults to `true`. It waits for the same approval as a tag push.

- **A dry run** (the default) re-runs the gate and the tarball leak scan, then ends with
  `pnpm -r publish --dry-run`, which uploads nothing. Like a real publish, it leaves out every package whose
  version is already on the registry, so on a ref whose manifests carry the released version it packs nothing and
  still exits 0: it exercises the publish step only on a version not yet released, such as `main` after the
  version-bump pull request merges and before the tag. It skips the still-private check and the registry probes.
- **`dryRun: false` publishes for real.** It runs the gate, the still-private check, the registry probes and the
  tarball leak scan, then publishes whatever version the manifests carry.
- **On a branch ref, either one skips the tag check and the release-notes check**, because both key on a tag
  ref, so a real run there publishes with no notes checked. Dispatched on a tag ref (`refs/tags/v…`), both run.
- **No run started by hand creates a GitHub Release**: that job runs only on a tag push. After a real manual
  publish, create it yourself, as the [break-glass](#manual--break-glass-release) steps do.

So `dryRun: false` is for a deliberate manual release, and a tag push is the release path.

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

## One-time setup

Configured once, outside this file; documented here so the pipeline can be rebuilt or audited.

**npm** — per published package (`@cloudbitmaps/core`, `@cloudbitmaps/roaring`, `@cloudbitmaps/s3`,
`@cloudbitmaps/gcs`, `@cloudbitmaps/azure-blob`, `@cloudbitmaps/tools`). **A newly created package name starts with none of this**,
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
  gate; without it the publish job runs unpaused. Limit its deployment branches and tags to `main` and the
  `v*.*.*` tags (_Selected branches and tags_), so a tag push can deploy and a manual run can start from `main` or
  a tag, and from nothing else.
- `main` **branch-protected**: PRs required, force-pushes and deletions blocked.
- Account 2FA.

## Bootstrapping a name

**Every package name has to be created by hand once, because a Trusted Publisher cannot be bound to a package
that does not exist yet.** `pnpm release:bootstrap` runs once for each new package name, **including one added to
a family whose other packages are already on npm**, and publishes only the names the registry does not have.

> [!WARNING]
> **Do this before tagging, not after.** The release pipeline is tokenless: it authenticates by OIDC against
> a per-package Trusted Publisher, which a brand-new name does not have. `pnpm -r publish` walks the
> workspace topologically and stops at the first failure, so tagging with an unbootstrapped name in the tree
> publishes `@cloudbitmaps/core` at the new version, and any package pnpm reaches before the new one — immutably,
> outside a 72-hour window — and then dies there. The family ships in lockstep; that leaves part of it on the
> registry with no way back. `release.yml`'s registry probe refuses such a run before its publish step, once the run is approved
> and the gate has passed, but the refusal is a backstop for this procedure, not a replacement for it.

A manual publish carries **no provenance attestation** — provenance attests to a *workflow* identity, and a
laptop has none. So the bootstrap creates the name at a **throwaway prerelease** and the real version still
ships through the gated, attested pipeline. `pnpm release:bootstrap` derives that prerelease from the family
version (`X.Y.Z` → `X.Y.Z-rc.0`), publishes under `--tag rc`, and puts the manifests back afterwards.

That indirection is not fastidiousness. Publishing the real version by hand would burn it: the pipeline's
registry probe then refuses the real tag, because that version is already on the registry — which it checks
because `pnpm publish` would otherwise **silently skip** the package and exit 0 — so the family has to move to the
next version.

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

Two things the sequence relies on are repo-wide and in place for every name: the GitHub repo is public, so the
packages' `repository`/`homepage` links resolve and provenance has a public source to attest to; and the
`release` environment has its required reviewer, from the [one-time setup](#one-time-setup).

**The sequence** (each step gates the next — this order is not incidental):

1. **Land the new package on `main`**, with its version matching the rest of the family. Nothing to clear:
   packages carry no `private` flag.
2. **Create the names**, with interactive 2FA. The helper publishes **only the names the registry lacks** and
   skips the ones it has, so it is safe to run against a family that is already published:

   ```sh
   npm login                            # interactive 2FA — npm's own auth, not something pnpm wraps
   pnpm release:bootstrap               # dry run: checks everything, publishes nothing
   pnpm release:bootstrap --confirm
   ```

   It reports each name it created, and verifies the dist-tag landed. Confirm with
   `npm access get status <name>` rather than `npm view` — `npm view` reads a replica that lags for minutes
   after a first publish (see the troubleshooting table), so a 404 there proves nothing either way.
3. **Bind a Trusted Publisher to each new name** and set its publishing access to *require 2FA and disallow
   tokens* — the [one-time setup](#one-time-setup), per package. **Until this is done the tokenless pipeline
   cannot publish that name**, so creating the name is only half the job.
4. **Ship the real release** by tag — the normal [TL;DR](#tldr--cutting-a-release) flow. The run waits for your
   approval, then runs the full gate, re-probes the registry, and publishes **tokenlessly with provenance**.

Outside this procedure the manual path is never used, except as
[break-glass](#manual--break-glass-release).

## Manual / break-glass release

Only if the pipeline is down and a release genuinely cannot wait. Requires npm ≥ 11.5.1 and your **interactive
npm 2FA** — automation tokens are disallowed by design, so there is no unattended fallback, deliberately.

Run it on the `main` commit the version bump made — the [TL;DR](#tldr--cutting-a-release)'s steps 1–4 still
apply. This path runs only what you type, so it types the checks the workflow runs around the publish: the
gate, the audit, the check that every manifest carries `<version>` and none is private, the release-notes check
and the tarball leak scan. Set `LEAK_SCAN_EXTRA` to the
needle list, as the workflow's secret does, for the scan's strict mode.

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm lint:arch && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
node scripts/audit.cjs                                      # the dependency audit
node -e 'for (const d of require("fs").readdirSync("packages")) { const m = require(`./packages/${d}/package.json`);
  if (m.version !== process.argv[1] || m.private) throw new Error(`${m.name}@${m.version}`); }' <version>
node scripts/changelog-section.cjs v<version> > /dev/null   # the release notes exist
pnpm leak-scan:tarballs                                     # packs each package and scans the tarball
pnpm -r --filter './packages/**' publish --access public
git tag v<version> && git push origin v<version>
node scripts/changelog-section.cjs v<version> > notes.md
gh release create v<version> --title v<version> --notes-file notes.md --verify-tag
```

It has **none of the registry probes**, the one refusal left out. `pnpm publish` skips a version already on the registry and exits 0, so
check first that no package is on the registry at `<version>` (`npm view <name>@<version> version` fails with a
404 for each). Pushing the tag starts `release.yml`, which waits for approval: reject that deployment, since
every package is on the registry by then and the run's probe would refuse it anyway.

Note this path publishes **without provenance** (there is no workflow identity to attest to), so prefer the
automated flow. This exists so a broken pipeline never blocks a critical security fix.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `tag vX.Y.Z does not match <pkg> version …` | A package version and the tag disagree. Every package releases in lockstep, so all six must equal the tag. Fix the manifests through a pull request, delete the tag (`git push origin --delete vX.Y.Z && git tag -d vX.Y.Z`), and tag the merge commit. |
| `… still has "private": true` | Someone added `private` to a package manifest. Only the workspace root is private; every package under `packages/` publishes. |
| Publish rejected: token not permitted | Something re-introduced token auth. The packages disallow tokens; the workflow must authenticate via OIDC. |
| `npm error unable to authenticate` on a fresh package | The Trusted Publisher binding is missing or its repo/workflow/environment don't match exactly. |
| The run never pauses for approval | The `release` environment has no required reviewer — the gate is the reviewer, not the environment. |
| Provenance missing on the published package | `id-token: write` was dropped, or the job ran on a self-hosted runner. Provenance needs a GitHub-hosted runner's OIDC identity. |
| A publish failed PART-WAY through the family | Some packages are on the registry at this version, immutably, and the rest are not. **Do not re-run the workflow** — it refuses, correctly, because those packages' version now exists. Nor can the stragglers ship alone at the next patch: the workflow refuses a tag any manifest disagrees with, and the `fixed` group moves all six together. Recovery is a **patch release of the whole family**: fix what failed first (the log names the package), then a patch changeset and the [TL;DR](#tldr--cutting-a-release) at `X.Y.Z+1`, with a changelog section that says why. Every package publishes at the new version, and the partial one stays on the registry beside it. Expensive and untidy; not fatal. |
| `gh release create` failed after a successful publish | Use GitHub's **"Re-run failed jobs"**, which skips the already-green publish job. A full re-run cannot work: it stops at the already-on-the-registry guard, by design. |
| `npm i @cloudbitmaps/s3` fails to resolve `@cloudbitmaps/core@^X.Y.Z` | **Expected, and it is why the bootstrap window is time-sensitive.** The bootstrap rewrites only the MISSING packages' versions to `-rc.0`; `packages/core/package.json` keeps the real version, so pnpm rewrites the rc tarballs' `workspace:^` dependency to `^X.Y.Z` — a version the registry does not have until the real release, when the bootstrap runs after the version bump. (When core's version is already on the registry, the rc tarballs resolve.) The rc tarballs exist to create the NAME so a Trusted Publisher can bind to it; they are not installable and are not meant to be. Ship the real version promptly. |
| `npm i @cloudbitmaps/roaring` serves a prerelease | `latest` landed on the bootstrap version — either because `--tag` was omitted (`npm publish` defaults to `latest` and is not semver-aware) or because the registry assigned it to the package's first version anyway. **Do not chase `npm dist-tag rm … latest`** — npm refuses to remove `latest`. Ship the real release; it claims `latest` and closes the window. |
| `EUSAGE: Automatic provenance generation not supported for provider: null` | Something is asking for provenance outside CI. Provenance needs a workflow's OIDC identity, so it is opt-in at the call site (`--provenance`, in `release.yml` only) and deliberately **not** set via `publishConfig.provenance`, which cannot be overridden from the CLI or the environment and would make every manual publish impossible. |
| `bootstrap-publish: every package already exists on the registry` | Working as intended — there is nothing to create. Ship the version by tag through the pipeline instead. |
| `<pkg> does not exist on the registry` during a release | A package was added to the workspace without bootstrapping its name. The tokenless pipeline cannot create a name. Run `pnpm release:bootstrap`, bind the Trusted Publisher, then re-tag. The guard fired *before* anything was published, which is the point. |
| `<pkg>@<version> is already on the registry` during a release | That version was published before — most likely by hand. pnpm would skip it silently and the run would go green having published nothing for it. Bump the version. |
| A publish logs `PUT 200` but `npm view` 404s for minutes | npm ACKs on the write path and serves reads from a replica that lags — **measured at ~7 minutes** for a brand-new package. The publish succeeded. Confirm with `npm access get status <pkg>`, which reads the authoritative API; `npm view --prefer-online` only defeats npm's *local* cache, not the replica. The bootstrap waits this out rather than reporting a failure. |
