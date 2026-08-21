import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_UPSTREAM_CODING_AGENT_VERSION,
  EXPECTED_UPSTREAM_COMMIT,
  runDoctorChecks,
} from "../src/doctor.ts";

/**
 * `compatibilityArtifactsPresent` deliberately hardcodes the upstream identity rather than reading
 * it from the lock it is validating. That duplication is the point — it detects a tampered or
 * mismatched lock — but it silently rots on an upstream refresh. On 2026-08-19 the pin moved to
 * v17.3.8 while these constants still named v17.0.6, and `doctor` reported `compatibility: false`
 * against a correct checkout. Nothing failed, because nothing compared the two.
 */
test("pin contract: doctor's expected upstream identity matches UPSTREAM.lock.json", async () => {
  const lock = JSON.parse(
    await readFile(fileURLToPath(new URL("../../../UPSTREAM.lock.json", import.meta.url)), "utf8"),
  ) as { commit: string; packageVersions: Record<string, string> };

  expect(EXPECTED_UPSTREAM_COMMIT).toBe(lock.commit);
  expect(lock.packageVersions["@oh-my-pi/pi-coding-agent"]).toBe(EXPECTED_UPSTREAM_CODING_AGENT_VERSION);
});

test("pin contract: the shipped patch targets the locked upstream commit", async () => {
  const patch = await readFile(
    fileURLToPath(new URL("../../../patches/oh-my-pi/0001-collab-controller-autostart-registry.patch", import.meta.url)),
    "utf8",
  );

  // The controller and publisher are the two files the compatibility check looks for; if a refresh
  // ever regenerates the mbox without them, the gateway integration is not actually present.
  expect(patch).toContain("packages/coding-agent/src/collab/controller.ts");
  expect(patch).toContain("packages/coding-agent/src/collab/registry-publisher.ts");
});

/**
 * The wiring, not the predicate.
 *
 * `tailscaleTunDevicePresent` has direct unit tests, but nothing exercised its use inside
 * `runDoctorChecks`: the commit that introduced the check said so outright — "removing that wiring
 * leaves the suite green". These cases close that, and they are the reason `runDoctorChecks` takes an
 * injectable probe. Reading the real interface table would make the result depend on whether the
 * machine running the test has Tailscale in TUN mode, and the unsafe topology — the only case worth
 * pinning — cannot be produced on a developer workstation at all.
 *
 * Nothing here asserts `tailscaleConnected`. An earlier version faked `tailscale` on `PATH` to make
 * it an input; that passed on macOS and failed on Linux, because `Bun.spawn` did not resolve the
 * fake there. It was scaffolding rather than the contract: `loopbackTrustSound` is assigned from the
 * injected probe regardless of whether the CLI answered, so the wiring is testable without depending
 * on process spawning at all. Everything network-facing — the daemon probe, the relay probe — is
 * expected to fail in an isolated root, and these assertions deliberately touch only the trust check.
 */
describe("doctor reports the loopback trust topology", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  async function isolatedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gateway-doctor-"));
    for (const part of ["config/omp-session-gateway", "state/omp-session-gateway", "run/omp-session-gateway"]) {
      await mkdir(join(root, part), { recursive: true, mode: 0o700 });
    }
    const configPath = join(root, "config/omp-session-gateway/config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4399, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["doctor@example.com"] },
        registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 10, maxSessions: 10 },
      })}\n`,
    );
    await chmod(configPath, 0o600);
    const tokenPath = join(root, "config/omp-session-gateway/publisher-token");
    await writeFile(tokenPath, "D".repeat(43));
    await chmod(tokenPath, 0o600);

    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.XDG_RUNTIME_DIR = join(root, "run");
    return root;
  }

  test("withholds the loopback claim and names the finding when no tunnel device is present", async () => {
    await isolatedRoot();

    const report = await runDoctorChecks({ tunDevicePresent: () => false });

    expect(report.checks.loopbackTrustSound).toBe(false);
    // Deliberately no assertion on `listenerLoopbackOnly` here. It is computed as
    // `checks.daemon && hostname is loopback`, and no daemon runs in this isolated root, so it is
    // false either way and an assertion on it would discriminate nothing. Proving the *withholding*
    // specifically would need a live daemon on the fixture's port, which is a heavier integration
    // fixture than this secondary claim is worth.
  }, 30_000);

  test("reports sound trust when a tunnel device is present", async () => {
    await isolatedRoot();

    const report = await runDoctorChecks({ tunDevicePresent: () => true });

    expect(report.checks.loopbackTrustSound).toBe(true);
  }, 30_000);

  test("answers from the topology, not from a config that declares trust", async () => {
    const root = await isolatedRoot();
    const configPath = join(root, "config/omp-session-gateway/config.json");
    const document = JSON.parse(await readFile(configPath, "utf8")) as {
      auth: { trustIdentityWithoutTailnetDevice?: boolean };
    };
    document.auth.trustIdentityWithoutTailnetDevice = true;
    await writeFile(configPath, `${JSON.stringify(document)}\n`);
    await chmod(configPath, 0o600);

    const report = await runDoctorChecks({ tunDevicePresent: () => false });

    // The flag asserts trust; it does not establish it. A host that sets it while running
    // userspace-mode tailscaled must still fail here, or the escape hatch would hide the exposure.
    expect(report.checks.loopbackTrustSound).toBe(false);
  }, 30_000);
});

