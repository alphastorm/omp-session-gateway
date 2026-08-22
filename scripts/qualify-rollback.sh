#!/usr/bin/env bash
#
# macOS gateway rollback qualification: install an exact predecessor, upgrade to an exact candidate,
# then reinstall the predecessor from its signed archive.
#
# This harness measures the isolated installer's cross-version state machine without touching a live
# LaunchAgent. The first-class `omp-gateway rollback` command has separate Linux and unit coverage;
# this path deliberately exercises rollback-by-reinstall because that is the recovery available from
# an older predecessor archive. OMP binary rollback is separate and must restore the matching exact
# patched OMP version before sessions restart.
#
# WHY THE launchctl GATE EXISTS
#
# HOME, XDG_CONFIG_HOME, XDG_STATE_HOME and TMPDIR scope every file this program writes and none of
# the state launchd reads back. launchd keys a LaunchAgent on `gui/<uid>/<label>` alone, so a
# sandboxed install still sees the production daemon under its own label. On 2026-08-19 that cost a
# live daemon four minutes: an "isolated" smoke read `active: true` off the production service and
# booted it out.
#
# The original `v0.1.0-prealpha.13` artifact had that defect; `.14` added the program-path ownership
# check. Current predecessor/candidate pairs should both refuse before touching a foreign service.
# The shim and positive control remain mandatory so a regression is observed rather than aimed at a
# live daemon.
#
# It therefore puts a `launchctl` shim first on PATH for every isolated call. The shim refuses every
# mutating verb, unconditionally, and logs the attempt. That is a gate rather than an assertion:
# step 2 fires a real `launchctl bootout` of the production label through the shim and aborts unless
# it is refused, because a gate that has never refused anything cannot be trusted to refuse
# anything.
#
# The shim also scopes the one read launchd cannot scope itself: `print` of our exact label reports
# "not loaded" when the loaded program lives outside the scratch root. That is the launchd analogue
# of XDG_STATE_HOME and lets an isolated installer observe only its own service. Step 4b runs both
# selected artifacts' `status` with scoping OFF to test ownership against real launchd state; step 8
# repeats uninstall with scoping OFF and records any attempted mutation. Every scoped read and
# refusal is logged and counted.
#
# Nothing is ever activated (`--no-start` throughout), so no isolated service is ever loaded. The
# trap still boots one out if launchd somehow holds a label whose program lives inside the scratch
# root, using the real /bin/launchctl and only after confirming the program path is ours.
#
# The publisher token is compared by digest and mode. Its bytes are never read into a variable,
# printed, or copied.
#
# Usage:
#   OMP_ROLLBACK_OLD_TAG=v0.1.0-alpha.1 OMP_ROLLBACK_NEW_TAG=v0.1.0-prealpha.20 \
#     scripts/qualify-rollback.sh run   # full qualification; prints an invariant table
#   scripts/qualify-rollback.sh clean   # remove leftover scratch roots from earlier runs
set -euo pipefail

REPO="alphastorm/omp-session-gateway"
OLD_TAG="${OMP_ROLLBACK_OLD_TAG:-v0.1.0-alpha.1}"
NEW_TAG="${OMP_ROLLBACK_NEW_TAG:-v0.1.0-prealpha.20}"
ARCHIVE="omp-session-gateway-0.1.0-bun.tar"
ARCHIVE_ROOT="omp-session-gateway-0.1.0-bun"
LABEL="omp-session-gateway"
QUAL_BASE="/tmp/omp-rollback-qual"

# Deliberately not 4317. The installer probes its own configured loopback port for a live listener;
# reusing the production port would aim that probe at the live daemon.
ISO_PORT="47317"
ISO_ORIGIN="https://rollback-qual.example.ts.net"
ISO_LOGIN="rollback-qual@example.invalid"

FAILURES=0
FINDINGS=()
ROW_NAME=()
ROW_BEFORE=()
ROW_AFTER=()
ROW_RESULT=()
ROWS_PRINTED=0
SCRATCH=""
ISO_SCOPE="on"

