#!/usr/bin/env bash
#
# Linux qualification lane: one throwaway DigitalOcean droplet, release and OMP evidence.
#
# Why this exists. The original Linux evidence in docs/RELEASE_STATUS.md came from a Debian 13
# aarch64 container. A container shares the host kernel, never boots, has no public address of its
# own, and its `systemd --user` manager exists only because something outside kept it alive. That is
# enough to prove an install/uninstall sequence and file permissions, and nothing else. Five things
# a container structurally cannot show are the point of this script:
#
#   1. a real machine lifecycle: its own kernel, its own boot, its own public IP;
#   2. reboot and login persistence;
#   3. a denied Tailscale identity;
#   4. signed-candidate install/doctor/uninstall with checksum and provenance verification; and
#   5. the mandatory exact patched-OMP build, activation, publication, launch, and revocation path.
#
# Two design decisions are worth knowing before editing this file.
#
# Lingering versus a login session. The gateway's systemd unit is `WantedBy=default.target` and the
# CLI never calls `loginctl enable-linger`. So "the service came back after reboot" is ambiguous by
# default: it can mean lingering started the user manager at boot, or it can mean the SSH login used
# to check created a session that pulled in default.target. This script resolves the ambiguity by
# rebooting twice and measuring from *root only*, so the qualified user has zero sessions at the
# instant of measurement. With lingering off the daemon must be absent; with lingering on it must be
# present while `loginctl` reports no session for that user, and its process age must track system
# uptime rather than the age of our connection. Both numbers are printed, every time.
#
# Tagged identity. The droplet joins the tailnet with a *tagged* auth key. Tailscale Serve populates
# `Tailscale-User-Login` only for user-owned source devices, so a request from a tagged node arrives
# with no user identity at all and the gateway must fail closed. That is the denial half the ledger
# needs and it cannot be produced from the operator's own devices. The price of a tagged node is that
# it can never present a user identity, so `doctor` cannot pass every check on it and the allowed half has
# to come from the operator's workstation, which is a genuinely distinct user-owned node. Both are
# measured here. See docs/LINUX_QUALIFICATION.md for exactly what each pass does and does not prove.
#
# Secrets. The DigitalOcean token and the Tailscale auth key are read from the environment and never
# appear in argv, in cloud-init user data (which is readable from the droplet's own metadata service
# and from the DigitalOcean API), or in any printed line. The auth key is streamed over stdin into a
# mode-0600 file that a remote EXIT trap removes, and `tailscale up` reads it with the documented
# `file:` form. The service's one-time readiness nonce is redacted where ExecStart is printed.
#
# The image is a parameter. OMP_QUAL_IMAGE defaults to the same `debian-13-x64` slug this lane has
# always used, and also accepts a numeric DigitalOcean *custom image* id. Custom images have no slug,
# so a purely numeric value is the only shape an imported image can take and the distinction needs no
# second knob. That exists for one reason: the Linux service backend in apps/gateway/src/service.ts
# builds a systemd user unit for every `linux` platform and then drives `systemctl --user`, with no
# check on what init system is actually running. Whether systemd-only is acceptable for alpha is a
# decision, and the cheapest input to it is to point this lane at a non-systemd distribution and read
# the failure. OMP_QUAL_INIT=openrc provisions an imported Alpine image and runs lane `init`, whose
# expected result is a *refused* install that leaves nothing running. See docs/LINUX_QUALIFICATION.md
# §10 for the import procedure; no OpenRC service backend is implemented here and none should be
# inferred from this lane passing.
#
# Cost. One `s-1vcpu-2gb` droplet, one fixed name, reused rather than duplicated. The EXIT trap
# always reprints the destroy command, because the only way this lane becomes expensive is by being
# forgotten. An imported custom image is a *second* billable resource and `destroy` deliberately does
# not delete it, so `destroy` lists every user image in the account and names the delete command.
#
# Usage:
#   scripts/provision-linux-qual.sh provision
#   scripts/provision-linux-qual.sh qualify [lane...]
#   scripts/provision-linux-qual.sh status
#   scripts/provision-linux-qual.sh destroy
#
# Lanes, systemd: host artifact lifecycle omp migration rollback identity persistence uninstall
#                 (default: all). `omp` builds and exercises the exact versioned publisher route;
#                 `migration` reinstalls to move between gateway versions; `rollback` drives the
#                 `omp-gateway rollback` command, which is a different code path, and reads the two
#                 archive roots `migration` leaves on the droplet.
# Lanes, OpenRC:  host artifact init (default: all three; the rest presume a working install).
#
set -euo pipefail

readonly REPO_SLUG="alphastorm/omp-session-gateway"
readonly TAILNET_TAG="${OMP_QUAL_TAG:-tag:omp-session-gateway}"
readonly DROPLET_NAME="${OMP_QUAL_NAME:-omp-gateway-qual}"
readonly DROPLET_REGION="${OMP_QUAL_REGION:-sfo3}"
readonly DROPLET_SIZE="${OMP_QUAL_SIZE:-s-1vcpu-2gb}"
readonly DROPLET_IMAGE="${OMP_QUAL_IMAGE:-debian-13-x64}"
readonly SSH_KEY_ID="${OMP_QUAL_SSH_KEY_ID:-11924832}"
readonly QUAL_USER="${OMP_QUAL_USER:-ompqual}"
readonly BUN_VERSION="${OMP_QUAL_BUN_VERSION:-1.3.14}"
readonly GH_CLI_VERSION="${OMP_QUAL_GH_VERSION:-2.97.0}"
readonly COSIGN_VERSION="${OMP_QUAL_COSIGN_VERSION:-3.1.3}"
readonly GATEWAY_PORT="${OMP_QUAL_PORT:-4317}"
readonly OMP_SOURCE_COMMIT="9350b7990d26ebf69a604edc82d8558ef04adf30"
readonly OMP_PATCHED_TREE="a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7"
readonly OMP_VERSION="17.4.1"

# Which init system the droplet is expected to run. `systemd` is the historical and only supported
# shape; `openrc` provisions a non-systemd box so the installer's refusal can be observed. Validated
# in preflight_tools so a typo cannot reach a billable resource.
readonly QUAL_INIT="${OMP_QUAL_INIT:-systemd}"

# An address in a reserved TLD. Nobody can ever authenticate as this, which is what makes it a usable
# stand-in for "a well-formed login that is not on the allowlist".
readonly SYNTHETIC_DENIED_LOGIN="denied-identity@qual.invalid"

# The OpenRC path never joins a tailnet, so it has no MagicDNS name to install against. `install`
# only requires an exact HTTPS origin and refuses long before it resolves anything, so a reserved-TLD
# placeholder is both sufficient and unable to name a real host.
readonly OPENRC_SYNTHETIC_ORIGIN="https://openrc-qual.example.invalid"

readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway-qual"
readonly STATE_FILE="$STATE_DIR/${DROPLET_NAME}.json"
readonly KNOWN_HOSTS="$STATE_DIR/${DROPLET_NAME}.known_hosts"

LOCAL_TEMP=""
DROPLET_JSON=""
DROPLET_IP=""
DROPLET_ID=""
HOURLY_RATE=""
SSH_OPTS=()

step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
measure() { printf '   %-38s %s\n' "$1:" "$2"; }
warn() { printf '   WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# `doctl compute droplet create --image` accepts either a distribution slug or a numeric image id.
# Imported custom images are only ever addressable by id — DigitalOcean assigns them no slug — so the
# value's own shape decides which catalog to validate against, and an operator cannot desynchronise a
# "kind" flag from the value it describes.
image_kind() {
  case "$DROPLET_IMAGE" in
    '' | *[!0-9]*) printf 'distribution' ;;
    *) printf 'custom' ;;
  esac
}

droplet_exists_quietly() {
  command -v doctl >/dev/null 2>&1 || return 1
  doctl compute droplet list --format Name --no-header 2>/dev/null | grep -qx "$DROPLET_NAME"
}

# Set once a delete has been observed to complete. The EXIT trap runs immediately afterwards, when
# DigitalOcean's list endpoint can still report the droplet present, so without this a fully
# successful destroy prints the "STILL BILLING" banner and teaches the operator to ignore it.
DESTROY_CONFIRMED=0

on_exit() {
  local code=$?
  if [ -n "$LOCAL_TEMP" ] && [ -d "$LOCAL_TEMP" ]; then rm -rf "$LOCAL_TEMP"; fi
  if [ "$DESTROY_CONFIRMED" -eq 0 ] && droplet_exists_quietly; then
    printf '\n'
    printf '  ############################################################\n'
    printf '  #  %-54s#\n' "$DROPLET_NAME IS STILL RUNNING AND STILL BILLING"
    printf '  #  %-54s#\n' "run: $0 destroy"
    printf '  ############################################################\n'
  fi
  return "$code"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

# ---------------------------------------------------------------------------- local state

state_read() {
  [ -f "$STATE_FILE" ] || return 0
  jq -r --arg key "$1" '.[$key] // ""' "$STATE_FILE"
}

state_write() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local existing='{}'
  if [ -f "$STATE_FILE" ]; then existing="$(cat "$STATE_FILE")"; fi
  printf '%s' "$existing" | jq --arg key "$1" --arg value "$2" '.[$key] = $value' >"$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# ---------------------------------------------------------------------------- droplet queries

size_hourly_rate() {
  doctl compute size list --output json |
    jq -r --arg slug "$DROPLET_SIZE" '.[] | select(.slug == $slug) | .price_hourly | tostring'
}

# Hours the droplet has existed and the dollars that implies. DigitalOcean bills by the hour and does
# not refund a partial one, so this is the number that matters when deciding whether to destroy now.
accrued_cost() {
  jq -nr --arg created "$1" --arg rate "$2" '
    ($created | fromdateiso8601) as $t
    | ((now - $t) / 3600) as $hours
    | "\(($hours * 100 | round) / 100) h elapsed, about $\((($hours * ($rate | tonumber)) * 100 | round) / 100) accrued"'
}

# Sets DROPLET_JSON/DROPLET_ID/DROPLET_IP. Never call this inside a command substitution: the
# assignments would be lost with the subshell.
load_droplet() {
  DROPLET_JSON="$(doctl compute droplet list --output json |
    jq --arg name "$DROPLET_NAME" '[.[] | select(.name == $name)] | first // empty')"
  [ -n "$DROPLET_JSON" ] || return 1
  DROPLET_ID="$(printf '%s' "$DROPLET_JSON" | jq -r '.id')"
  DROPLET_IP="$(printf '%s' "$DROPLET_JSON" |
    jq -r '[.networks.v4[] | select(.type == "public") | .ip_address] | first // ""')"
}

require_droplet() {
  load_droplet || die "no droplet named $DROPLET_NAME; run '$0 provision' first"
  [ -n "$DROPLET_IP" ] || die "droplet $DROPLET_NAME has no public IPv4 address yet; retry shortly"
}

# ---------------------------------------------------------------------------- ssh plumbing

init_ssh_options() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  touch "$KNOWN_HOSTS"
  SSH_OPTS=(
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$KNOWN_HOSTS"
    -o LogLevel=ERROR
  )
  if [ -n "${OMP_QUAL_SSH_IDENTITY:-}" ]; then
    SSH_OPTS+=(-i "$OMP_QUAL_SSH_IDENTITY" -o IdentitiesOnly=yes)
  fi
}

# Runs the script on stdin as $1 on the droplet. Remaining arguments are NAME=VALUE pairs exported for
# that script; they are shell-quoted here so no caller has to think about spacing.
remote() {
  local user="$1"
  shift
  local assignments="" pair
  for pair in "$@"; do assignments="$assignments $(printf '%q' "$pair")"; done
  # shellcheck disable=SC2029  # client-side expansion is the design: values are quoted with %q here
  # so the remote `env` prefix is exact, and no caller has to reason about remote word splitting.
  ssh "${SSH_OPTS[@]}" "${user}@${DROPLET_IP}" "env${assignments} bash -s -e -u -o pipefail"
}

remote_root() { remote root "$@"; }
remote_user() { remote "$QUAL_USER" "$@"; }

# ---------------------------------------------------------------------------- bounded waits

wait_for() {
  local label="$1" attempts="$2" delay="$3"
  shift 3
  local index started elapsed
  started="$(date -u +%s)"
  for ((index = 1; index <= attempts; index++)); do
    if "$@" >/dev/null 2>&1; then
      elapsed=$(($(date -u +%s) - started))
      measure "$label" "ready after ${elapsed}s (attempt $index/$attempts)"
      return 0
    fi
    sleep "$delay"
  done
  die "$label did not become ready within $((attempts * delay))s. The droplet is still running; inspect it with '$0 status'."
}

droplet_is_active() {
  [ "$(doctl compute droplet list --output json |
    jq -r --arg name "$DROPLET_NAME" '[.[] | select(.name == $name)] | first.status // ""')" = "active" ]
}

ssh_is_up() { ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" true; }

cloud_init_done() { ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" "test -f /run/cloud-init/result.json"; }

tailscale_is_online() {
  local state
  state="$(ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" \
    "tailscale status --json 2>/dev/null | jq -r '(.BackendState // \"\") + \":\" + ((.Self.Online // false) | tostring)'" 2>/dev/null || true)"
  [ "$state" = "Running:true" ]
}

# ---------------------------------------------------------------------------- preflight

preflight_tools() {
  need_command doctl
  need_command jq
  need_command ssh
  need_command scp
  need_command ssh-keygen
  need_command curl
  # Checked here rather than at first use: every command routes through this function, and a typo
  # must be rejected before anything is created or measured.
  case "$QUAL_INIT" in
    systemd | openrc) ;;
    *) die "OMP_QUAL_INIT must be 'systemd' or 'openrc', not '$QUAL_INIT'. Nothing was created." ;;
  esac
  doctl account get --output json >/dev/null 2>&1 ||
    die "doctl is not authenticated. Export DIGITALOCEAN_ACCESS_TOKEN or run 'doctl auth init'."
}

# Refuses to create a droplet whose root account we could not then log into. DigitalOcean stores the
# legacy MD5 fingerprint of the public key, which is what `ssh-keygen -E md5` prints.
preflight_ssh_key() {
  local key_json do_fingerprint key_name pub local_fingerprint candidates
  key_json="$(doctl compute ssh-key get "$SSH_KEY_ID" --output json 2>/dev/null || true)"
  # A missing key makes doctl print an {"errors":[...]} object rather than an empty list, so check the
  # shape instead of trusting the exit status.
  if ! printf '%s' "$key_json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
    die "SSH key id $SSH_KEY_ID is not in this DigitalOcean account. List keys with 'doctl compute ssh-key list' and set OMP_QUAL_SSH_KEY_ID. No droplet was created."
  fi
  do_fingerprint="$(printf '%s' "$key_json" | jq -r '.[0].fingerprint')"
  key_name="$(printf '%s' "$key_json" | jq -r '.[0].name')"
  measure "DigitalOcean SSH key" "id $SSH_KEY_ID, name $key_name"

  # Newline-delimited rather than an array: bash 3.2, which is what /bin/bash is on macOS, treats
  # "${empty[@]}" as an unbound variable under `set -u`.
  if [ -n "${OMP_QUAL_SSH_IDENTITY:-}" ]; then
    candidates="${OMP_QUAL_SSH_IDENTITY}.pub"
  else
    candidates="$(for pub in "$HOME"/.ssh/*.pub; do if [ -f "$pub" ]; then printf '%s\n' "$pub"; fi; done)"
  fi
  while IFS= read -r pub; do
    if [ -z "$pub" ] || [ ! -f "$pub" ]; then continue; fi
    local_fingerprint="$(ssh-keygen -l -E md5 -f "$pub" 2>/dev/null | awk '{print $2}')"
    if [ "$local_fingerprint" = "MD5:${do_fingerprint}" ]; then
      measure "matching local private key" "${pub%.pub}"
      return 0
    fi
  done <<CANDIDATES
$candidates
CANDIDATES
  if ssh-add -l -E md5 2>/dev/null | awk '{print $2}' | grep -qx "MD5:${do_fingerprint}"; then
    measure "matching key in ssh-agent" "yes"
    return 0
  fi
  die "no local private key matches DigitalOcean SSH key '$key_name' (MD5:${do_fingerprint}). Add that key to your agent, or set OMP_QUAL_SSH_IDENTITY=/path/to/private_key. No droplet was created."
}

