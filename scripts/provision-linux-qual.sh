#!/usr/bin/env bash
#
# Linux qualification lane: one throwaway DigitalOcean droplet, four ledger gaps.
#
# Why this exists. The only Linux evidence in docs/RELEASE_STATUS.md came from a Debian 13 aarch64
# container. A container shares the host kernel, never boots, has no public address of its own, and
# its `systemd --user` manager exists only because something outside kept it alive. That is enough to
# prove an install/uninstall sequence and file permissions, and nothing else. Four things a container
# structurally cannot show are the entire point of this script:
#
#   1. a real machine lifecycle: its own kernel, its own boot, its own public IP;
#   2. reboot and login persistence, which has never been tested on any platform;
#   3. a *denied* Tailscale identity, unprovable from same-account user devices because Serve stamps
#      every one of them with a login that is on the allowlist;
#   4. install/doctor/uninstall from the signed candidate archive with checksum, GitHub attestation,
#      and Cosign bundle verification, rather than from a development checkout.
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
# it can never present a user identity, so `doctor` cannot reach 16/16 on it and the allowed half has
# to come from the operator's workstation, which is a genuinely distinct user-owned node. Both are
# measured here. See docs/LINUX_QUALIFICATION.md for exactly what each pass does and does not prove.
#
# Secrets. The DigitalOcean token and the Tailscale auth key are read from the environment and never
# appear in argv, in cloud-init user data (which is readable from the droplet's own metadata service
# and from the DigitalOcean API), or in any printed line. The auth key is streamed over stdin into a
# mode-0600 file that a remote EXIT trap removes, and `tailscale up` reads it with the documented
# `file:` form. The service's one-time readiness nonce is redacted where ExecStart is printed.
#
# Cost. One `s-1vcpu-2gb` droplet, one fixed name, reused rather than duplicated. The EXIT trap
# always reprints the destroy command, because the only way this lane becomes expensive is by being
# forgotten.
#
# Usage:
#   scripts/provision-linux-qual.sh provision
#   scripts/provision-linux-qual.sh qualify [lane...]
#   scripts/provision-linux-qual.sh status
#   scripts/provision-linux-qual.sh destroy
#
# Lanes: host artifact lifecycle identity persistence uninstall (default: all, in that order).
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

# An address in a reserved TLD. Nobody can ever authenticate as this, which is what makes it a usable
# stand-in for "a well-formed login that is not on the allowlist".
readonly SYNTHETIC_DENIED_LOGIN="denied-identity@qual.invalid"

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

droplet_exists_quietly() {
  command -v doctl >/dev/null 2>&1 || return 1
  doctl compute droplet list --format Name --no-header 2>/dev/null | grep -qx "$DROPLET_NAME"
}

on_exit() {
  local code=$?
  if [ -n "$LOCAL_TEMP" ] && [ -d "$LOCAL_TEMP" ]; then rm -rf "$LOCAL_TEMP"; fi
  if droplet_exists_quietly; then
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

preflight_catalog() {
  doctl compute image list-distribution --output json |
    jq -e --arg slug "$DROPLET_IMAGE" 'any(.[]; .slug == $slug)' >/dev/null ||
    die "image slug $DROPLET_IMAGE does not exist in this account's distribution list"
  doctl compute size list --output json |
    jq -e --arg slug "$DROPLET_SIZE" --arg region "$DROPLET_REGION" \
      'any(.[]; .slug == $slug and .available and (.regions | index($region)))' >/dev/null ||
    die "size $DROPLET_SIZE is not available in region $DROPLET_REGION"
  HOURLY_RATE="$(size_hourly_rate)"
  measure "image / size / region" "$DROPLET_IMAGE / $DROPLET_SIZE / $DROPLET_REGION"
  measure "hourly rate" "\$$HOURLY_RATE per hour"
}

# ---------------------------------------------------------------------------- provision

cloud_init_user_data() {
  # Deliberately free of secrets: user data is retrievable from the droplet's metadata service and
  # from the DigitalOcean API. Tailscale is installed here and never authenticated here.
  cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - jq
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

cmd_provision() {
  step "Preflight"
  preflight_tools
  preflight_ssh_key
  preflight_catalog
  [ -n "${TS_AUTHKEY:-}" ] ||
    die "TS_AUTHKEY is not set. Create a tagged, preauthorized, non-ephemeral auth key carrying $TAILNET_TAG (see docs/LINUX_QUALIFICATION.md) and export it. No droplet was created."
  case "$TS_AUTHKEY" in
    tskey-auth-*) measure "Tailscale auth key" "present, tskey-auth form, value not printed" ;;
    *) die "TS_AUTHKEY does not look like a Tailscale auth key (expected a tskey-auth- prefix). No droplet was created." ;;
  esac

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
show "kernel" "$(uname -srm)"
show "virtualisation" "$(systemd-detect-virt || true)"
show "uptime seconds" "$(awk '{printf "%d", $1}' /proc/uptime)"
show "tailscale backend" "$(tailscale status --json | jq -r '.BackendState + " online=" + ((.Self.Online // false) | tostring)')"
show "node tags" "$(tailscale status --json | jq -r '(.Self.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "user@${uid}.service" "$(systemctl is-active "user@${uid}.service" 2>/dev/null || true)"
show "sessions for qualified user" "$(loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$QUAL_USER" '$3 == u' | wc -l | tr -d ' ')"
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

  local present=0 node_id created code index
  if load_droplet; then present=1; fi
  node_id="$(state_read ts_node_id)"

  step "Tailnet node removal"
  # A non-ephemeral tagged node leaves a machine record behind when it logs out, and repeated runs of
  # this lane would pile up dead nodes. Logging out stops it advertising; deleting the device record
  # is what actually removes it, and that needs the Tailscale API.
  if [ "$present" -eq 1 ] && [ -n "$DROPLET_IP" ] && ssh_is_up; then
    if [ -z "$node_id" ]; then
      node_id="$(remote_root <<'REMOTE'
