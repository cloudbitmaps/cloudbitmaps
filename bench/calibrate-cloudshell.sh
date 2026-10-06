#!/usr/bin/env bash
# In-region calibration: run this from AWS CloudShell, in the region being measured.
#
# WHY CLOUDSHELL. Latency measured from outside the region is internet transit, not the library: a run from a
# laptop produces a p50 that describes the network. CloudShell sits inside the region, needs no instance to
# provision, and costs nothing.
#
# WHY THE PUBLISHED PACKAGES. This installs @cloudbitmaps/roaring and @cloudbitmaps/s3 from npm into a scratch
# directory and runs the harness against those, not against a build of this checkout. The figures then describe
# what a consumer actually installs, and CloudShell never needs this repository's toolchain.
#
# Usage, from a clone of this repository inside CloudShell:
#   CR_CALIBRATE_CONFIRM=yes-spend-money CR_CALIBRATE_MAX_USD=0.05 bash bench/calibrate-cloudshell.sh
#
# Optional: CR_CALIBRATE_EXPECT_ACCOUNT=<12-digit id> refuses to run anywhere else.
#           CR_CALIBRATE_PACKAGE_VERSION=0.11.0 overrides the release measured (default: this clone's version).
#           CR_CALIBRATE_MAX_SOCKETS=64 sets the workload client's socket limit (default 128, the limit the library gives
#           the client it builds; the AWS SDK's own default is 50). A positive integer of at most 1024, refused otherwise.
#           CR_CALIBRATE_REHEARSE=1 runs the same install path against local MinIO, to test this script. Any
#           other value than unset, 0 or 1 is refused.
#           CR_CALIBRATE_SUITE=large runs the large suite (combines on operands of 10^6 to 10^7 ids) in place of the
#           default one, and CR_CALIBRATE_LARGE_READS and CR_CALIBRATE_LARGE_INTOS size it; its evidence is written
#           under bench/calibration/large/. Any other suite name is refused by the harness, before anything is created.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Only unset, empty, 0 or 1 say which target this is. Anything else, `true` or ` 1` or `yes`, would fall through to the
# run that spends money with a ceiling and a phrase already exported, so it is refused before anything else is read.
refuse_bad_rehearse() {
  case "${CR_CALIBRATE_REHEARSE:-}" in
    '' | 0 | 1) ;;
    *)
      echo "cloudshell: CR_CALIBRATE_REHEARSE must be 1 or unset, not \"${CR_CALIBRATE_REHEARSE}\"" >&2
      exit 2
      ;;
  esac
}
refuse_bad_rehearse

# Only unset, empty, `default` or `large` name a suite. The harness refuses any other, but only once the packages are
# installed, so it is refused here first, and a name it would take is left to it.
refuse_bad_suite() {
  case "${CR_CALIBRATE_SUITE:-}" in
    '' | default | large) ;;
    *)
      echo "cloudshell: CR_CALIBRATE_SUITE must be default or large, not \"${CR_CALIBRATE_SUITE}\"" >&2
      exit 2
      ;;
  esac
}
refuse_bad_suite