# Validates the image against whichever catalog can actually contain it, and prints the same
# `image / size / region` and `hourly rate` lines as before so a default run's output is unchanged.
preflight_catalog() {
  if [ "$(image_kind)" = "custom" ]; then
    preflight_custom_image
  else
    doctl compute image list-distribution --output json |
      jq -e --arg slug "$DROPLET_IMAGE" 'any(.[]; .slug == $slug)' >/dev/null ||
      die "image slug $DROPLET_IMAGE does not exist in this account's distribution list"
  fi
  doctl compute size list --output json |
    jq -e --arg slug "$DROPLET_SIZE" --arg region "$DROPLET_REGION" \
      'any(.[]; .slug == $slug and .available and (.regions | index($region)))' >/dev/null ||
    die "size $DROPLET_SIZE is not available in region $DROPLET_REGION"
  HOURLY_RATE="$(size_hourly_rate)"
  measure "image / size / region" "$DROPLET_IMAGE / $DROPLET_SIZE / $DROPLET_REGION"
  measure "hourly rate" "\$$HOURLY_RATE per hour"
}

# A custom image can fail in three ways a distribution slug cannot: it may not exist, it may still be
# importing, and — because custom images are region-scoped — it may exist in a region other than the
# one we are about to create a droplet in. All three are cheap to check and expensive to discover
# after `droplet create` has already been accepted, so check them before anything is created.
preflight_custom_image() {
  local image_json record status regions size_gb monthly
  image_json="$(doctl compute image get "$DROPLET_IMAGE" --output json 2>/dev/null || true)"
  # `doctl compute image get` prints a single-element array on success and an {"errors":[...]} object
  # on failure, so normalise the shape rather than trusting the exit status.
  record="$(printf '%s' "$image_json" |
    jq -c 'if type == "array" then (.[0] // empty) else empty end' 2>/dev/null || true)"
  [ -n "$record" ] ||
    die "custom image id $DROPLET_IMAGE is not in this DigitalOcean account. List imported images with 'doctl compute image list-user'. No droplet was created."
  status="$(printf '%s' "$record" | jq -r '.status // "unknown"')"
  regions="$(printf '%s' "$record" | jq -r '(.regions // []) | join(",")')"
  size_gb="$(printf '%s' "$record" | jq -r '.size_gigabytes // 0')"
  measure "custom image name" "$(printf '%s' "$record" | jq -r '.name // "<unnamed>"')"
  measure "custom image distribution" "$(printf '%s' "$record" | jq -r '.distribution // "Unknown"')"
  measure "custom image status" "$status"
  measure "custom image regions" "${regions:-<none>}"
  # $0.06 per GB per month, and unlike the droplet it keeps billing after `destroy`.
  monthly="$(jq -nr --arg gb "$size_gb" '(($gb | tonumber) * 0.06 * 100 | round) / 100')"
  measure "custom image stored size / cost" "$size_gb GB, about \$$monthly per month until deleted"
  [ "$status" = "available" ] ||
    die "custom image id $DROPLET_IMAGE reports status '$status', not 'available'. An import takes several minutes; wait and retry. No droplet was created."
  printf '%s' "$record" | jq -e --arg region "$DROPLET_REGION" '(.regions // []) | index($region)' >/dev/null ||
    die "custom image id $DROPLET_IMAGE exists in regions [${regions:-none}] but not in $DROPLET_REGION. Custom images are region-scoped: add the region in the DigitalOcean control panel, or set OMP_QUAL_REGION to one it already covers. No droplet was created."
}

# ---------------------------------------------------------------------------- provision

cloud_init_user_data() {
  if [ "$QUAL_INIT" = "openrc" ]; then
    cloud_init_user_data_openrc
    return 0
  fi
  # Deliberately free of secrets: user data is retrievable from the droplet's metadata service and
  # from the DigitalOcean API. Tailscale is installed here and never authenticated here.
  cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - jq
  - git
  - unzip
  - iproute2
  - procps
users:
  - default
  - name: ${QUAL_USER}
    shell: /bin/bash
    lock_passwd: true
write_files:
  - path: /etc/omp-qual-provisioned
    content: "omp-session-gateway linux qualification droplet\n"
runcmd:
  - [ sh, -c, "install -d -m 700 -o ${QUAL_USER} -g ${QUAL_USER} /home/${QUAL_USER}/.ssh" ]
  - [ sh, -c, "cp /root/.ssh/authorized_keys /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chown ${QUAL_USER}:${QUAL_USER} /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chmod 600 /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "curl -fsSL https://tailscale.com/install.sh | sh" ]
CLOUDINIT
}

# The Alpine/OpenRC variant. Four deliberate differences from the systemd user data above, each of
# which is a property of the distribution rather than a preference:
#
#   * `bash` is a package here, and `remote()` runs `bash -s`. `coreutils` and `grep` replace the
#     busybox applets whose option sets differ (`stat -c`, `grep -c`), and `libstdc++` is what Bun's
#     musl build links against.
#   * the qualified user's login shell is `/bin/ash`, not `/bin/bash`. cloud-init creates users in
#     `cloud_init_modules` and installs packages later in `cloud_config_modules`, so naming a shell
#     that does not exist yet leaves the account unusable in between. `remote()` asks for `bash`
#     explicitly, so the login shell does not need to be it.
#   * `disable_root: false` is stated rather than assumed. The lane logs in as root to measure, and
#     an imported image's `cloud.cfg` is not ours to trust on that point.
#   * no Tailscale. Serve is only needed by the lanes that require a working install, and the install
#     is expected to be refused here. Installing tailscaled would also mean writing an OpenRC service
#     for it, which is exactly the thing this lane must not quietly do.
cloud_init_user_data_openrc() {
  cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - bash
  - ca-certificates
  - coreutils
  - curl
  - grep
  - iproute2
  - jq
  - libstdc++
  - unzip
disable_root: false
users:
  - default
  - name: ${QUAL_USER}
    shell: /bin/ash
    lock_passwd: true
write_files:
  - path: /etc/omp-qual-provisioned
    content: "omp-session-gateway linux qualification droplet (non-systemd)\n"
runcmd:
  - [ sh, -c, "install -d -m 700 -o ${QUAL_USER} -g ${QUAL_USER} /home/${QUAL_USER}/.ssh" ]
  - [ sh, -c, "cp /root/.ssh/authorized_keys /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chown ${QUAL_USER}:${QUAL_USER} /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chmod 600 /home/${QUAL_USER}/.ssh/authorized_keys" ]
CLOUDINIT
}

# Two stdin consumers cannot share one ssh invocation, so the key transfer and the join are separate
# calls: the key goes over stdin under a fixed argv (never in `ps`), then a second call uses it via
# the documented `file:` form and removes it. Removal is attempted on both the success and failure
# path, because an ssh connection that dies before the remote trap arms would otherwise leave it.
join_tailnet() {
  local key_file="$LOCAL_TEMP/authkey" joined=0
  (
    umask 077
    printf '%s' "$TS_AUTHKEY" >"$key_file"
  )
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" 'umask 077; cat > /root/.ts-authkey' <"$key_file"
  rm -f "$key_file"
  remote_root <<'REMOTE' && joined=1
trap 'rm -f /root/.ts-authkey' EXIT
test -s /root/.ts-authkey
tailscale up --auth-key "file:/root/.ts-authkey" --hostname "$(hostname -s)" --accept-dns=true --ssh=false
REMOTE
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" 'rm -f /root/.ts-authkey' || true
  [ "$joined" -eq 1 ] ||
    die "'tailscale up' failed on the droplet. The auth key file was removed; check that the key is still valid, preauthorized, and carries $TAILNET_TAG."
}

# Extracted from cmd_provision unchanged so the OpenRC path can skip it as a unit. Everything here is
# specific to a tailnet-joined systemd host: Serve, the operator grant, and lingering all exist to
# serve lanes that presume a working install.
provision_tailnet() {
  step "Tailnet"
  if tailscale_is_online; then
    note "already joined; leaving the existing session alone"
  else
    join_tailnet
  fi
  wait_for "tailscale backend running and online" 30 5 tailscale_is_online
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
# The qualified user, not root, drives `tailscale serve` and is the identity `doctor` runs as, so it
# needs operator access to the local API. Without this, doctor's tailscaleConnected and funnelDisabled
# checks fail for a permission reason that looks like a gateway fault.
tailscale set --operator="$QUAL_USER"
# Lingering is on for the install and identity lanes so measurements are not perturbed by our own
# sessions coming and going. The persistence lane turns it off deliberately, as its negative control.
loginctl enable-linger "$QUAL_USER"
printf '   %-38s %s\n' "tailscale operator:" "$QUAL_USER"
printf '   %-38s %s\n' "linger marker:" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
REMOTE

  local self dns_name tags node_id
  self="$(remote_root <<'REMOTE'
tailscale status --json | jq -r '[(.Self.DNSName | sub("\\.$"; "")), ((.Self.Tags // []) | join(",")), .Self.ID] | @tsv'
REMOTE
)"
  dns_name="$(printf '%s' "$self" | cut -f1)"
  tags="$(printf '%s' "$self" | cut -f2)"
  node_id="$(printf '%s' "$self" | cut -f3)"
  measure "tailnet DNS name" "$dns_name"
  measure "node tags" "${tags:-<none>}"
  measure "tailscale node id" "$node_id"
  state_write dns_name "$dns_name"
  state_write ts_node_id "$node_id"
  state_write node_tags "${tags:-}"
  # A tag is required only by the identity lane, which needs an identity-less node. The host,
  # artifact, lifecycle, persistence, and uninstall lanes are unaffected by tagging, so an untagged
  # join degrades this to a warning and disables one lane rather than discarding a paid droplet.
  if [ -z "$tags" ]; then
    warn "joined as an UNTAGGED node: it carries a user identity, so the 'identity' lane cannot prove denial and will be skipped."
    warn "to run that lane, destroy and re-provision with an auth key that applies $TAILNET_TAG."
  fi
}

# The OpenRC counterpart. It joins nothing and grants nothing; it only establishes that the machine we
# just paid for is genuinely not running systemd, because every conclusion lane `init` can support
# depends on that. An imported image that turns out to ship systemd is a wasted droplet, and saying so
# here costs one round trip instead of a full lane sequence.
provision_init_facts() {
  step "Init system"
  remote_root <<'REMOTE' || die "this droplet reports systemd as its init system, so it cannot show the installer's non-systemd behaviour. Check that OMP_QUAL_IMAGE names the imported Alpine image. The droplet is still running; remove it with the destroy command below."
show() { printf '   %-38s %s\n' "$1:" "$2"; }
. /etc/os-release
show "distribution" "${PRETTY_NAME:-unknown}"
show "kernel" "$(uname -srm)"
show "pid 1" "$(tr '\0' ' ' </proc/1/cmdline | awk '{print $1}')"
show "/run/systemd/system" "$(test -d /run/systemd/system && echo present || echo absent)"
show "systemctl on PATH" "$(command -v systemctl || echo absent)"
show "rc-service on PATH" "$(command -v rc-service || echo absent)"
show "bash on PATH" "$(command -v bash || echo absent)"
# The assertion this whole path rests on. Printed above, enforced here.
test ! -d /run/systemd/system
REMOTE
  note "No tailnet was joined: Tailscale Serve only serves lanes that need a running gateway, and the"
  note "install is expected to be refused here. Lingering is a systemd concept and does not apply."
}

cmd_provision() {
  step "Preflight"
  preflight_tools
  preflight_ssh_key
  preflight_catalog
  if [ "$QUAL_INIT" = "systemd" ]; then
    [ -n "${TS_AUTHKEY:-}" ] ||
      die "TS_AUTHKEY is not set. Create a tagged, preauthorized, non-ephemeral auth key carrying $TAILNET_TAG (see docs/LINUX_QUALIFICATION.md) and export it. No droplet was created."
    case "$TS_AUTHKEY" in
      tskey-auth-*) measure "Tailscale auth key" "present, tskey-auth form, value not printed" ;;
      *) die "TS_AUTHKEY does not look like a Tailscale auth key (expected a tskey-auth- prefix). No droplet was created." ;;
    esac
  else
    # The OpenRC path needs no auth key because it joins no tailnet, so demanding one would refuse a
    # run for a credential it will never use.
    measure "init system requested" "$QUAL_INIT (no tailnet, no auth key required)"
  fi

  init_ssh_options
  LOCAL_TEMP="$(mktemp -d)"

  local created
  step "Droplet"
  if load_droplet; then
    created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
    measure "reusing existing droplet" "id $DROPLET_ID, $DROPLET_IP, created $created"
    measure "cost so far" "$(accrued_cost "$created" "$HOURLY_RATE")"
  else
    note "creating $DROPLET_NAME ($DROPLET_SIZE, $DROPLET_IMAGE, $DROPLET_REGION)"
    cloud_init_user_data >"$LOCAL_TEMP/cloud-init.yaml"
    doctl compute droplet create "$DROPLET_NAME" \
      --image "$DROPLET_IMAGE" \
      --size "$DROPLET_SIZE" \
      --region "$DROPLET_REGION" \
      --ssh-keys "$SSH_KEY_ID" \
      --tag-names "$DROPLET_NAME" \
      --user-data-file "$LOCAL_TEMP/cloud-init.yaml" \
      --wait --output json >"$LOCAL_TEMP/created.json"
    load_droplet || die "droplet creation reported success but the droplet is not listed"
    created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
    measure "created" "id $DROPLET_ID, $DROPLET_IP, created $created"
  fi
  state_write droplet_id "$DROPLET_ID"

  step "Readiness"
  wait_for "droplet status active" 30 5 droplet_is_active
  wait_for "ssh as root" 60 5 ssh_is_up
  wait_for "cloud-init finished" 60 10 cloud_init_done
  remote_root <<'REMOTE'
errors="$(jq -r '.v1.errors | length' /run/cloud-init/result.json)"
printf '   %-38s %s\n' "cloud-init errors:" "$errors"
test "$errors" = "0"
REMOTE

  if [ "$QUAL_INIT" = "systemd" ]; then
    provision_tailnet
  else
    provision_init_facts
  fi

  step "Provisioned"
  measure "hourly rate" "\$$HOURLY_RATE per hour"
  measure "next step" "$0 qualify"
}

# ---------------------------------------------------------------------------- status

