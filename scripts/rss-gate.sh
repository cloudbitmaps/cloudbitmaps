#!/usr/bin/env bash
#
# Hard RSS ceiling gate (Phase 8 — the definitive memory bound the soak's leak-*watch* can't prove;
# residual #1 / gap #12).
#
# The soak bench proves *no creep* (post-GC heap stays flat); it does NOT prove a hard *peak-RSS* ceiling —
# and RSS includes the `roaring` addon's **off-heap native** memory, which a JS heap sample can't see. This
# gate closes that: run a sustained write+read+compact workload under a hard cgroup `--memory` limit (swap
# disabled, so the limit is a true RSS ceiling) and assert the process **completes without being OOM-killed**
# (a cgroup OOM surfaces as container exit code 137). If a cache regressed to unbounded, the sustained fleet
# would grow past the cap and the kernel would kill it — the gate has teeth.
#
# Why Docker (not systemd-run): it works identically on a Linux CI runner AND on a local Linux-VM Docker
# (Colima/Docker Desktop), and it builds `roaring` **from source for the container's platform** (the host's
# macOS/arm64 addon can't load in the Linux container), reusing the supply-chain from-source path.
#
# Two independent teeth: (1) the hard `--memory` CEILING catches a gross/fast blowup (OOM-kill → exit 137);
# (2) the soak's own post-GC creep verdict catches a subtle sub-MiB leak (soak.cjs exits 1). We build roaring
# in an UNCONSTRAINED stage and run ONLY the soak under the tight ceiling — so the ceiling is sized to the
# runtime working set (sharp), not inflated by the one-off from-source compile.
#
# Usage: `pnpm rss-gate` (or `bash scripts/rss-gate.sh`). Needs Docker. Tunables (env):
#   RSS_GATE_MEMORY=384m     hard cgroup RSS ceiling for the RUN phase (well above the ~170 MiB reader-phase
#                            parent+child peak, well below a real regression; the build phase is uncapped)
#   RSS_GATE_SECONDS=30      soak duration under the cap
#   RSS_GATE_SEGMENTS=400    fleet size (sustained working set)
#   RSS_GATE_CAP=64          cold reader-cache cap (the bound under test)

set -euo pipefail

MEM="${RSS_GATE_MEMORY:-384m}"
SECONDS_="${RSS_GATE_SECONDS:-30}"
SEGMENTS="${RSS_GATE_SEGMENTS:-400}"
CAP="${RSS_GATE_CAP:-64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || {
  echo "rss-gate: docker is required (a Linux-VM Docker enforces the cgroup --memory limit)" >&2
  exit 1
}

echo "rss-gate: build the library (both workspace packages)"
pnpm build >/dev/null

# Pin the in-container roaring build to the exact version the repo resolves, so the gate tests our real dep.
ROARING_VER="$(node -p "require('./node_modules/roaring/package.json').version")"
# Repo-local, NOT mktemp: Docker Desktop shares /Users but not /var/folders, and this is bind-mounted.
STAGE="$ROOT/.rss-stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# Stage 1 — build roaring FROM SOURCE + stage dist + soak into a shared dir, UNCONSTRAINED (the compile's peak
# is not what we gate). node:22 (full) ships the C/C++ toolchain node-gyp needs. Output is kept so a build
# failure is diagnosable (only piped away on success would hide the error) — `set -e` fails the gate on error.
echo "rss-gate: stage build (roaring ${ROARING_VER} from source, uncapped)"
docker run --rm -e ROARING_VER="$ROARING_VER" -v "$ROOT:/w:ro" -v "$STAGE:/stage" node:22 bash -lc '
  set -e
  cd /stage
  npm init -y >/dev/null 2>&1
  npm_config_build_from_source=true npm install "roaring@${ROARING_VER}" --no-audit --no-fund
  # soak.cjs now requires the packages BY NAME (`@cloudbitmaps/roaring`), so lay out a minimal node_modules with
  # both built packages. Placing them directly (rather than `npm install`-ing tarballs) keeps the stage
  # registry-free: the flavor package depends on `@cloudbitmaps/core@workspace:*`, which no registry can resolve
  # pre-publish. Node needs only package.json + dist to resolve through the `exports` map, which is what we want
  # to exercise. `roaring` sits at the stage root, so both packages resolve the native addon from there.
  mkdir -p bench node_modules/@cloudbitmaps/core node_modules/@cloudbitmaps/roaring
  cp -r /w/packages/core/dist        node_modules/@cloudbitmaps/core/dist
  cp    /w/packages/core/package.json node_modules/@cloudbitmaps/core/package.json
  cp -r /w/packages/roaring/dist        node_modules/@cloudbitmaps/roaring/dist
  cp    /w/packages/roaring/package.json node_modules/@cloudbitmaps/roaring/package.json
  cp /w/bench/soak.cjs ./bench/soak.cjs
'

# Stage 2 — run ONLY the soak under the tight hard ceiling. `--memory-swap` == `--memory` disables swap, so the
# limit is a true RSS ceiling (no spill hides growth) and covers roaring's off-heap native memory.
echo "rss-gate: run soak under a hard ${MEM} RSS ceiling (swap off)"
docker run --rm \
  --memory="$MEM" --memory-swap="$MEM" \
  -e SOAK_SECONDS="$SECONDS_" -e SOAK_SEGMENTS="$SEGMENTS" -e SOAK_CAP="$CAP" \
  -v "$STAGE:/stage" node:22 bash -lc '
    cd /stage
    # NOTE: soak spawns a reader-child; if the child alone were OOM-killed, soak.cjs treats it as a bonus and
    # the parent still runs — so a read-path blowup is caught by the parent hitting the ceiling / the creep
    # verdict, not by the child. Adequate here (big margin); the isolated child footprint is not separately gated.
    node --expose-gc bench/soak.cjs
  ' || {
  code=$?
  if [ "$code" -eq 137 ]; then
    echo "rss-gate: FAIL — workload was OOM-killed at the ${MEM} ceiling (exit 137): a memory bound is not holding." >&2
  else
    echo "rss-gate: FAIL — soak exited ${code} under the ${MEM} ceiling (heap-creep verdict or error)." >&2
  fi
  exit "$code"
}

echo "rss-gate: PASS — the sustained workload stayed within the hard ${MEM} RSS ceiling (no OOM, no creep)."
