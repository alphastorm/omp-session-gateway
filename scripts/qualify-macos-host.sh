#!/usr/bin/env bash
#
# macOS host qualification against a signed candidate, over SSH, from a second tailnet node.
#
# WHY THIS EXISTS
#
# The Linux lane (`scripts/provision-linux-qual.sh`) is one command that provisions, measures and
# destroys, and it emits every number the ledger needs. macOS had no equivalent: the 2026-08-21
# re-qualification of `provenance-test-v0.1.0.11` was driven by hand over about twenty SSH
# invocations, which means the next candidate could only be re-qualified by someone repeating those
# by hand and trusting prose. This script is that run, written down.
#
# It deliberately does *not* provision the host. Apple silicon leases are 24-hour minimum, billed
# whether or not the machine is powered on, and no provider API here can be trusted to hand back an
# identical image; conflating "rent a Mac" with "measure a Mac" would make the measurement hostage to
# the provider. Bring your own host, point this at it.
#
# WHAT THE HOST MUST ALREADY HAVE
#
#   - SSH as a non-root admin user, with `sudo` available (a password may be supplied out of band).
#   - Bun on PATH for that user.
#   - Tailscale running its **TUN-mode** client, joined as a **user-owned** node.
#
# That last requirement is the whole reason the earlier attempt failed, and the correction is worth
# stating because it cost a release delay. `tailscaled --tun=userspace-networking` has no tunnel
# device, so its netstack forwards inbound tailnet connections to localhost and every tailnet peer
# reaches the loopback listener as a loopback peer; the gateway detects that and refuses everything,
# so `doctor` cannot pass and nothing here can be qualified. The NetworkExtension approval a *GUI*
# Tailscale client needs does **not** apply to open-source `tailscaled`, which creates a real `utun`
# as root on a headless host:
#
#   sudo tailscaled --tun=utun --state=/var/lib/tailscale/tailscaled.state
#   sudo tailscale login          # click the printed URL; a user-owned node, not a tagged one
#   sudo tailscaled install-system-daemon    # so it survives the reboot lane
#
# A tagged node cannot present a user identity, so Serve populates no identity headers and the
# identity lane would measure nothing. That is the opposite of the Linux lane, which *wants* a tagged
# node to prove denial.
#
# CERTIFICATES, AND A TRAP WORTH INHERITING
#
# Never probe `https://<name>` to find out whether Serve is ready. Each TLS handshake without a
# cached certificate triggers an ACME authorization, and five failures lock that exact name out of
# Let's Encrypt for an hour — with every further probe pushing the window later. This script calls
# `tailscale cert` instead, which fetches without a handshake and fails loudly. If a name is already
# rate-limited, rename the node: the limit is per-identifier, and a fresh name provisions instantly.
#
# WHAT IT MEASURES, AND WHAT IT CANNOT
#
# Lanes: artifact, install, identity, persistence, rollback, omp-build, omp-clean, uninstall.
# Every line it prints is a measurement.
# Two things it cannot establish and does not claim:
#
#   - Reboot persistence on macOS is LaunchAgent behaviour, so it proves return at **console login**.
#     With auto-login enabled that is automatic; it is still not "starts with nobody logged in".
#   - Sleep/wake is not covered. A remote host that genuinely sleeps can lose its network interface,
#     so it needs a physically accessible Mac.
#
# Usage:
#   OMP_MAC_HOST=user@host OMP_MAC_TAG=v0.1.0-alpha scripts/qualify-macos-host.sh [lane...]
#
# Environment:
#   OMP_MAC_HOST      required, ssh destination (`user@host`)
#   OMP_MAC_TAG          required, signed release tag to qualify
#   OMP_MAC_PREVIOUS_TAG optional, exact predecessor for rollback; defaults to v0.1.0-beta.1
#   OMP_MAC_LOGIN     required, tailnet login to allowlist
#   OMP_MAC_SUDO_PW   optional, sudo password piped to `sudo -S`; omit if sudo is passwordless
#   OMP_MAC_SSH_KEY   optional, identity file
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly OMP_PIN_PATH="$REPO_ROOT/patches/oh-my-pi/qualification.env"
[ -r "$OMP_PIN_PATH" ] || { printf 'missing OMP qualification pin: %s\n' "$OMP_PIN_PATH" >&2; exit 1; }
# shellcheck source=../patches/oh-my-pi/qualification.env
. "$OMP_PIN_PATH"
step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
measure() { printf '   %-38s %s\n' "$1:" "$2"; }
warn() { printf '   WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

readonly HOST="${OMP_MAC_HOST:-}"
readonly TAG="${OMP_MAC_TAG:-}"
readonly PREVIOUS_TAG="${OMP_MAC_PREVIOUS_TAG:-v0.1.0-beta.1}"
readonly LOGIN="${OMP_MAC_LOGIN:-}"
readonly REPO_SLUG="${OMP_MAC_REPO:-alphastorm/omp-session-gateway}"
readonly GATEWAY_PORT="${OMP_MAC_PORT:-4317}"
readonly RECORD_DIR="${OMP_MAC_RECORD_DIR:-$HOME/.local/share/omp-session-gateway/test}"
readonly OMP_SOURCE_COMMIT="$OMP_PIN_SOURCE_COMMIT"
readonly OMP_PATCHED_TREE="$OMP_PIN_PATCHED_TREE"
readonly OMP_VERSION="$OMP_PIN_VERSION"
readonly BUN_VERSION="$OMP_PIN_BUN_VERSION"

[ -n "$HOST" ] || die "OMP_MAC_HOST is not set. Nothing was measured."
[ -n "$TAG" ] || die "OMP_MAC_TAG is not set; name the signed release tag to qualify. Nothing was measured."
[ -n "$LOGIN" ] || die "OMP_MAC_LOGIN is not set; name the tailnet login to allowlist. Nothing was measured."
case "$TAG:$PREVIOUS_TAG" in
  *[!A-Za-z0-9._:-]*) die "OMP_MAC_TAG and OMP_MAC_PREVIOUS_TAG must be plain release tags" ;;