cmd_status() {
  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"

  step "Droplet"
  if ! load_droplet; then
    measure "$DROPLET_NAME" "absent (nothing is billing)"
    return 0
  fi
  local created
  created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
  measure "id / ip" "$DROPLET_ID / ${DROPLET_IP:-<none>}"
  measure "status / region / size" "$(printf '%s' "$DROPLET_JSON" | jq -r '[.status, .region.slug, .size_slug] | join(" / ")')"
  measure "created" "$created"
  measure "cost so far" "$(accrued_cost "$created" "$HOURLY_RATE")"
  [ -n "$DROPLET_IP" ] || return 0

  step "Reachability"
  if ssh_is_up; then
    measure "ssh as root" "reachable"
  else
    measure "ssh as root" "unreachable"
    return 0
  fi
  remote_root QUAL_USER="$QUAL_USER" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
uid="$(id -u "$QUAL_USER")"

# Sessions belonging to the qualified user, as "class|id|type|remote". Enumerated by session id --
# the one column `loginctl list-sessions` has had in every systemd version -- and classified with
# `show-session`, because that table's column layout has changed across releases and a positional
# field is not a fact. Ownership is matched on uid or user name, whichever this systemd renders.
#
# Class is the measurement, never the count. When lingering works the count can never be zero: the
# lingering user manager is itself a session, of class `manager`, and its presence is what lingering
# succeeding looks like. Only a session of class `user` means somebody is logged in.
sessions_of_user() {
  local id owner name class type remote
  while read -r id; do
    [ -n "$id" ] || continue
    owner="$(loginctl show-session "$id" --property=User --value 2>/dev/null || true)"
    name="$(loginctl show-session "$id" --property=Name --value 2>/dev/null || true)"
    [ "$owner" = "$uid" ] || [ "$name" = "$QUAL_USER" ] || continue
    class="$(loginctl show-session "$id" --property=Class --value 2>/dev/null || true)"
    type="$(loginctl show-session "$id" --property=Type --value 2>/dev/null || true)"
    remote="$(loginctl show-session "$id" --property=Remote --value 2>/dev/null || true)"
    printf '%s|%s|%s|%s\n' "${class:-unknown}" "$id" "${type:-unknown}" "${remote:-unknown}"
  done < <(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}')
}
session_display() {
  printf '%s' "$1" | awk -F'|' 'NF { printf "%s(class=%s,type=%s,remote=%s) ", $2, $1, $3, $4 }' |
    sed 's/ *$//' | grep . || printf 'none'
}
session_class_count() {
  printf '%s\n' "$1" | awk -F'|' -v want="$2" 'NF && $1 == want { n++ } END { print n + 0 }'
}
sessions="$(sessions_of_user)"
show "kernel" "$(uname -srm)"
show "virtualisation" "$(systemd-detect-virt || true)"
show "uptime seconds" "$(awk '{printf "%d", $1}' /proc/uptime)"
show "tailscale backend" "$(tailscale status --json | jq -r '.BackendState + " online=" + ((.Self.Online // false) | tostring)')"
show "node tags" "$(tailscale status --json | jq -r '(.Self.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "user@${uid}.service" "$(systemctl is-active "user@${uid}.service" 2>/dev/null || true)"
show "sessions for qualified user" "$(session_display "$sessions")"
show "sessions of class user" "$(session_class_count "$sessions" user)"
show "sessions of class manager" "$(session_class_count "$sessions" manager)"
show "gateway pids" "$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | tr '\n' ' ' | grep . || echo none)"
show "loopback probe" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo request-failed)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
REMOTE
}

# ---------------------------------------------------------------------------- destroy

cmd_destroy() {
  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"

  local present=0 node_id created code index deleted
  if load_droplet; then present=1; fi
  node_id="$(state_read ts_node_id)"

  step "Tailnet node removal"
  # A non-ephemeral tagged node leaves a machine record behind when it logs out, and repeated runs of
  # this lane would pile up dead nodes. Logging out stops it advertising; deleting the device record
  # is what actually removes it, and that needs the Tailscale API.
  if [ "$present" -eq 1 ] && [ -n "$DROPLET_IP" ] && ssh_is_up; then
    if [ -z "$node_id" ]; then
      # A droplet provisioned with OMP_QUAL_INIT=openrc never joined a tailnet and has no `tailscale`
      # binary at all, so this substitution fails. An unguarded assignment would abort destroy under
      # `set -e` and leave the droplet billing, which is the one outcome teardown must never have.
      node_id="$(remote_root <<'REMOTE'
tailscale status --json 2>/dev/null | jq -r '.Self.ID // ""'
REMOTE
)" || node_id=""
    fi
    remote_root <<'REMOTE' || true
tailscale serve reset >/dev/null 2>&1 || true
tailscale logout || true
REMOTE
    measure "tailscale logout" "issued on the droplet"
  else
    measure "tailscale logout" "skipped (droplet absent or unreachable)"
  fi
  measure "tailscale node id" "${node_id:-<unknown>}"
  if [ -n "${TS_API_KEY:-}" ] && [ -n "$node_id" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
      -H "Authorization: Bearer ${TS_API_KEY}" \
      "https://api.tailscale.com/api/v2/device/${node_id}" 2>/dev/null || echo request-failed)"
    measure "device delete HTTP status" "$code (200 removed, 404 already gone)"
  else
    note "TS_API_KEY is not set, so the tailnet machine record stays behind."
    note "Remove '$DROPLET_NAME' in the Tailscale admin console, or export TS_API_KEY and rerun destroy."
  fi

  step "Droplet removal"
  if [ "$present" -eq 0 ]; then
    measure "$DROPLET_NAME" "already absent; nothing to delete"
  else
    created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
    measure "final cost" "$(accrued_cost "$created" "$HOURLY_RATE")"
    doctl compute droplet delete "$DROPLET_NAME" --force
    # DigitalOcean's list endpoint is eventually consistent right after a delete, so it can report
    # the droplet absent and then present again moments later. Trust the poll that observed it gone
    # rather than re-asking afterwards, which once failed a destroy that had actually succeeded.
    deleted=0
    for ((index = 1; index <= 30; index++)); do
      if ! droplet_exists_quietly; then
        deleted=1
        DESTROY_CONFIRMED=1
        break
      fi
      sleep 5
    done
    [ "$deleted" -eq 1 ] ||
      die "delete was accepted but $DROPLET_NAME is still listed after 150s; check the DigitalOcean console"
    measure "$DROPLET_NAME" "deleted and no longer listed"
  fi
  rm -f "$KNOWN_HOSTS" "$STATE_FILE"
  measure "local state" "removed $STATE_DIR entries for $DROPLET_NAME"

  report_imported_images
}

# An imported custom image is a second billable resource class, and it is the one that actually leaks:
# the droplet stops billing the moment it is deleted, whereas an image keeps costing $0.06 per GB per
# month forever. `destroy` deliberately does not delete it — an import takes several minutes and is
# reusable across runs, so deleting it would tax every subsequent run for a fraction of a cent a month
# — but silence would be how one survives for a year. Listing every user image in the account, rather
# than only the one OMP_QUAL_IMAGE happens to name, means a leak is visible even when `destroy` is run
# without the knob that created it.
report_imported_images() {
  local images count
  step "Imported images (not deleted by destroy)"
  images="$(doctl compute image list-user --output json 2>/dev/null || true)"
  count="$(printf '%s' "$images" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)"
  if [ "$count" = "0" ]; then
    measure "user images in this account" "none (nothing is accruing image storage)"
    return 0
  fi
  measure "user images in this account" "$count, listed below with monthly storage cost"
  printf '%s' "$images" | jq -r '.[] |
    "   \(.id)  \(.status)  \(.size_gigabytes // 0) GB  about $\(((.size_gigabytes // 0) * 0.06 * 100 | round) / 100)/month  \(.name)"'
  note "These are NOT deleted by destroy. Remove one with: doctl compute image delete <id> --force"
  note "Keeping the Alpine image is the cheap default; deleting it means the next OpenRC run re-imports."
}

# ---------------------------------------------------------------------------- qualification lanes

release_version() {
  if [ -n "${OMP_QUAL_VERSION:-}" ]; then
    printf '%s' "$OMP_QUAL_VERSION"
  else
    jq -r '.version' package.json
  fi
}

require_dns_name() {
  local dns_name
  dns_name="$(state_read dns_name)"
  [ -n "$dns_name" ] || die "no tailnet DNS name recorded in $STATE_FILE; run '$0 provision' first"
  printf '%s' "$dns_name"
}

lane_host() {
  step "Lane 1: real machine facts"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
. /etc/os-release
show "distribution" "$PRETTY_NAME"
show "kernel" "$(uname -srm)"
show "virtualisation" "$(systemd-detect-virt || true)"
show "systemd version" "$(systemctl --version | head -1)"
show "cpus / memory MiB" "$(nproc) / $(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
show "boot id" "$(cat /proc/sys/kernel/random/boot_id)"
show "uptime seconds" "$(awk '{printf "%d", $1}' /proc/uptime)"
show "own public ipv4" "$(curl -sS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || echo unavailable)"
show "qualified user uid / shell" "$(id -u "$QUAL_USER") / $(getent passwd "$QUAL_USER" | cut -d: -f7)"
REMOTE
  note "The virtualisation line is the honest platform word for the ledger. It will say kvm, not none."
}

lane_artifact() {
  local tag version archive sbom local_dir asset attestation_mode asset_digest
  tag="${OMP_QUAL_RELEASE_TAG:-}"
  [ -n "$tag" ] ||
    die "set OMP_QUAL_RELEASE_TAG to the signed candidate tag, for example v0.1.0-prealpha.14"
  version="$(release_version)"
  archive="omp-session-gateway-${version}-bun.tar"
  sbom="omp-session-gateway-${version}.spdx.json"
  local_dir="$STATE_DIR/release/$tag"

  step "Lane 2: signed candidate artifact"
  need_command gh
  mkdir -p "$local_dir"
  if [ -f "$local_dir/$archive" ]; then
    measure "assets" "already downloaded to $local_dir"
  else
    gh release download "$tag" --repo "$REPO_SLUG" --dir "$local_dir"
    measure "downloaded" "$tag assets into $local_dir"
  fi
  for asset in "$archive" "$sbom" SHA256SUMS "$archive.sigstore.json" "$sbom.sigstore.json" SHA256SUMS.sigstore.json; do
    [ -f "$local_dir/$asset" ] || die "release $tag is missing asset $asset"
  done
  measure "archive sha256 (workstation)" "$(sha256_of "$local_dir/$archive")"

  # `gh attestation verify` needs GitHub API access. If the droplet has no token, fetch the bundles
  # here with the already-authenticated CLI and verify them offline on the droplet instead.
  attestation_mode="online"
  if [ -z "${GH_TOKEN:-}" ]; then
    attestation_mode="offline"
    for asset in "$archive" "$sbom" SHA256SUMS; do
      if [ ! -f "$local_dir/$asset.attestation.jsonl" ]; then
        # `gh attestation download` has no --output-file; it writes sha256:<digest>.jsonl into the
        # working directory, so run it there and rename to the name the droplet expects.
        asset_digest="$(sha256_of "$local_dir/$asset")"
        ( cd "$local_dir" && gh attestation download "$asset" --repo "$REPO_SLUG" >/dev/null )
        [ -f "$local_dir/sha256:$asset_digest.jsonl" ] ||
          die "gh attestation download did not produce sha256:$asset_digest.jsonl for $asset"
        mv "$local_dir/sha256:$asset_digest.jsonl" "$local_dir/$asset.attestation.jsonl"
      fi
    done
  fi
  measure "attestation verification mode" "$attestation_mode"

  note "uploading assets to the droplet"
  remote_user <<'REMOTE'
rm -rf ~/candidate && mkdir -p ~/candidate
REMOTE
  scp "${SSH_OPTS[@]}" -q "$local_dir"/* "${QUAL_USER}@${DROPLET_IP}:candidate/"

  remote_user \
    ARCHIVE="$archive" SBOM="$sbom" TAG="$tag" REPO_SLUG="$REPO_SLUG" \
    GH_CLI_VERSION="$GH_CLI_VERSION" COSIGN_VERSION="$COSIGN_VERSION" BUN_VERSION="$BUN_VERSION" \
    ATTESTATION_MODE="$attestation_mode" SUPPLIED_GH_TOKEN="${GH_TOKEN:-}" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
cd ~/candidate
mkdir -p ~/tools

if [ ! -x ~/tools/cosign ]; then
  curl -fsSL -o ~/tools/cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64"
  chmod 0755 ~/tools/cosign
fi
if [ ! -x ~/tools/gh ]; then
  curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz"
  tar -xzf /tmp/gh.tar.gz -C /tmp
  install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" ~/tools/gh
  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64"
fi
show "cosign binary sha256" "$(sha256sum ~/tools/cosign | awk '{print $1}')"
show "gh binary sha256" "$(sha256sum ~/tools/gh | awk '{print $1}')"

show "sha256sum --check" "$(sha256sum --check SHA256SUMS | tr '\n' ' ')"
show "archive digest on droplet" "$(sha256sum "$ARCHIVE" | awk '{print $1}')"

identity="https://github.com/${REPO_SLUG}/.github/workflows/release.yml@refs/tags/${TAG}"
show "expected certificate identity" "$identity"
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS; do
  ~/tools/cosign verify-blob \
    --bundle "${artifact}.sigstore.json" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "$artifact" >/dev/null 2>&1
  show "cosign verify-blob" "$artifact verified"
done

for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS; do
  if [ "$ATTESTATION_MODE" = "online" ]; then
    GH_TOKEN="$SUPPLIED_GH_TOKEN" ~/tools/gh attestation verify "$artifact" --repo "$REPO_SLUG" \
      --signer-workflow "${REPO_SLUG}/.github/workflows/release.yml" \
      --source-ref "refs/tags/${TAG}" >/dev/null
  else
    ~/tools/gh attestation verify "$artifact" --repo "$REPO_SLUG" \
      --bundle "${artifact}.attestation.jsonl" \
      --signer-workflow "${REPO_SLUG}/.github/workflows/release.yml" \
      --source-ref "refs/tags/${TAG}" >/dev/null
  fi
  show "gh attestation verify" "$artifact verified ($ATTESTATION_MODE)"
done

rm -rf ~/runtime && mkdir -p ~/runtime
tar -xf "$ARCHIVE" -C ~/runtime
root="$(find ~/runtime -maxdepth 1 -mindepth 1 -type d | head -1)"
printf '%s\n' "$root" >~/runtime-root
show "extracted root" "$(basename "$root")"
show "bundled upstream pin" "$(jq -r '.tag + " " + .commit' "$root/UPSTREAM.lock.json")"
show "release-info source commit" "$(jq -r '.sourceCommit' "$root/release-info.json")"
show "release-info version / runtime" "$(jq -r '.version + " / " + .runtime' "$root/release-info.json")"
show "cli mode" "$(stat -c '%a %n' "$root/apps/gateway/src/cli.js")"

if [ ! -x ~/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >/dev/null 2>&1
fi
show "bun version" "$(~/.bun/bin/bun --version)"
REMOTE
}

lane_lifecycle() {
  local dns_name
  dns_name="$(require_dns_name)"

  step "Lane 3: install / status / doctor / rotate, from the artifact"
  remote_user DNS_NAME="$dns_name" GATEWAY_PORT="$GATEWAY_PORT" \
    ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"

# install derives runtimeDir from XDG_RUNTIME_DIR, and so does the daemon systemd starts. If this
# session lacks it, the two disagree and the registry socket lands where the service cannot use it.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "XDG_RUNTIME_DIR is unset in this session, so systemd --user paths would be inconsistent" >&2
  exit 1
fi
show "XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR"

# The Serve mapping must exist before doctor, which checks the exact external host and port against
# the configured public origin.
tailscale serve --bg --https=443 "http://127.0.0.1:${GATEWAY_PORT}" >/dev/null
show "serve mapping" "$(tailscale serve status --json | jq -c '(.TCP // {}) | keys')"

# The allowlist starts as a synthetic address on purpose: this node is tagged, so it presents no user
# identity at all, and lane 4 needs a known-not-allowlisted starting state.
"$bun" "$cli" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
show "install" "completed with origin https://${DNS_NAME}"
show "status" "$("$bun" "$cli" status || true)"

show "unit path / mode" "$(stat -c '%n %a' "$HOME/.config/systemd/user/omp-session-gateway.service")"
show "unit ExecStart" "$(systemctl --user show -p ExecStart --value omp-session-gateway.service |
  sed 's/--readiness-instance [A-Za-z0-9_-]*/--readiness-instance <redacted>/' | tr -s ' ')"
show "unit WantedBy / Restart" "$(systemctl --user show -p WantedBy -p Restart --value omp-session-gateway.service | tr '\n' ' ')"
show "config mode / dir mode" "$(stat -c '%a' "$HOME/.config/omp-session-gateway/config.json") / $(stat -c '%a' "$HOME/.config/omp-session-gateway")"
show "token mode / bytes" "$(stat -c '%a / %s' "$HOME/.config/omp-session-gateway/publisher-token")"
show "socket mode / path" "$(stat -c '%a %n' "$XDG_RUNTIME_DIR/omp-session-gateway/registry.sock")"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ')"
show "main pid" "$(systemctl --user show -p MainPID --value omp-session-gateway.service)"

report="$("$bun" "$cli" doctor || true)"
show "doctor true / total" "$(printf '%s' "$report" |
  jq -r '([.checks[]] | length) as $t | ([.checks[] | select(.)] | length) as $ok | "\($ok) / \($t)"')"
