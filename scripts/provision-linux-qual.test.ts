import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

test.skipIf(process.platform === "win32")("rollback refuses a non-private predecessor config before service operations", async () => {
  const home = await mkdtemp(join(tmpdir(), "omp-rollback-config-private-"));
  const state = join(home, ".local", "state", "omp-session-gateway");
  const backup = join(state, "pre-mainline-config.json");
  const bin = join(home, "bin");
  const managerMarker = join(home, "service-touched");
  await Promise.all([mkdir(state, { recursive: true }), mkdir(bin)]);
  await writeFile(backup, '{"http":{"port":47419}}', { mode: 0o644 });
  // `mode` is filtered by the umask; a 077 umask would silently make the backup private.
  await chmod(backup, 0o644);
  await writeFile(join(home, "runtime-root"), "unused");
  await writeFile(join(bin, "systemctl"), '#!/bin/sh\ntouch "$MANAGER_MARKER"\nexit 90\n', { mode: 0o700 });
  const harness = `
source "$1"
require_dns_name() { printf qual.example.invalid; }
remote_user() { env "$@" bash -se; }
if [ "$(uname -s)" = Darwin ]; then
  stat() { /usr/bin/stat -f '%Lp' "\${@: -1}"; }
  export -f stat
fi
lane_rollback
`;
  try {
    const child = Bun.spawn(["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, MANAGER_MARKER: managerMarker },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("predecessor config backup private");
    expect(await Bun.file(managerMarker).exists()).toBe(false);
    expect(await Bun.file(backup).text()).toBe('{"http":{"port":47419}}');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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

test.skipIf(process.platform === "win32")("zero-input remote framing executes the supplied script", async () => {
  const harness = `
set -euo pipefail
source "$1"
DROPLET_IP=synthetic
SSH_OPTS=(-o synthetic)
ssh() {
  local command="" argument
  for argument in "$@"; do command="$argument"; done
  eval "$command"
}
remote_root <<'REMOTE'
printf zero-input-script-ran
REMOTE
`;
  const child = Bun.spawn(
    ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")],
    { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "zero-input-script-ran",
    stderr: "",
  });
});

test.skipIf(process.platform === "win32")(
  "release metadata distinguishes installed runtimes with identical CLIs",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-runtime-identity-test-"));
    const predecessorRoot = join(temporaryRoot, "predecessor");
    const candidateRoot = join(temporaryRoot, "candidate");
    const versionsRoot = join(temporaryRoot, "versions");
    const predecessorVersion = join(versionsRoot, "0.1.0-predecessor");
    const candidateVersion = join(versionsRoot, "0.1.0-candidate");
    const predecessorInfo = '{"sourceCommit":"predecessor"}\n';
    const candidateInfo = '{"sourceCommit":"candidate"}\n';
    const cliRelative = join("apps", "gateway", "src", "cli.js");
    for (const directory of [predecessorRoot, candidateRoot, predecessorVersion, candidateVersion]) {
      await mkdir(join(directory, "apps", "gateway", "src"), { recursive: true });
      await writeFile(join(directory, cliRelative), "identical-cli-bytes");
    }
    await Promise.all([
      writeFile(join(predecessorRoot, "release-info.json"), predecessorInfo),
      writeFile(join(predecessorVersion, "release-info.json"), predecessorInfo),
      writeFile(join(candidateRoot, "release-info.json"), candidateInfo),
      writeFile(join(candidateVersion, "release-info.json"), candidateInfo),
    ]);
    const run = async (archiveRoot: string) => {
      const child = Bun.spawn(
        [
          "/bin/bash",
          "-c",
          'source "$1"; identify_version_by_release_info "$2" "$3"',
          "test",
          join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"),
          archiveRoot,
          versionsRoot,
        ],
        { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    try {
      expect(await run(predecessorRoot)).toEqual({
        exitCode: 0,
        stdout: "0.1.0-predecessor",
        stderr: "",
      });
      expect(await run(candidateRoot)).toEqual({
        exitCode: 0,
        stdout: "0.1.0-candidate",
        stderr: "",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "SSH key preflight waits out DigitalOcean read-after-create lag, but only for a bounded window",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-key-consistency-"));
    const bin = join(temporaryRoot, "bin");
    const identity = join(temporaryRoot, "id_ed25519");
    const calls = join(temporaryRoot, "doctl-calls");
    await mkdir(bin);
    expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", identity]).exitCode).toBe(0);
    const fingerprint = Bun.spawnSync(["ssh-keygen", "-l", "-E", "md5", "-f", `${identity}.pub`])
      .stdout.toString()
      .split(/\s+/u)[1]
      ?.replace(/^MD5:/u, "");
    // Stands in for DigitalOcean serving a freshly created key as "not found" for a while.
    await writeFile(
      join(bin, "doctl"),
      `#!/bin/bash
count=$(( $(cat "$DOCTL_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$count" >"$DOCTL_CALLS"
if [ "$count" -lt "$DOCTL_READABLE_AT" ]; then
  echo 'Error: GET https://api.digitalocean.com/v2/account/keys/4242: 404 The resource you were accessing could not be found.' >&2
  exit 1
fi
printf '[{"id":4242,"name":"omp-qual-ci-test-1","fingerprint":"%s"}]\\n' "$KEY_FINGERPRINT"
`,
      { mode: 0o700 },
    );
    const run = async (readableAt: number) => {
      await rm(calls, { force: true });
      const child = Bun.spawn(
        ["/bin/bash", "-c", 'source "$1"; sleep() { :; }; preflight_ssh_key', "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            OMP_QUAL_SSH_KEY_ID: "4242",
            OMP_QUAL_SSH_IDENTITY: identity,
            DOCTL_CALLS: calls,
            DOCTL_READABLE_AT: String(readableAt),
            KEY_FINGERPRINT: fingerprint ?? "",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, reads: Number.parseInt(await Bun.file(calls).text(), 10) };
    };
    try {
      // Readable only on the eighth read, past the former five-read window.
      const lagged = await run(8);
      expect(lagged.exitCode).toBe(0);
      expect(lagged.stdout).toContain("matching local private key");
      expect(lagged.reads).toBe(8);

      const absent = await run(1_000);
      expect(absent.exitCode).toBe(1);
      expect(absent.stderr).toContain("did not resolve after 11 attempts");
      expect(absent.stderr).toContain("404 The resource you were accessing could not be found.");
      expect(absent.reads).toBe(11);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