# The workload client's socket limit, by the harness's own rule: digits, 1 to 1024 (beyond a process's usual
# file-descriptor limit, 1,024 on Lambda for one, it cannot be held). Whitespace only is unset. Refused here, before
# anything is installed, and normalised, so the line echoed below is the number the harness will use.
MAX_SOCKETS_ASKED="${CR_CALIBRATE_MAX_SOCKETS:-}"
MAX_SOCKETS_ASKED="${MAX_SOCKETS_ASKED#"${MAX_SOCKETS_ASKED%%[![:space:]]*}"}"
MAX_SOCKETS_ASKED="${MAX_SOCKETS_ASKED%"${MAX_SOCKETS_ASKED##*[![:space:]]}"}"
MAX_SOCKETS_SHOWN="128 (the library's default)"
if [ -n "$MAX_SOCKETS_ASKED" ]; then
  case "$MAX_SOCKETS_ASKED" in
    *[!0-9]*)
      echo "cloudshell: CR_CALIBRATE_MAX_SOCKETS is \"${CR_CALIBRATE_MAX_SOCKETS}\"; expected a positive integer of at most 1024 (more than a process's usual file-descriptor limit, 1,024 on Lambda, cannot be held)" >&2
      exit 2
      ;;
  esac
  MAX_SOCKETS_NUM=$((10#$MAX_SOCKETS_ASKED))
  if [ "$MAX_SOCKETS_NUM" -lt 1 ] || [ "$MAX_SOCKETS_NUM" -gt 1024 ]; then
    echo "cloudshell: CR_CALIBRATE_MAX_SOCKETS is \"${CR_CALIBRATE_MAX_SOCKETS}\"; expected a positive integer of at most 1024 (more than a process's usual file-descriptor limit, 1,024 on Lambda, cannot be held)" >&2
    exit 2
  fi
  MAX_SOCKETS_SHOWN="$MAX_SOCKETS_NUM"
  export CR_CALIBRATE_MAX_SOCKETS="$MAX_SOCKETS_NUM"
fi

# The shell must be IN the region measured: a latency taken from another region is labelled in-region by a floor under
# 30 ms, which a neighbouring region can also make. So the shell's own region, which CloudShell exports, has to exist,
# and a region asked for has to be it.
refuse_foreign_region() {
  if [ -z "${AWS_REGION:-}" ]; then
    echo "cloudshell: this script is for CloudShell, which exports AWS_REGION; it is not set here" >&2
    exit 2
  fi
  if [ -n "${CR_CALIBRATE_REGION:-}" ] && [ "$CR_CALIBRATE_REGION" != "$AWS_REGION" ]; then
    echo "cloudshell: this shell runs in ${AWS_REGION}; open CloudShell in ${CR_CALIBRATE_REGION}" >&2
    exit 2
  fi
}

# The release measured is the one this clone's expectations were written for, so a release cut since cannot change
# what is measured. CR_CALIBRATE_PACKAGE_VERSION overrides it.
default_package_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' packages/roaring/package.json | head -n 1
}
PKG_VERSION="${CR_CALIBRATE_PACKAGE_VERSION:-$(default_package_version)}"
if [ -z "$PKG_VERSION" ]; then
  echo "cloudshell: could not read this clone's version from packages/roaring/package.json" >&2
  exit 2
fi
echo "cloudshell: measuring @cloudbitmaps/roaring and @cloudbitmaps/s3 at ${PKG_VERSION}"
# The harness validates the number and records the limit it read back from the client; this line says what was asked.
echo "cloudshell: the workload client's socket limit is ${MAX_SOCKETS_SHOWN}"
MODE_FLAG="--run"
if [ "${CR_CALIBRATE_REHEARSE:-}" = "1" ]; then
  MODE_FLAG="--rehearse"
else
  refuse_foreign_region
  export CR_CALIBRATE_REGION="${CR_CALIBRATE_REGION:-$AWS_REGION}"
  # Recorded with the results, so the file says which region the shell ran in.
  export CR_CALIBRATE_CLIENT_REGION="$AWS_REGION"
fi
# Which harness ran is part of the result: the numbers mean nothing without the code that produced them. A clone
# with uncommitted edits to the files this script runs is marked -dirty, because the commit alone would name a harness
# that did not run. The packages are not among them: they come from npm.
harness_ref() {
  local ref
  ref="$(git rev-parse --short HEAD 2>/dev/null)" || { echo unknown; return; }
  if [ -n "$(git status --porcelain -- bench/calibrate-aws.cjs bench/calibrate-cloudshell.sh bench/lib/aws-meter.cjs \
    bench/lib/calibrate-guards.cjs bench/lib/calibrate-large-resources.cjs bench/lib/calibrate-large-stages.cjs \
    bench/lib/calibrate-large.cjs bench/lib/calibrate-process.cjs bench/lib/calibrate-samples.cjs \
    bench/lib/calibrate-spread.cjs bench/lib/calibrate-stages.cjs bench/lib/large-counts.cjs \
    bench/lib/range-counts.cjs 2>/dev/null)" ]; then
    ref="${ref}-dirty"
  fi
  echo "$ref"
}
CR_CALIBRATE_HARNESS_REF="$(harness_ref)"
export CR_CALIBRATE_HARNESS_REF

# Evidence is write-once, and the harness cannot see this clone's evidence from the scratch copy it runs in below —
# so a run named after a committed one is refused HERE, before anything is installed or spent. An unset id is
# generated by the harness, with a random suffix no committed run can share.
refuse_committed_run_id() {
  local dir="bench/calibration"
  if [ "${CR_CALIBRATE_SUITE:-}" = "large" ]; then dir="bench/calibration/large"; fi
  if [ -n "${CR_CALIBRATE_RUN_ID:-}" ] && [ -f "${dir}/${CR_CALIBRATE_RUN_ID}.json" ]; then
    echo "cloudshell: ${dir}/${CR_CALIBRATE_RUN_ID}.json is committed evidence — choose another CR_CALIBRATE_RUN_ID, or leave it unset" >&2
    exit 2
  fi
}
refuse_committed_run_id

# The harness runs as a job in a process group of its own (see run_harness), and such a job may write to the terminal
# only while `tostop` is off, as it is by default. With it on, the harness would stop at its first line of output and
# this script would wait on it for ever, so a terminal with `tostop` set is refused before anything is installed.
refuse_tostop() {
  if { stty -a </dev/tty; } 2>/dev/null | grep -Eq '(^|[[:space:]])tostop([[:space:]]|$)'; then
    echo "cloudshell: this terminal has tostop set, which stops a background job at its first line of output — run 'stty -tostop', then try again" >&2
    exit 2
  fi
}
refuse_tostop

# The packages declare Node >= 22.12, and CloudShell's default Node may be older.
node_ok() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null
}
if ! node_ok; then
  echo "cloudshell: installing Node 22 with nvm (the packages require Node >= 22.12)"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash || {
      echo "cloudshell: could not install nvm from GitHub — install Node >= 22.12 by hand, then re-run" >&2
      exit 2
    }
  fi
  # nvm is not written for `set -eu`: sourcing nvm.sh returns 3 while no default Node is installed, which under `set -e`
  # ended this script here without a word. So nvm runs with both off, and what it did is checked by hand.
  set +eu
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null && nvm use 22 >/dev/null
  nvm_rc=$?
  set -eu
  if [ "$nvm_rc" -ne 0 ] || ! node_ok; then
    echo "cloudshell: still no Node >= 22.12 (nvm exited ${nvm_rc}) — install it by hand, then re-run" >&2
    exit 2
  fi