esac

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes)
[ -z "${OMP_MAC_SSH_KEY:-}" ] || SSH_OPTS+=(-i "$OMP_MAC_SSH_KEY" -o IdentitiesOnly=yes)
# Every remote block and its values travel over SSH stdin. Secrets never enter local or remote argv
# and stay as unexported variables in the one static remote shell that evaluates the supplied block.
remote() {
  local script bootstrap
  script="$(cat)"
  printf -v bootstrap 'bash -c %q' \
    'IFS= read -r -d "" PW || exit; IFS= read -r -d "" PORT || exit; IFS= read -r -d "" LOGIN || exit; IFS= read -r -d "" TAG || exit; IFS= read -r -d "" PREVIOUS_TAG || exit; IFS= read -r -d "" OMP_SOURCE_COMMIT || exit; IFS= read -r -d "" OMP_PATCHED_TREE || exit; IFS= read -r -d "" OMP_VERSION || exit; IFS= read -r -d "" BUN_VERSION || exit; IFS= read -r -d "" SCRIPT || exit; eval "$SCRIPT"'
  {
    printf '%s\0' "${OMP_MAC_SUDO_PW:-}" "$GATEWAY_PORT" "$LOGIN" "$TAG" "$PREVIOUS_TAG" \
      "$OMP_SOURCE_COMMIT" "$OMP_PATCHED_TREE" "$OMP_VERSION" "$BUN_VERSION" "$script"
  } | ssh "${SSH_OPTS[@]}" -q "$HOST" "$bootstrap"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required on this workstation but was not found."
}

# ---------------------------------------------------------------------------------------------------