show "doctor false checks" "$(printf '%s' "$report" |
  jq -r '[.checks | to_entries[] | select(.value == false) | .key] | join(",") | if . == "" then "<none>" else . end')"

before="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
"$bun" "$cli" rotate-publisher-token >/dev/null
after="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
show "token rotation pid" "$before -> $after"
show "status after rotation" "$("$bun" "$cli" status || true)"

bundle="$HOME/diagnostics-$(date -u +%s).tar"
"$bun" "$cli" doctor --bundle --output "$bundle" >/dev/null 2>&1 || true
if [ -f "$bundle" ]; then
  token="$(cat "$HOME/.config/omp-session-gateway/publisher-token")"
  if grep -a -q -F "$token" "$bundle"; then
    echo "the diagnostics bundle contains the publisher token" >&2
    exit 1
  fi
  show "diagnostics bundle bytes" "$(stat -c '%s' "$bundle")"
  show "token bytes in bundle" "0 (checked with a literal match)"
  show "home path hits in bundle" "$(grep -a -c -F "$HOME" "$bundle" || true)"
  rm -f "$bundle"
fi
REMOTE
}

# Exact patched-OMP qualification on the same Debian host as the signed gateway. This lane is
# intentionally after `artifact lifecycle`: it consumes the verified archive's patch and live
# authenticated registry, then removes every OMP-specific process and file before later lanes run.
# Collaboration output is discarded rather than logged because a live OMP UI may render a bearer
# link. Launch bodies flow directly to jq and are never written to disk.
lane_omp() (
  set -euo pipefail
  local dns_name omp_input omp_ssh_pid=""
  dns_name="$(require_dns_name)"
  step "Lane 4: exact patched OMP build, publication, launch, and revocation"

  remote_user \
    BUN_VERSION="$BUN_VERSION" OMP_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
    OMP_PATCHED_TREE="$OMP_PATCHED_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
omp_root="$HOME/omp-gateway-source"
native_fixture="$HOME/omp-native-fixture"
tree_short="${OMP_PATCHED_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"

rm -rf "$omp_root" "$native_fixture" "$version_dir"
rm -f "$HOME/.local/bin/omp-gateway-patched"
git clone --filter=blob:none https://github.com/can1357/oh-my-pi.git "$omp_root"
git -C "$omp_root" checkout --detach "$OMP_SOURCE_COMMIT"
test "$(git -C "$omp_root" rev-parse HEAD)" = "$OMP_SOURCE_COMMIT"
git -C "$omp_root" -c user.name=omp-session-gateway -c user.email=qual@example.invalid \
  am "$root/patches/oh-my-pi/0001-collab-controller-autostart-registry.patch"
test "$(git -C "$omp_root" rev-parse 'HEAD^{tree}')" = "$OMP_PATCHED_TREE"
show "source commit / patched tree" "${OMP_SOURCE_COMMIT:0:12} / ${OMP_PATCHED_TREE:0:12}"

cd "$omp_root"
test "$(~/.bun/bin/bun --version)" = "$BUN_VERSION"
~/.bun/bin/bun install --frozen-lockfile
mkdir -p "$native_fixture"
printf '%s\n' "{\"private\":true,\"dependencies\":{\"@oh-my-pi/pi-natives\":\"${OMP_VERSION}\"}}" \
  >"$native_fixture/package.json"
(cd "$native_fixture" && ~/.bun/bin/bun install)
native_file=pi_natives.linux-x64-baseline.node
cp "$native_fixture/node_modules/@oh-my-pi/pi-natives-linux-x64/$native_file" \
  "packages/natives/native/$native_file"

# Bound independently from the 50-minute workflow deadline so a stalled upstream suite leaves
# enough time for the always-run droplet teardown.
timeout 1500 ~/.bun/bin/bun run ci:check:full
~/.bun/bin/bun --cwd=packages/coding-agent run build
test "$(packages/coding-agent/dist/omp --version)" = "omp/${OMP_VERSION}"

mkdir -p "$version_dir" "$HOME/.local/bin"
install -m 0755 packages/coding-agent/dist/omp "$version_dir/omp"
ln -sfn "$version_dir/omp" "$HOME/.local/bin/omp-gateway-patched"
test "$(readlink "$HOME/.local/bin/omp-gateway-patched")" = "$version_dir/omp"
"$HOME/.local/bin/omp-gateway-patched" config set collab.autoStart control >/dev/null
"$HOME/.local/bin/omp-gateway-patched" config set collab.registryEndpoint auto >/dev/null
"$HOME/.local/bin/omp-gateway-patched" config get collab.autoStart --json |
  jq -e '.value == "control"' >/dev/null
"$HOME/.local/bin/omp-gateway-patched" config get collab.registryEndpoint --json |
  jq -e '.value == "auto"' >/dev/null
show "binary version" "$("$HOME/.local/bin/omp-gateway-patched" --version)"
show "binary sha256" "$(sha256sum "$version_dir/omp" | awk '{print $1}')"
show "versioned symlink" "$(readlink "$HOME/.local/bin/omp-gateway-patched")"
show "collab config" "autoStart=control registryEndpoint=auto"
mkdir -p "$HOME/omp-linux-qualification"
rm -rf "$native_fixture"
REMOTE

  cleanup_omp_lane() (
    set +e
    if [ -n "$omp_ssh_pid" ] && kill -0 "$omp_ssh_pid" >/dev/null 2>&1; then
      kill -TERM "$omp_ssh_pid" >/dev/null 2>&1 || true
      wait "$omp_ssh_pid" >/dev/null 2>&1 || true
    fi
    exec 9>&- 2>/dev/null || true
    remote_user OMP_PATCHED_TREE="$OMP_PATCHED_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE' >/dev/null 2>&1
set +e
tree_short="${OMP_PATCHED_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"
for exe in /proc/[0-9]*/exe; do
  [ "$(readlink "$exe" 2>/dev/null)" = "$version_dir/omp" ] || continue
  pid="${exe#/proc/}"
  kill -TERM "${pid%/exe}" 2>/dev/null || true
done
sleep 1
rm -rf "$HOME/omp-gateway-source" "$HOME/omp-native-fixture" \
  "$HOME/omp-linux-qualification" "$version_dir" "$HOME/.omp"
rm -f "$HOME/.local/bin/omp-gateway-patched"
REMOTE
  )
  trap cleanup_omp_lane EXIT

  # Keep an input descriptor open without sending bytes. SSH supplies the real PTY OMP requires;
  # its entire output goes to /dev/null so a collaboration capability cannot enter logs or files.
  omp_input="$LOCAL_TEMP/omp-linux-input"
  mkfifo "$omp_input"
  exec 9<>"$omp_input"
  ssh "${SSH_OPTS[@]}" -tt "${QUAL_USER}@${DROPLET_IP}" \
    'cd "$HOME/omp-linux-qualification" && exec "$HOME/.local/bin/omp-gateway-patched" --model openai-codex/gpt-5.4-mini --api-key qualification-synthetic-never-sent --no-extensions --no-skills --thinking low' \
    <&9 >/dev/null 2>&1 &
  omp_ssh_pid=$!

  # shellcheck disable=SC2329
  omp_session_present() {
    kill -0 "$omp_ssh_pid" >/dev/null 2>&1 || return 1
    remote_user ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" |
  jq -e '
    [.sessions[] | select(.cwdLabel == "omp-linux-qualification")] as $matched
    | ($matched | length) == 1
      and $matched[0].canView
      and $matched[0].canControl
      and ($matched[0].generation == 1)
  ' >/dev/null
REMOTE
  }
  wait_for "patched OMP publication" 90 1 omp_session_present

  remote_user DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" \
    GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
sessions="$(curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions")"
record="$(printf '%s' "$sessions" |
  jq -c '[.sessions[] | select(.cwdLabel == "omp-linux-qualification")] | if length == 1 then .[0] else error("expected exactly one patched OMP session") end')"
instance_id="$(printf '%s' "$record" | jq -r '.instanceId')"
generation="$(printf '%s' "$record" | jq -r '.generation')"
test "$(printf '%s' "$record" | jq -r '.canView and .canControl')" = true
show "published metadata" "one generation-${generation} session with View and Control"

for mode in view control; do
  headers="$(mktemp)"
  payload="$(jq -nc --argjson generation "$generation" --arg mode "$mode" \
    '{generation: $generation, mode: $mode}')"
  curl -fsS -D "$headers" \
    -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
    -H "Origin: https://${DNS_NAME}" \
    -H "Sec-Fetch-Site: same-origin" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions/${instance_id}/launch" |
    jq -e --arg mode "$mode" \
      'keys == ["capability","generation","mode"] and .mode == $mode and (.capability | type) == "string" and (.capability | length) > 0' \
      >/dev/null
  grep -qi '^cache-control:.*no-store' "$headers"
  rm -f "$headers"
  show "$mode launch" "200-shaped response, no-store, capability retained in pipe memory only"
done
REMOTE

  # Closing the SSH PTY terminates the interactive process. The registry must revoke before any
  # OMP files are removed, proving process lifecycle rather than TTL cleanup.
  kill -TERM "$omp_ssh_pid"
  wait "$omp_ssh_pid" >/dev/null 2>&1 || true
  omp_ssh_pid=""
  exec 9>&-

  # shellcheck disable=SC2329
  omp_session_absent() {
    remote_user ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" |
  jq -e '[.sessions[] | select(.cwdLabel == "omp-linux-qualification")] | length == 0' >/dev/null
REMOTE
  }
  wait_for "patched OMP revocation" 45 1 omp_session_absent

  cleanup_omp_lane
  trap - EXIT
  remote_user OMP_PATCHED_TREE="$OMP_PATCHED_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE'
tree_short="${OMP_PATCHED_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"
test ! -e "$HOME/.local/bin/omp-gateway-patched"
test ! -e "$version_dir"
test ! -e "$HOME/omp-gateway-source"
printf '   %-38s %s\n' "OMP qualification cleanup:" "source, binary, symlink, config, and process removed"
REMOTE
)

lane_identity() {
  # An untagged node presents a real user identity, so it cannot demonstrate denial. Skip rather
  # than fail: the other lanes are still valid on this droplet, and the denial half was measured
  # separately by varying the allowlist against a real Serve-injected identity.
  if [ -z "$(state_read node_tags 2>/dev/null || true)" ]; then
    step "Identity (skipped)"
    note "this droplet joined untagged, so it carries a user identity and cannot prove denial."
    note "re-provision with an auth key applying $TAILNET_TAG to run this lane."
    return 0
  fi
  local dns_name tailscale_ip workstation_login public_ip
  dns_name="$(require_dns_name)"
  public_ip="$DROPLET_IP"
  tailscale_ip="$(remote_root <<'REMOTE'
tailscale ip -4
REMOTE
)"
  workstation_login="${OMP_QUAL_ALLOWED_LOGIN:-}"
  if [ -z "$workstation_login" ] && command -v tailscale >/dev/null 2>&1; then
    workstation_login="$(tailscale status --json 2>/dev/null |
      jq -r '.User[(.Self.UserID | tostring)].LoginName // ""' 2>/dev/null || true)"
  fi

  step "Lane 4a: identity from the tagged droplet itself"
  remote_user DNS_NAME="$dns_name" TS_IP="$tailscale_ip" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo request-failed; }

show "configured allowlist size" "$(jq -r '.auth.allowedLogins | length' "$HOME/.config/omp-session-gateway/config.json")"
show "configured auth mode" "$(jq -r '.auth.mode' "$HOME/.config/omp-session-gateway/config.json")"
show "self tags" "$(tailscale status --json | jq -r '(.Self.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "whois self login" "$(tailscale whois --json "$TS_IP" 2>/dev/null | jq -r '.UserProfile.LoginName // "<no user profile>"')"
show "whois self tags" "$(tailscale whois --json "$TS_IP" 2>/dev/null | jq -r '(.Node.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "funnel status" "$(tailscale funnel status 2>&1 | head -1)"

show "tagged self -> Serve /api/v1/sessions" "$(probe "https://${DNS_NAME}/api/v1/sessions")"
show "tagged self -> Serve /" "$(probe "https://${DNS_NAME}/")"
show "tailscale-user headers reaching us" "$(curl -sS --max-time 15 -D - -o /dev/null "https://${DNS_NAME}/api/v1/sessions" 2>/dev/null | grep -ci 'tailscale-user' || true)"
# Deliberately kept, and deliberately not trusted. In userspace-networking mode the host has no
# route to its own tailnet address either, so this probe fails on an exposed host exactly as it does
# on a safe one. Only the workstation probe in lane 4b can tell them apart. See #98.
show "backend via tailnet ip, from self" "$(probe "http://${TS_IP}:${GATEWAY_PORT}/api/v1/sessions")"
show "tailnet address on an interface" "$(ip -o addr show 2>/dev/null | awk '$4 ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./ || $4 ~ /^fd7a:115c:a1e0:/ { found = 1 } END { print (found ? "yes (TUN mode)" : "NO (userspace mode: identity trust is unsound)") }')"
show "loopback, no identity supplied" "$(probe "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions")"
show "listener addresses" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ')"
REMOTE
  note "403 for the tagged self probe is the denial observable: Serve adds no user identity for a"
  note "tagged source, so the gateway fails closed. The whois lines above are why."

  step "Lane 4b: identity from this workstation, a distinct user-owned node"
  measure "droplet public ip:port" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${public_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-failed)"
  # The probe that would have caught #98, and the only one that can. A bind-address check cannot see
  # the failure, and neither can the droplet probing itself: userspace-mode tailscaled forwards
  # inbound tailnet connections to localhost, so the backend port is reachable from any tailnet peer
  # while every local observation still looks correct. Expect connection-refused on a TUN-mode host;
  # any HTTP status here means the backend is exposed to the tailnet.
  measure "droplet tailnet ip:port, no header" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${tailscale_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-refused)"
  measure "droplet tailnet ip:port, forged hdr" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "http://${tailscale_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-refused)"
  measure "workstation tailnet login" "${workstation_login:-<unavailable>}"
  if [ -z "$workstation_login" ]; then
    note "No user-owned tailnet login is available here, so the allowed half is NOT exercised."
    note "Set OMP_QUAL_ALLOWED_LOGIN to a user-owned tailnet login and rerun: $0 qualify identity"
    return 0
  fi
  measure "not-allowlisted, real identity" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "forged header, not allowlisted" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"

  note "reinstalling with this workstation's login on the allowlist"
  remote_user DNS_NAME="$dns_name" ALLOWED_LOGIN="$workstation_login" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
