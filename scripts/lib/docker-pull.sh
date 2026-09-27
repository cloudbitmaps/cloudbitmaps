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
# suppressing output, putting the registry's actual error in the log. If that pull succeeds, so does the call. If
# not, it returns non-zero, unless CI's cache (below) holds a copy of the image: then the copy stands in, and the run
# is warned.
#
# THE CACHE. Backoff absorbs a rate, not a refusal, and registries refuse too: quay.io began refusing anonymous
# pulls of MinIO in September 2026, public.ecr.aws answers `Data limit exceeded` once the runners' shared IPs pass
# its anonymous quota of 500 GB a month, and Chainguard's free tier publishes only `latest` and `latest-dev`: it
# lets anyone pull by digest, but does not say for how long, so a digest pinned today could stop resolving.
# With DOCKER_IMAGE_CACHE set to a directory, which CI keeps in the Actions cache, each image pulled is also saved
# there, and a later run uses the copy:
#   - without asking the registry when DOCKER_IMAGE_CACHE_HIT is `true`, which CI sets when it restored the entry
#     saved this month, on this runner image, for the files that name the images and for this helper. Otherwise the
#     image is pulled again: a tag for its newer build, and a digest to learn whether the registry still serves it.
#     So each image is asked for once a month, and again whenever one of those things changes;
#   - when a pull fails after every attempt, or stalls, whatever the month: the log says so, and in GitHub Actions
#     the run carries a warning. Only the run that asks warns: its save keeps the copy under the month's key, and
#     the runs after it that month load the copy without asking. So a registry that has stopped serving an image is
#     seen once a month, before the cache loses its copy, which it does after a week in which no run restores it.
# A registry that changes its rules then fails a run only when the cache holds no copy of the image at all. CI saves
# only from a run that passed, so a broken build of a tag is not kept. To drop a copy all the same, delete that job's
# entries (`gh cache list --key docker-images-<job>-`, then `gh cache delete <key>`): the next run asks again.
# Unset, as it is for anyone running these scripts by hand, the cache does nothing.

# Usage: docker_pull_with_backoff <image> [max-attempts]
docker_pull_with_backoff() {
  local img="${1:?docker_pull_with_backoff: image required}"
  local attempts="${2:-5}"
  # `usable` is the copy the cache kept, while it may still load: one that has failed to is not tried again.
  local cached="" usable=""
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ]; then
    cached="$(docker_image_cache_file "$img")"
    [ -f "$cached" ] && usable="$cached"
    if [ -n "$usable" ] && [ "${DOCKER_IMAGE_CACHE_HIT:-}" = true ]; then
      if docker_image_load "$img" "$cached"; then
        echo "docker-pull: $img from the cache" >&2
        return 0
      fi
      echo "docker-pull: the copy of $img the cache kept did not load; pulling it" >&2
      usable=""
    fi
  fi
  local attempt=1 rc did why stalls=0
  while :; do
    # Tested, not run bare: the callers run under `set -e`, which a failed attempt must not end.
    if docker_pull_attempt -q "$img" >/dev/null 2>&1; then rc=0; else rc=$?; fi
    if [ "$rc" -eq 0 ]; then
      [ "$attempt" -gt 1 ] && echo "docker-pull: ok $img (attempt $attempt)" >&2
      docker_image_keep "$img" "$cached"
      return 0
    fi
    # A pull that stalls is not a throttle, and waiting on more of them only runs down the job's timeout. With a copy
    # kept, use it now. With none that loads, a second stall, in all and not only in a row, ends the tries: each costs
    # DOCKER_PULL_TIMEOUT, three minutes by default, and six would take 18 of the integration job's 20, leaving its
    # timeout to end the job with no word of why.
    if [ "$rc" -eq 124 ]; then
      stalls=$((stalls + 1))
      if [ -n "$usable" ]; then
        echo "docker-pull: the pull of $img stalled" >&2
        docker_image_fall_back "$img" "$cached" "stalled" && return 0
        usable=""
      fi
      if [ "$stalls" -ge 2 ]; then
        echo "docker-pull: FAILED: the pull of $img stalled twice, and no copy the cache kept could stand in" >&2
        return 1
      fi
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "docker-pull: FAILED after $attempts attempts: $img" >&2
      echo "docker-pull: re-running once with output so the real error is visible ↓" >&2
      if docker_pull_attempt "$img" >&2; then rc=0; else rc=$?; fi
      if [ "$rc" -eq 0 ]; then
        docker_image_keep "$img" "$cached"
        return 0
      fi
      if [ -n "$usable" ]; then
        if [ "$rc" -eq 124 ]; then did="stalled"; else did="refused it"; fi
        docker_image_fall_back "$img" "$cached" "$did" && return 0
      fi
      # A stall prints nothing of its own, so the log would otherwise end at the line above.
      [ "$rc" -eq 124 ] &&
        echo "docker-pull: FAILED: the last pull of $img stalled (no answer in ${DOCKER_PULL_TIMEOUT:-180}s)" >&2
      return 1
    fi
    # Linear backoff: a per-second rate limit clears in moments, so 10s/20s/30s/40s is ample: 100s of waiting at most,
    # well inside a job timeout, beside at most two stalls. Exponential would buy nothing here and risks the timeout.
    why="throttled or unavailable"
    [ "$rc" -eq 124 ] && why="stalled"
    echo "docker-pull: $img $why (attempt $attempt/$attempts) — waiting $((attempt * 10))s" >&2
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}