preflight() {
  step "Preflight"
  need_command ssh
  need_command gh
  need_command shasum
  need_command scp

  remote <<'REMOTE' || die "cannot reach the host over SSH, or its shell rejected the probe."
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
show() { printf '   %-38s %s\n' "$1:" "$2"; }
show "host" "$(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"
show "hardware" "$(sysctl -n hw.model 2>/dev/null || echo unknown)"
show "user / shell" "$(whoami) / $SHELL"
# Same PATH the lanes export. Probing a bare login shell reported `bun: MISSING` on a host where bun
# was installed and every lane worked, which is a misleading preflight rather than a real finding.
show "bun" "$(PATH="$HOME/.bun/bin:$HOME/go/bin:$PATH"; command -v bun >/dev/null 2>&1 && bun --version || echo MISSING)"
show "sudo" "$(S true >/dev/null 2>&1 && echo available || echo UNAVAILABLE)"
REMOTE

  # The topology gate. Checked here rather than discovered three lanes later, because on a
  # userspace-networking host every identity assertion below would fail for one reason and the report
  # would blame the gateway.
  local topology
  topology="$(remote <<'REMOTE'
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
if ! command -v tailscale >/dev/null 2>&1 && [ ! -x "$HOME/go/bin/tailscale" ]; then echo "no-tailscale"; exit 0; fi
TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"
state="$("$TS" status --json 2>/dev/null || S "$TS" status --json 2>/dev/null)" &&
  state="$(printf '%s' "$state" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("BackendState","?"), "tagged" if d.get("Self",{}).get("Tags") else "user-owned", d.get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || echo "? ? ?")" ||
  state="? ? ?"
# A tailnet address on a real interface is what distinguishes TUN mode from userspace networking, and
# it is the same signal the gateway itself enforces.
tun="userspace"
if ifconfig 2>/dev/null | grep -qE 'inet6 fd7a:115c:a1e0:'; then tun="tun"; fi
echo "$state $tun"
REMOTE
)"
  measure "tailscale" "$topology"
  case "$topology" in
    no-tailscale*) die "Tailscale is not installed on the host. See the header of this script." ;;
    *userspace*) die "the host runs userspace networking, so it has no tunnel device. The gateway will refuse every request and doctor cannot pass; see the header for the headless TUN-mode recipe. Nothing was measured." ;;
    *tagged*) die "the host joined as a *tagged* node, which can never present a user identity, so Serve populates no identity headers and the identity lane would measure nothing. Re-join as a user-owned node." ;;
    Running*) : ;;
    *) die "tailscale backend is not Running on the host: $topology" ;;
  esac
  DNS_NAME="$(printf '%s' "$topology" | awk '{print $3}')"
  [ -n "$DNS_NAME" ] || die "could not read the host's tailnet DNS name."
  measure "tailnet name" "$DNS_NAME"
}

lane_artifact() {
  step "Lane 1: signed candidate artifact"
  local dir="$RECORD_DIR/$TAG/artifact"
  mkdir -p "$dir"
  if [ ! -f "$dir/SHA256SUMS" ]; then
    ( cd "$dir" && gh release download "$TAG" --repo "$REPO_SLUG" >/dev/null ) ||
      die "could not download release $TAG from $REPO_SLUG."
  fi
  ( cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 ) ||
    die "checksums do not verify for $TAG. Refusing to install unverified bytes."
  measure "checksums" "verified locally"

  local archive
  archive="$(cd "$dir" && ls omp-session-gateway-*-bun.tar)"
  for asset in "$archive" SHA256SUMS; do
    gh attestation verify "$dir/$asset" --repo "$REPO_SLUG" >/dev/null 2>&1 ||
      die "gh attestation verify failed for $asset at $TAG."
  done
  measure "github attestations" "verified"
  if command -v cosign >/dev/null 2>&1; then
    local identity="https://github.com/${REPO_SLUG}/.github/workflows/signed-release.yml@refs/tags/${TAG}"
    cosign verify-blob --bundle "$dir/${archive}.sigstore.json" --certificate-identity "$identity" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "$dir/$archive" >/dev/null 2>&1 ||
      die "cosign verify-blob failed for $archive at $TAG."
    measure "cosign bundle" "verified against the tag identity"
  else
    warn "cosign is not installed here, so signature verification was limited to GitHub attestations."
  fi

  scp "${SSH_OPTS[@]}" -q "$dir/$archive" "$HOST:/tmp/$archive" || die "could not copy the archive to the host."
  remote <<REMOTE
show() { printf '   %-38s %s\n' "\$1:" "\$2"; }
rm -rf ~/qual && mkdir -p ~/qual && tar -xf "/tmp/$archive" -C ~/qual
root="\$(cd ~/qual && ls -d omp-session-gateway-*-bun)"
show "extracted root" "\$root"
show "release-info commit" "\$(python3 -c 'import json;print(json.load(open("'"\$HOME"'/qual/'"\$root"'/release-info.json"))["sourceCommit"])' 2>/dev/null)"
show "bundled upstream pin" "\$(python3 -c 'import json;print(json.load(open("'"\$HOME"'/qual/'"\$root"'/release-info.json"))["upstreamCommit"])' 2>/dev/null)"
REMOTE
}