before="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
~/.bun/bin/bun "$root/apps/gateway/src/cli.js" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
after="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
show "active reinstall pid" "$before -> $after"
show "configured allowlist size" "$(jq -r '.auth.allowedLogins | length' "$HOME/.config/omp-session-gateway/config.json")"
REMOTE
  measure "allowlisted, real identity" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "cache-control on that response" "$(curl -sS -D - -o /dev/null --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null |
    awk 'tolower($1) == "cache-control:" { sub(/^[^ ]+ /, ""); print }' | tr -d '\r' || true)"
  measure "body keys of that response" "$(curl -sS --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null | jq -rc 'keys' || echo unavailable)"
  measure "forged header, real login allowed" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  note "The forged-header pair is the point: the same supplied value is denied when the caller's real"
  note "identity is not allowlisted and ignored when it is, so Serve owns the header, not the caller."
}

# Reboots and returns only once the machine answers SSH with a *different* boot id, so a pre-reboot
# host can never be mistaken for the rebooted one.
reboot_and_wait() {
  local before after index
  before="$(remote_root <<'REMOTE'
cat /proc/sys/kernel/random/boot_id
REMOTE
)"
  measure "boot id before reboot" "$before"
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" \
    "nohup sh -c 'sleep 1; systemctl reboot' >/dev/null 2>&1 & exit 0" || true
  sleep 10
  for ((index = 1; index <= 60; index++)); do
    after="$(ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" "cat /proc/sys/kernel/random/boot_id" 2>/dev/null || true)"
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      measure "boot id after reboot" "$after (attempt $index)"
      return 0
    fi
    sleep 5
  done
  die "the droplet did not come back with a new boot id within 310s"
}

# Everything here runs as root, never as the qualified user, so measuring cannot create the very login
# session whose absence is the whole point.
#
# $3 is what lingering is expected to be doing: `off` for the negative control, `on` for the
# persistence claim. It decides the assertions, because the two passes require opposite outcomes from
# the same measurements and a function that only printed them left the reader to adjudicate.
measure_after_reboot() {
  note "$1, measured from root only, with no login session for $QUAL_USER"
  remote_root QUAL_USER="$QUAL_USER" TARGET_UID="$2" EXPECT_LINGER="$3" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
uid="$TARGET_UID"

# Sessions belonging to the qualified user, as "class|id|type|remote". Enumerated by session id --
# the one column `loginctl list-sessions` has had in every systemd version -- and classified with
# `show-session`, because that table's column layout has changed across releases and a positional
# field is not a fact. Ownership is matched on uid or user name, whichever this systemd renders.
#
# Class is the measurement, never the count. When lingering works the count can never be zero: the
# lingering user manager is itself a session, of class `manager`, and its presence is what lingering
# succeeding looks like. Only a session of class `user` means somebody is logged in.
sessions_of_user() {
  local id owner name class type remote
  while read -r id; do
    [ -n "$id" ] || continue
    owner="$(loginctl show-session "$id" --property=User --value 2>/dev/null || true)"
    name="$(loginctl show-session "$id" --property=Name --value 2>/dev/null || true)"
    [ "$owner" = "$uid" ] || [ "$name" = "$QUAL_USER" ] || continue
    class="$(loginctl show-session "$id" --property=Class --value 2>/dev/null || true)"
    type="$(loginctl show-session "$id" --property=Type --value 2>/dev/null || true)"
    remote="$(loginctl show-session "$id" --property=Remote --value 2>/dev/null || true)"
    printf '%s|%s|%s|%s\n' "${class:-unknown}" "$id" "${type:-unknown}" "${remote:-unknown}"
  done < <(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}')
}
session_display() {
  printf '%s' "$1" | awk -F'|' 'NF { printf "%s(class=%s,type=%s,remote=%s) ", $2, $1, $3, $4 }' |
    sed 's/ *$//' | grep . || printf 'none'
}
session_class_count() {
  printf '%s\n' "$1" | awk -F'|' -v want="$2" 'NF && $1 == want { n++ } END { print n + 0 }'
}
sessions="$(sessions_of_user)"
session_total="$(printf '%s' "$sessions" | grep -c . || true)"

show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "sessions for qualified user" "$(session_display "$sessions")"
show "sessions of class user / manager" "$(session_class_count "$sessions" user) / $(session_class_count "$sessions" manager)"
show "user@${TARGET_UID}.service" "$(systemctl is-active "user@${TARGET_UID}.service" 2>/dev/null || true)"
pid="$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | head -1 || true)"
show "gateway pid" "${pid:-none}"
if [ -n "$pid" ]; then
  show "daemon age vs system uptime" "process $(ps -o etimes= -p "$pid" | tr -d ' ')s old, system up $(awk '{printf "%d", $1}' /proc/uptime)s"
fi
show "loopback probe (403 = up, closed)" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo request-failed)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
if [ "$EXPECT_LINGER" = off ]; then
  # Lingering disabled: nothing may have started the user manager, so the user owns no session of any
  # class and no daemon exists. This is the control that gives the other pass its meaning.
  check "no session of any class for the user" "$session_total" 0
  check "no gateway daemon" "$(if [ -n "$pid" ]; then printf '%s' "$pid"; else printf 'none'; fi)" none
else
  # Lingering enabled: nobody is logged in, so no session of class `user` may exist. A `manager`
  # session must exist, because that session *is* lingering having taken effect; its absence would
  # mean the daemon came back for some other reason and the pass would prove nothing.
  check "no session of class user" "$(session_class_count "$sessions" user)" 0
  check "manager session present (lingering)" "$(if [ "$(session_class_count "$sessions" manager)" -ge 1 ]; then printf 'present'; else printf 'absent'; fi)" present
  check "gateway daemon present" "$(if [ -n "$pid" ]; then printf 'present'; else printf 'absent'; fi)" present
fi
[ "$fail" -eq 0 ] || { echo "reboot persistence invariants failed with lingering $EXPECT_LINGER" >&2; exit 1; }
REMOTE
}

lane_persistence() {
  local uid
  step "Lane 5: reboot and login persistence"
  uid="$(remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
id -u "$QUAL_USER"
REMOTE
)"
  measure "qualified user uid" "$uid"

  note "pass A, the negative control: lingering disabled"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
loginctl disable-linger "$QUAL_USER"
printf '   %-38s %s\n' "linger marker:" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
REMOTE
  reboot_and_wait
  measure_after_reboot "pass A (lingering off)" "$uid" off

  note "pass A follow-up: a login session should pull the unit in through default.target"
  remote_user <<'REMOTE'
root="$(cat ~/runtime-root)"
printf '   %-38s %s\n' "status inside a login session:" "$(~/.bun/bin/bun "$root/apps/gateway/src/cli.js" status || true)"
REMOTE
  remote_root QUAL_USER="$QUAL_USER" TARGET_UID="$uid" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
show "user@${TARGET_UID}.service after login" "$(systemctl is-active "user@${TARGET_UID}.service" 2>/dev/null || true)"
pid="$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | head -1 || true)"
if [ -n "$pid" ]; then
  show "daemon age vs system uptime" "process $(ps -o etimes= -p "$pid" | tr -d ' ')s old, system up $(awk '{printf "%d", $1}' /proc/uptime)s"
else
  show "daemon age vs system uptime" "no daemon process"
fi
REMOTE
  note "A daemon far younger than uptime here means the login started it, not the boot."

  note "pass B: lingering enabled"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
loginctl enable-linger "$QUAL_USER"
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "loginctl Linger property" "$(loginctl show-user "$QUAL_USER" --property=Linger --value 2>/dev/null || echo unavailable)"
REMOTE
  reboot_and_wait
  measure_after_reboot "pass B (lingering on)" "$uid" on
  note "Pass B proves persistence because no session of class 'user' exists: the only session the"
  note "qualified user owns is the 'manager' session that lingering itself creates, which is why the"
  note "count is one rather than zero. Nobody is logged in, and the daemon's age tracks system uptime"
  note "rather than the age of our connection."
}