banner() { printf '\n== %s\n' "$*"; }
fact() { printf '   %-44s %s\n' "$1" "$2"; }
die() { printf '\nABORT: %s\n' "$*" >&2; exit 2; }

# --------------------------------------------------------------------------------------------
# measurement
# --------------------------------------------------------------------------------------------

digest_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
mode_of() { stat -f '%Lp' "$1"; }

# Full digest used only for in-memory equality checks. Never print a publisher-token fingerprint.
token_digest() {
  if [ -f "$1" ]; then digest_of "$1"; else printf 'absent'; fi
}

pointer_version() {
  if [ -f "$1" ]; then
    sed -n 's/.*"versionDirectory":"\([^"]*\)".*/\1/p' "$1"
  else
    printf 'absent'
  fi
}

# The version directory named by the LaunchAgent's ProgramArguments. A plist that no longer points
# into a versioned install is the failure this exists to catch, so say so rather than returning "".
plist_version() {
  local found
  if [ ! -f "$1" ]; then printf 'absent'; return; fi
  found=$(sed -n 's|.*/installation/versions/\([^/]*\)/apps/gateway/src/cli\.js.*|\1|p' "$1" | head -1)
  if [ -z "$found" ]; then printf 'no-versioned-path'; else printf '%s' "$found"; fi
}

version_dirs() { ls -1 "$ISO_VERSIONS" 2>/dev/null | sort; }
version_dir_count() { version_dirs | grep -c . || true; }

row_same() { # name before after -- passes when both are equal and non-empty
  ROW_NAME+=("$1"); ROW_BEFORE+=("$2"); ROW_AFTER+=("$3")
  if [ -n "$2" ] && [ "$2" = "$3" ]; then ROW_RESULT+=("PASS"); else ROW_RESULT+=("FAIL"); FAILURES=$((FAILURES + 1)); fi
}

row_expect() { # name before after expected -- passes when after equals expected
  ROW_NAME+=("$1"); ROW_BEFORE+=("$2"); ROW_AFTER+=("$3")
  if [ -n "$4" ] && [ "$3" = "$4" ]; then ROW_RESULT+=("PASS"); else ROW_RESULT+=("FAIL"); FAILURES=$((FAILURES + 1)); fi
}

# Values are compared in full and printed clipped; a 64-hex digest would otherwise wreck alignment.
print_rows() {
  local i="$ROWS_PRINTED" dash44 dash26
  dash44="--------------------------------------------"
  dash26="--------------------------"
  printf '\n   %-44.44s %-26.26s %-26.26s %s\n' "INVARIANT" "BEFORE" "AFTER" "RESULT"
  printf '   %-44.44s %-26.26s %-26.26s %s\n' "$dash44" "$dash26" "$dash26" "------"
  while [ "$i" -lt "${#ROW_NAME[@]}" ]; do
    printf '   %-44.44s %-26.26s %-26.26s %s\n' "${ROW_NAME[$i]}" "${ROW_BEFORE[$i]}" "${ROW_AFTER[$i]}" "${ROW_RESULT[$i]}"
    i=$((i + 1))
  done
  ROWS_PRINTED="${#ROW_NAME[@]}"
}

# --------------------------------------------------------------------------------------------
# isolation
# --------------------------------------------------------------------------------------------

# The program path launchd currently has loaded for our label, or empty. Always the real launchctl:
# the gate must never be able to answer a safety question about itself.
loaded_program_path() {
  /bin/launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null |
    sed -n 's|^[[:space:]]*\(/[^[:space:]]*/installation/versions/[^[:space:]]*cli\.js\)$|\1|p' |
    head -1
}

loaded_pid() {
  /bin/launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null |
    sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -1
}

# Every isolated command runs through this. `env -i` is deliberate: an inherited XDG_* or TMPDIR is
# exactly how a "scoped" run leaks back onto the real root.
iso() {
  env -i \
    PATH="$SCRATCH/bin:$REAL_PATH" \
    HOME="$SCRATCH/home" \
    XDG_CONFIG_HOME="$SCRATCH/config" \
    XDG_STATE_HOME="$SCRATCH/state" \
    TMPDIR="$SCRATCH/tmp" \
    USER="${REAL_USER}" \
    LANG=C \
    RQ_SCRATCH="$SCRATCH" \
    RQ_LOG="$SCRATCH/launchctl-gate.log" \
    RQ_UID="$(id -u)" \
    RQ_SCOPE="$ISO_SCOPE" \
    "$@"
}