lane_install() {
  step "Lane 2: install, doctor, rotate"
  remote <<REMOTE
S() { if [ -n "\$PW" ]; then echo "\$PW" | sudo -S -p '' "\$@"; else sudo -n "\$@"; fi; }
show() { printf '   %-38s %s\n' "\$1:" "\$2"; }
export PATH="\$HOME/.bun/bin:\$HOME/go/bin:\$PATH"
CLI="\$HOME/qual/\$(cd ~/qual && ls -d omp-session-gateway-*-bun)/apps/gateway/src/cli.js"
TS="\$(command -v tailscale || echo "\$HOME/go/bin/tailscale")"

# The operator grant matters: doctor runs as this user and shells out to \`tailscale\`, so without it
# the tailscale checks fail for a permission reason that looks like a gateway fault.
"\$TS" set --operator="\$(whoami)" >/dev/null 2>&1 ||
  S "\$TS" set --operator="\$(whoami)" >/dev/null 2>&1 ||
  true

bun "\$CLI" install --origin "https://$DNS_NAME" --allow "\$LOGIN" >/dev/null 2>&1 ||
  { echo "   install FAILED"; exit 1; }
show "install" "completed for https://$DNS_NAME"
show "status" "\$(bun "\$CLI" status)"
show "listeners" "\$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk -v p=":\$PORT" '\$9 ~ p {print \$9}' | tr '\n' ' ')"
show "plist mode" "\$(stat -f '%Sp' ~/Library/LaunchAgents/omp-session-gateway.plist 2>/dev/null)"
show "config mode" "\$(stat -f '%Sp' ~/.config/omp-session-gateway/config.json 2>/dev/null)"
show "token mode" "\$(stat -f '%Sp' ~/.config/omp-session-gateway/publisher-token 2>/dev/null)"
show "launchagent state" "\$(launchctl print "gui/\$(id -u)/omp-session-gateway" 2>/dev/null | awk '/state =/{print \$3; exit}')"

# Serve, then the certificate fetched directly. Probing https to find out whether it is ready is the
# trap described in this script's header.
\$TS serve reset >/dev/null 2>&1 || true
\$TS serve --bg --https=443 "http://127.0.0.1:\$PORT" >/dev/null 2>&1 || true
("\$TS" cert --cert-file /tmp/omp-qual.crt --key-file /tmp/omp-qual.key "$DNS_NAME" >/dev/null 2>&1 ||
  S "\$TS" cert --cert-file /tmp/omp-qual.crt --key-file /tmp/omp-qual.key "$DNS_NAME" >/dev/null 2>&1) &&
  show "tls certificate" "provisioned for $DNS_NAME" ||
  show "tls certificate" "NOT provisioned (check the ACME rate limit; do not retry by probing)"

bun "\$CLI" doctor > /tmp/omp-doctor.json 2>/dev/null; rc=\$?
python3 - <<'PY'
import json
c = json.load(open('/tmp/omp-doctor.json'))['checks']
false = [k for k, v in c.items() if not v]
print('   %-38s %s' % ('doctor', '%d/%d true' % (len(c) - len(false), len(c))))
print('   %-38s %s' % ('doctor false checks', ','.join(false) if false else '(none)'))
for key in ('loopbackTrustSound', 'listenerLoopbackOnly', 'identityAllowed', 'serveMapping', 'funnelDisabled'):
    print('   %-38s %s' % (key, c.get(key)))
PY
show "doctor exit" "\$rc"

before="\$(lsof -nP -iTCP:\$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print \$2}')"
digest_before="\$(shasum -a 256 ~/.config/omp-session-gateway/publisher-token | cut -c1-12)"
bun "\$CLI" rotate-publisher-token >/dev/null 2>&1
sleep 3
after="\$(lsof -nP -iTCP:\$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print \$2}')"
digest_after="\$(shasum -a 256 ~/.config/omp-session-gateway/publisher-token | cut -c1-12)"
show "token rotation pid" "\$before -> \$after"
show "token digest" "\$digest_before -> \$digest_after"

bun "\$CLI" doctor --bundle /tmp/omp-bundle.tar >/dev/null 2>&1
tok="\$(cat ~/.config/omp-session-gateway/publisher-token)"
show "token bytes in bundle" "\$(grep -c -- "\$tok" /tmp/omp-bundle.tar 2>/dev/null || echo 0)"
show "login in bundle" "\$(grep -c -- "\$LOGIN" /tmp/omp-bundle.tar 2>/dev/null || echo 0)"
REMOTE
}