# Explicit forward upgrade and rollback on a real systemd user manager. `qualify-rollback.sh` proves
# this on macOS, but it cannot exercise a user unit, an `enable` state, or a service manager that
# owns the runtime directory, and #69 showed those are exactly where Linux differs. Staged here
# rather than by generalising `lane_artifact`, so the existing lanes keep their behaviour byte for
# byte; this lane only adds a second extracted root beside the primary one and reuses the tools
# `lane_artifact` has already placed on the droplet.
lane_migration() {
  local previous_tag successor_tag version archive sbom local_dir dns_name
  successor_tag="${OMP_QUAL_RELEASE_TAG:-}"
  previous_tag="${OMP_QUAL_PREVIOUS_TAG:-v0.1.0-alpha.1}"
  [ -n "$successor_tag" ] || die "set OMP_QUAL_RELEASE_TAG to the successor candidate tag"

  step "Lane 4: explicit upgrade and rollback"
  if [ "$previous_tag" = "$successor_tag" ]; then
    note "predecessor and successor tags are both $successor_tag, so there is nothing to migrate."
    note "set OMP_QUAL_PREVIOUS_TAG to an earlier signed tag to run this lane."
    return 0
  fi

  version="$(release_version)"
  archive="omp-session-gateway-${version}-bun.tar"
  sbom="omp-session-gateway-${version}.spdx.json"
  local_dir="$STATE_DIR/release/$previous_tag"
  dns_name="$(require_dns_name)"
  measure "predecessor / successor" "$previous_tag -> $successor_tag"

  mkdir -p "$local_dir"
  if [ -f "$local_dir/$archive" ]; then
    measure "predecessor assets" "already downloaded to $local_dir"
  else
    gh release download "$previous_tag" --repo "$REPO_SLUG" --dir "$local_dir"
    measure "predecessor downloaded" "$previous_tag assets into $local_dir"
  fi
  for asset in "$archive" SHA256SUMS "$archive.sigstore.json" SHA256SUMS.sigstore.json; do
    [ -f "$local_dir/$asset" ] || die "release $previous_tag is missing asset $asset"
  done
  measure "predecessor archive sha256" "$(sha256_of "$local_dir/$archive")"

  note "uploading the predecessor to the droplet"
  remote_user <<'REMOTE'
rm -rf ~/candidate-prev && mkdir -p ~/candidate-prev
REMOTE
  scp "${SSH_OPTS[@]}" -q "$local_dir"/* "${QUAL_USER}@${DROPLET_IP}:candidate-prev/"

  remote_user \
    ARCHIVE="$archive" SBOM="$sbom" PREV_TAG="$previous_tag" REPO_SLUG="$REPO_SLUG" \
    DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
bun=~/.bun/bin/bun

# Verify the predecessor on the droplet with the tools lane_artifact already installed, so a bad
# download cannot be installed even though this lane staged it separately.
cd ~/candidate-prev
sha256sum --check SHA256SUMS >/dev/null
identity="https://github.com/${REPO_SLUG}/.github/workflows/release.yml@refs/tags/${PREV_TAG}"
~/tools/cosign verify-blob --bundle "${ARCHIVE}.sigstore.json" --certificate-identity "$identity" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "$ARCHIVE" >/dev/null 2>&1
show "predecessor verified" "checksum and signature for $PREV_TAG"

rm -rf ~/runtime-prev && mkdir -p ~/runtime-prev
tar -xf "$ARCHIVE" -C ~/runtime-prev
prev_root="$(find ~/runtime-prev -maxdepth 1 -mindepth 1 -type d | head -1)"
next_root="$(cat ~/runtime-root)"
show "predecessor root" "$(basename "$prev_root")"
show "successor root" "$(basename "$next_root")"

state_dir="$HOME/.local/state/omp-session-gateway"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"

# One line per step so the comparison below is textual and auditable rather than remembered.
snapshot() {
  local active_version versions config_digest token_digest token_mode exec_path enabled main_pid listener
  active_version="$(jq -r '.versionDirectory' "$state_dir/installation/current.json")"
  versions="$(find "$state_dir/installation/versions" -maxdepth 1 -mindepth 1 -type d -printf '%f ' | tr ' ' '\n' | sort | tr '\n' ' ')"
  config_digest="$(sha256sum "$HOME/.config/omp-session-gateway/config.json" | awk '{print $1}')"
  token_digest="$(sha256sum "$HOME/.config/omp-session-gateway/publisher-token" | awk '{print $1}')"
  token_mode="$(stat -c '%a' "$HOME/.config/omp-session-gateway/publisher-token")"
  exec_path="$(systemctl --user show -p ExecStart --value omp-session-gateway.service | grep -o '/[^ ]*cli\.js' | head -1)"
  enabled="$(systemctl --user is-enabled omp-session-gateway.service 2>&1 || true)"
  main_pid="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
  listener="$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$active_version" "$versions" "$config_digest" "$token_digest" "$token_mode" \
    "$exec_path" "$enabled" "$main_pid" "$listener"
}

install_root() {
  "$bun" "$1/apps/gateway/src/cli.js" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
}

install_root "$prev_root"; a="$(snapshot)"; show "after install predecessor" "$a"
install_root "$next_root"; b="$(snapshot)"; show "after upgrade to successor" "$b"
install_root "$prev_root"; c="$(snapshot)"; show "after rollback to predecessor" "$c"

field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
check "predecessor install names a version" "$([ -n "$(field "$a" 1)" ] && echo named || echo empty)" named
check "active version changes on upgrade" "$([ "$(field "$a" 1)" != "$(field "$b" 1)" ] && echo changed || echo same)" changed
check "active version restored on rollback" "$(field "$c" 1)" "$(field "$a" 1)"
check "predecessor version dir survives upgrade" "$(printf '%s' "$(field "$b" 2)" | grep -qF "$(field "$a" 1)" && echo present || echo missing)" present
check "config identical across all steps" "$([ "$(field "$a" 3)" = "$(field "$b" 3)" ] && [ "$(field "$b" 3)" = "$(field "$c" 3)" ] && echo identical || echo differs)" identical
check "token digest unchanged" "$([ "$(field "$a" 4)" = "$(field "$b" 4)" ] && [ "$(field "$b" 4)" = "$(field "$c" 4)" ] && echo unchanged || echo changed)" unchanged
check "token mode unchanged" "$([ "$(field "$a" 5)" = "$(field "$c" 5)" ] && echo "$(field "$a" 5)" || echo drifted)" 600
check "ExecStart tracks active version" "$(printf '%s' "$(field "$c" 6)" | grep -qF "$(field "$c" 1)" && echo tracks || echo stale)" tracks
check "unit still enabled after rollback" "$(field "$c" 7)" enabled
check "main pid changed across upgrade" "$([ "$(field "$a" 8)" != "$(field "$b" 8)" ] && echo changed || echo same)" changed
check "listener loopback only after rollback" "$(printf '%s' "$(field "$c" 9)" | grep -qE '^127\.0\.0\.1:' && echo loopback || echo "$(field "$c" 9)")" loopback

[ "$fail" -eq 0 ] || { echo "migration invariants failed" >&2; exit 1; }
REMOTE
}

# Lane `rollback`: the `omp-gateway rollback` command itself, on a real systemd user manager.
#
# WHY THIS IS NOT LANE 4 AGAIN. Lane 4 walks predecessor -> successor -> predecessor and every one of
# its three steps is an `install` of an archive root. That is rollback-by-reinstall. PR #78 added a
# second and different code path: `omp-gateway rollback` resolves a target from
# `installation/history.json`, refuses rather than guessing when the history cannot name one,
# rewrites the service definition from that target, and rebuilds the definition from `current.json`
# when its own activation fails. An install exercises none of that, and `scripts/qualify-rollback.sh`
# cannot either: the command postdates that harness, and it installs with `--no-start` throughout so
# nothing there is ever activated at all.
#
# This lane therefore asserts lane 4's class of invariants around the command, and deliberately does
# not re-measure five things lane 4 already establishes on the reinstall path: that a predecessor
# install names a version, that the active version changes on the forward upgrade, that the
# predecessor's version directory survives that upgrade, that the unit stays `enabled`, and that a
# reinstall preserves configuration and the publisher token. Those are lane 4's rows. They are
# printed here wherever they are cheap to read and never asserted, because two overlapping sources of
# truth for one claim are worse than one.
#
# WHAT IT NEEDS ON THE DROPLET. Lane 4's two extracted roots, ~/runtime-prev and ~/runtime-root, and
# the install lane 4 left behind. Both are read and neither is written: this lane downloads nothing
# and stages nothing, so the archives it measures are exactly the ones lane 4 verified by checksum
# and Cosign bundle. It needs the same two candidate tags lane 4 needs and has no knob of its own.
#
# WHICH STAGED DIRECTORY IS WHICH ARTIFACT. Answered by digest, not by `current.json` and not by the
# activation history: the installer copies a `.js` CLI into the staged runtime verbatim, in both
# artifacts, so a staged version directory whose `apps/gateway/src/cli.js` matches an archive's byte
# for byte was staged from that archive. Every "it went back to the predecessor" claim below is
# anchored to that, so none of them can be satisfied by a pointer that merely changed.
#
# WHY THE WALK STARTS WITH A REFUSAL, THEN `--to`. A bare `rollback` resolves its target from the
# activation history, and the history is written only by the CLI that performs an activation. A
# predecessor artifact older than PR #78 records nothing, so the history can name only what the newer
# artifact activated and a bare `rollback` must refuse to guess. That refusal is a safety property, so
# it is asserted first, with its message compared against the one installation.ts documents. Two
# explicit `rollback --to` invocations then follow: they are half of what this lane has to exercise
# anyway, they are recorded whichever artifact is installed because the newer CLI performs them, and
# they leave a history whose predecessor is known. Only then is the bare command run, twice, so the
# documented oscillation between two versions is measured rather than assumed.
lane_rollback() {
  local dns_name
  step "Lane 8: the rollback command, its --to form, and induced divergence"
  dns_name="$(require_dns_name)"

  remote_user DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" \
    GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
bun=~/.bun/bin/bun
state_dir="$HOME/.local/state/omp-session-gateway"
versions="$state_dir/installation/versions"
pointer="$state_dir/installation/current.json"
history="$state_dir/installation/history.json"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"
config="$HOME/.config/omp-session-gateway/config.json"
token="$HOME/.config/omp-session-gateway/publisher-token"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

digest_of() { sha256sum "$1" | awk '{print $1}'; }
clip() { printf '%.12s' "$1"; }
# Nanosecond mtime, kept as its printed form: the pointer write and the history append are
# consecutive awaits inside one command and whole seconds cannot order two writes that fast.
mtime_of() { if [ -f "$1" ]; then stat -c '%.9Y' "$1"; else printf '0'; fi; }
pointer_version() { if [ -f "$pointer" ]; then jq -r '.versionDirectory' "$pointer"; else printf 'absent'; fi; }
version_dirs() { find "$versions" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort; }
history_entries() { if [ -f "$history" ]; then jq -r '.activations[]' "$history"; fi; }
history_count() { history_entries | grep -c . || true; }
history_last() { history_entries | tail -1 | grep . || printf 'none'; }
main_pid() { systemctl --user show -p MainPID --value omp-session-gateway.service; }
unit_enabled() { systemctl --user is-enabled omp-session-gateway.service 2>&1 || true; }
# Which shape the unit file has, independent of which staged runtime its ExecStart executes. The CLI
# that last wrote the definition decides this, so a mixed-version droplet can hold a post-#69 unit
# executing an older runtime, or the reverse.
unit_shape() {
  if grep -q '^RuntimeDirectory=omp-session-gateway$' "$unit"; then printf 'RuntimeDirectory='
  else printf 'ReadWritePaths-only'; fi
}
listener() {
  ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | sort | tr '\n' ' ' | sed 's/ *$//' |
    grep . || printf 'none'
}
loopback_only() {
  if [ "$(listener)" = "127.0.0.1:${GATEWAY_PORT}" ]; then printf 'loopback'; else listener; fi
}

# The unit FILE is what the CLI reads to decide whether the definition and the pointer agree; the
# LOADED unit is what systemd would actually execute. They agree only after a daemon-reload, so both
# are measured, separately, every time.
unit_exec_path() {
  grep -o '"[^"]*/installation/versions/[^"]*/apps/gateway/src/cli\.js"' "$unit" |
    head -1 | tr -d '"' | grep . || printf 'no-versioned-path'
}
version_of_path() {
  case "$1" in
    */installation/versions/*) printf '%s' "$1" | sed 's|.*/installation/versions/\([^/]*\)/.*|\1|' ;;
    *) printf '%s' "$1" ;;
  esac
}
unit_version() { version_of_path "$(unit_exec_path)"; }
loaded_exec_version() {
  local value
  value="$(systemctl --user show -p ExecStart --value omp-session-gateway.service |
    grep -o '/installation/versions/[^/]*/' | head -1 || true)"
  if [ -z "$value" ]; then printf 'none'; else printf '%s' "$value" | sed 's|.*/versions/\([^/]*\)/|\1|'; fi
}

# A restart is asynchronous, so reading the listener the instant a command returns is a false
# negative rather than a finding. Bounded, and the wait it actually needed is printed.
LISTENER_WAIT=""
await_listener() {
  local index=0
  while [ "$index" -lt 30 ]; do
    if [ "$(loopback_only)" = "loopback" ]; then
      LISTENER_WAIT="${index}s"
      printf 'loopback'
      return 0
    fi
    sleep 1
    index=$((index + 1))
  done
  LISTENER_WAIT="timed out after 30s"
  loopback_only
}

status_quad() {
  printf '%s' "$1" |
    jq -r '[(.installed|tostring),(.active|tostring),(.ready|tostring),(.diverged|tostring)] | join("/")' 2>/dev/null ||
    printf 'unparseable'
}
# `//` is wrong here: jq's alternative operator also fires on `false`, which is exactly the value
# `.diverged` carries when nothing is wrong.
status_field() {
  printf '%s' "$1" | jq -r --arg key "$2" 'if has($key) then (.[$key] | tostring) else "absent" end' 2>/dev/null ||
    printf 'unparseable'
}
# Exact, not floating point. Both values are ten digits, a dot, then nine digits until the year 2286,
# so removing the dot leaves equal-length digit strings that compare correctly as strings. Feeding
# them to awk as numbers would land on the edge of double precision at nanosecond scale.
later_or_equal() {
  awk -v first="$1" -v second="$2" 'BEGIN {
    gsub(/\./, "", first); gsub(/\./, "", second)
    print ((second "") >= (first "")) ? "after" : "before"
  }'
}
contains() { if grep -qF -- "$2" "$1"; then printf 'present'; else printf 'absent'; fi; }

CHECKS=0
FAILURES=0
check() {
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then printf '   %-48s %-30s %s\n' "$1" "$2" PASS
  else printf '   %-48s %-30s %s\n' "$1" "expected $3, got $2" FAIL; FAILURES=$((FAILURES + 1)); fi
}
table_head() { printf '   %-48s %-30s %s\n' INVARIANT OBSERVED RESULT; }

# ---------------------------------------------------------------- preconditions and identification
[ -s ~/runtime-root ] || {
  echo "~/runtime-root is missing: lane 'artifact' extracts the candidate. Run 'qualify artifact lifecycle migration' first." >&2
  exit 1
}
next_root="$(cat ~/runtime-root)"
prev_root="$(find ~/runtime-prev -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1 || true)"
[ -n "$prev_root" ] || {
  echo "~/runtime-prev holds no extracted archive. Lane 'migration' puts the predecessor there, and it skips itself when OMP_QUAL_PREVIOUS_TAG equals OMP_QUAL_RELEASE_TAG. Run 'qualify migration' with two different published candidate tags first." >&2
  exit 1
}
# Every rollback here is driven by the candidate's CLI: it is the newer of the two artifacts, it is
# what an operator on this box would reach for, and the predecessor may predate the command entirely.
cli="$next_root/apps/gateway/src/cli.js"
candidate_cli() {
  "$bun" -e '
const [, modulePath, ...args] = Bun.argv;
const { main } = await import(modulePath);
const describe = error => {
  const message = error instanceof Error ? error.message : String(error);
  const children =
    error instanceof AggregateError
      ? error.errors
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  return [message, ...children.flatMap(describe)];
};
try {
  await main(args);
} catch (error) {
  console.error(describe(error).map((line, index) => `${index === 0 ? "" : "caused by: "}${line}`).join("\n"));
  process.exitCode = 1;
}
' "$cli" "$@"
}
grep -q -a -F 'refusing to guess a rollback target' "$cli" || {
  echo "the candidate artifact carries no rollback target resolver, so it predates PR #78 and there is no command for this lane to exercise. Point OMP_QUAL_RELEASE_TAG at a candidate that has it." >&2
  exit 1
}
systemctl --user is-active omp-session-gateway.service >/dev/null || {
  echo "the gateway service is not active, and rollback refuses without an installed active service. Run 'qualify lifecycle migration' first." >&2
  exit 1
}

version_for_archive() {
  local want dir
  want="$(digest_of "$1/apps/gateway/src/cli.js")"
  while read -r dir; do
    [ -f "$versions/$dir/apps/gateway/src/cli.js" ] || continue
    if [ "$(digest_of "$versions/$dir/apps/gateway/src/cli.js")" = "$want" ]; then
      printf '%s' "$dir"
      return 0
    fi
  done < <(version_dirs)
  printf 'none'
}
prev_version="$(version_for_archive "$prev_root")"
next_version="$(version_for_archive "$next_root")"

show "predecessor archive root" "$(basename "$prev_root")"
show "candidate archive root" "$(basename "$next_root")"
show "predecessor staged as" "$prev_version"
show "candidate staged as" "$next_version"
show "version directories present" "$(version_dirs | tr '\n' ' ')"
show "activations recorded / last" "$(history_count) / $(history_last)"
show "active version directory" "$(pointer_version)"
show "unit file / loaded version" "$(unit_version) / $(loaded_exec_version)"
show "unit file shape" "$(unit_shape)"
show "unit enabled (lane 4 asserts this)" "$(unit_enabled)"

[ "$prev_version" != none ] && [ "$next_version" != none ] || {
  echo "one of the two archives has no staged version directory whose CLI matches it byte for byte, so this droplet was not left by lane 'migration'. Run 'qualify migration' immediately before this lane." >&2
  exit 1
}
[ "$prev_version" != "$next_version" ] || {
  echo "both archives stage the same version directory $prev_version, so there is no second version to roll back to. Name two different published candidate tags." >&2
  exit 1
}
[ "$(version_dirs | grep -c .)" -ge 2 ] || {
  echo "fewer than two installed version directories, so no predecessor is retained and rollback must refuse." >&2
  exit 1
}
case "$(pointer_version)" in
  "$prev_version" | "$next_version") ;;
  *)
    echo "current.json names $(pointer_version), which is neither archive's staged directory. Run 'qualify migration' immediately before this lane." >&2
    exit 1
    ;;
esac

# Baselines for "survived byte-identically". Read once, before the first command, compared in full,
# and only ever printed as their first twelve hex digits.
BASE_CONFIG="$(digest_of "$config")"
BASE_TOKEN="$(digest_of "$token")"
BASE_TOKEN_MODE="$(stat -c '%a' "$token")"
show "baseline config / token digest" "$(clip "$BASE_CONFIG") / $(clip "$BASE_TOKEN")"
show "baseline token mode" "$BASE_TOKEN_MODE"

# The same rule installation.ts documents for a `--to`-less rollback: the newest recorded activation
# before the last activation of whatever is active now, skipping repeats. Computed here rather than
# trusted, so both "it refused because there is none" and "it returned to the recorded predecessor"
# are independent claims about history.json rather than restatements of the command's own output.
recorded_predecessor() {
  history_entries | awk -v active="$1" '
    { line[NR] = $0; if ($0 == active) last = NR }
    END { for (index_ = last - 1; index_ >= 1; index_--) if (line[index_] != active) { print line[index_]; exit } }'
}

# ---------------------------------------------------------------- one measured rollback
# Every successful invocation goes through these two functions, so a later step cannot quietly be
# measured more loosely than an earlier one and the table reads as a sequence rather than as a set of
# special cases.
ROLL_FROM=""; ROLL_TO=""; ROLL_OUTPUT=""; ROLL_PID_BEFORE=""; ROLL_PID=""
ROLL_UNIT_PATH=""; ROLL_UNIT_VERSION=""; ROLL_LOADED_VERSION=""; ROLL_LISTENER=""; ROLL_ABS=""
ROLL_CONFIG=""; ROLL_TOKEN=""; ROLL_TOKEN_MODE=""; ROLL_ENABLED=""; ROLL_SHAPE=""
ROLL_HISTORY_BEFORE=""; ROLL_HISTORY=""; ROLL_HISTORY_LAST=""; ROLL_HISTORY_LAST_BEFORE=""
ROLL_POINTER_MTIME=""; ROLL_HISTORY_MTIME=""; ROLL_STATUS=""