tailscale status --json | jq -r '.Self.ID // ""'
REMOTE
)"
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
    for ((index = 1; index <= 30; index++)); do
      droplet_exists_quietly || break
      sleep 5
    done
    droplet_exists_quietly &&
      die "delete was accepted but $DROPLET_NAME is still listed; check the DigitalOcean console"
    measure "$DROPLET_NAME" "deleted and no longer listed"
  fi
  rm -f "$KNOWN_HOSTS" "$STATE_FILE"
  measure "local state" "removed $STATE_DIR entries for $DROPLET_NAME"
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
show "backend via tailnet ip (bypass)" "$(probe "http://${TS_IP}:${GATEWAY_PORT}/api/v1/sessions")"
show "loopback, no identity supplied" "$(probe "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions")"
show "listener addresses" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ')"
REMOTE
  note "403 for the tagged self probe is the denial observable: Serve adds no user identity for a"
  note "tagged source, so the gateway fails closed. The whois lines above are why."

  step "Lane 4b: identity from this workstation, a distinct user-owned node"
  measure "droplet public ip:port" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${public_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-failed)"
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
measure_after_reboot() {
  note "$1, measured from root only, with no session for $QUAL_USER"
  remote_root QUAL_USER="$QUAL_USER" TARGET_UID="$2" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "sessions for qualified user" "$(loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$QUAL_USER" '$3 == u' | wc -l | tr -d ' ')"
show "user@${TARGET_UID}.service" "$(systemctl is-active "user@${TARGET_UID}.service" 2>/dev/null || true)"
pid="$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | head -1 || true)"
show "gateway pid" "${pid:-none}"
if [ -n "$pid" ]; then
  show "daemon age vs system uptime" "process $(ps -o etimes= -p "$pid" | tr -d ' ')s old, system up $(awk '{printf "%d", $1}' /proc/uptime)s"
fi
show "loopback probe (403 = up, closed)" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo request-failed)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
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
  measure_after_reboot "pass A (lingering off)" "$uid"

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
  measure_after_reboot "pass B (lingering on)" "$uid"
  note "Pass B proves persistence only because the session count is zero: the daemon is running with"
  note "nobody logged in, and its age tracks system uptime rather than the age of our connection."
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

cmd_qualify() {
  local lane lanes="$*"
  [ -n "$lanes" ] || lanes="host artifact lifecycle identity persistence uninstall"
  # Reject a typo before anything slow or billable is touched.
  for lane in $lanes; do
    case "$lane" in
      host | artifact | lifecycle | identity | persistence | uninstall) ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle identity persistence uninstall" ;;
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
      identity) lane_identity ;;
      persistence) lane_persistence ;;
      uninstall) lane_uninstall ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle identity persistence uninstall" ;;
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
