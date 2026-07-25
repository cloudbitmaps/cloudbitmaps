#!/usr/bin/env bash
#
# Build a ready-to-attach AWS Lambda **layer** for CloudRoaring (Phase 8 — the "prebuilt Lambda layer" ceiling
# item). The layer bundles the library + its runtime deps with the native `roaring` addon **compiled for the
# Amazon Linux 2023 Lambda runtime**, so a function can `import '@cloudbitmaps/roaring'` with zero build step at deploy.
#
# A Node Lambda layer is a zip whose contents live under `nodejs/node_modules/…` (that path is prepended to
# NODE_PATH by the runtime). We build it the same way `lambda-smoke` proves deployability: inside an AL2023
# container, install the packed tarball with `npm_config_build_from_source=true` (compile roaring for the
# target, no reliance on a prebuilt), then zip `nodejs/`.
#
# Usage: `pnpm build-lambda-layer`. Needs Docker. Output: dist-lambda/cloud-roaring-lambda-layer.zip.
# Override the base image with LAMBDA_LAYER_IMAGE (its arch decides the layer's arch — arm64/Graviton on an
# Apple-Silicon host, x64 on a GitHub-hosted runner; publish one layer per arch you target).

set -euo pipefail

IMAGE="${LAMBDA_LAYER_IMAGE:-public.ecr.aws/lambda/nodejs:22}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || {
  echo "build-lambda-layer: docker is required" >&2
  exit 1
}

echo "build-lambda-layer: build + pack"
pnpm build >/dev/null
# Pack both workspace packages (pnpm rewrites `workspace:*` to a concrete version, so these are publish-shaped)
# into a REPO-LOCAL dir — Docker Desktop shares /Users, not /var/folders — then place them into the layer's
# node_modules by hand, since the pinned `@cloudbitmaps/core` version is not registry-resolvable pre-launch.
PACKDIR="$ROOT/.pack-tmp"
rm -rf "$PACKDIR" && mkdir -p "$PACKDIR"
( cd packages/core    && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
( cd packages/roaring && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
CORE_TGZ="$(ls "$PACKDIR"/cloudbitmaps-core-*.tgz | head -1)"
ROARING_TGZ="$(ls "$PACKDIR"/cloudbitmaps-roaring-*.tgz | head -1)"
[ -n "$CORE_TGZ" ] && [ -n "$ROARING_TGZ" ] || {
  echo "build-lambda-layer: pnpm pack produced no tarballs" >&2
  exit 1
}
ROARING_VER="$(node -p "require('./node_modules/roaring/package.json').version")"

trap 'rm -rf "$PACKDIR"' EXIT

OUT="$ROOT/dist-lambda"
rm -rf "$OUT"
mkdir -p "$OUT"

# Mount the tarball read-only and an output dir read-write; build + zip the layer inside the AL2023 runtime.
echo "build-lambda-layer: install (from source) + zip inside $IMAGE"
docker run --rm --entrypoint bash \
  -e ROARING_VER="$ROARING_VER" -v "$CORE_TGZ:/w/core.tgz:ro" -v "$ROARING_TGZ:/w/roaring.tgz:ro" -v "$OUT:/out" "$IMAGE" -lc '
    set -e
    dnf install -y gcc-c++ make python3 tar gzip zip >/dev/null 2>&1
    build="$(mktemp -d)"; cd "$build"
    mkdir -p nodejs && cd nodejs
    npm init -y >/dev/null 2>&1
    # --omit=dev: ship only runtime deps (the library + roaring); build roaring FROM SOURCE for AL2023.
    npm init -y >/dev/null 2>&1
    npm_config_build_from_source=true npm install "roaring@${ROARING_VER}" --omit=dev --no-audit --no-fund >/dev/null 2>&1
    mkdir -p node_modules/@cloudbitmaps/core node_modules/@cloudbitmaps/roaring
    tar -xzf /w/core.tgz    --strip-components=1 -C node_modules/@cloudbitmaps/core
    tar -xzf /w/roaring.tgz --strip-components=1 -C node_modules/@cloudbitmaps/roaring
    cd "$build"
    zip -qr /out/cloud-roaring-lambda-layer.zip nodejs
  '

SIZE="$(du -h "$OUT/cloud-roaring-lambda-layer.zip" | cut -f1)"
echo "build-lambda-layer: PASS — $OUT/cloud-roaring-lambda-layer.zip ($SIZE, $IMAGE)"
