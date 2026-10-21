#!/usr/bin/env bash
#
# Build a ready-to-attach AWS Lambda **layer** for CloudRoaring: the flavor and the engine under `nodejs/node_modules/`.
# A Node Lambda layer is a zip whose contents live under `nodejs/node_modules/...`, which the runtime puts on
# NODE_PATH. The packages carry no native code, so the layer holds only JavaScript and is the same for x64 and arm64:
# nothing is compiled for the target. The script packs the two packages, unpacks them into `nodejs/node_modules`, zips
# that, and then loads the unpacked layer from `/opt/nodejs/node_modules` in the Amazon Linux 2023 Lambda image, the
# path a function sees it at, under CJS (NODE_PATH resolves `require`, not an ESM `import`).
#
# Usage: `pnpm build-lambda-layer`. Needs Docker and `zip`. Output: dist-lambda/cloudbitmaps-lambda-layer.zip.
# Override the base image with LAMBDA_LAYER_IMAGE.

set -euo pipefail

IMAGE="${LAMBDA_LAYER_IMAGE:-public.ecr.aws/lambda/nodejs:22}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || {
  echo "build-lambda-layer: docker is required" >&2
  exit 1
}
command -v zip >/dev/null 2>&1 || {
  echo "build-lambda-layer: zip is required" >&2
  exit 1
}

# Same implicit-pull trap as lambda-smoke.sh and rss-gate.sh: `docker run` pulls on a cache miss, and a
# registry rate limit then fails the build with nothing produced. Pull explicitly, with backoff.
# shellcheck source=scripts/lib/docker-pull.sh
. "$ROOT/scripts/lib/docker-pull.sh"
docker_pull_with_backoff "$IMAGE"
RUN_IMAGE="$(docker_image_run_name "$IMAGE")" # a copy loaded from the cache runs by this name

echo "build-lambda-layer: build + pack"
pnpm build >/dev/null
# Pack the flavor and the engine (pnpm rewrites `workspace:*` to a concrete version, so these are publish-shaped) into a
# REPO-LOCAL dir (Docker Desktop shares /Users, not /var/folders), then unpack them into the layer's node_modules by
# hand, since the `@cloudbitmaps/core` version pinned in THIS tree is generally not on the registry yet. The three
# driver packages are deliberately NOT in the layer: which storage a function talks to is the function's own choice, and
# bundling all three would put every cloud SDK into every deployment, the exact cost separate driver packages exist to
# avoid.
PACKDIR="$ROOT/.pack-tmp"
rm -rf "$PACKDIR" && mkdir -p "$PACKDIR"
trap 'rm -rf "$PACKDIR"' EXIT
( cd packages/core    && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
( cd packages/roaring && pnpm pack --pack-destination "$PACKDIR" >/dev/null )
CORE_TGZ="$(ls "$PACKDIR"/cloudbitmaps-core-*.tgz | head -1)"
ROARING_TGZ="$(ls "$PACKDIR"/cloudbitmaps-roaring-*.tgz | head -1)"
[ -n "$CORE_TGZ" ] && [ -n "$ROARING_TGZ" ] || {
  echo "build-lambda-layer: pnpm pack produced no tarballs" >&2
  exit 1
}

LAYER="$PACKDIR/layer"
mkdir -p "$LAYER/nodejs/node_modules/@cloudbitmaps/core" "$LAYER/nodejs/node_modules/@cloudbitmaps/roaring"
tar -xzf "$CORE_TGZ"    --strip-components=1 -C "$LAYER/nodejs/node_modules/@cloudbitmaps/core"
tar -xzf "$ROARING_TGZ" --strip-components=1 -C "$LAYER/nodejs/node_modules/@cloudbitmaps/roaring"

# A layer with an addon in it is the regression this script exists to prevent.
if [ -n "$(find "$LAYER" -name '*.node' -print -quit)" ] || [ -e "$LAYER/nodejs/node_modules/roaring" ]; then
  echo "build-lambda-layer: the layer holds a native addon" >&2
  exit 1
fi

OUT="$ROOT/dist-lambda"
rm -rf "$OUT"
mkdir -p "$OUT"
( cd "$LAYER" && zip -qr "$OUT/cloudbitmaps-lambda-layer.zip" nodejs )

# Load the layer where a function finds it: mounted at /opt, resolved through NODE_PATH.
echo "build-lambda-layer: load the layer from /opt inside $IMAGE"
docker run --rm --entrypoint node -e NODE_PATH=/opt/nodejs/node_modules -v "$LAYER/nodejs:/opt/nodejs:ro" "$RUN_IMAGE" -e "
  const m = require('@cloudbitmaps/roaring');
  const store = new m.CloudRoaring({ storage: new m.MemoryStorage({ now: () => 0 }) });
  store.load({ segment: 'layer' }, [42, 70000]).then(async () => {
    const seg = store.segment('layer');
    if (!(await seg.has(42)) || (await seg.count()) !== 2) throw new Error('the layer round-trip returned a wrong result');
    console.log('  layer loads + round-trips on ' + process.platform + '/' + process.arch);
  });
"

SIZE="$(du -h "$OUT/cloudbitmaps-lambda-layer.zip" | cut -f1)"
echo "build-lambda-layer: PASS: $OUT/cloudbitmaps-lambda-layer.zip ($SIZE, $IMAGE)"
