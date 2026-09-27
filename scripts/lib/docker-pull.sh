# shellcheck shell=bash
# Pull a container image, absorbing a registry RATE limit, and putting the registry's own error in the log when an
# image cannot be had.
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
# suppressing output, putting the registry's actual error in the log. It then returns non-zero, unless CI's cache
# (below) holds a copy of the image: then the copy stands in, and the run is warned.
#
# THE CACHE. Backoff absorbs a rate, not a refusal, and registries refuse too: quay.io began refusing anonymous
# pulls of MinIO in September 2026, public.ecr.aws answers `Data limit exceeded` once the runners' shared IPs pass
# its anonymous quota of 500 GB a month, and Chainguard's free tier publishes only `latest` and `latest-dev`: it
# lets anyone pull by digest, but does not say for how long, so a digest pinned today could stop resolving.
# With DOCKER_IMAGE_CACHE set to a directory, which CI keeps in the Actions cache, each image pulled is also saved
# there, and a later run uses the copy:
#   - without asking the registry when DOCKER_IMAGE_CACHE_HIT is `true`, which CI sets when it restored the entry
#     saved this month for the files that name the images and for this helper. Otherwise the image is pulled
#     again: a tag for its newer build, and a digest to learn whether the registry still serves it. So each image
#     is asked for once a month, and again whenever one of those files changes;
#   - when a pull fails after every attempt, whatever the month: the log says so, and in GitHub Actions the run
#     carries a warning. A registry that has stopped serving an image is seen there before the cache loses its copy,
#     which it does after a week in which no run restores it.
# A registry that changes its rules then fails a run only when the cache holds no copy of the image at all.
# Unset, as it is for anyone running these scripts by hand, the cache does nothing.

# Usage: docker_pull_with_backoff <image> [max-attempts]
docker_pull_with_backoff() {
  local img="${1:?docker_pull_with_backoff: image required}"
  local attempts="${2:-5}"
  local cached=""
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ]; then
    cached="$(docker_image_cache_file "$img")"
    if [ -f "$cached" ] && [ "${DOCKER_IMAGE_CACHE_HIT:-}" = true ] && docker_image_load "$img" "$cached"; then
      echo "docker-pull: $img from the cache" >&2
      return 0
    fi
  fi
  local attempt=1
  while :; do
    if docker pull -q "$img" >/dev/null 2>&1; then
      [ "$attempt" -gt 1 ] && echo "docker-pull: ok $img (attempt $attempt)" >&2
      docker_image_keep "$img" "$cached"
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "docker-pull: FAILED after $attempts attempts: $img" >&2
      echo "docker-pull: re-running once with output so the real error is visible ↓" >&2
      if docker pull "$img" >&2; then
        docker_image_keep "$img" "$cached"
        return 0
      fi
      # The copy an earlier run kept is this image, or an earlier build of its tag: a run on it tests what the last
      # run tested, where no image at all tests nothing.
      if [ -n "$cached" ] && [ -f "$cached" ] && docker_image_load "$img" "$cached"; then
        docker_pull_warning "using the copy of $img the cache kept from an earlier run: the registry refused it"
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

# The local name a cached image is saved and loaded under. A loaded image answers only to the names it was saved
# under, and a digest it was pulled by is not one, so an image named by digest is found after a load only by this
# name. Its registry is under `.invalid`, which never resolves, so a pull of it fails rather than fetch whatever
# Docker Hub might one day hold under a name like `cloud-roaring-ci/cache`.
docker_image_local_name() { printf 'cloud-roaring-ci.invalid/cache:%s' "$(docker_image_cache_id "$1")"; }

# The name to run an image by once docker_pull_with_backoff has made it local: its local name when that exists, and
# the image otherwise. `docker run <digest>` on a copy loaded from the cache would pull it again, with no backoff.
docker_image_run_name() {
  local name
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ]; then
    name="$(docker_image_local_name "$1")"
    if docker image inspect "$name" >/dev/null 2>&1; then
      printf '%s' "$name"
      return 0
    fi
  fi
  printf '%s' "$1"
}

# Say that a copy stood in for a refused pull. In GitHub Actions it is also a warning on the run, which a green run
# would otherwise hide.
docker_pull_warning() {
  echo "docker-pull: $1" >&2
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::warning title=A registry refused a container image::$1" >&2
  fi
  return 0
}

# Keep a pulled image in the cache, when there is one. Failing to keep it is said, and is not a failed pull.
docker_image_keep() {
  [ -n "$2" ] || return 0
  docker_image_save "$1" "$2" || echo "docker-pull: pulled $1, but could not keep it in the cache" >&2
}

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
