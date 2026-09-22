# `scripts/` — the build, the release, and the gates

Most of what keeps this repository honest lives here: the package build, the release machinery, and a set of
gates that each exist because something went wrong without them. Every script opens with a header comment
explaining **why** it exists — usually the specific failure it was written after. Read that before changing one.

"When" below means: **CI** — on every pull request, from `.github/workflows/ci.yml`; **release** — from
`.github/workflows/release.yml` on a tag; **by hand** — a `pnpm` script someone runs deliberately; **by other
code** — imported or sourced by another script or a test.

## Contents

- [Build and package](#build-and-package)
- [Release and supply chain](#release-and-supply-chain)
- [Deployability and memory](#deployability-and-memory)
- [The site](#the-site)
- [`lib/`](#lib)
- [Conventions](#conventions)

## Build and package

| script | what it does | when |
|---|---|---|
| `build.mjs` | The package build: bundles each package's entries with esbuild, ESM only; emits declarations with `tsc`; rewrites the `@/…` self-alias in the emitted `.d.ts` into relative paths; and gives every relative specifier there its `.js` extension, without which a consumer's TypeScript silently resolves those types to `any`. | CI, release — `pnpm build`, which runs it in every package |
| `smoke.cjs` | The built packages must import cleanly on real Node, through the `exports` map a consumer resolves, with the native `roaring` addon loaded and the main entries free of any cloud SDK. | CI, release — `pnpm smoke` |
| `dts-specifiers.cjs` | The detector behind "every relative specifier in an emitted `.d.ts` carries its extension" — without one, a consumer's TypeScript cannot resolve the published types. | by other code — `build.mjs`, `smoke.cjs`, and `tests/arch` |
| `sdk-specifiers.cjs` | The detector behind "the main entry stays SDK-free", one of the hard invariants in `CLAUDE.md`. | by other code — `smoke.cjs` and `tests/arch` |
| `runtime-floor.cjs` | The detectors behind the declared Node floor (`>= 22.12`). A `node-version:` pin in a workflow must resolve at or above it — `22` passes, because it means the latest 22.x; `22.11` does not — and a prose statement of the floor in the docs `tests/ci` reads must state exactly it. Written after a review found `node-version: 22.11`, a quoted `"20"`, and phrasings like `Node.js >= 20` all passing a green gate. | by other code — `tests/ci` and `tests/arch` |
| `sync-version.cjs` | After `changeset version` bumps the five manifests, moves the `VERSION` constant to match. `VERSION` ships as a literal in the published `.d.ts`, so it cannot be read from a manifest at runtime. | by hand — `pnpm version:packages` |

The three detector modules are split out of what uses them — `build.mjs` and `smoke.cjs`, and for the floor, a
test — so that `tests/arch` can fire each one at planted inputs and watch it catch them. In the words of
`sdk-specifiers.cjs`: **a detector nothing tests is a check that cannot be trusted.** `dts-specifiers.cjs` has a
second reason: the build rewrites exactly what the smoke test detects, so both import one scanner and cannot
disagree.

## Release and supply chain

See [`RELEASING.md`](../RELEASING.md) for how these fit together into a release.

| script | what it does | when |
|---|---|---|
| `bootstrap-publish.cjs` | Creates a package **name** that does not exist on npm yet. The release pipeline publishes tokenlessly through a Trusted Publisher, and a Trusted Publisher cannot be bound to a name that has never been published — so the first version of each new name has to be published by hand. | by hand — `pnpm release:bootstrap` |
| `changelog-section.cjs` | Prints one version's section of `CHANGELOG.md`, which the release job feeds straight into the GitHub Release — so the release notes and the changelog cannot drift apart. Fails loudly rather than publishing empty notes. | release, twice: before publishing, to prove the section exists, and again to write the notes |
| `audit.cjs` | Wraps `pnpm audit --prod` and fails only on a **production** advisory at or above `high` that has not been triaged. Triaged advisory ids live in `package.json`, under `pnpm.auditConfig.ignoreGhsas`, with the reasoning in `SECURITY.md`. It also fails, with exit 2, if the audit itself cannot run. | CI, release — `node scripts/audit.cjs`, or `pnpm run audit`. Bare `pnpm audit` is pnpm's own built-in command, and does not run this. |
| `leak-scan.cjs` | Scans every tracked file for credentials and for project-specific strings that must never become public. `--history` scans every blob reachable from every ref instead, and `--dir <path>` any directory, such as an unpacked tarball. `--snapshot` turns the migration findings — references to the old repository and to private documents — from notes into failures, and refuses to run without extra strings. Extra strings come from a gitignored `.leak-needles` file or the `LEAK_SCAN_EXTRA` variable, and matches against them are reported redacted. | CI — `pnpm leak-scan`; and by other code — `leak-scan-tarballs.cjs` |
| `leak-scan-tarballs.cjs` | The same scan over the **packed npm tarballs** — what actually ships, which includes built output and sourcemaps the tracked-file scan cannot see. | CI, release — `pnpm leak-scan:tarballs` |
| `verify-roaring-prebuilt.cjs` | `roaring` — the one third-party runtime dependency of `@cloudbitmaps/roaring` — downloads a prebuilt native binary at install time, which our signed publish does not cover. This records its checksum per platform and fails when it changes. With `--strict`, as CI runs it, a platform with no recorded checksum fails too; without it, an unrecorded one prints a line to record and passes. | CI — the `native-os-matrix` job, on macOS, Windows and Ubuntu |
| `roaring-prebuilt-checksums.json` | The checksums `verify-roaring-prebuilt.cjs` compares against. | read by `verify-roaring-prebuilt.cjs` and `tests/ci` |

## Deployability and memory

| script | what it does | when |
|---|---|---|
| `lambda-smoke.sh` | Proves the **packed** library deploys to AWS Lambda's Amazon Linux 2023 runtime. In an AL2023 container it forces `roaring` to build from source — the path a deploy to arm64 Lambda has to take, since that target has no prebuilt — then loads the addon and round-trips it under both `import` and `require()`. CI runs it on x64. | CI — `pnpm lambda-smoke` |
| `lambda-smoke.mjs` | The half of the Lambda smoke that runs inside the container. | by other code — `lambda-smoke.sh` |
| `build-lambda-layer.sh` | Builds a ready-to-attach Lambda **layer** holding `@cloudbitmaps/core` and `@cloudbitmaps/roaring`, with `roaring` compiled for the Lambda runtime, so a function needs no native build at deploy. The storage drivers are left out on purpose: which one a function talks to is its own dependency, and bundling all three would put every cloud SDK in every deployment. | by hand — `pnpm build-lambda-layer`; CI's `lambda-layer` job builds and uploads it when the workflow is run manually |
| `rss-gate.sh` | The hard memory ceiling: runs the soak (`bench/soak.cjs`) under a 384 MiB cgroup limit with swap disabled, so the limit is a true bound on resident memory — including the addon's off-heap allocations, which a heap sample cannot see. An OOM-kill fails the build, and so does the soak's own verdict on slower memory creep. Records its run to `bench/rss-gate-results.json`. | CI — `pnpm rss-gate` |

## The site

`site/` is published as-is, and these keep it true. See [`site/README.md`](../site/README.md).

| script | what it does | when |
|---|---|---|
| `site-figures.cjs` | Checks the site's money figures and its crossover rate against `bench/results.json`, `docs/benchmarks.md` and the pricing profile: every one must appear on `benchmarks.html`, which owns them, and a dollar amount on any of six pages that none of them accounts for fails — so no price can drift or improve without a run behind it. The rate is required on `benchmarks.html` and its chart; stated anywhere else, it is not checked. Also: the measured values two pages quote — the RSS ceiling and soak figures on `benchmarks.html`, the encoding sizes on `flavors/roaring.html` — and any count of storage drivers on the pages or in `llms.txt`, against the drivers that ship, when it says "drivers". It does not check the at-scale table. | CI — `pnpm site:figures` |
| `site-links.py` | Every cross-link points at a page that exists; `robots.txt`, `sitemap.xml` and `llms.txt` are all present; every page declares a canonical URL, and the sitemap and those URLs match **in both directions**; every sitemap URL resolves to the page that claims it; and every external link opens in a new tab, with `rel="noopener"` and an `aria-label`. | CI |
| `site-classes.py` | Every class in a page's markup — nested pages included — is defined in the stylesheet. A class a script adds at runtime is not seen. A class the sheet never defines renders as unstyled, and nothing else notices. | CI |
| `site-replay.cjs` | Generates `site/assets/replay.json` — the benchmark run the `/demo` page steps through, reduced to what it shows — from `bench/scale-results.json`, cross-checked against how `bench/scale.cjs` builds its segments, so the demo shows a recorded run rather than numbers someone typed. `--check` fails if the committed file is stale, or if `demo.html`'s own figures, which live in its markup, disagree with the benchmark. | CI — `pnpm site:replay:check` |
| `site-screenshots.mjs` | Full-page screenshots of every page in both themes, derived from the pages on disk, for design briefs. Drives Chrome directly, with no browser-automation dependency. | by hand — `pnpm site:screenshots` |

## `lib/`

| file | what it is |
|---|---|
| `lib/docker-pull.sh` | Pulls a container image, retrying with a linear backoff to absorb a registry's rate limit, then re-running the last attempt with its output shown, so an image that genuinely does not exist fails with the registry's own error rather than a timeout. Shared rather than copied because the CI integration job had grown this retry and the scripts that `docker run` an image directly had not, so they kept failing on a throttle a short wait absorbs. Sourced by `rss-gate.sh`, `lambda-smoke.sh`, `build-lambda-layer.sh`, and the `integration` job in `ci.yml`. |

## Conventions

- **Open with why.** Each script's header names the failure it prevents. A gate whose reason is lost gets deleted
  by the next person who finds it inconvenient.
- **Fail loudly.** A script that cannot do its job exits non-zero with a message saying what to do. A gate that
  silently passes when it cannot see its input is worse than no gate.
- **Verify a gate in both directions.** Plant the defect it exists for and watch it fail; then check that the
  legitimate look-alikes pass.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
