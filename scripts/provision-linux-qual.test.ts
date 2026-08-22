import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

test.skipIf(process.platform === "win32")(
  "fresh NeedsLogin state uses bounded login rather than up",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-tailnet-login-test-"));
    const localTemp = join(temporaryRoot, "local");
    const remoteTemp = join(temporaryRoot, "remote");
    const bin = join(temporaryRoot, "bin");
    const argsPath = join(temporaryRoot, "tailscale-args");
    await Promise.all([mkdir(localTemp), mkdir(remoteTemp), mkdir(bin)]);
    const fakeTailscale = join(bin, "tailscale");
    await writeFile(
      fakeTailscale,
      `#!/bin/bash
set -euo pipefail
echo "$*" >"$TEST_ARGS"
[ "$1" = login ]
auth_file=""
for argument in "$@"; do
  case "$argument" in --auth-key=file:*) auth_file="$(echo "$argument" | sed 's/^--auth-key=file://')" ;; esac
done
[ -s "$auth_file" ]
[ "$(cat "$auth_file")" = "$EXPECTED_KEY" ]
`,
    );
    await chmod(fakeTailscale, 0o700);

    const harness = `
set -euo pipefail
source "$1"
local_tmp="$2"
remote_tmp="$3"
LOCAL_TEMP="$local_tmp"
DROPLET_IP=synthetic
TS_AUTHKEY=tskey-auth-test-secret
SSH_OPTS=(-o synthetic)
export TEST_ARGS="$4"
export EXPECTED_KEY="$TS_AUTHKEY"
ssh() {
  case "$*" in
    *"cat > /root/.ts-authkey"*) umask 077; cat >"$remote_tmp/authkey" ;;
    *"rm -f /root/.ts-authkey"*) rm -f "$remote_tmp/authkey" ;;
    *) return 1 ;;
  esac
}
remote_root() {
  local script
  script="$(cat)"
  script="$(echo "$script" | sed "s#/root/.ts-authkey#$remote_tmp/authkey#g")"
  PATH="$local_tmp/../bin:$PATH" bash -c "$script"
}
join_tailnet
test ! -e "$local_tmp/authkey"
test ! -e "$remote_tmp/authkey"
grep -q '^login ' "$TEST_ARGS"
grep -q -- '--auth-key=file:' "$TEST_ARGS"
grep -q -- '--timeout=120s' "$TEST_ARGS"
`;
    try {
      const child = Bun.spawn(
        ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"), localTemp, remoteTemp, argsPath],
        { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(await Bun.file(argsPath).text()).toStartWith("login ");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
