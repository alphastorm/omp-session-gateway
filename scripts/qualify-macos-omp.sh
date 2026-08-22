#!/usr/bin/env bash
# Exact patched-OMP build and disposable publication process for the retained macOS qualification host.
# The caller owns SSH, the gateway lifecycle, and the PTY. This helper never prints OMP UI output.
set -euo pipefail

command_name="${1:-}"
gateway_root="${OMP_QUAL_GATEWAY_ROOT:-}"
source_commit="${OMP_PIN_SOURCE_COMMIT:-}"
patched_tree="${OMP_PIN_PATCHED_TREE:-}"
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
require_value OMP_PIN_PATCHED_TREE "$patched_tree"
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
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${omp_version}-${patched_tree:0:8}"
binary="$version_dir/omp"
symlink="$HOME/.local/bin/omp-gateway-patched"
fixture="${OMP_QUAL_NATIVE_FIXTURE:-$HOME/omp-native-fixture}"
build_log="${OMP_QUAL_BUILD_LOG:-/tmp/omp-stable-patched-build.log}"
qualification_cwd="$HOME/$session_label"
patch="$gateway_root/patches/oh-my-pi/0001-collab-controller-autostart-registry.patch"
native_path="$omp_root/packages/natives/native/pi_natives.darwin-arm64.node"
native_tarball_url="https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-${omp_version}.tgz"

validate_host() {
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "patched OMP stable qualification requires Darwin-arm64"
  local tool
  for tool in git python3 curl shasum tar; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing"
  done
  [ -x "$bun_executable" ] || fail "pinned bun executable is missing"
  [ "$("$bun_executable" --version)" = "$bun_version" ] || fail "bun version does not match the qualification pin"
  [ -f "$patch" ] || fail "candidate artifact is missing the OMP patch"
}

native_file_matches() {
  [ -f "$native_path" ] || return 1
  [ "$(shasum -a 256 "$native_path" | cut -d' ' -f1)" = "$native_binary_sha256" ]
}

source_is_prepared() {
  [ -d "$omp_root/.git" ] || return 1
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}' 2>/dev/null || true)" = "$patched_tree" ] || return 1
  native_file_matches || return 1
  [ -z "$(git -C "$omp_root" status --porcelain --untracked-files=all -- . ":(exclude)packages/natives/native/pi_natives.darwin-arm64.node")" ]
}

prepare_source() {
  if source_is_prepared; then
    printf 'source preparation: resumed exact patched tree %s\n' "${patched_tree:0:12}"
    return
  fi
  rm -rf "$omp_root" "$fixture"
  git clone --filter=blob:none https://github.com/can1357/oh-my-pi.git "$omp_root" >/dev/null 2>&1
  git -C "$omp_root" checkout --detach "$source_commit" >/dev/null 2>&1
  [ "$(git -C "$omp_root" rev-parse HEAD)" = "$source_commit" ] || fail "source checkout does not match the pin"
  git -C "$omp_root" -c user.name=omp-session-gateway -c user.email=qual@example.invalid am "$patch" >/dev/null 2>&1
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}')" = "$patched_tree" ] || fail "patched tree does not match the pin"
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
  source_is_prepared || fail "patched OMP working tree contains unpinned changes"
  printf 'source preparation: %s / %s / native %s\n' "${source_commit:0:12}" "${patched_tree:0:12}" "${native_binary_sha256:0:12}"
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

  mkdir -p "$version_dir" "$HOME/.local/bin"
  install -m 0755 "$omp_root/packages/coding-agent/dist/omp" "$binary"
  ln -sfn "$binary" "$symlink"
  [ "$(readlink "$symlink")" = "$binary" ] || fail "versioned OMP symlink is wrong"
  "$symlink" config set collab.autoStart control >/dev/null
  "$symlink" config set collab.registryEndpoint auto >/dev/null
  [ "$("$symlink" config get collab.autoStart --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')" = control ] || fail "collab.autoStart is wrong"
  [ "$("$symlink" config get collab.registryEndpoint --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')" = auto ] || fail "collab.registryEndpoint is wrong"
  source_is_prepared || fail "patched OMP working tree changed during the build"
  printf '{"version":"%s","sourceCommit":"%s","patchedTree":"%s","nativeSha256":"%s","binarySha256":"%s","symlink":"%s"}\n' \
    "$omp_version" "$source_commit" "$patched_tree" "$native_binary_sha256" \
    "$(shasum -a 256 "$binary" | cut -d' ' -f1)" "$(readlink "$symlink")"
}

run_session() {
  validate_host
  [ -x "$binary" ] || fail "patched OMP binary is missing; run build first"
  [ "$(readlink "$symlink" 2>/dev/null || true)" = "$binary" ] || fail "patched OMP symlink does not name the qualified binary"
  source_is_prepared || fail "patched OMP source or native addon is missing, changed, or unpinned"
  [ "$("$symlink" --version)" = "omp/$omp_version" ] || fail "patched OMP version changed"
  mkdir -p "$qualification_cwd"
  cd "$qualification_cwd"
  exec "$symlink" \
    --model openai-codex/gpt-5.4-mini \
    --api-key qualification-synthetic-never-sent \
    --no-extensions --no-skills --thinking low >/dev/null 2>&1
}

clean() {
  local process_ids="" process_id waits=0
  process_ids="$(pgrep -f 'omp-gateway-patched.*--api-key qualification-synthetic-never-sent' || true)"
  if [ -n "$process_ids" ]; then
    while IFS= read -r process_id; do
      [ -z "$process_id" ] || kill -TERM "$process_id" >/dev/null 2>&1 || true
    done <<<"$process_ids"
  fi
  while [ "$waits" -lt 10 ]; do
    process_ids="$(pgrep -f 'omp-gateway-patched.*--api-key qualification-synthetic-never-sent' || true)"
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
  rm -rf "$version_dir" "$omp_root" "$fixture" "$qualification_cwd"
  rm -f "$build_log"
  local process_count symlink_present source_present
  process_count="$( (pgrep -f 'omp-gateway-patched.*--api-key qualification-synthetic-never-sent' || true) | wc -l | tr -d ' ')"
  symlink_present="$([ -e "$symlink" ] && echo true || echo false)"
  source_present="$([ -e "$omp_root" ] && echo true || echo false)"
  printf '{"patchedOmpProcessCount":%s,"symlinkPresent":%s,"sourcePresent":%s}\n' \
    "$process_count" "$symlink_present" "$source_present"
  [ "$process_count:$symlink_present:$source_present" = "0:false:false" ] || fail "patched OMP cleanup left qualification state"
}

case "$command_name" in
  build) build ;;
  run) run_session ;;
  clean) clean ;;
  *) printf 'usage: %s build|run|clean\n' "$0" >&2; exit 64 ;;
esac
