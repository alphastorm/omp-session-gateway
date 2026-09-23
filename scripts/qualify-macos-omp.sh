#!/usr/bin/env bash
# Exact mainline OMP build and disposable publication process for the retained macOS qualification host.
# The caller owns SSH, the gateway lifecycle, and the PTY. This helper never prints OMP UI output.
set -euo pipefail

command_name="${1:-}"
gateway_root="${OMP_QUAL_GATEWAY_ROOT:-}"
source_commit="${OMP_PIN_SOURCE_COMMIT:-}"
source_tree="${OMP_PIN_SOURCE_TREE:-}"
omp_version="${OMP_PIN_VERSION:-}"
bun_version="${OMP_PIN_BUN_VERSION:-}"
native_tarball_sha256="${OMP_PIN_NATIVE_TARBALL_SHA256:-}"
native_binary_sha256="${OMP_PIN_NATIVE_BINARY_SHA256:-}"
session_label="${OMP_QUAL_SESSION_LABEL:-omp-stable-pixel-qualification}"
bun_executable="${OMP_PIN_BUN_EXECUTABLE:-${HOME:-}/.bun/bin/bun}"

fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
require_value() { [ -n "$2" ] || fail "$1 is required"; }

require_value OMP_QUAL_GATEWAY_ROOT "$gateway_root"
require_value OMP_PIN_SOURCE_COMMIT "$source_commit"
require_value OMP_PIN_SOURCE_TREE "$source_tree"
require_value OMP_PIN_VERSION "$omp_version"
require_value OMP_PIN_BUN_VERSION "$bun_version"
require_value OMP_PIN_NATIVE_TARBALL_SHA256 "$native_tarball_sha256"
require_value OMP_PIN_NATIVE_BINARY_SHA256 "$native_binary_sha256"
case "$session_label" in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) fail "OMP_QUAL_SESSION_LABEL must be a safe single path component" ;;
esac
[ "${#session_label}" -le 128 ] || fail "OMP_QUAL_SESSION_LABEL must not exceed 128 characters"

export PATH="$HOME/.bun/bin:$PATH"
omp_root="$HOME/src/oh-my-pi-gateway-v${omp_version}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${omp_version}-${source_tree:0:8}"
binary="$version_dir/omp"
fixture="${OMP_QUAL_NATIVE_FIXTURE:-$HOME/omp-native-fixture}"
build_log="${OMP_QUAL_BUILD_LOG:-/tmp/omp-stable-mainline-build.log}"
qualification_cwd="$HOME/$session_label"
native_path="$omp_root/packages/natives/native/pi_natives.darwin-arm64.node"
native_tarball_url="https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-${omp_version}.tgz"

validate_host() {
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "mainline OMP stable qualification requires Darwin-arm64"
  local tool
  for tool in git python3 curl shasum tar; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing"
  done
  [ -x "$bun_executable" ] || fail "pinned bun executable is missing"
  [ "$("$bun_executable" --version)" = "$bun_version" ] || fail "bun version does not match the qualification pin"
}

native_file_matches() {
  [ -f "$native_path" ] || return 1
  [ "$(shasum -a 256 "$native_path" | cut -d' ' -f1)" = "$native_binary_sha256" ]
}

source_is_prepared() {
  [ -d "$omp_root/.git" ] || return 1
  [ "$(git -C "$omp_root" rev-parse HEAD 2>/dev/null || true)" = "$source_commit" ] || return 1
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}' 2>/dev/null || true)" = "$source_tree" ] || return 1
  native_file_matches || return 1
  [ -z "$(git -C "$omp_root" status --porcelain --untracked-files=all -- . ":(exclude)packages/natives/native/pi_natives.darwin-arm64.node")" ]
}

prepare_source() {
  if source_is_prepared; then
    printf 'source preparation: resumed exact mainline tree %s\n' "${source_tree:0:12}"
    return
  fi
  rm -rf "$omp_root" "$fixture"
  git clone --filter=blob:none https://github.com/can1357/oh-my-pi.git "$omp_root" >/dev/null 2>&1
  git -C "$omp_root" checkout --detach "$source_commit" >/dev/null 2>&1
  [ "$(git -C "$omp_root" rev-parse HEAD)" = "$source_commit" ] || fail "source checkout does not match the pin"
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}')" = "$source_tree" ] || fail "mainline tree does not match the pin"
  (
    cd "$omp_root"
    "$bun_executable" install --frozen-lockfile >"$build_log" 2>&1
  )
  rm -rf "$fixture"
  mkdir -p "$fixture/unpack"
  curl -fsSL "$native_tarball_url" -o "$fixture/native.tgz"
  printf '%s  %s\n' "$native_tarball_sha256" "$fixture/native.tgz" | shasum -a 256 -c - >/dev/null ||
    fail "native package tarball does not match the qualification pin"
  tar -xzf "$fixture/native.tgz" -C "$fixture/unpack"
  install -m 0644 "$fixture/unpack/package/pi_natives.darwin-arm64.node" "$native_path"
  native_file_matches || fail "native addon does not match the qualification pin"
  rm -rf "$fixture"
  source_is_prepared || fail "mainline OMP working tree contains unpinned changes"
  printf 'source preparation: %s / %s / native %s\n' "${source_commit:0:12}" "${source_tree:0:12}" "${native_binary_sha256:0:12}"
}