# One pull. With DOCKER_IMAGE_CACHE set, as CI sets it, it is bounded where `timeout` exists (DOCKER_PULL_TIMEOUT
# seconds, 180 by default): `docker pull` sets no bound of its own, so a registry that accepts a connection and then
# stops answering would otherwise hold the job until its timeout. 124 means it stalled. By hand it is not bounded: over
# a slow link one layer can take longer than that, and whoever is watching can stop it.
docker_pull_attempt() {
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ] && command -v timeout >/dev/null 2>&1; then
    timeout "${DOCKER_PULL_TIMEOUT:-180}" docker pull "$@"
  else
    docker pull "$@"
  fi
}

# Load the copy an earlier run kept, in place of a pull that failed: it is this image, or an earlier build of its
# tag, and a run on it tests what the last run tested, where no image at all tests nothing. $3 says what the
# registry did.
docker_image_fall_back() {
  if docker_image_load "$1" "$2"; then
    docker_pull_warning "using the copy of $1 the cache kept from an earlier run: the registry $3"
    return 0
  fi
  echo "docker-pull: the copy of $1 the cache kept did not load either" >&2
  return 1
}

# The part of a cache name that is the image: a hash of the reference it was pulled by, so a re-pinned image is a
# new file and nothing pulled for one reference stands in for another.
docker_image_cache_id() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-16
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-16 # older macOS has shasum but no sha256sum
  fi
}
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
    echo "::warning title=A registry did not serve a container image::$1" >&2
  fi
  return 0
}

# Keep a pulled image in the cache, when there is one. Failing to keep it is said, and is not a failed pull. The copy
# an earlier run kept then stays, whole, since a save writes beside it and takes its place only when done. With no
# such copy the cache now lacks this image, so it is marked incomplete, and not saved (docker_image_cache_prune): a
# month's entry is never written again, and one lacking an image would lack it all month.
docker_image_keep() {
  [ -n "$2" ] || return 0
  docker_image_save "$1" "$2" && return 0
  echo "docker-pull: pulled $1, but could not keep it in the cache" >&2
  if [ -f "$2" ]; then
    docker_image_cache_used "$2"
  else
    docker_image_cache_incomplete
  fi
  return 0
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
# One that cannot be recorded, as on a full disk, is said, and stops the save, since the prune would drop it unrecorded.
# It is not a failed pull: the callers run under `set -e`, and the image is local either way.
docker_image_cache_used() {
  { basename "$1" >>"$DOCKER_IMAGE_CACHE/.used"; } 2>/dev/null && return 0
  echo "docker-pull: could not record that this run used $(basename "$1"); the cache will not be saved" >&2
  docker_image_cache_incomplete
}

# Mark the cache as lacking something this run needed, so it is not saved (docker_image_cache_prune).
docker_image_cache_incomplete() { : 2>/dev/null >"$DOCKER_IMAGE_CACHE/.incomplete" || true; }

# Drop every file this run did not use, so an image re-pinned away leaves the cache. Prints whether the cache is worth
# saving: some file is left, and no image this run pulled went unkept (docker_image_keep). CI saves it only then. A
# save cut short with no earlier copy beside it is an image unkept too, which it says even when the marker could not be
# written.
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
  [ -e "$DOCKER_IMAGE_CACHE/.incomplete" ] && kept=false
  for file in "$DOCKER_IMAGE_CACHE"/*.part; do
    [ -e "$file" ] && [ ! -e "${file%.part}" ] && kept=false
  done
  rm -f "$DOCKER_IMAGE_CACHE/.used" "$DOCKER_IMAGE_CACHE/.incomplete" "$DOCKER_IMAGE_CACHE"/*.part
  echo "$kept"
}
