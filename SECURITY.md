# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via GitHub Security Advisories —
[open a draft advisory](https://github.com/cloudbitmaps/cloudbitmaps/security/advisories/new) on this repository.
Do not open a public issue for a security report. We aim to acknowledge a report within a few days and will
coordinate a fix and disclosure timeline with you.

CloudRoaring is pre-1.0; there is no long-term-support branch yet. Fixes land on `main` and in the next
release.

## Trust boundary (what the library defends)

CloudRoaring treats **all bytes read back from any tier as untrusted input**. Every `.crbm` object and Warm
delta is length-checked and CRC-verified, and deserialized with the **safe** RoaringBitmap reader (never the
trusting variant) behind a hard size cap, before the native addon sees it. A hostile or corrupted object fails
closed with a typed `IntegrityError` on read — it can neither crash the process nor return a wrong answer. This
boundary is exercised by coverage-guided fuzzing (`pnpm fuzz:*`, nightly) and the DR drill's byte-corruption
scenario (`pnpm dr-drill`).

Encryption-at-rest (opt-in) is envelope AES-256-GCM with a per-segment DEK wrapped under operator-held KEK(s);
the AEAD wiring is pinned to published known-answer vectors and the envelope/rotation/crypto-shred paths are
tested (`tests/crypto-vectors.test.ts`, `tests/key-rotation.test.ts`, `tests/drivers/crypto.test.ts`, `tests/core/encryption-lifecycle.test.ts`).
Keys and plaintext bitmap contents are never logged.

## Dependency audit

CI runs a blocking dependency audit — [`node scripts/audit.cjs`](scripts/audit.cjs), a thin wrapper over
`pnpm audit --prod --json` — scoped to **production** dependencies at the **high** severity bar. A brand-new
advisory in a runtime dependency breaks the build. (It is invoked as `node scripts/audit.cjs`, not bare
`pnpm audit`, which is pnpm's own built-in command.) Advisories that have been triaged as not-applicable are listed in
`package.json` → `pnpm.auditConfig.ignoreGhsas`, each with its rationale below, and are the **only** ones the
gate ignores.

### Triaged (accepted) advisories

**Currently empty.** No advisory is being ignored — every one the gate sees is either fixed or absent.

Three `tar` advisories (`GHSA-23hp-3jrh-7fpw` critical, `GHSA-8x88-c5mf-7j5w` high, `GHSA-w8wr-v893-vjvp`
moderate) were previously accepted here on reachability grounds: `tar` is pulled in only by `roaring`'s
**install-time** native-build chain (`@mapbox/node-pre-gyp` → `node-gyp`), which uses it to extract `roaring`'s
own trusted prebuilt binary, and is never on CloudRoaring's runtime path. That entry carried an explicit revisit
condition — *"`tar` ships a fixed release"* — which upstream met, so the ignores were removed and `tar` upgraded
to a patched release (2026-07-25) rather than left accepted. Reachability is a reason to **not panic**, never a
reason to stay unpatched when a patch exists.

**The bar for adding an entry here:** a rationale that names the exact path the advisory would have to travel to
matter, plus a concrete condition under which the entry gets removed. An accepted advisory with no revisit
condition is an unmaintained one. If any accepted advisory ever becomes reachable from a runtime path, the entry
must be removed and the advisory addressed, not ignored.

## Supply chain (build, publish & provenance)

CloudRoaring is published through a hardened pipeline so that a consumer can verify **exactly what source
produced the package they installed** (threat model S9, implemented in
Phase 8). The controls:

- **Build provenance (SLSA).** The [release workflow](.github/workflows/release.yml) publishes with
  `--provenance` and `NPM_CONFIG_PROVENANCE=true`, set at the call site rather than in the manifests. (It was
  briefly also `publishConfig.provenance: true`, which is strictly worse: a manifest flag cannot be overridden
  by the CLI *or* the environment, so it silently made every non-CI publish — the bootstrap and the break-glass
  path both — abort with `EUSAGE: … not supported for provider: null`. Opting in where provenance is actually
  achievable keeps the guarantee and drops the trap.) npm records a **signed,
  publicly-verifiable attestation** linking the tarball to the exact GitHub Actions workflow, repository, and
  commit that built it, minted via GitHub **OIDC** (the job runs on a GitHub-hosted runner with
  `id-token: write` and no other write scope). Verify an installed copy with **`npm audit signatures`**, or
  read the "Provenance" panel on the package's npm page. A tarball whose provenance doesn't trace to this repo's
  release workflow should be treated as untrusted. A *publicly-verifiable* attestation requires the source repository to
  be public and the package published under a real version — both true from `0.1.0` onward, so every
  published tarball carries an attestation you can check yourself.
- **Publish only a re-verified tree.** The release workflow re-runs the **entire** gate (`lint · lint:arch ·
  format:check · typecheck · test · build · smoke`) against the exact commit being published before the tarball
  is created — a green `main` is necessary but not sufficient. A `vX.Y.Z` tag must also match `package.json`
  version, or the release fails.
- **Reproducible, frozen installs.** Both CI and the release build use `pnpm install --frozen-lockfile` (fails
  on a stale lockfile). Consumers get the same guarantee with **`npm ci`** against a committed lockfile.
- **SHA-pinned GitHub Actions.** Every `uses:` in every workflow is pinned to a **full commit SHA** (with a
  `# vX` comment for readability), so a hijacked or force-moved tag on a third-party Action cannot inject code
  into our build. Bumps are deliberate (Dependabot's `github-actions` ecosystem, monthly + grouped).
- **The native addon, from source (optional, for the most cautious).** CloudRoaring ships **pure JS/TS** — the
  only native code is its runtime dependency **`roaring`** (CRoaring), which the *consumer* installs. Consumers
  who prefer not to trust `roaring`'s prebuilt binary can build it **from source** at install time
  (`npm_config_build_from_source=true npm ci`, given a C/C++ toolchain). CI already proves this exact path works
  on every run: the `lambda deployability` job installs the packed tarball with **`npm_config_build_from_source=true`**
  inside an Amazon Linux 2023 container — forcing the from-source compile (not merely relying on a missing
  prebuilt) — and loads the result under both ESM and CJS. **Platform note:** `roaring` publishes prebuilt
  binaries for common **glibc** targets but **none for musl**, so on Alpine the addon builds from source at
  install regardless — provision a toolchain (`apk add --no-cache build-base python3`) or use a glibc base
  image. The from-source path is currently CI-proven on glibc (AL2023); a musl/Alpine lane is a tracked
  follow-up (the guarantee is documented, not yet gated).
- **Least-privilege CI.** Workflows declare minimal `permissions:` (the default CI job is `contents: read`;
  only the release job adds `id-token: write` for provenance). No workflow has write access to repo contents.

Releases run through the workflow only. It can also be dispatched in **dry-run**
(`workflow_dispatch` with `dryRun: true`), which exercises the **full gate + tarball pack** without
publishing — a dry run mints no attestation, by design.
