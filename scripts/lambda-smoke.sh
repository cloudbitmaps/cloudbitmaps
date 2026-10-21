#!/usr/bin/env bash
#
# Lambda / Amazon-Linux deployability smoke: the orchestrator half.
#
# Proves the PACKED library loads on the flagship serverless target (AWS Lambda's Amazon Linux 2023 Node runtime).
# The packages carry no native code, so there is nothing to build for the target: this packs core and the flavor,
# unpacks them into a `node_modules` on the host, mounts that into the Lambda runtime image and, there, loads the
# library under both ESM and CJS and round-trips a load (scripts/lambda-smoke.mjs). It also checks that no native
# addon is installed. Catches a deploy regression the unit lane cannot see: a packed file missing from the tarball, an
# `exports` map that does not resolve on the runtime's Node, a built-in the runtime lacks.
#
# Usage: `pnpm lambda-smoke` (or `bash scripts/lambda-smoke.sh`). Needs Docker. Override the base image with
# LAMBDA_SMOKE_IMAGE (e.g. `public.ecr.aws/lambda/nodejs:20`). Docker on the runner fixes the architecture tested
# (x64 in CI, arm64 on an Apple-Silicon host); the code is the same JavaScript on both, and the cross-OS job
# (`cross-os` in ci.yml) loads the built packages on Linux, macOS and Windows.

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
RUN_IMAGE="$(docker_image_run_name "$IMAGE")" # a copy loaded from the cache runs by this name

echo "lambda-smoke: build + pack the flavor and the engine"
pnpm build >/dev/null
# Pack each package separately. `pnpm pack` rewrites the `workspace:*` dependency to a concrete version, so the
# tarballs are what a publish would ship. They are unpacked into `node_modules` BY HAND rather than
# `npm install`-ed, because the version of `@cloudbitmaps/core` that the flavor pins here is the one in THIS
# tree, which is generally not on the registry yet: that is the whole point of testing before publishing. Manual
# placement keeps the check registry-free while still exercising the REAL packed artifacts and the `exports` maps.
#
# Flavor + engine only: the driver packages are plain JS over a cloud SDK with nothing platform-specific to
# establish, and `pnpm smoke` already resolves their entries and subpaths out of the built artifacts.
# Repo-local (NOT mktemp): Docker Desktop shares /Users, not /var/folders, and this gets bind-mounted.
PACKDIR="$ROOT/.pack-tmp"
rm -rf "$PACKDIR" && mkdir -p "$PACKDIR"
trap 'rm -rf "$PACKDIR"' EXIT
( cd packages/core    && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
( cd packages/roaring && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
CORE_TGZ="$(ls "$PACKDIR"/cloudbitmaps-core-*.tgz | head -1)"
ROARING_TGZ="$(ls "$PACKDIR"/cloudbitmaps-roaring-*.tgz | head -1)"
[ -n "$CORE_TGZ" ] && [ -n "$ROARING_TGZ" ] || {
  echo "lambda-smoke: pnpm pack produced no tarballs" >&2
  exit 1
}
APP="$PACKDIR/app"
mkdir -p "$APP/node_modules/@cloudbitmaps/core" "$APP/node_modules/@cloudbitmaps/roaring"
tar -xzf "$CORE_TGZ"    --strip-components=1 -C "$APP/node_modules/@cloudbitmaps/core"
tar -xzf "$ROARING_TGZ" --strip-components=1 -C "$APP/node_modules/@cloudbitmaps/roaring"
cp scripts/lambda-smoke.mjs "$APP/lambda-smoke.mjs"

# Mounted read-only: the smoke only reads. No install runs in the container, so it needs no network and no toolchain.
echo "lambda-smoke: load + run inside $IMAGE"
docker run --rm --entrypoint node -v "$APP:/w/app:ro" -w /w/app "$RUN_IMAGE" lambda-smoke.mjs
echo "lambda-smoke: PASS ($IMAGE)"
