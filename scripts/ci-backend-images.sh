#!/usr/bin/env bash
# Make every image the integration backends run local, and write a compose override that runs each service on it.
#
# Each image comes through docker_pull_with_backoff, one at a time, which with DOCKER_IMAGE_CACHE set uses the copy
# CI keeps in the Actions cache (scripts/lib/docker-pull.sh says when). A copy of an image named by digest is found
# after a load only under its local name, since `docker load` gives back tags and not digests, and compose asks for
# MinIO by digest. So the override points each service at the name its image is kept under, and with no cache, at the
# image itself.
#
# Usage: scripts/ci-backend-images.sh <override-file>
#   then: docker compose -f docker-compose.yml -f <override-file> up ...
set -uo pipefail

override="${1:?usage: ci-backend-images.sh <override-file>}"
. "$(dirname "$0")/lib/docker-pull.sh"

config="$(docker compose config --format json)" || exit 1
printf 'services:\n' >"$override"
rc=0
for service in $(docker compose config --services); do
  image="$(jq -r --arg s "$service" '.services[$s].image // empty' <<<"$config")"
  if [ -z "$image" ]; then
    echo "backend-images: service $service declares no image" >&2
    rc=1
    continue
  fi
  if ! docker_pull_with_backoff "$image"; then
    rc=1
    continue
  fi
  name="$image"
  if [ -n "${DOCKER_IMAGE_CACHE:-}" ] && docker image inspect "$(docker_image_local_name "$image")" >/dev/null 2>&1; then
    name="$(docker_image_local_name "$image")"
  fi
  printf '  %s:\n    image: %s\n' "$service" "$name" >>"$override"
  sleep 2 # one at a time: simultaneous pulls are what provoke a registry's rate limit in the first place
done
exit "$rc"