lane_identity() {
  step "Lane 3: identity and exposure, from this workstation"
  note "This workstation is a distinct user-owned tailnet node, which is the only vantage point that"
  note "can see the failure in #98: a bind-address check cannot, and neither can the host itself."

  local host_ip
  host_ip="$(remote <<'REMOTE'
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"
("$TS" status --json 2>/dev/null || S "$TS" status --json 2>/dev/null) |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["TailscaleIPs"][0])' 2>/dev/null
REMOTE
)"
  measure "host tailnet address" "${host_ip:-<unknown>}"

  measure "Serve, allowlisted identity" "$(curl -sS -o /tmp/omp-serve.json -w '%{http_code}' --max-time 45 "https://$DNS_NAME/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "body keys" "$(python3 -c 'import json;print(list(json.load(open("/tmp/omp-serve.json")).keys()))' 2>/dev/null || echo unavailable)"
  measure "cache-control" "$(curl -sS -D - -o /dev/null --max-time 30 "https://$DNS_NAME/api/v1/sessions" 2>/dev/null | awk 'tolower($1)=="cache-control:"{sub(/^[^ ]+ /,"");print}' | tr -d '\r')"
  measure "PWA shell" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "https://$DNS_NAME/" 2>/dev/null || echo request-failed)"
  # The forged value must be ignored rather than honoured: Serve owns the header, not the caller.
  measure "forged header, real login allowed" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -H 'Tailscale-User-Login: nobody@example.invalid' "https://$DNS_NAME/api/v1/sessions" 2>/dev/null || echo request-failed)"

  note "The two probes below must be refused. Any HTTP status means the backend is tailnet-reachable,"
  note "which is #98 and is a release blocker, not a warning."
  local tailnet_probe public_probe
  tailnet_probe="$(timeout 8 bash -c "cat < /dev/null > /dev/tcp/${host_ip}/${GATEWAY_PORT}" 2>/dev/null && echo "OPEN — EXPOSED" || echo refused)"
  public_probe="$(timeout 8 bash -c "cat < /dev/null > /dev/tcp/${HOST#*@}/${GATEWAY_PORT}" 2>/dev/null && echo "OPEN — EXPOSED" || echo refused)"
  measure "backend at tailnet address" "$tailnet_probe"
  measure "backend at ssh address" "$public_probe"
  case "$tailnet_probe$public_probe" in *OPEN*) die "the gateway port answered from a distinct node. That is #98; stop and fix before recording anything." ;; esac
}