fi

WORK="$(mktemp -d)"
# Copy the results out on EVERY exit, including an interrupt: the harness writes them before it stops, and a
# scratch directory deleted with them inside would throw away a run already paid for.
# shellcheck disable=SC2329 # called by the EXIT trap below
finish() {
  # A real run writes its evidence as bench/calibration/<runId>.json, or <runId>.partial.json if it did not finish (the
  # large suite's under bench/calibration/large/);
  # a rehearsal writes a file of its own, so it can never be mistaken for a real run's evidence. Commit a finished
  # run's file at that same path: the large suite's are copied out under the same path in $HOME, since a large run
  # committed beside the default suite's would become the default suite's latest report. Nothing here may abort the
  # trap or overwrite a file already in $HOME. A name that
  # is taken gets this run's copy beside it, stamped, since CloudShell keeps $HOME between sessions and not the
  # scratch directory; a copy that still fails leaves the scratch directory in place and says where.
  set +e
  # A reader that has gone, such as a `tee` a Ctrl-C stopped, must fail an echo here rather than kill the copy.
  trap '' PIPE
  local kept=0
  local tilde='~'
  for f in "$WORK"/bench/calibration/*.json "$WORK"/bench/calibration/large/*.json \
    "$WORK/bench/calibrate-aws-rehearsal.json" "$WORK/bench/calibrate-aws-rehearsal-large.json"; do
    [ -f "$f" ] || continue
    local name dest out
    name="$(basename "$f")"
    out="$HOME"
    case "$f" in
      "$WORK"/bench/calibration/large/*) out="$HOME/bench/calibration/large" ;;
    esac
    dest="$out/$name"
    if [ -e "$dest" ]; then
      # The stamp goes before `.partial.json`, so a copy of a partial file is still one git ignores.
      local stamp
      stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      case "$name" in
        *.partial.json) dest="$out/${name%.partial.json}.$stamp.partial.json" ;;
        *) dest="$out/${name%.json}.$stamp.json" ;;
      esac
      echo "cloudshell: ${out/#$HOME/$tilde}/$name already exists and was left alone" >&2
    fi
    if [ ! -e "$dest" ] && mkdir -p "$out" && cp "$f" "$dest"; then
      echo "cloudshell: results at ${dest/#$HOME/$tilde} (Actions → Download file, or cat it)"
    else
      echo "cloudshell: could not copy the results — they are at $f" >&2
      kept=1
    fi
  done
  if [ "$kept" -eq 0 ]; then rm -rf "$WORK"; fi
}
trap finish EXIT

# Runs the harness as a job of its own, passes on every signal that would stop this script, and returns only once
# the harness has exited. Were the harness run in the foreground, a SIGTERM or a hang-up would stop the script at
# once, and the exit trap would run while the harness was still tearing down, copy nothing, and delete the scratch
# directory under it. And a SIGTERM to the script alone would never reach the harness, which would go on to run the
# whole paid workload. A process group of its own (`set -m`) means a Ctrl-C reaches the harness once, from here, and
# not a second time from the terminal.
run_harness() {
  # The traps come first: a signal in the moment before the harness has a pid is held, and passed on as soon as it
  # has one, rather than killing this script with the harness left running unwatched.
  HARNESS_PID=''
  PENDING=''
  for sig in INT TERM HUP; do
    # shellcheck disable=SC2064 # the signal is fixed now; the pid is read when the trap fires
    trap "FORWARDED=1; if [ -n \"\$HARNESS_PID\" ]; then kill -s $sig \"\$HARNESS_PID\" 2>/dev/null || true; else PENDING=$sig; fi" "$sig"
  done
  set -m
  (cd "$WORK" && exec "$@") &
  HARNESS_PID=$!
  set +m
  if [ -n "$PENDING" ]; then kill -s "$PENDING" "$HARNESS_PID" 2>/dev/null || true; fi
  local rc=0
  while :; do
    FORWARDED=0
    if wait "$HARNESS_PID"; then rc=0; else rc=$?; fi
    # A signal ends `wait` early, with the harness still stopping: wait for it again.
    if [ "$FORWARDED" -eq 1 ] && kill -0 "$HARNESS_PID" 2>/dev/null; then continue; fi
    break
  done
  # From here the script only copies the results out, and a signal must not cut that short.
  trap '' INT TERM HUP PIPE
  return "$rc"
}

mkdir -p "$WORK/bench/lib"
cp bench/calibrate-aws.cjs "$WORK/bench/"
cp bench/lib/aws-meter.cjs bench/lib/calibrate-guards.cjs bench/lib/calibrate-large-resources.cjs bench/lib/calibrate-large-stages.cjs bench/lib/calibrate-large.cjs bench/lib/calibrate-process.cjs bench/lib/calibrate-samples.cjs bench/lib/calibrate-spread.cjs bench/lib/calibrate-stages.cjs bench/lib/large-counts.cjs bench/lib/range-counts.cjs "$WORK/bench/lib/"
echo "cloudshell: installing the published packages at ${PKG_VERSION}"
(
  cd "$WORK"
  npm init -y >/dev/null
  # npm 12 runs a dependency's install script only where the project allows it, and roaring's is the one that fetches
  # its native binary; without this the install exits 0 and the first import throws. npm 10 and 11 run it anyway.
  node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.allowScripts={roaring:true};fs.writeFileSync("package.json",JSON.stringify(p,null,2))'
  npm i --no-audit --no-fund --loglevel=error \
    "@cloudbitmaps/roaring@${PKG_VERSION}" "@cloudbitmaps/s3@${PKG_VERSION}" \
    @aws-sdk/client-s3 @aws-sdk/client-sts
  # Fail here, before anything is created or spent, if the native binary did not arrive.
  node -e 'import("@cloudbitmaps/roaring").catch((e)=>{console.error("cloudshell: @cloudbitmaps/roaring does not load: "+e.message.split("\n")[0]);process.exit(2)})'
)

rc=0
run_harness node bench/calibrate-aws.cjs "$MODE_FLAG" || rc=$?
exit "$rc"
