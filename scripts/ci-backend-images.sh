#!/usr/bin/env bash
# Make every image the integration backends run local, and write a compose override that runs each service on it.
#
# Each image comes through docker_pull_with_backoff, one at a time, which with DOCKER_IMAGE_CACHE set uses the copy
# CI keeps in the Actions cache (scripts/lib/docker-pull.sh says when). A copy of an image named by digest is found
# after a load only under its local name, since a loaded image answers only to the names it was saved under, and
# compose asks for MinIO by digest. So the override points each service at the name its image is kept under, and at
# the image itself when there is no cache or its copy could not be kept.
#
# It reads docker-compose.yml alone, as ci.yml starts it: with no `-f`, compose would also read an override file or
# COMPOSE_FILE, and ready images the job never starts.
#
# Usage: scripts/ci-backend-images.sh <override-file>
#   then: docker compose -f docker-compose.yml -f <override-file> up ...
set -uo pipefail

override="${1:?usage: ci-backend-images.sh <override-file>}"
root="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
. "$root/scripts/lib/docker-pull.sh"

config="$(docker compose -f "$root/docker-compose.yml" config --format json)" || exit 1
# Each service and the image it declares, a line each, read with node, which CI and every contributor already have.
pairs="$(node -e '
  const services = JSON.parse(require("fs").readFileSync(0, "utf8")).services ?? {};
  for (const name of Object.keys(services).sort()) console.log(`${name} ${services[name].image ?? ""}`);
' <<<"$config")" || exit 1
if [ -z "$pairs" ]; then
  echo "backend-images: docker-compose.yml declares no services" >&2
  exit 1
fi
printf 'services:\n' >"$override"
rc=0
while read -r service image; do
  if [ -z "$image" ]; then
    echo "backend-images: service $service declares no image" >&2
    rc=1
    continue
  fi
  if ! docker_pull_with_backoff "$image"; then
    rc=1
    continue
  fi
  printf '  %s:\n    image: %s\n' "$service" "$(docker_image_run_name "$image")" >>"$override"
  sleep 2 # one at a time: simultaneous pulls are what provoke a registry's rate limit in the first place
done <<<"$pairs"
exit "$rc"