lane_persistence() {
  step "Lane 4: reboot and login persistence"
  note "macOS starts a LaunchAgent at console login, so this measures return at login. With"
  note "auto-login enabled that is automatic; it is still not start-with-nobody-logged-in."
  local before_digest
  before_digest="$(remote <<'REMOTE'
shasum -a 256 ~/.config/omp-session-gateway/publisher-token | cut -c1-12
REMOTE
)"
  measure "token digest before reboot" "$before_digest"

  ssh "${SSH_OPTS[@]}" -q "$HOST" "${OMP_MAC_SUDO_PW:+echo '$OMP_MAC_SUDO_PW' | }sudo -S -p '' shutdown -r now" >/dev/null 2>&1 || true
  note "reboot issued; waiting for SSH, then for the gateway to bind its listener"
  local up=""
  for _ in $(seq 1 36); do
    sleep 10
    up="$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=8 -q "$HOST" 'ps -o etime= -p 1 | tr -d " "' 2>/dev/null || true)"
    [ -n "$up" ] && break
  done
  [ -n "$up" ] || die "the host did not come back after the reboot."
  measure "pid 1 elapsed when ssh answered" "$up"

  # Readiness is waited for, not sampled. The first version of this lane snapshotted as soon as SSH
  # answered, which on a real run was 22 seconds after boot: the LaunchAgent was already `running`
  # but had not yet bound the listener, so the report said `gateway pid: <none>` and `ready:false`
  # and looked exactly like a persistence failure. What the row actually wants is whether the
  # gateway returns and how long it takes, so both are measured.
  local waited=0 ready=""
  for _ in $(seq 1 24); do
    ready="$(remote <<'REMOTE'
export PATH="$HOME/.bun/bin:$PATH"
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}'
REMOTE
)"
    [ -n "$ready" ] && break
    sleep 5
    waited=$((waited + 5))
  done
  if [ -z "$ready" ]; then
    measure "gateway after reboot" "NEVER RETURNED within $waited s"
    die "the gateway did not return after the reboot. That is the failure this lane exists to find."
  fi
  measure "gateway returned after" "${waited}s of polling (pid $ready)"

  remote <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
export PATH="$HOME/.bun/bin:$HOME/go/bin:$PATH"
CLI="$HOME/qual/$(cd ~/qual && ls -d omp-session-gateway-*-bun)/apps/gateway/src/cli.js"
pid="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
show "gateway pid" "${pid:-<none>}"
[ -n "$pid" ] && show "gateway process age" "$(ps -o etime= -p "$pid" | tr -d ' ')"
show "launchagent state" "$(launchctl print "gui/$(id -u)/omp-session-gateway" 2>/dev/null | awk '/state =/{print $3; exit}')"
show "console sessions" "$(who | awk '{print $1"/"$2}' | tr '\n' ' ')"
show "token digest after reboot" "$(shasum -a 256 ~/.config/omp-session-gateway/publisher-token | cut -c1-12)"
show "status" "$(bun "$CLI" status 2>/dev/null)"
bun "$CLI" doctor >/tmp/omp-doctor2.json 2>/dev/null; show "doctor exit" "$?"
REMOTE
  note "Compare the two token digests: an unchanged digest is the point, because a reboot must not"
  note "mint new publisher credentials."
}

stage_remote_rollback_tools() {
  local gh_bin cosign_bin
  need_command cosign
  gh_bin="$(command -v gh)"
  cosign_bin="$(command -v cosign)"
  remote <<'REMOTE'
mkdir -p "$HOME/qual-tools"
chmod 700 "$HOME/qual-tools"
REMOTE
  scp "${SSH_OPTS[@]}" -q "$gh_bin" "$cosign_bin" "$REPO_ROOT/scripts/qualify-rollback.sh" "$HOST:qual-tools/" ||
    die "could not stage the rollback harness and verification tools on the Mac."
  remote <<'REMOTE'
chmod 700 "$HOME/qual-tools/gh" "$HOME/qual-tools/cosign" "$HOME/qual-tools/qualify-rollback.sh"
REMOTE
}

lane_rollback() {
  step "Lane 5: isolated gateway upgrade and rollback"
  stage_remote_rollback_tools
  remote <<'REMOTE'
export PATH="$HOME/qual-tools:$HOME/.bun/bin:$PATH"
OMP_ROLLBACK_OLD_TAG="$PREVIOUS_TAG" OMP_ROLLBACK_NEW_TAG="$TAG" \
  bash "$HOME/qual-tools/qualify-rollback.sh" run
REMOTE
}

