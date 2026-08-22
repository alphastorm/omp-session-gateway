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
    const bin = join(temporaryRoot, "bin");
    const argsPath = join(temporaryRoot, "tailscale-args");
    await mkdir(bin);
    const fakeTailscale = join(bin, "tailscale");
    await writeFile(
      fakeTailscale,
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >"$TEST_ARGS"
[ "$1" = login ]
`,
    );
    await chmod(fakeTailscale, 0o700);

    const harness = `
set -euo pipefail
source "$1"
tmp="$2"
LOCAL_TEMP="$tmp"
DROPLET_IP=synthetic
TS_AUTHKEY=tskey-auth-test-secret
SSH_OPTS=(-o synthetic)
export TEST_ARGS="$3"
ssh() {
  case "$*" in
    *"cat > /root/.ts-authkey"*) umask 077; cat >"$tmp/authkey" ;;
    *"rm -f /root/.ts-authkey"*) rm -f "$tmp/authkey" ;;
    *) return 1 ;;
  esac
}
remote_root() {
  local script
  script="$(cat)"
  script="\${script//\\/root\\/.ts-authkey/$tmp/authkey}"
  PATH="$tmp/bin:$PATH" bash -c "$script"
}
join_tailnet
test ! -e "$tmp/authkey"
grep -q '^login ' "$TEST_ARGS"
grep -q -- '--auth-key=file:' "$TEST_ARGS"
grep -q -- '--timeout=120s' "$TEST_ARGS"
`;
    try {
      const child = Bun.spawn(
        ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"), temporaryRoot, argsPath],
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
