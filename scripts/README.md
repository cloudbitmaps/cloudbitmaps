# `scripts/` — the build, the release, and the gates

Most of what keeps this repository honest lives here: the package build, the release machinery, and a set of
gates that each exist because something goes wrong without them. Every script opens with a header comment
explaining **why** it exists — the specific failure it prevents. Read that before changing one.

"When" below means: **CI** — on every pull request, from `.github/workflows/ci.yml`; **release** — from
`.github/workflows/release.yml` on a tag; **by hand** — a `pnpm` script someone runs deliberately; **by other
code** — imported or sourced by another script or a test.

## Contents

- [Build and package](#build-and-package)
- [Release and supply chain](#release-and-supply-chain)
- [Deployability and memory](#deployability-and-memory)
- [The integration backends](#the-integration-backends)
- [The site](#the-site)
- [The documentation](#the-documentation)
- [`lib/`](#lib)
- [Conventions](#conventions)

## Build and package

| script | what it does | when |
|---|---|---|
| `build.mjs` | The package build: bundles each package's entries with esbuild, ESM only; emits declarations with `tsc`; rewrites the `@/…` self-alias in the emitted `.d.ts` into relative paths; and gives every relative specifier there its `.js` extension, without which a consumer's TypeScript silently resolves those types to `any`; last, deletes every emitted `.d.ts` that no `exports` entry reaches, so internal modules ship no declaration. | CI, release — `pnpm build`, which runs it in every package |
| `api-surface.cjs` | The gate on public type signatures. Reads the declarations the build emitted for every entry point in each package's `exports` map, and writes one sorted line per exported symbol and per member, each with its full signature text. A class that declares no constructor is recorded with the one it inherits, or with `constructor();` when its chain declares none, and a private constructor as declared. `--check` fails if the built surface is not the committed snapshot in `api-surface/`; `--against <ref>` fails if an entry is removed, changed or added against the snapshot committed at that ref (a new `(referenced)` key, a type a public signature names and no entry exports, included), unless `api-surface/allowed.json` names it with a reason in a row the ref does not already have (a `Name*` row covers `Name` and its members, never `NameOptions`). An entry a package lists in its manifest's `cloudbitmaps.internalEntries` is outside the promise: it is left out of `surface.json`, its lines go to `api-surface/internal.json` (which `--check` also keeps current), and making an entry internal needs the row `<specifier> (internal)`. | CI, release — `pnpm api:surface:check`; the `api-surface-base` workflow on a pull request — `--against` the base branch, with no build; by hand — `pnpm api:surface` regenerates the snapshot |
| `function-length.cjs` | The function-length gate: no function in `packages/*/src` is over 100 code lines (blank and comment-only lines not counted), and the ones that already are can only shrink. Measures every function with ESLint's parser, identifies each by file and enclosing names rather than line number, and compares the over-limit ones with `function-length-baseline.json`: a new offender, a baselined function that grew, and one that shrank without its entry being lowered or removed all fail. `--update` lowers or drops entries (never records growth) and `--list` prints today's offenders. Its header comment states the limits. | CI, as part of `pnpm lint` (`pnpm lint:fn-length` alone) |
| `function-length-baseline.json` | Every function over 100 code lines today, with its size: the ratchet `function-length.cjs` compares against. An entry is removed once its function is at or under the limit. | read by `function-length.cjs` |
| `smoke.cjs` | The built packages must import cleanly on real Node, through the `exports` map a consumer resolves, with the native `roaring` addon loaded and the main entries free of any cloud SDK; and the shipped declarations must equal what the TypeScript compiler loads for a consumer importing every entry by package name under NodeNext, Bundler and Node10 resolution (skipLibCheck off): it fails on any diagnostic inside a `dist/` (a lost declaration is TS2307), any diagnostic in the probe itself (a lost entry is TS7016 or TS2307 on its import), any stray `.d.ts` no mode loads, and any declaration loaded from outside this checkout (a worktree nested in another checkout can resolve a package through the outer `node_modules` and so load a file this build did not ship, without a diagnostic), naming the files. The compiler reads only the `typesVersions` range its own version selects; the walk reads them all. The check is independent of the build's prune walk. In the same three modes it compiles, on its own, every import from a workspace package on the README, the guides, the package READMEs and the site, so a sample cannot import a name its package does not export (a name the flavor stopped exporting is said to be one), the API reference's block of derived port types, each alias held to the port its comment names, and the typed fixture `tests/smoke/typed-surface.ts`, which names every type `@cloudbitmaps/roaring` exports and reads `BudgetExceededError`'s typed fields. It fails when the flavor exports a type the fixture does not name (or one it stopped exporting, `tests/docs/left-the-flavor.json`), when a line starts an import of a workspace package that does not parse, and when it finds fewer than 50 imports. | CI, release — `pnpm smoke` |
| `dts-specifiers.cjs` | The detector behind "every relative specifier in an emitted `.d.ts` carries its extension" — without one, a consumer's TypeScript cannot resolve the published types. | by other code — `build.mjs`, `smoke.cjs`, and `tests/arch` |
| `sdk-specifiers.cjs` | The detector behind "the main entry stays SDK-free", one of the hard invariants in `AGENTS.md`. | by other code — `smoke.cjs` and `tests/arch` |
| `doc-imports.cjs` | The detector behind "every import a guide shows compiles": the pages a reader copies samples from (the README, `docs/guide/`, each package's README, the site's HTML pages through their markup and `site/llms.txt`), each import from a workspace package in them (named bindings on one line or many, in a list item, a block quote or after a comment, a namespace import, a default import), and each line that starts such an import and does not parse. Its header says what it does not read. | by other code — `smoke.cjs` and `tests/arch` |
| `runtime-floor.cjs` | The detectors behind the declared Node floor (`>= 22.12`). A `node-version:` pin in a workflow must resolve at or above it — `22` passes, because it means the latest 22.x; `22.11` does not — and a prose statement of the floor in the docs `tests/ci` reads must state exactly it. `node-version: 22.11`, a quoted `"20"`, a pin with a trailing comment, and phrasings like `Node.js >= 20` are each caught, where a looser pattern passes them green. | by other code — `tests/ci` and `tests/arch` |

The four detector modules are split out of what uses them — `build.mjs` and `smoke.cjs`, and for the floor, a
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
| `leak-scan.cjs` | Scans every tracked file for credentials and for project-specific strings that must never become public. `--history` scans every blob reachable from every ref instead, and `--dir <path>` any directory, such as an unpacked tarball. `--snapshot` turns the migration findings — references to the old repository and to private documents — from notes into failures, and refuses to run without extra strings. Extra strings come from a gitignored `.leak-needles` file (in a linked worktree with none of its own, the main worktree's) or the `LEAK_SCAN_EXTRA` variable, and matches against them are reported redacted. AWS account ids (any standalone 12-digit run) and ARNs are refused by the built-in rules. | CI — `pnpm leak-scan`; and by other code — `leak-scan-tarballs.cjs` |
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

## The integration backends

`pnpm test:integration` runs against the storage services `docker-compose.yml` starts: MinIO, and emulators of Google
Cloud Storage and Azure Blob Storage.

| script | what it does | when |
|---|---|---|
| `ci-backend-images.sh` | Makes every image `docker-compose.yml` names local before the `integration` job starts it, one at a time through `lib/docker-pull.sh`, so each comes from the copy the Actions cache keeps or from a pull with backoff. It writes a compose override that runs each service by the local name the helper gives an image it keeps or loads, which a copy that failed to save part-way still has, and by the image itself when it has none, because a loaded image answers only to the names it was saved under and a digest is not one, and compose asks for MinIO by digest. It reads `docker-compose.yml` alone, as `ci.yml` starts it, and fails if that declares no services. | CI — the `integration` job |

## The site

`site/` is published as-is, and these keep it true. See [`site/README.md`](../site/README.md).

| script | what it does | when |
|---|---|---|
| `site-figures.cjs` | Checks the site's money figures and its crossover rate against `bench/results.json`, `docs/benchmarks.md`, the latest calibration run's evidence in `bench/calibration/` and the pricing profile: every one must appear on `benchmarks.html`, which owns them, and a dollar amount that none of them accounts for fails on any of six site pages, `llms.txt`, the root and npm READMEs, the roadmap or `docs/benchmarks.md` — so no price can drift or improve without a run behind it. A run's figures pass at any honest precision, through the matcher its report is checked with, bindings included: wherever a paragraph, list item or table row states one of the run's figures or a request shape, every figure in it must also stand beside the words for the claim it makes. Inside `benchmarks.html`'s panel on the latest run, every unit and every count is checked, and each row against the run's derivation. The rate is required on `benchmarks.html` and its chart, and is checked wherever it stands in a block that quotes the run; stated anywhere else, it is not checked. Also: the measured values two pages quote — the RSS ceiling and soak figures on `benchmarks.html`, the encoding sizes on `flavors/roaring.html` — and any count of storage drivers on the pages or in `llms.txt`, against the drivers that ship, whether it says "drivers" or "backends". It does not check the at-scale table. | CI — `pnpm site:figures` |
| `site-links.py` | Every cross-link points at a page that exists; `robots.txt`, `sitemap.xml` and `llms.txt` are all present; every page declares a canonical URL, and the sitemap and those URLs match **in both directions**; every sitemap URL resolves to the page that claims it; every external link opens in a new tab, with `rel="noopener"` and an `aria-label`; and nothing a page loads comes from another origin — a script, a stylesheet, an image, a font, a preconnect, a `<base>`, a `url()` — and no script, the pages' inline ones included, holds an absolute URL. | CI |
| `site-classes.py` | Every class in a page's markup — nested pages included — and every class a script applies, in a `.js` file or a page's inline script, is defined in the stylesheet. A class the sheet never defines renders as unstyled, and nothing else notices. | CI |
| `site-replay.cjs` | Holds the `/demo` page's figures, which live in its markup, to `bench/scale-results.json`, the benchmark it replays: each one is read from that file or derived from how `bench/scale.cjs` builds its segments, the two are cross-checked first, and a figure the benchmark cannot account for fails. It writes nothing. | CI — `pnpm site:replay:check` |
| `site_markup.py` | What the two site gates above read out of a page: its tags and attributes in any quoting, its inline scripts and styles, and each script's strings with its comments removed. Shared so the gates cannot read one spelling of the markup each. | by `site-links.py` and `site-classes.py` |
| `site-screenshots.mjs` | Full-page screenshots of every page in both themes, derived from the pages on disk, for design briefs. Drives Chrome directly, with no browser-automation dependency. | by hand — `pnpm site:screenshots` |

## The documentation

| script | what it does | when |
|---|---|---|
| `summary-ties.cjs` | The gate behind `tests/docs/summary-ties.test.ts`: every restatement of a guarantee links the claim of `docs/guide/correctness.md` it restates. It reads every tracked page but the ones it excludes, each with its reason, splits each into blocks and sentences, and holds a sentence that matches a claim's signature, or copies a run of its words, to a link to that claim in its block; it holds each guide's summary region to the section it summarises, and each claim to an anchor of its own. `--update` drops the rows of `tests/docs/summary-ties.json`, the baseline of restatements untied when the gate was written, that excuse nothing, and never adds one. `--changed` prints each claim this branch changed with the blocks that tie it, and each tied block it changed with its claims, against the merge base with `origin/main` or with `--against <ref>`, for the docs-fidelity review to read side by side. Its header states the rules and the limits. | CI, through `pnpm test`; by hand — `pnpm docs:ties`, `pnpm docs:ties --update`, `pnpm docs:ties --changed` |

## `lib/`

| file | what it is |
|---|---|
| `lib/docker-pull.sh` | Pulls a container image, retrying with a linear backoff to absorb a registry's rate limit, then re-running the last attempt with its output shown, so an image that genuinely does not exist fails with the registry's own error rather than a timeout, unless CI kept a copy of it (below). Shared rather than copied, so the scripts that `docker run` an image directly retry just as the CI integration job does; without it they fail on a throttle a short wait absorbs. With `DOCKER_IMAGE_CACHE` set, as CI sets it, each image it pulls is also kept in a directory CI saves to the Actions cache. A later run uses that copy without asking the registry until the month turns, or the runner image, a file that names the images, or the helper changes; then it asks again, and uses the copy only if the registry refuses or stalls, with a warning on the run. CI keeps a job's copies only from a run that passed; to drop one all the same, delete that job's entries with `gh cache delete`. `docker_image_run_name` gives the name to run an image by, since a loaded image answers only to the names it was saved under and a digest is not one. Unset, as it is by hand, it keeps nothing and bounds no pull: it retries with backoff, and a last, loud attempt that succeeds succeeds the call. Sourced by `rss-gate.sh`, `lambda-smoke.sh`, `build-lambda-layer.sh`, `ci-backend-images.sh`, the `docker-images-save` action in `.github/actions/`, and `tests/ci`. |
| `lib/reachable-declarations.cjs` | Which `.d.ts` files of a built package a consumer can reach: it starts from every `types` target of the `exports` map (conditions may nest; a `.json` target such as `./package.json` is skipped), a top-level `types` field and every target of every `typesVersions` range, and follows each relative `import`/`export … from`, `import x = require`, `declare module` and `import('…')` specifier (a `.js` specifier names the sibling `.d.ts`, a directory its `index.d.ts`; bare specifiers to other packages, `.json` specifiers and `/// <reference types>` are not followed). `build.mjs` deletes the rest with `pruneUnreachable`. Because it deletes, it fails closed: it throws on a missing or unresolvable `types` root or relative specifier, `/// <reference path>`, a `typesVersions` target with a `*` or a missing file, `.mjs`/`.cjs` specifiers and `.d.mts`/`.d.cts` or `.d.ts.map` files, an `exports` target that is an array or string, has no `types`, uses a `types@` condition or a wildcard subpath, and `imports`/`#` specifiers; the header lists the limits. `tests/ci/shipped-declarations.test.ts` fires it at planted trees, with no build. | by other code — `build.mjs` and `tests/ci` |

## Conventions

- **Open with why.** Each script's header names the failure it prevents. A gate whose reason is lost gets deleted
  by the next person who finds it inconvenient.
- **Fail loudly.** A script that cannot do its job exits non-zero with a message saying what to do. A gate that
  silently passes when it cannot see its input is worse than no gate.
- **Verify a gate in both directions.** Plant the defect it exists for and watch it fail; then check that the
  legitimate look-alikes pass.
- **List it here.** `tests/docs/directory-readmes.test.ts` fails if a file in this directory has no row in a
  table here, or if a row names a file that does not exist.