stage_remote_omp_helper() {
  remote <<'REMOTE'
mkdir -p "$HOME/qual-tools"
chmod 700 "$HOME/qual-tools"
REMOTE
  scp "${SSH_OPTS[@]}" -q "$REPO_ROOT/scripts/qualify-macos-omp.sh" "$HOST:qual-tools/" ||
    die "could not stage the patched OMP qualification helper on the Mac."
  remote <<'REMOTE'
chmod 700 "$HOME/qual-tools/qualify-macos-omp.sh"
REMOTE
}

lane_omp_build() {
  step "Lane 6: exact patched OMP build"
  stage_remote_omp_helper
  remote <<'REMOTE'
export PATH="$HOME/.bun/bin:$PATH"
root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"
OMP_QUAL_GATEWAY_ROOT="$root" \
OMP_PIN_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
OMP_PIN_PATCHED_TREE="$OMP_PATCHED_TREE" \
OMP_PIN_VERSION="$OMP_VERSION" \
OMP_PIN_BUN_VERSION="$BUN_VERSION" \
  bash "$HOME/qual-tools/qualify-macos-omp.sh" build
REMOTE
}

lane_omp_clean() {
  step "Lane 7: patched OMP cleanup"
  stage_remote_omp_helper
  remote <<'REMOTE'
export PATH="$HOME/.bun/bin:$PATH"
root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"
OMP_QUAL_GATEWAY_ROOT="$root" \
OMP_PIN_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
OMP_PIN_PATCHED_TREE="$OMP_PATCHED_TREE" \
OMP_PIN_VERSION="$OMP_VERSION" \
OMP_PIN_BUN_VERSION="$BUN_VERSION" \
  bash "$HOME/qual-tools/qualify-macos-omp.sh" clean
REMOTE
}

lane_uninstall() {
  step "Lane 5: uninstall"
  remote <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
export PATH="$HOME/.bun/bin:$PATH"
CLI="$HOME/qual/$(cd ~/qual && ls -d omp-session-gateway-*-bun)/apps/gateway/src/cli.js"
out="$(bun "$CLI" uninstall --no-stop 2>&1 || true)"
case "$out" in
  *"cannot uninstall an active gateway"*) show "uninstall --no-stop while active" "refused, as required" ;;
  *) show "uninstall --no-stop while active" "NOT REFUSED: $out" ;;
esac
bun "$CLI" uninstall >/dev/null 2>&1
sleep 2
show "plist present" "$([ -f ~/Library/LaunchAgents/omp-session-gateway.plist ] && echo yes || echo no)"
show "gui job" "$(launchctl print "gui/$(id -u)/omp-session-gateway" >/dev/null 2>&1 && echo present || echo absent)"
show "gateway pids" "$(pgrep -f 'omp-session-gateway.*cli.js serve' | wc -l | tr -d ' ')"
show "listeners" "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -c ":$PORT" || echo 0)"
REMOTE
}

# ---------------------------------------------------------------------------------------------------

DNS_NAME=""
lanes=("$@")
[ ${#lanes[@]} -gt 0 ] || lanes=(artifact install identity persistence uninstall)

for lane in "${lanes[@]}"; do
  case "$lane" in
    artifact | install | identity | persistence | rollback | omp-build | omp-clean | uninstall) ;;
    *) die "unknown lane '$lane'; choose from artifact install identity persistence rollback omp-build omp-clean uninstall" ;;
  esac
done

preflight
for lane in "${lanes[@]}"; do
  case "$lane" in
    artifact) lane_artifact ;;
    install) lane_install ;;
    identity) lane_identity ;;
    persistence) lane_persistence ;;
    rollback) lane_rollback ;;
    omp-build) lane_omp_build ;;
    omp-clean) lane_omp_clean ;;
    uninstall) lane_uninstall ;;
  esac
done

step "Finished"
note "Every line above is a measurement, not a verdict. Record the numbers against $TAG in"
note "docs/RELEASE_STATUS.md; nothing here promotes a ledger row on its own."