build() {
  validate_host
  prepare_source
  : >"$build_log"
  (cd "$omp_root" && "$bun_executable" install --frozen-lockfile) >>"$build_log" 2>&1 || { tail -100 "$build_log" >&2; fail "bun install failed"; }
  set +e
  python3 - "$bun_executable" "$omp_root" "$build_log" <<'PY'
import subprocess
import sys
bun, root, log = sys.argv[1:]
with open(log, "ab") as output:
    subprocess.run(
        [bun, "run", "ci:check:full"],
        cwd=root,
        stdout=output,
        stderr=subprocess.STDOUT,
        timeout=1500,
        check=True,
    )
PY
  check_exit=$?
  set -e
  if [ "$check_exit" -ne 0 ]; then
    tail -100 "$build_log" >&2
    exit "$check_exit"
  fi
  (cd "$omp_root" && "$bun_executable" --cwd=packages/coding-agent run build) >>"$build_log" 2>&1
  [ "$("$omp_root/packages/coding-agent/dist/omp" --version)" = "omp/$omp_version" ] || fail "built OMP version is wrong"

  mkdir -p "$version_dir"
  install -m 0755 "$omp_root/packages/coding-agent/dist/omp" "$binary"
  "$binary" config set collab.autoStart control >/dev/null
  [ "$("$binary" config get collab.autoStart --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')" = control ] || fail "collab.autoStart is wrong"
  source_is_prepared || fail "mainline OMP working tree changed during the build"
  printf '{"version":"%s","sourceCommit":"%s","sourceTree":"%s","nativeSha256":"%s","binarySha256":"%s"}\n' \
    "$omp_version" "$source_commit" "$source_tree" "$native_binary_sha256" \
    "$(shasum -a 256 "$binary" | cut -d' ' -f1)"
}

run_session() {
  validate_host
  [ -x "$binary" ] || fail "mainline OMP binary is missing; run build first"
  source_is_prepared || fail "mainline OMP source or native addon is missing, changed, or unpinned"
  [ "$("$binary" --version)" = "omp/$omp_version" ] || fail "mainline OMP version changed"
  mkdir -p "$qualification_cwd"
  cd "$qualification_cwd"
  exec "$binary" \
    --model openai-codex/gpt-5.4-mini \
    --api-key qualification-synthetic-never-sent \
    --no-extensions --no-skills --thinking low >/dev/null 2>&1
}

live_host_count() {
  python3 - <<'PY'
import errno
import json
import os
import socket
from pathlib import Path

directory = Path.home() / os.environ.get("PI_CONFIG_DIR", ".omp") / "run" / "collab-hosts"
count = 0
for path in directory.glob("*.json"):
    try:
        entry = json.loads(path.read_text())
        pid = entry["pid"]
        if type(pid) is not int or pid < 1:
            continue
    except (OSError, ValueError, KeyError, TypeError):
        continue
    # PIDs can belong to unrelated processes after reuse. Only the published
    # endpoint can prove this host gone; leave OMP-owned discovery files alone.
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(entry["endpoint"])
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            continue
    except (ValueError, KeyError, TypeError):
        pass
    count += 1
print(count)
PY
}

clean() {
  local process_ids="" process_id waits=0
  process_ids="$(pgrep -f "$binary.*--api-key qualification-synthetic-never-sent" || true)"
  if [ -n "$process_ids" ]; then
    while IFS= read -r process_id; do
      [ -z "$process_id" ] || kill -TERM "$process_id" >/dev/null 2>&1 || true
    done <<<"$process_ids"
  fi
  while [ "$waits" -lt 10 ]; do
    process_ids="$(pgrep -f "$binary.*--api-key qualification-synthetic-never-sent" || true)"
    [ -z "$process_ids" ] && break
    sleep 1
    waits=$((waits + 1))
  done
  if [ -n "$process_ids" ]; then
    while IFS= read -r process_id; do
      [ -z "$process_id" ] || kill -KILL "$process_id" >/dev/null 2>&1 || true
    done <<<"$process_ids"
    sleep 1
  fi
  local live_hosts binary_present source_present
  live_hosts="$(live_host_count)"
  rm -rf "$version_dir" "$omp_root" "$fixture" "$qualification_cwd"
  rm -f "$build_log"
  binary_present="$([ -e "$binary" ] && echo true || echo false)"
  source_present="$([ -e "$omp_root" ] && echo true || echo false)"
  printf '{"liveOmpHosts":%s,"binaryPresent":%s,"sourcePresent":%s}\n' \
    "$live_hosts" "$binary_present" "$source_present"
  [ "$live_hosts:$binary_present:$source_present" = "0:false:false" ] || fail "mainline OMP cleanup left qualification state"
}

case "$command_name" in
  build) build ;;
  run) run_session ;;
  clean) clean ;;
  *) printf 'usage: %s build|run|clean\n' "$0" >&2; exit 64 ;;
esac