write_shim() {
  mkdir -p "$SCRATCH/bin"
  cat >"$SCRATCH/bin/launchctl" <<'SHIM'
#!/bin/bash
# Isolation gate: refuses every mutating launchctl verb, and scopes `print` of our own label to the
# scratch root. See the header of scripts/qualify-rollback.sh for why this exists.
real=/bin/launchctl
target="gui/${RQ_UID}/omp-session-gateway"
verb="${1:-}"
case "$verb" in
  print | list | dumpstate | procinfo | examine | help | version)
    if [ "$verb" = "print" ] && [ "${2:-}" = "$target" ] && [ "${RQ_SCOPE}" = "on" ]; then
      out=$("$real" "$@" 2>/dev/null) || exit 1
      case "$out" in
        *"${RQ_SCRATCH}/"*)
          printf '%s\n' "$out"
          exit 0
          ;;
      esac
      printf 'scoped-hidden\t%s\n' "$*" >>"$RQ_LOG"
      exit 1
    fi
    exec "$real" "$@"
    ;;
esac
printf 'refused\t%s\n' "$*" >>"$RQ_LOG"
printf 'rollback-qual gate refused a mutating launchctl verb: %s\n' "$*" >&2
exit 90
SHIM
  chmod 700 "$SCRATCH/bin/launchctl"
}

gate_count() { # pattern
  if [ -f "$SCRATCH/launchctl-gate.log" ]; then
    grep -c "$1" "$SCRATCH/launchctl-gate.log" || true
  else
    printf '0'
  fi
}

# --------------------------------------------------------------------------------------------
# cleanup
# --------------------------------------------------------------------------------------------