roll() {
  printf '\n   -- %s --\n' "$1"
  shift
  ROLL_FROM="$(pointer_version)"
  ROLL_PID_BEFORE="$(main_pid)"
  ROLL_HISTORY_BEFORE="$(history_count)"
  ROLL_HISTORY_LAST_BEFORE="$(history_last)"
  ROLL_OUTPUT="$(candidate_cli rollback "$@" | tr '\n' ' ')"
  ROLL_TO="$(pointer_version)"
  ROLL_UNIT_PATH="$(unit_exec_path)"
  ROLL_UNIT_VERSION="$(version_of_path "$ROLL_UNIT_PATH")"
  ROLL_LOADED_VERSION="$(loaded_exec_version)"
  ROLL_PID="$(main_pid)"
  ROLL_LISTENER="$(await_listener)"
  ROLL_CONFIG="$(digest_of "$config")"
  ROLL_TOKEN="$(digest_of "$token")"
  ROLL_TOKEN_MODE="$(stat -c '%a' "$token")"
  ROLL_ENABLED="$(unit_enabled)"
  ROLL_SHAPE="$(unit_shape)"
  ROLL_HISTORY="$(history_count)"
  ROLL_HISTORY_LAST="$(history_last)"
  ROLL_POINTER_MTIME="$(mtime_of "$pointer")"
  ROLL_HISTORY_MTIME="$(mtime_of "$history")"
  ROLL_STATUS="$("$bun" "$cli" status || true)"
  case "$ROLL_UNIT_PATH" in
    /*/installation/versions/*/apps/gateway/src/cli.js) ROLL_ABS="absolute" ;;
    *) ROLL_ABS="$ROLL_UNIT_PATH" ;;
  esac
  show "command" "rollback${*:+ $*}"
  show "output" "$ROLL_OUTPUT"
  show "current.json" "$ROLL_FROM -> $ROLL_TO"
  show "unit file / loaded version" "$ROLL_UNIT_VERSION / $ROLL_LOADED_VERSION"
  show "unit ExecStart path" "$(printf '%s' "$ROLL_UNIT_PATH" | sed "s|^$HOME|~|")"
  show "unit file shape" "$ROLL_SHAPE"
  show "daemon main pid" "$ROLL_PID_BEFORE -> $ROLL_PID"
  show "listener / wait" "$ROLL_LISTENER / $LISTENER_WAIT"
  show "config / token digest" "$(clip "$ROLL_CONFIG") / $(clip "$ROLL_TOKEN")"
  show "token mode / unit enabled" "$ROLL_TOKEN_MODE / $ROLL_ENABLED"
  show "activations / last" "$ROLL_HISTORY_BEFORE -> $ROLL_HISTORY / $ROLL_HISTORY_LAST"
  show "current.json / history mtime" "$ROLL_POINTER_MTIME / $ROLL_HISTORY_MTIME"
  show "status" "$ROLL_STATUS"
}

# $1 = row prefix, $2 = version directory the command had to activate, $3 = selection word it had to
# report. Paired values are folded into one row each so the observed column stays readable while
# still naming both halves of a mismatch.
assert_roll() {
  local expected_activations=1
  # Activation history is deliberately idempotent: re-activating the version the history already ends
  # with appends nothing, so that a run of identical entries cannot evict a genuine predecessor. The
  # expected delta is therefore derived from what the history held, not fixed at one.
  [ "$ROLL_HISTORY_LAST_BEFORE" != "$2" ] || expected_activations=0
  table_head
  check "$1: current.json names the target" "$ROLL_TO" "$2"
  check "$1: reported selection" "$(if printf '%s' "$ROLL_OUTPUT" | grep -qF "($3)"; then printf '%s' "$3"; else printf 'not reported'; fi)" "$3"
  check "$1: definition and loaded unit follow" "$ROLL_UNIT_VERSION / $ROLL_LOADED_VERSION" "$2 / $2"
  check "$1: ExecStart absolute and versioned" "$ROLL_ABS" absolute
  check "$1: daemon restarted" "$(if [ "$ROLL_PID_BEFORE" != "$ROLL_PID" ]; then printf 'changed'; else printf 'same'; fi)" changed
  check "$1: listener bound, loopback only" "$ROLL_LISTENER" loopback
  check "$1: config and token survived" "$(if [ "$ROLL_CONFIG" = "$BASE_CONFIG" ] && [ "$ROLL_TOKEN" = "$BASE_TOKEN" ]; then printf 'identical'; else printf 'differs'; fi)" identical
  check "$1: token mode unchanged" "$ROLL_TOKEN_MODE" "$BASE_TOKEN_MODE"
  check "$1: activations recorded" "$((ROLL_HISTORY - ROLL_HISTORY_BEFORE))" "$expected_activations"
  check "$1: last activation is the pointer" "$ROLL_HISTORY_LAST" "$ROLL_TO"
  # Only meaningful when something was appended. When the history already ended with this version
  # nothing was rewritten, so its mtime is legitimately older than the pointer's and an unconditional
  # ordering row would fail on correct behaviour. Say which case it was instead of hiding either.
  check "$1: history appended after the pointer" \
    "$(if [ "$expected_activations" -eq 1 ]; then later_or_equal "$ROLL_POINTER_MTIME" "$ROLL_HISTORY_MTIME"; else printf 'nothing appended'; fi)" \
    "$(if [ "$expected_activations" -eq 1 ]; then printf 'after'; else printf 'nothing appended'; fi)"
  check "$1: installed/active/ready/diverged" "$(status_quad "$ROLL_STATUS")" "true/true/true/false"
}

# ---------------------------------------------------------------- W0: what a bare rollback does first
printf '\n   -- W0: rollback with no --to, against whatever lane 4 left recorded --\n'
w0_active="$(pointer_version)"
w0_expected="$(recorded_predecessor "$w0_active" | grep . || printf 'none')"
w0_pid_before="$(main_pid)"
w0_unit_before="$(unit_version)"
w0_history_before="$(history_count)"
w0_history_last_before="$(history_last)"
show "active version directory" "$w0_active"
show "activations recorded" "$(history_entries | tr '\n' ' ' | sed 's/ *$//' | grep . || printf 'none')"
show "recorded predecessor, computed here" "$w0_expected"
w0_rc=0
candidate_cli rollback >"$work/w0.log" 2>&1 || w0_rc=$?
show "exit code" "$w0_rc"
show "output" "$(head -c 240 "$work/w0.log" | tr '\n' ' ')"
show "current.json after" "$(pointer_version)"
show "unit file version after" "$(unit_version)"
show "daemon main pid" "$w0_pid_before -> $(main_pid)"

if [ "$w0_expected" = none ]; then
  # The predecessor artifact predates PR #78, so it recorded no activation of its own and the command
  # has nothing to resolve. Refusing is the safety property; the message rows are transcribed from
  # apps/gateway/src/installation.ts, so a FAIL among them is a discrepancy between the command and
  # its own documented refusal, to be reported rather than absorbed by loosening this lane.
  printf '\n   %s\n' "No activation is recorded for the active version, so the documented behaviour is a"
  printf '   %s\n' "refusal that changes nothing. The message rows are transcribed from installation.ts."
  table_head
  check "W0: refuses without a recorded predecessor" "$(if [ "$w0_rc" -ne 0 ]; then printf 'refused'; else printf 'accepted'; fi)" refused
  check "W0: exit code" "$w0_rc" 1
  check "W0: message refuses to guess" "$(contains "$work/w0.log" 'refusing to guess a rollback target')" present
  check "W0: message names the remedy" "$(contains "$work/w0.log" 'pass --to <version-directory>')" present
  check "W0: message lists installed versions" "$(contains "$work/w0.log" 'installed: ')" present
  check "W0: refusal changed no pointer" "$(pointer_version)" "$w0_active"
  check "W0: refusal changed no definition" "$(unit_version)" "$w0_unit_before"
  w0_history_after="$(history_count)"
  check "W0: refusal recorded no activation" "$((w0_history_after - w0_history_before))" 0
  check "W0: refusal did not restart the daemon" "$(if [ "$w0_pid_before" = "$(main_pid)" ]; then printf 'unchanged'; else printf 'restarted'; fi)" unchanged
else
  # Both artifacts record activations, so the bare command has a predecessor to resolve and must land
  # on the one computed above. Measured with the same routine as every later invocation.
  printf '\n   %s\n' "A predecessor is recorded, so the documented behaviour is a rollback onto it."
  ROLL_FROM="$w0_active"
  ROLL_PID_BEFORE="$w0_pid_before"
  ROLL_HISTORY_BEFORE="$w0_history_before"
  ROLL_HISTORY_LAST_BEFORE="$w0_history_last_before"
  ROLL_OUTPUT="$(tr '\n' ' ' <"$work/w0.log")"
  ROLL_TO="$(pointer_version)"
  ROLL_UNIT_PATH="$(unit_exec_path)"
  ROLL_UNIT_VERSION="$(version_of_path "$ROLL_UNIT_PATH")"
  ROLL_LOADED_VERSION="$(loaded_exec_version)"
  ROLL_PID="$(main_pid)"
  ROLL_LISTENER="$(await_listener)"
  ROLL_CONFIG="$(digest_of "$config")"
  ROLL_TOKEN="$(digest_of "$token")"
  ROLL_TOKEN_MODE="$(stat -c '%a' "$token")"
  ROLL_HISTORY="$(history_count)"
  ROLL_HISTORY_LAST="$(history_last)"
  ROLL_POINTER_MTIME="$(mtime_of "$pointer")"
  ROLL_HISTORY_MTIME="$(mtime_of "$history")"
  ROLL_STATUS="$("$bun" "$cli" status || true)"
  case "$ROLL_UNIT_PATH" in
    /*/installation/versions/*/apps/gateway/src/cli.js) ROLL_ABS="absolute" ;;
    *) ROLL_ABS="$ROLL_UNIT_PATH" ;;
  esac
  table_head
  check "W0: succeeded with a recorded predecessor" "$(if [ "$w0_rc" -eq 0 ]; then printf 'accepted'; else printf 'exit %s' "$w0_rc"; fi)" accepted
  assert_roll W0 "$w0_expected" recorded-predecessor
fi

# ---------------------------------------------------------------- the walk
# Recomputed after W0, because its successful branch moves the pointer and every step below is
# defined against wherever the command actually left it.
start_version="$(pointer_version)"
if [ "$start_version" = "$prev_version" ]; then other_version="$next_version"; else other_version="$prev_version"; fi

roll "W1: rollback --to $other_version, the version that is not active" --to "$other_version"
assert_roll W1 "$other_version" requested

roll "W2: rollback --to $start_version, back again, which seeds the history" --to "$start_version"
assert_roll W2 "$start_version" requested

roll "W3: rollback with no --to, which must now resolve a recorded predecessor"
assert_roll W3 "$other_version" recorded-predecessor
check "W3: target matches the history, read here" "$other_version" "$(recorded_predecessor "$start_version" | grep . || printf 'none')"

roll "W4: rollback again, which must oscillate back"
assert_roll W4 "$start_version" recorded-predecessor

# The divergence step needs the predecessor active: it has to point the definition at a version the
# pointer does not name, and the only reachable direction is definition-newer. The walk ends where it
# started, so one more bare rollback is needed exactly when the lane began on the candidate.
if [ "$(pointer_version)" != "$prev_version" ]; then
  roll "W5: rollback once more, to reach the predecessor"
  assert_roll W5 "$prev_version" recorded-predecessor
else
  printf '\n   %s\n' "W5 not needed: the walk already ends on the predecessor $prev_version."
fi

# ---------------------------------------------------------------- D: induced divergence
printf '\n   -- D: induced divergence, definition newer than current.json --\n'
[ "$(pointer_version)" = "$prev_version" ] && [ "$(unit_version)" = "$prev_version" ] || {
  echo "the walk did not end with both current.json and the service definition on $prev_version, so the divergence below would not be the documented direction. Refusing to induce it." >&2
  exit 1
}
# install and rollback both write the service definition first and advance current.json only once the
# new runtime has proven loopback readiness, so exactly one divergence direction is reachable: a
# crash between those two writes leaves the definition naming a NEWER version than the pointer.
# Reproduce that by hand, including the restart a real crash would already have completed, so the
# daemon genuinely executes the version the pointer does not name.
diverge_pid_before="$(main_pid)"
sed -i "s|/installation/versions/${prev_version}/|/installation/versions/${next_version}/|g" "$unit"
systemctl --user daemon-reload
systemctl --user restart omp-session-gateway.service
diverged_listener="$(await_listener)"
diverged_unit_version="$(unit_version)"
diverged_loaded_version="$(loaded_exec_version)"
diverged_pointer="$(pointer_version)"
diverged_history="$(history_count)"
diverged_pid="$(main_pid)"
show "unit file / loaded version" "$diverged_unit_version / $diverged_loaded_version"
show "current.json still names" "$diverged_pointer"
show "daemon main pid" "$diverge_pid_before -> $diverged_pid"
show "listener / wait" "$diverged_listener / $LISTENER_WAIT"

status_rc=0
diverged_status="$("$bun" "$cli" status 2>"$work/status.err")" || status_rc=$?
show "status" "$diverged_status"
show "status exit code" "$status_rc"
show "status stderr" "$(head -c 240 "$work/status.err" | tr '\n' ' ')"

# `status` names two remedies: `rollback --to <version>` or a reinstall. With two installed versions
# the command cannot reach the conservative outcome at all -- naming the pointer's own version is
# refused, and every other target adopts a version the pointer never proved -- so the refusal is
# measured here and the repair below is the reinstall. The command did not perform this repair, and
# no third version is manufactured to pretend otherwise.
refusal_rc=0
"$bun" "$cli" rollback --to "$prev_version" >"$work/refusal.log" 2>&1 || refusal_rc=$?
# Captured before the repair runs, because the repair rewrites the very definition this asserts was
# left untouched.
refusal_unit_version="$(unit_version)"
refusal_pointer="$(pointer_version)"
show "rollback --to <active> exit" "$refusal_rc"
show "rollback --to <active> message" "$(head -c 240 "$work/refusal.log" | tr '\n' ' ')"
show "after refusal: unit / pointer" "$refusal_unit_version / $refusal_pointer"

repair_pid_before="$(main_pid)"
"$bun" "$prev_root/apps/gateway/src/cli.js" install \
  --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
repair_pointer="$(pointer_version)"
repair_unit_version="$(unit_version)"
repair_loaded_version="$(loaded_exec_version)"
repair_pid="$(main_pid)"
repair_listener="$(await_listener)"
repair_history="$(history_count)"
repair_status="$("$bun" "$cli" status || true)"
show "repair: current.json" "$diverged_pointer -> $repair_pointer"
show "repair: unit file / loaded" "$repair_unit_version / $repair_loaded_version"
show "repair: unit file shape" "$(unit_shape)"
show "repair: daemon main pid" "$repair_pid_before -> $repair_pid"
show "repair: listener / wait" "$repair_listener / $LISTENER_WAIT"
show "repair: activations recorded" "$diverged_history -> $repair_history"
show "repair: status" "$repair_status"
show "repair: config / token digest" "$(clip "$(digest_of "$config")") / $(clip "$(digest_of "$token")")"
show "repair: unit enabled" "$(unit_enabled)"

