# shellcheck shell=bash
# Pull a container image, absorbing a registry RATE limit without hiding a genuinely-missing image.
#
# Why this exists as a shared function rather than three copies. Every public registry throttles the shared
# GitHub-runner IP pool, and the two shapes need opposite responses: Docker Hub answers with a **6-hour quota**
# (`pull rate limit`), which cannot be waited out and needs a different registry; public.ecr.aws answers with a
# **per-second rate** (`toomanyrequests: Rate exceeded`), which clears in moments and only needs backoff. The CI
# integration job learned that the hard way and grew a serial-pull-with-backoff loop. The two scripts that
# `docker run` an ECR image directly — rss-gate.sh and lambda-smoke.sh — did not, so they kept failing on a
# throttle that a 10-second retry would have absorbed. `docker run` pulls implicitly on a cache miss, which is
# exactly the trap: the pull happens whether or not anyone wrote a pull step, so the retry has to be explicit.
#
# Failing loudly still matters. Throttling is transient; a typo'd tag or a deleted image is not, and a retry
# loop that swallows both is worse than no retry at all. So on the final attempt this re-runs the pull WITHOUT
# suppressing output, putting the registry's actual error in the log before returning non-zero.
#
# THE CACHE. Backoff absorbs a rate, not a refusal, and registries refuse too: quay.io began refusing anonymous
# pulls of MinIO in September 2026, public.ecr.aws answers `Data limit exceeded` once the runners' shared IPs pass
# its anonymous quota, and Chainguard's free tier serves only `latest`, so a digest pinned today may stop resolving.
# With DOCKER_IMAGE_CACHE set to a directory, which CI keeps in the Actions cache, each image pulled is also saved
# there, and a later run uses the copy:
#   - an image named by digest cannot change, so its copy is used and the registry is not asked;
#   - a tag's copy is used without asking when DOCKER_IMAGE_CACHE_HIT is `true`, which CI sets when it restored the
#     cache saved for this month; otherwise the tag is pulled again, so a tag is refreshed once a month;
#   - when a pull fails after every attempt, a copy an earlier run saved is used, and the log says so.
# A registry that changes its rules then fails a run only when the cache holds no copy of the image at all.
# Unset, as it is for anyone running these scripts by hand, the cache does nothing.

# Usage: docker_pull_with_backoff <image> [max-attempts]
docker_pull_with_backoff() {
  local img="${1:?docker_pull_with_backoff: image required}"
  local attempts="${2:-5}"
  local cached=""
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ]; then
    cached="$(docker_image_cache_file "$img")"
    if [ -f "$cached" ] && { [[ "$img" == *@sha256:* ]] || [ "${DOCKER_IMAGE_CACHE_HIT:-}" = true ]; } &&
      docker_image_load "$img" "$cached"; then
      echo "docker-pull: $img from the cache" >&2
      return 0
    fi
  fi
  local attempt=1
  while :; do
    if docker pull -q "$img" >/dev/null 2>&1; then
      [ "$attempt" -gt 1 ] && echo "docker-pull: ok $img (attempt $attempt)" >&2
      if [ -n "$cached" ] && ! docker_image_save "$img" "$cached"; then
        echo "docker-pull: pulled $img, but could not keep it in the cache" >&2
      fi
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "docker-pull: FAILED after $attempts attempts: $img" >&2
      echo "docker-pull: re-running once with output so the real error is visible ↓" >&2
      docker pull "$img" >&2 || true
      # The copy an earlier run kept is this image, or an earlier build of its tag: a run on it tests what the last
      # run tested, where no image at all tests nothing.
      if [ -n "$cached" ] && [ -f "$cached" ] && docker_image_load "$img" "$cached"; then
        echo "docker-pull: using the copy of $img the cache kept from an earlier run" >&2
        return 0
      fi
      return 1
    fi
    # Linear backoff: a per-second rate limit clears in moments, so 10s/20s/30s/40s is ample and keeps the
    # worst case (100s) well inside a job timeout. Exponential would buy nothing here and risks the timeout.
    echo "docker-pull: $img throttled or unavailable (attempt $attempt/$attempts) — waiting $((attempt * 10))s" >&2
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}

# The part of a cache name that is the image: a hash of the reference it was pulled by, so a re-pinned image is a
# new file and nothing pulled for one reference stands in for another.
docker_image_cache_id() { printf '%s' "$1" | sha256sum | cut -c1-16; }
docker_image_cache_file() { printf '%s/%s.tar' "$DOCKER_IMAGE_CACHE" "$(docker_image_cache_id "$1")"; }

# The local name a cached image is saved and loaded under. `docker save` keeps an image's tags but not the digest it
# was pulled by, so an image named by digest is found after a load only by this name, which a caller running it
# uses in its place: scripts/ci-backend-images.sh points compose at it.
docker_image_local_name() { printf 'cloud-roaring-ci/cache:%s' "$(docker_image_cache_id "$1")"; }

docker_image_save() {
  local name
  name="$(docker_image_local_name "$1")"
  mkdir -p "$(dirname "$2")" &&
    docker tag "$1" "$name" &&
    docker save -o "$2.part" "$name" &&
    mv "$2.part" "$2" &&
    docker_image_cache_used "$2"
}

docker_image_load() {
  local name
  name="$(docker_image_local_name "$1")"
  docker load -q -i "$2" >/dev/null 2>&1 && docker image inspect "$name" >/dev/null 2>&1 || return 1
  docker_image_cache_used "$2"
  # A tag is given back, so `docker run <image>` finds it; a digest cannot be.
  [[ "$1" == *@sha256:* ]] || docker tag "$name" "$1"
}

# Which files this run used, so the ones it did not are dropped before the cache is saved (docker_image_cache_prune).
docker_image_cache_used() { basename "$1" >>"$DOCKER_IMAGE_CACHE/.used"; }

# Drop every file this run did not use, so an image re-pinned away leaves the cache. Prints whether any file is left:
# CI saves the cache only if one is.
docker_image_cache_prune() {
  local file kept=false
  for file in "$DOCKER_IMAGE_CACHE"/*.tar; do
    [ -e "$file" ] || continue
    if grep -qxF "$(basename "$file")" "$DOCKER_IMAGE_CACHE/.used" 2>/dev/null; then
      kept=true
    else
      rm -f "$file"
    fi
  done
  rm -f "$DOCKER_IMAGE_CACHE/.used" "$DOCKER_IMAGE_CACHE"/*.part
  echo "$kept"
}