# Removes a scratch root and any service loaded *from* it. Never touches a service whose program
# lives elsewhere; that one belongs to somebody else by definition.
purge_root() { # directory
  local root="$1" program
  case "$root" in
    "$QUAL_BASE" | "$QUAL_BASE"/*) : ;;
    *) die "refusing to purge a path outside $QUAL_BASE: $root" ;;
  esac
  program=$(loaded_program_path)
  case "$program" in
    "$root"/*)
      printf '   booting out an isolated service loaded from %s\n' "$root"
      /bin/launchctl bootout "gui/$(id -u)/$LABEL" || true
      ;;
  esac
  rm -rf "$root"
}

on_exit() {
  local rc=$? now held
  if [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ]; then
    banner "cleanup"
    purge_root "$SCRATCH"
    if [ -e "$SCRATCH" ]; then
      fact "scratch root removed" "NO -- $SCRATCH still exists"
      rc=1
    else
      fact "scratch root removed" "yes"
    fi
    held=$(loaded_program_path)
    fact "launchd label held by" "${held:-nothing}"
    case "$held" in
      "$QUAL_BASE"/*)
        fact "isolated service still loaded" "YES -- $held"
        rc=1
        ;;
    esac
    if [ -n "${HOST_PLIST_DIGEST:-}" ]; then
      now=$(digest_of "$HOST_PLIST" 2>/dev/null || printf 'absent')
      fact "host LaunchAgent plist digest" "$now"
      if [ "$now" != "$HOST_PLIST_DIGEST" ]; then
        printf '   HOST PLIST CHANGED -- was %s\n' "$HOST_PLIST_DIGEST"
        rc=1
      fi
    fi
    if [ -n "${HOST_DAEMON_PID:-}" ]; then
      if ps -p "$HOST_DAEMON_PID" >/dev/null 2>&1; then
        fact "host daemon still running" "PID $HOST_DAEMON_PID"
      else
        fact "host daemon still running" "NO -- PID $HOST_DAEMON_PID is gone"
        rc=1
      fi
    fi
  fi
  exit "$rc"
}

# --------------------------------------------------------------------------------------------
# steps
# --------------------------------------------------------------------------------------------

preflight() {
  banner "preflight"
  [ "$(uname -s)" = "Darwin" ] || die "macOS only; the Linux/systemd path is out of scope for this script"
  [ "$(id -u)" != "0" ] || die "refusing to run as root"
  [ -x /bin/launchctl ] || die "/bin/launchctl is missing"
  local tool
  for tool in bun gh cosign tar shasum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required and was not found on PATH"
  done
  REAL_PATH="$PATH"
  REAL_HOME="$HOME"
  REAL_USER="$(id -un)"
  fact "macOS" "$(sw_vers -productVersion) $(uname -m)"
  fact "bun" "$(bun --version)"
  # Anything answering here would be probed by the installer's own liveness check.
  if (exec 3<>/dev/tcp/127.0.0.1/"$ISO_PORT") 2>/dev/null; then
    die "something is listening on 127.0.0.1:$ISO_PORT; the isolated root needs an unused port"
  fi
  fact "isolated loopback port" "$ISO_PORT (nothing listening)"
}

step_scratch() {
  banner "step 1 -- isolated root"
  mkdir -p "$QUAL_BASE"
  chmod 700 "$QUAL_BASE"
  SCRATCH="$QUAL_BASE/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$SCRATCH/home" "$SCRATCH/config" "$SCRATCH/state" "$SCRATCH/tmp" "$SCRATCH/dl"
  chmod 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/config" "$SCRATCH/state" "$SCRATCH/tmp"
  : >"$SCRATCH/launchctl-gate.log"
  write_shim
  ISO_CONFIG_JSON="$SCRATCH/config/omp-session-gateway/config.json"
  ISO_TOKEN="$SCRATCH/config/omp-session-gateway/publisher-token"
  ISO_VERSIONS="$SCRATCH/state/omp-session-gateway/installation/versions"
  ISO_POINTER="$SCRATCH/state/omp-session-gateway/installation/current.json"
  ISO_PLIST="$SCRATCH/home/Library/LaunchAgents/$LABEL.plist"
  fact "scratch root" "$SCRATCH"
  fact "HOME" "$SCRATCH/home"
  fact "XDG_CONFIG_HOME" "$SCRATCH/config"
  fact "XDG_STATE_HOME" "$SCRATCH/state"
  fact "TMPDIR" "$SCRATCH/tmp"
  fact "isolated LaunchAgent path" "$ISO_PLIST"
}

step_isolation_gate() {
  banner "step 2 -- isolation gate (fail-closed)"
  HOST_PLIST="$REAL_HOME/Library/LaunchAgents/$LABEL.plist"

  # G1: every scoped path lands inside the scratch root, and HOME really moved.
  local path
  for path in "$SCRATCH/home" "$SCRATCH/config" "$SCRATCH/state" "$SCRATCH/tmp" "$ISO_PLIST"; do
    case "$path" in
      "$SCRATCH"/*) : ;;
      *) die "scoped path escapes the scratch root: $path" ;;
    esac
  done
  [ "$SCRATCH/home" != "$REAL_HOME" ] || die "isolated HOME equals the real HOME"
  fact "scoped paths inside scratch root" "5/5"

  # G2: whatever launchd holds right now must not be ours. If it is, an earlier run leaked.
  HOST_PROGRAM=$(loaded_program_path)
  case "$HOST_PROGRAM" in
    "$QUAL_BASE"/*) die "launchd already holds $LABEL from a scratch root: $HOST_PROGRAM" ;;
  esac
  HOST_DAEMON_PID=""
  if [ -n "$HOST_PROGRAM" ]; then
    HOST_DAEMON_PID=$(loaded_pid)
    fact "foreign service holding the label" "$HOST_PROGRAM"
    fact "its PID" "${HOST_DAEMON_PID:-unknown}"
  else
    fact "foreign service holding the label" "none loaded"
  fi
  HOST_PLIST_DIGEST=""
  HOST_PLIST_SHORT="absent"
  if [ -f "$HOST_PLIST" ]; then
    HOST_PLIST_DIGEST=$(digest_of "$HOST_PLIST")
    HOST_PLIST_SHORT="${HOST_PLIST_DIGEST:0:16}"
    fact "host LaunchAgent plist digest" "$HOST_PLIST_DIGEST"
  else
    fact "host LaunchAgent plist" "absent"
  fi

  # G3: the positive control. Fire a real bootout of the production label through the gate and
  # require refusal. Everything destructive downstream rides on this single observation.
  local rc=0
  iso launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || rc=$?
  [ "$rc" = "90" ] || die "positive control failed: the gate returned $rc instead of refusing a bootout"
  [ "$(gate_count '^refused')" -ge 1 ] || die "positive control failed: the gate logged no refusal"
  fact "positive control (bootout refused)" "exit 90, logged"

  # ... and prove the refusal was not itself the kill: the production daemon is still there.
  if [ -n "$HOST_DAEMON_PID" ]; then
    ps -p "$HOST_DAEMON_PID" >/dev/null 2>&1 || die "the positive control killed PID $HOST_DAEMON_PID"
    fact "host daemon after positive control" "PID $HOST_DAEMON_PID alive"
  fi
}

fetch_tag() { # tag destination
  local tag="$1" dest="$2"
  mkdir -p "$dest"
  (
    cd "$dest"
    local workflow="release.yml"
    case "$tag" in
      v0.1.0-prealpha.21 | v0.1.0) workflow="signed-release.yml" ;;
    esac
    gh release download "$tag" -R "$REPO" -D . --clobber \
      -p "$ARCHIVE" -p "$ARCHIVE.sigstore.json" -p SHA256SUMS -p SHA256SUMS.sigstore.json >/dev/null
    shasum -a 256 -c SHA256SUMS --ignore-missing >/dev/null
    local asset
    for asset in "$ARCHIVE" SHA256SUMS; do
      cosign verify-blob \
        --bundle "$asset.sigstore.json" \
        --certificate-identity "https://github.com/$REPO/.github/workflows/$workflow@refs/tags/$tag" \
        --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
        "$asset" >/dev/null 2>&1 ||
        {
          printf 'cosign verify-blob failed for %s at %s\n' "$asset" "$tag" >&2
          exit 1
        }
    done
    mkdir -p extract
    tar -xf "$ARCHIVE" -C extract
  ) || die "download or verification failed for $tag"
  fact "$tag archive sha256" "$(digest_of "$dest/$ARCHIVE")"
  fact "$tag SHA256SUMS + cosign" "shasum -c OK; verify-blob OK (archive, SHA256SUMS)"
}

step_artifacts() {
  banner "step 3 -- signed artifacts"
  OLD_DIR="$SCRATCH/dl/$OLD_TAG"
  NEW_DIR="$SCRATCH/dl/$NEW_TAG"
  fetch_tag "$OLD_TAG" "$OLD_DIR"
  fetch_tag "$NEW_TAG" "$NEW_DIR"
  OLD_CLI="$OLD_DIR/extract/$ARCHIVE_ROOT/apps/gateway/src/cli.js"
  NEW_CLI="$NEW_DIR/extract/$ARCHIVE_ROOT/apps/gateway/src/cli.js"
  [ -f "$OLD_CLI" ] && [ -f "$NEW_CLI" ] || die "extracted archives do not contain apps/gateway/src/cli.js"
  fact "$OLD_TAG cli.js" "$(wc -c <"$OLD_CLI" | tr -d ' ') bytes"
  fact "$NEW_TAG cli.js" "$(wc -c <"$NEW_CLI" | tr -d ' ') bytes"
}

install_from() { # cli-path description
  iso bun "$1" install \
    --origin "$ISO_ORIGIN" \
    --allow "$ISO_LOGIN" \
    --port "$ISO_PORT" \
    --no-start || die "$2 failed"
}

snapshot() { # index
  local i="$1"
  STEP_POINTER[$i]=$(pointer_version "$ISO_POINTER")
  STEP_CONFIG[$i]=$(digest_of "$ISO_CONFIG_JSON")
  STEP_TOKEN[$i]=$(token_digest "$ISO_TOKEN")
  STEP_TOKEN_MODE[$i]=$(mode_of "$ISO_TOKEN")
  STEP_PLIST[$i]=$(plist_version "$ISO_PLIST")
  fact "current.json -> versionDirectory" "${STEP_POINTER[$i]}"
  fact "version directories present" "$(version_dirs | tr '\n' ' ')"
  fact "config.json sha256" "${STEP_CONFIG[$i]}"
  fact "publisher token mode" "${STEP_TOKEN_MODE[$i]} (content retained only for equality checks)"
  fact "LaunchAgent ProgramArguments version" "${STEP_PLIST[$i]}"
}

step_install_old() {
  banner "step 4 -- install $OLD_TAG (--no-start)"
  install_from "$OLD_CLI" "$OLD_TAG install"
  snapshot 0
  [ "$(version_dir_count)" = "1" ] || die "expected exactly one version directory after the first install"
  # Independent of the pointer: the only directory that exists is the one it must name.
  INSTALL_EXPECTED=$(version_dirs)
  fact "sole staged version directory" "$INSTALL_EXPECTED"

  # A/B on service ownership: read-only, launchd scoping OFF, so both artifacts answer the same
  # question about the same real launchd state. `status` only reads launchctl and probes its own
  # (unused) loopback port.
  banner "step 4b -- unscoped service-ownership reading (read-only)"
  ISO_SCOPE="off"
  OLD_STATUS=$(iso bun "$OLD_CLI" status 2>&1 || true)
  NEW_STATUS=$(iso bun "$NEW_CLI" status 2>&1 || true)
  ISO_SCOPE="on"
  fact "$OLD_TAG status" "$OLD_STATUS"
  fact "$NEW_TAG status" "$NEW_STATUS"
  if [ -n "$HOST_PROGRAM" ]; then
    case "$OLD_STATUS" in
      *'"active":true'*)
        FINDINGS+=("$OLD_TAG reports active:true from an isolated root while the only loaded service is $HOST_PROGRAM. Its ownership test is the launchd label alone, so every deactivating path in that artifact targets the production daemon.")
        fact "FINDING" "$OLD_TAG claims the host daemon as its own"
        ;;
    esac
    case "$NEW_STATUS" in
      *'"active":false'*) fact "$NEW_TAG ownership check" "correct (active:false)" ;;
      *) FINDINGS+=("$NEW_TAG did not report active:false from an isolated root: $NEW_STATUS") ;;
    esac
  fi
}

step_upgrade() {
  banner "step 5 -- upgrade to $NEW_TAG (--no-start)"
  install_from "$NEW_CLI" "$NEW_TAG upgrade"
  snapshot 1
  VERSION_COUNT_AFTER_UPGRADE=$(version_dir_count)
  # Independent of the pointer again: the upgrade must have staged exactly one new directory.
  UPGRADE_EXPECTED=$(version_dirs | grep -v "^${STEP_POINTER[0]}$" || true)
  [ "$(printf '%s\n' "$UPGRADE_EXPECTED" | grep -c .)" = "1" ] ||
    die "expected exactly one newly staged version directory, saw: $UPGRADE_EXPECTED"
  fact "newly staged version directory" "$UPGRADE_EXPECTED"
  if [ -d "$ISO_VERSIONS/${STEP_POINTER[0]}" ]; then
    PREDECESSOR_AFTER_UPGRADE="present"
  else
    PREDECESSOR_AFTER_UPGRADE="removed"
  fi
  fact "predecessor ${STEP_POINTER[0]} after upgrade" "$PREDECESSOR_AFTER_UPGRADE"
}

step_rollback() {
  banner "step 6 -- roll back to $OLD_TAG by installing its archive again (--no-start)"
  install_from "$OLD_CLI" "$OLD_TAG rollback"
  snapshot 2
  fact "scoped launchd reads so far" "$(gate_count '^scoped-hidden')"
  fact "refused mutating launchctl calls" "$(gate_count '^refused')"
}

step_invariants() {
  banner "step 7 -- invariants"
  row_expect "current.json after predecessor install" "-" "${STEP_POINTER[0]}" "$INSTALL_EXPECTED"
  row_expect "current.json after candidate upgrade" "${STEP_POINTER[0]}" "${STEP_POINTER[1]}" "$UPGRADE_EXPECTED"
  row_expect "current.json after predecessor restore" "${STEP_POINTER[1]}" "${STEP_POINTER[2]}" "${STEP_POINTER[0]}"
  row_expect "both runtimes kept side by side" "1" "$VERSION_COUNT_AFTER_UPGRADE" "2"
  row_expect "predecessor dir survives the upgrade" "${STEP_POINTER[0]}" "$PREDECESSOR_AFTER_UPGRADE" "present"
  row_same "config.json identical install->upgrade" "${STEP_CONFIG[0]}" "${STEP_CONFIG[1]}"
  row_same "config.json identical upgrade->rollback" "${STEP_CONFIG[1]}" "${STEP_CONFIG[2]}"
  row_expect "token unchanged install->upgrade" "unchanged" \
    "$([ "${STEP_TOKEN[0]}" = "${STEP_TOKEN[1]}" ] && echo unchanged || echo changed)" unchanged
  row_expect "token unchanged upgrade->rollback" "unchanged" \
    "$([ "${STEP_TOKEN[1]}" = "${STEP_TOKEN[2]}" ] && echo unchanged || echo changed)" unchanged
  row_same "token mode identical install->upgrade" "${STEP_TOKEN_MODE[0]}" "${STEP_TOKEN_MODE[1]}"
  row_same "token mode identical upgrade->rollback" "${STEP_TOKEN_MODE[1]}" "${STEP_TOKEN_MODE[2]}"
  row_same "LaunchAgent follows active (install)" "${STEP_POINTER[0]}" "${STEP_PLIST[0]}"
  row_same "LaunchAgent follows active (upgrade)" "${STEP_POINTER[1]}" "${STEP_PLIST[1]}"
  row_same "LaunchAgent follows active (rollback)" "${STEP_POINTER[2]}" "${STEP_PLIST[2]}"
  print_rows
}

step_uninstall() {
  banner "step 8 -- uninstall and residue"

  # Unscoped, on purpose, and first. Old artifacts that key ownership only on the launchd label
  # target the production daemon here; current predecessors refuse before mutation. The gate keeps
  # either result observational and the host daemon untouched.
  local before after rc=0 plist_state residue held preserved
  before=$(gate_count '^refused')
  ISO_SCOPE="off"
  iso bun "$OLD_CLI" uninstall >"$SCRATCH/uninstall-unscoped.log" 2>&1 || rc=$?
  ISO_SCOPE="on"
  after=$(gate_count '^refused')
  fact "unscoped $OLD_TAG uninstall exit code" "$rc"
  fact "mutating calls it attempted" "$((after - before))"
  if [ "$((after - before))" -gt 0 ]; then
    FINDINGS+=("$OLD_TAG uninstall issued 'launchctl bootout gui/<uid>/$LABEL' from an isolated root. The gate refused it; without the gate it would have stopped the production daemon.")
    fact "FINDING" "$OLD_TAG uninstall targeted the host label"
  fi
  if [ -n "$HOST_DAEMON_PID" ]; then
    ps -p "$HOST_DAEMON_PID" >/dev/null 2>&1 || die "the unscoped uninstall probe killed PID $HOST_DAEMON_PID"
    fact "host daemon after the probe" "PID $HOST_DAEMON_PID alive"
  fi

  # Now the real uninstall, with launchd scoped the way the rest of the run had it.
  iso bun "$OLD_CLI" uninstall >"$SCRATCH/uninstall.log" 2>&1 || die "scoped uninstall failed; see $SCRATCH/uninstall.log"
  fact "uninstall output" "$(head -1 "$SCRATCH/uninstall.log")"

  plist_state="removed"
  if [ -e "$ISO_PLIST" ]; then plist_state="STILL PRESENT"; fi
  fact "isolated LaunchAgent" "$plist_state"

  # Uninstall preserves configuration and installed runtimes by design; measure what it leaves
  # rather than asserting a clean tree the command never promised.
  residue=$(cd "$SCRATCH" && find config state -type f 2>/dev/null | wc -l | tr -d ' ')
  preserved="missing"
  if [ -f "$ISO_CONFIG_JSON" ] && [ -f "$ISO_TOKEN" ]; then preserved="present"; fi
  fact "files left under config/ and state/" "$residue (two runtime payloads plus config and token)"
  fact "config.json + publisher-token" "$preserved (token fingerprint withheld; mode $(mode_of "$ISO_TOKEN"))"
  fact "version directories left" "$(version_dirs | tr '\n' ' ')"
  held=$(loaded_program_path)
  fact "launchd label held by" "${held:-nothing}"

  row_expect "uninstall removes isolated LaunchAgent" "present" "$plist_state" "removed"
  row_expect "uninstall preserves config and token" "present" "$preserved" "present"
  row_expect "token survives uninstall unchanged" "unchanged" \
    "$([ "${STEP_TOKEN[2]}" = "$(token_digest "$ISO_TOKEN")" ] && echo unchanged || echo changed)" unchanged
  case "$held" in
    "$QUAL_BASE"/*) row_expect "no isolated service loaded" "none" "$held" "none" ;;
    *) row_expect "no isolated service loaded" "none" "none" "none" ;;
  esac
  row_expect "host daemon alive throughout" "${HOST_DAEMON_PID:-none}" \
    "$(if [ -z "$HOST_DAEMON_PID" ]; then printf 'none'; elif ps -p "$HOST_DAEMON_PID" >/dev/null 2>&1; then printf '%s' "$HOST_DAEMON_PID"; else printf 'gone'; fi)" \
    "${HOST_DAEMON_PID:-none}"
  row_expect "host LaunchAgent plist unchanged" "$HOST_PLIST_SHORT" \
    "$(if [ -f "$HOST_PLIST" ]; then digest_of "$HOST_PLIST" | cut -c1-16; else printf 'absent'; fi)" \
    "$HOST_PLIST_SHORT"
  print_rows
}

step_report() {
  banner "result"
  local i=0
  if [ "${#FINDINGS[@]}" -gt 0 ]; then
    printf '   findings:\n'
    while [ "$i" -lt "${#FINDINGS[@]}" ]; do
      printf '   %d. %s\n' "$((i + 1))" "${FINDINGS[$i]}"
      i=$((i + 1))
    done
  else
    printf '   findings: none\n'
  fi
  fact "scoped launchd reads (total)" "$(gate_count '^scoped-hidden')"
  fact "refused mutating launchctl calls (total)" "$(gate_count '^refused')"
  if [ "$FAILURES" -eq 0 ]; then
    printf '\n   %d/%d invariants PASS\n' "${#ROW_NAME[@]}" "${#ROW_NAME[@]}"
  else
    printf '\n   %d of %d invariants FAILED\n' "$FAILURES" "${#ROW_NAME[@]}"
  fi
}

run() {
  trap on_exit EXIT
  preflight
  step_scratch
  step_isolation_gate
  step_artifacts
  step_install_old
  step_upgrade
  [ "${STEP_POINTER[1]}" != "${STEP_POINTER[0]}" ] ||
    die "$NEW_TAG staged the same version directory as $OLD_TAG; there is nothing to roll back"
  step_rollback
  step_invariants
  step_uninstall
  step_report
  [ "$FAILURES" -eq 0 ]
}

clean() {
  banner "clean"
  if [ ! -d "$QUAL_BASE" ]; then
    fact "$QUAL_BASE" "absent"
    return 0
  fi
  local root
  for root in "$QUAL_BASE"/*; do
    [ -e "$root" ] || continue
    fact "purging" "$root"
    purge_root "$root"
  done
  rm -rf "$QUAL_BASE"
  if [ -e "$QUAL_BASE" ]; then
    fact "$QUAL_BASE" "STILL PRESENT"
    return 1
  fi
  fact "$QUAL_BASE" "removed"
}

case "${1:-}" in
  run) run ;;
  clean) clean ;;
  *)
    printf 'usage: %s run|clean\n' "$0" >&2
    exit 64
    ;;
esac
