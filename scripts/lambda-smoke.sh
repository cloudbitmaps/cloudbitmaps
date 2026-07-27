#!/usr/bin/env bash
#
# Lambda / Amazon-Linux deployability smoke — the orchestrator half.
#
# Proves the PACKED library deploys to the flagship serverless target (AWS Lambda's Amazon Linux 2023 Node
# runtime). The native `roaring` dep has NO linux-arm64 prebuilt for the current Lambda node runtimes, so it
# must compile for the target — this replicates the real "build-for-target" deploy path: provision a toolchain
# in an AL2023 container, `npm install` the tarball (which builds roaring), then load + round-trip it under
# both ESM and CJS (scripts/lambda-smoke.mjs). Catches a deploy regression the macOS unit lane can't see.
#
# Usage: `pnpm lambda-smoke` (or `bash scripts/lambda-smoke.sh`). Needs Docker. Override the base image with
# LAMBDA_SMOKE_IMAGE (e.g. `public.ecr.aws/lambda/nodejs:20`). On an arm64 host this tests Graviton natively;
# a full x64 + multi-OS matrix is deferred to the public-launch GitHub-hosted runners.

set -euo pipefail

IMAGE="${LAMBDA_SMOKE_IMAGE:-public.ecr.aws/lambda/nodejs:22}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || {
  echo "lambda-smoke: docker is required (install/start Docker Desktop)" >&2
  exit 1
}

# `docker run` below pulls implicitly on a cache miss, and a registry rate limit then fails the whole smoke
# test before it has run anything. Pull explicitly, with backoff, so a transient throttle costs seconds rather
# than a red build. See scripts/lib/docker-pull.sh for why the two throttle shapes need different responses.
# shellcheck source=scripts/lib/docker-pull.sh
. "$ROOT/scripts/lib/docker-pull.sh"
docker_pull_with_backoff "$IMAGE"

echo "lambda-smoke: build + pack both workspace packages"
pnpm build >/dev/null
# Pack each package separately. `pnpm pack` rewrites the `workspace:*` dependency to a concrete version, so the
# tarballs are what a publish would ship. They are placed into the container's node_modules BY HAND rather than
# `npm install`-ed, because the flavor's pinned `@cloudbitmaps/core` version is not resolvable from any
# registry pre-launch — manual placement keeps the check registry-free while still exercising the REAL packed
# artifacts + the `exports` maps.
# Repo-local (NOT mktemp): Docker Desktop shares /Users, not /var/folders, and these get bind-mounted.
PACKDIR="$ROOT/.pack-tmp"
rm -rf "$PACKDIR" && mkdir -p "$PACKDIR"
( cd packages/core    && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
( cd packages/roaring && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
CORE_TGZ="$(ls "$PACKDIR"/cloudbitmaps-core-*.tgz | head -1)"
ROARING_TGZ="$(ls "$PACKDIR"/cloudbitmaps-roaring-*.tgz | head -1)"
[ -n "$CORE_TGZ" ] && [ -n "$ROARING_TGZ" ] || {
  echo "lambda-smoke: pnpm pack produced no tarballs" >&2
  exit 1
}
ROARING_VER="$(node -p "require('./node_modules/roaring/package.json').version")"

trap 'rm -rf "$PACKDIR"' EXIT

# Mount the repo read-only (it's under /Users, which Docker Desktop shares by default — a mktemp dir under
# /var/folders is NOT shared). We only read the tarball + the in-container script; the install writes to a
# container-local temp dir.
echo "lambda-smoke: install + run inside $IMAGE"
docker run --rm --entrypoint bash -e ROARING_VER="$ROARING_VER" -v "$CORE_TGZ:/w/core.tgz:ro" -v "$ROARING_TGZ:/w/roaring.tgz:ro" -v "$ROOT/scripts/lambda-smoke.mjs:/w/lambda-smoke.mjs:ro" "$IMAGE" -lc '
  set -e
  # Provide the toolchain so roaring compiles for the target, and FORCE the build-from-source path
  # (npm_config_build_from_source=true) rather than relying on the absence of a prebuilt — this both guarantees
  # the addon is built from source on ANY runner (x64/arm64) and exercises the exact command SECURITY.md
  # documents for consumers who do not want to trust a prebuilt binary.
  dnf install -y gcc-c++ make python3 tar gzip >/dev/null 2>&1
  cd "$(mktemp -d)"
  npm init -y >/dev/null 2>&1
  npm_config_build_from_source=true npm install "roaring@${ROARING_VER}" --no-audit --no-fund >/dev/null 2>&1
  # Unpack the two real tarballs into node_modules (see the pack comment above for why not `npm install`).
  mkdir -p node_modules/@cloudbitmaps/core node_modules/@cloudbitmaps/roaring
  tar -xzf /w/core.tgz    --strip-components=1 -C node_modules/@cloudbitmaps/core
  tar -xzf /w/roaring.tgz --strip-components=1 -C node_modules/@cloudbitmaps/roaring
  cp /w/lambda-smoke.mjs .
  node lambda-smoke.mjs
'
echo "lambda-smoke: PASS ($IMAGE)"