table_head
check "D: induced definition is the newer version" "$diverged_unit_version" "$next_version"
check "D: induced pointer stays the older one" "$diverged_pointer" "$prev_version"
check "D: the daemon really ran the newer one" "$diverged_loaded_version" "$next_version"
check "D: the restart really happened" "$(if [ "$diverge_pid_before" != "$diverged_pid" ]; then printf 'changed'; else printf 'same'; fi)" changed
check "D: listener bound while diverged" "$diverged_listener" loopback
check "D: status reports the divergence" "$(status_field "$diverged_status" diverged)" true
check "D: status names the pointer version" "$(status_field "$diverged_status" activeVersion)" "$prev_version"
check "D: status names the definition version" "$(status_field "$diverged_status" serviceVersion)" "$next_version"
check "D: status exits non-zero while diverged" "$(if [ "$status_rc" -ne 0 ]; then printf 'nonzero'; else printf 'zero'; fi)" nonzero
check "D: status stderr says DIVERGED" "$(contains "$work/status.err" 'DIVERGED')" present
check "D: rollback --to the active version refuses" "$(if [ "$refusal_rc" -ne 0 ]; then printf 'refused'; else printf 'accepted'; fi)" refused
check "D: refusal names the active version" "$(contains "$work/refusal.log" 'refusing rollback to the active version')" present
check "D: refusal left the diverged state alone" "$refusal_unit_version / $refusal_pointer" "$next_version / $prev_version"
check "D: repair keeps the older proven version" "$repair_pointer" "$prev_version"
check "D: repair rewrites definition and unit" "$repair_unit_version / $repair_loaded_version" "$prev_version / $prev_version"
check "D: repair adopts nothing unrecorded" "$(if [ "$repair_pointer" != "$next_version" ] && [ "$repair_unit_version" != "$next_version" ]; then printf 'not adopted'; else printf 'adopted'; fi)" "not adopted"
check "D: repair recorded no new activation" "$((repair_history - diverged_history))" 0
check "D: repair cleared the divergence" "$(status_field "$repair_status" diverged)" false
check "D: repair restarted the daemon" "$(if [ "$repair_pid_before" != "$repair_pid" ]; then printf 'changed'; else printf 'same'; fi)" changed
check "D: listener bound after repair" "$repair_listener" loopback

# ---------------------------------------------------------------- F: leave the candidate active
# Not tidying. Every lane after this one measures whatever is installed, and the ledger's subject is
# the candidate rather than its predecessor -- including lane `persistence`, which reboots, and which
# a predecessor unit predating the RuntimeDirectory= fix would fail for reasons that are #69 and not
# rollback. It is also a third `--to`, from a definition and pointer that were just repaired.
roll "F: rollback --to $next_version, leaving the candidate active" --to "$next_version"
assert_roll F "$next_version" requested
check "F: droplet left on a post-#69 unit shape" "$ROLL_SHAPE" "RuntimeDirectory="

printf '\n   Not checked here, and why:\n'
printf '   %s\n' "* the conservative divergence repair was NOT performed by the rollback command. With"
printf '   %s\n' "  two installed versions no invocation can do it: --to the pointer's own version is"
printf '   %s\n' "  refused, and any other target adopts a version the pointer never proved. The"
printf '   %s\n' "  reinstall measured above is the other remedy status prints, and it is what ran."
printf '   %s\n' "* the opposite divergence direction, a pointer newer than the definition, is not"
printf '   %s\n' "  induced because no command produces it: neither install nor rollback writes"
printf '   %s\n' "  current.json before the service definition."
printf '   %s\n' "* rollback's own repair path, the catch block that rebuilds the definition from"
printf '   %s\n' "  current.json when an activation fails, is not reached. Reaching it needs a rollback"
printf '   %s\n' "  whose target fails readiness, which means breaking a staged runtime, and a"
printf '   %s\n' "  deliberately corrupted runtime is not evidence about this candidate."
printf '   %s\n' "* the crash window between the two writes is not measured, only the state a crash"
printf '   %s\n' "  inside it leaves and how the next command treats that state."
printf '   %s\n' "* history.json ordering is shown by nanosecond mtime, which orders two writes and"
printf '   %s\n' "  says nothing about atomicity. Those two writes are documented as not atomic."
printf '   %s\n' "* the macOS harness's host-daemon and host-plist invariants have no analogue here:"
printf '   %s\n' "  that harness protects a live daemon on the operator's own machine, and this"
printf '   %s\n' "  droplet has one user, one service, and nothing to protect it from."
printf '   %s\n' "* lane 4's five reinstall-path rows are printed above but never re-asserted here:"
printf '   %s\n' "  predecessor install names a version, the active version changes on the forward"
printf '   %s\n' "  upgrade, the predecessor directory survives it, the unit stays enabled, and a"
printf '   %s\n' "  reinstall preserves config and token."

if [ "$FAILURES" -eq 0 ]; then
  printf '\n   %d/%d invariants PASS\n' "$CHECKS" "$CHECKS"
else
  printf '\n   %d of %d invariants FAILED\n' "$FAILURES" "$CHECKS"
  echo "rollback invariants failed" >&2
  exit 1
fi
REMOTE
  note "The lane ends with the candidate active and a post-#69 unit, so later lanes measure the"
  note "candidate. A failure between the induced divergence and its repair leaves the droplet"
  note "deliberately diverged: re-run this lane, or reinstall, to rebuild the unit from current.json."
}

lane_uninstall() {
  step "Lane 6: uninstall from the artifact"
  remote_user GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"

if "$bun" "$cli" uninstall --no-stop >/dev/null 2>&1; then
  echo "uninstall --no-stop succeeded while the service was active; it is required to refuse" >&2
  exit 1
fi
show "uninstall --no-stop while active" "refused, as required"

"$bun" "$cli" uninstall >/dev/null
show "uninstall" "completed"
show "is-enabled" "$(systemctl --user is-enabled omp-session-gateway.service 2>&1 || true)"
show "unit file still present" "$(test -e "$HOME/.config/systemd/user/omp-session-gateway.service" && echo yes || echo no)"
show "remaining gateway pids" "$(pgrep -u "$(id -u)" -f 'cli.js serve' | tr '\n' ' ' | grep . || echo none)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
tailscale serve reset >/dev/null 2>&1 || true
show "serve mapping after reset" "$(tailscale serve status 2>&1 | head -1)"
REMOTE
}

# Lane `init`: what the installer does on a host whose init system it does not support.
#
# apps/gateway/src/service.ts builds a systemd user unit for every `linux` platform and then drives
# `systemctl --user daemon-reload`, `enable`, and `start`. Nothing in that path inspects the init
# system, so on an OpenRC host `install` cannot succeed. This lane exists because "cannot succeed" has
# two very different shapes and the ledger needs to know which one is real: a refusal that leaves the
# machine as it found it, or a partial install that reports failure while leaving a token, a staged
# runtime, and possibly a listener behind.
#
# A NON-ZERO install exit is therefore the expected, successful outcome of this lane. Only three things
# are asserted, and each is a safety property rather than a message: the install refused, no gateway
# process survives, and nothing is listening. Everything else — the verbatim message, the residue, and
# how `status`, `doctor`, and `uninstall` behave afterwards — is measured and printed for the lead to
# read, because those are the findings, and asserting a predicted answer would hide a surprise.
#
# This lane implements no OpenRC backend and its passing must not be read as OpenRC being supported.
lane_init() {
  step "Lane 7: install on a host with no systemd"
  remote_user GATEWAY_PORT="$GATEWAY_PORT" ORIGIN="$OPENRC_SYNTHETIC_ORIGIN" \
    ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }

# Measured, never inferred from OMP_QUAL_INIT: the knob shaped provisioning, the machine decides what
# is running now.
. /etc/os-release
show "distribution" "${PRETTY_NAME:-unknown}"
show "kernel" "$(uname -srm)"
show "pid 1" "$(tr '\0' ' ' </proc/1/cmdline | awk '{print $1}')"
show "/run/systemd/system" "$(test -d /run/systemd/system && echo present || echo absent)"
show "systemctl on PATH" "$(command -v systemctl || echo absent)"
show "rc-service on PATH" "$(command -v rc-service || echo absent)"
show "rc-status default runlevel" "$(rc-status -s 2>/dev/null | wc -l | tr -d ' ') services listed"

if [ -d /run/systemd/system ]; then
  show "verdict" "systemd is running here, so there is no refusal to observe"
  echo "   This lane measures the installer on a NON-systemd host. On systemd the applicable lane is"
  echo "   'lifecycle', which installs for real; running this one would only duplicate it."
  exit 0
fi

if [ ! -f ~/runtime-root ]; then
  echo "no extracted artifact on this droplet: run lane 'artifact' before lane 'init'" >&2
  exit 1
fi
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"
config_dir="$HOME/.config/omp-session-gateway"
state_dir="$HOME/.local/state/omp-session-gateway"

# The runtime's own portability is a separate question from the service manager's, and it is answered
# for free: this is Bun's musl build, and every CLI invocation below is that binary executing the
# archive's JavaScript. `ldd --version` exits non-zero on musl, hence the guard.
show "bun version" "$("$bun" --version)"
show "libc" "$(ldd --version 2>&1 | head -1 || true)"
show "XDG_RUNTIME_DIR" "${XDG_RUNTIME_DIR:-<unset>}"
show "unit before install" "$(test -e "$unit" && echo present || echo absent)"
show "config dir before install" "$(test -d "$config_dir" && echo present || echo absent)"

# Capture the failure instead of dying on it: the message is the evidence this lane exists to collect.
install_log="$(mktemp)"
install_status=0
"$bun" "$cli" install --origin "$ORIGIN" --allow "$ALLOWED_LOGIN" >"$install_log" 2>&1 || install_status=$?
show "install exit status" "$install_status"
show "install output bytes" "$(wc -c <"$install_log" | tr -d ' ')"
printf '   install output, verbatim:\n'
sed 's/^/     | /' "$install_log"
rm -f "$install_log"

# Residue. Printed rather than asserted: whether a systemd unit is written on a machine with no
# systemd, and whether a token and a staged runtime outlive the refusal, are the open questions.
show "unit after install" "$(test -e "$unit" && echo present || echo absent)"
show "config.json after install" "$(test -e "$config_dir/config.json" && stat -c 'mode %a' "$config_dir/config.json" || echo absent)"
show "publisher-token after install" "$(test -e "$config_dir/publisher-token" && stat -c 'mode %a, %s bytes' "$config_dir/publisher-token" || echo absent)"
# busybox `find` has no `-printf`, and `ls` would miscount a name containing a newline, so count
# directory entries with the intersection of GNU and busybox `find` that both support.
show "staged version dirs" "$(find "$state_dir/installation/versions" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
show "installation/current.json" "$(test -e "$state_dir/installation/current.json" && echo present || echo absent)"

# busybox `pgrep` has no `-u`, and the point of this droplet is that its userland is not the familiar
# one, so read /proc directly rather than depend on procps being packaged under a particular name.
# The glob is expanded once, before any helper in the loop exists, so the loop cannot match itself.
pids=""
for entry in /proc/[0-9]*; do
  [ -r "$entry/cmdline" ] || continue
  if tr '\0' ' ' <"$entry/cmdline" 2>/dev/null | grep -q 'cli\.js serve'; then
    pids="$pids ${entry#/proc/}"
  fi
done
pids="${pids# }"
show "gateway processes" "${pids:-none}"

# Assert on curl's exit status, not its stdout: `-w '%{http_code}'` still prints `000` when the
# connection is refused, so the stdout of a failed probe is "000" *and* whatever the `||` branch adds.
# The exit status is the unambiguous statement that nothing answered, and both numbers are printed.
probe_status=0
probe_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null)" || probe_status=$?
show "loopback probe curl exit / code" "$probe_status / ${probe_code:-<none>}"
if command -v ss >/dev/null 2>&1; then
  show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
else
  show "listeners on gateway port" "ss unavailable; the loopback probe above is the measurement"
fi

# How the rest of the CLI behaves after the refusal. All three are measurements: an operator who hits
# this will run exactly these commands next, and what they print is part of whether the refusal is
# intelligible or merely non-zero.
status_status=0
status_out="$("$bun" "$cli" status 2>&1)" || status_status=$?
show "status exit status" "$status_status"
show "status output" "$(printf '%s' "$status_out" | tr '\n' ' ' | cut -c1-160)"

doctor_status=0
doctor_out="$("$bun" "$cli" doctor 2>&1)" || doctor_status=$?
show "doctor exit status" "$doctor_status"
show "doctor output" "$(printf '%s' "$doctor_out" | tr '\n' ' ' | cut -c1-240)"

uninstall_status=0
uninstall_out="$("$bun" "$cli" uninstall 2>&1)" || uninstall_status=$?
show "uninstall exit status" "$uninstall_status"
show "uninstall output" "$(printf '%s' "$uninstall_out" | tr '\n' ' ' | cut -c1-240)"
show "unit after uninstall" "$(test -e "$unit" && echo present || echo absent)"

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
check "install refused" "$([ "$install_status" -ne 0 ] && echo refused || echo accepted)" refused
check "no gateway process survives" "${pids:-none}" none
check "nothing answers on the gateway port" "$([ "$probe_status" -ne 0 ] && echo refused || echo "http $probe_code")" refused

[ "$fail" -eq 0 ] || { echo "the refusal was not clean; read the FAIL rows above" >&2; exit 1; }
REMOTE
  note "A non-zero install with nothing left running is this lane PASSING. The Linux service backend"
  note "is systemd-only and must refuse rather than half-install; the rows above say whether it does."
  note "Nothing here implements or implies OpenRC support."
}

cmd_qualify() {
  local lane lanes="$*"
  # The default set follows the init system, because on a non-systemd host every lane after `artifact`
  # presumes an install that is expected to be refused. A bare `qualify` there would spend twenty
  # minutes of droplet time failing six lanes for the same already-known reason.
  if [ -z "$lanes" ]; then
    if [ "$QUAL_INIT" = "openrc" ]; then
      lanes="host artifact init"
    else
      lanes="host artifact lifecycle omp migration rollback identity persistence uninstall"
    fi
  fi
  # Reject a typo, and an impossible lane, before anything slow or billable is touched.
  for lane in $lanes; do
    case "$lane" in
      host | artifact | init) ;;
      lifecycle | omp | migration | rollback | identity | persistence | uninstall)
        [ "$QUAL_INIT" != "openrc" ] ||
          die "lane '$lane' needs an installed service, and on a non-systemd host the install is expected to be refused. Run 'host artifact init' instead, or unset OMP_QUAL_INIT to qualify a systemd droplet."
        ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle omp migration rollback identity persistence uninstall init" ;;
    esac
  done

  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"
  require_droplet
  LOCAL_TEMP="$(mktemp -d)"
  measure "droplet" "$DROPLET_NAME at $DROPLET_IP"
  measure "lanes" "$lanes"

  for lane in $lanes; do
    case "$lane" in
      host) lane_host ;;
      artifact) lane_artifact ;;
      lifecycle) lane_lifecycle ;;
      omp) lane_omp ;;
      migration) lane_migration ;;
      rollback) lane_rollback ;;
      identity) lane_identity ;;
      persistence) lane_persistence ;;
      uninstall) lane_uninstall ;;
      init) lane_init ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle omp migration rollback identity persistence uninstall init" ;;
    esac
  done

  step "Qualification lanes finished"
  note "Every line above is a measurement, not a verdict. Nothing here promotes a ledger row."
  note "Record the numbers against the candidate tag, then run '$0 destroy'."
}

main() {
  local command="${1:-}"
  [ -n "$command" ] || die "usage: $0 <provision|qualify|destroy|status>"
  shift
  trap on_exit EXIT
  case "$command" in
    provision) cmd_provision "$@" ;;
    qualify) cmd_qualify "$@" ;;
    destroy) cmd_destroy "$@" ;;
    status) cmd_status "$@" ;;
    *) die "unknown command '$command'; expected provision, qualify, destroy, or status" ;;
  esac
}

main "$@"
