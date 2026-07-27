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

# Usage: docker_pull_with_backoff <image> [max-attempts]
docker_pull_with_backoff() {
  local img="${1:?docker_pull_with_backoff: image required}"
  local attempts="${2:-5}"
  local attempt=1
  while :; do
    if docker pull -q "$img" >/dev/null 2>&1; then
      [ "$attempt" -gt 1 ] && echo "docker-pull: ok $img (attempt $attempt)" >&2
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "docker-pull: FAILED after $attempts attempts: $img" >&2
      echo "docker-pull: re-running once with output so the real error is visible ↓" >&2
      docker pull "$img" >&2 || true
      return 1
    fi
    # Linear backoff: a per-second rate limit clears in moments, so 10s/20s/30s/40s is ample and keeps the
    # worst case (100s) well inside a job timeout. Exponential would buy nothing here and risks the timeout.
    echo "docker-pull: $img throttled or unavailable (attempt $attempt/$attempts) — waiting $((attempt * 10))s" >&2
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}
