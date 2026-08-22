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
session_label="${OMP_QUAL_SESSION_LABEL:-omp-stable-pixel-qualification}"

fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
require_value() { [ -n "$2" ] || fail "$1 is required"; }

require_value OMP_QUAL_GATEWAY_ROOT "$gateway_root"
require_value OMP_PIN_SOURCE_COMMIT "$source_commit"
require_value OMP_PIN_PATCHED_TREE "$patched_tree"
require_value OMP_PIN_VERSION "$omp_version"
require_value OMP_PIN_BUN_VERSION "$bun_version"
case "$session_label" in
  *[!A-Za-z0-9._-]* | "") fail "OMP_QUAL_SESSION_LABEL must contain only letters, digits, dot, underscore, and hyphen" ;;
esac

export PATH="$HOME/.bun/bin:$PATH"
omp_root="$HOME/src/oh-my-pi-gateway-v${omp_version}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${omp_version}-${patched_tree:0:8}"
binary="$version_dir/omp"
symlink="$HOME/.local/bin/omp-gateway-patched"
fixture="$HOME/omp-native-fixture"
build_log="/tmp/omp-stable-patched-build.log"
qualification_cwd="$HOME/$session_label"
patch="$gateway_root/patches/oh-my-pi/0001-collab-controller-autostart-registry.patch"

validate_host() {
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "patched OMP stable qualification requires Darwin-arm64"
  command -v bun >/dev/null 2>&1 || fail "bun is missing"
  command -v git >/dev/null 2>&1 || fail "git is missing"
  command -v python3 >/dev/null 2>&1 || fail "python3 is missing"
  [ "$(bun --version)" = "$bun_version" ] || fail "bun version does not match the qualification pin"
  [ -f "$patch" ] || fail "candidate artifact is missing the OMP patch"
}

source_is_prepared() {
  [ -d "$omp_root/.git" ] || return 1
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}' 2>/dev/null || true)" = "$patched_tree" ] || return 1
  [ -f "$omp_root/packages/natives/native/pi_natives.darwin-arm64.node" ]
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
    bun install --frozen-lockfile >"$build_log" 2>&1
  )
  mkdir -p "$fixture"
  printf '%s\n' "{\"private\":true,\"dependencies\":{\"@oh-my-pi/pi-natives\":\"$omp_version\"}}" >"$fixture/package.json"
  (cd "$fixture" && bun install) >>"$build_log" 2>&1
  cp "$fixture/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node" \
    "$omp_root/packages/natives/native/pi_natives.darwin-arm64.node"
  rm -rf "$fixture"
  printf 'source preparation: %s / %s\n' "${source_commit:0:12}" "${patched_tree:0:12}"
}

build() {
  validate_host
  prepare_source
  : >"$build_log"
  (cd "$omp_root" && bun install --frozen-lockfile) >>"$build_log" 2>&1 || { tail -100 "$build_log" >&2; fail "bun install failed"; }
  set +e
  python3 - "$HOME/.bun/bin/bun" "$omp_root" "$build_log" <<'PY'
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
  (cd "$omp_root" && bun --cwd=packages/coding-agent run build) >>"$build_log" 2>&1
  [ "$("$omp_root/packages/coding-agent/dist/omp" --version)" = "omp/$omp_version" ] || fail "built OMP version is wrong"

  mkdir -p "$version_dir" "$HOME/.local/bin"
  install -m 0755 "$omp_root/packages/coding-agent/dist/omp" "$binary"
  ln -sfn "$binary" "$symlink"
  [ "$(readlink "$symlink")" = "$binary" ] || fail "versioned OMP symlink is wrong"
  "$symlink" config set collab.autoStart control >/dev/null
  "$symlink" config set collab.registryEndpoint auto >/dev/null
  [ "$("$symlink" config get collab.autoStart --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')" = control ] || fail "collab.autoStart is wrong"
  [ "$("$symlink" config get collab.registryEndpoint --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')" = auto ] || fail "collab.registryEndpoint is wrong"

  printf '{"version":"%s","sourceCommit":"%s","patchedTree":"%s","binarySha256":"%s","symlink":"%s"}\n' \
    "$omp_version" "$source_commit" "$patched_tree" "$(shasum -a 256 "$binary" | cut -d' ' -f1)" "$(readlink "$symlink")"
}

run_session() {
  validate_host
  [ -x "$binary" ] || fail "patched OMP binary is missing; run build first"
  [ "$(readlink "$symlink" 2>/dev/null || true)" = "$binary" ] || fail "patched OMP symlink does not name the qualified binary"
  [ "$(git -C "$omp_root" rev-parse 'HEAD^{tree}' 2>/dev/null || true)" = "$patched_tree" ] || fail "patched OMP source tree is missing or wrong"
  [ "$("$symlink" --version)" = "omp/$omp_version" ] || fail "patched OMP version changed"
  mkdir -p "$qualification_cwd"
  cd "$qualification_cwd"
  exec "$symlink" \
    --model openai-codex/gpt-5.4-mini \
    --api-key qualification-synthetic-never-sent \
    --no-extensions --no-skills --thinking low >/dev/null 2>&1
}

clean() {
  pkill -TERM -f 'omp-gateway-patched.*--api-key qualification-synthetic-never-sent' >/dev/null 2>&1 || true
  sleep 1
  if [ "$(readlink "$symlink" 2>/dev/null || true)" = "$binary" ]; then rm -f "$symlink"; fi
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
