import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.ts";

test("rejects misspelled mutation options before side effects", async () => {
  await expect(main(["uninstall", "--no-stpo"])).rejects.toThrow("unknown option for uninstall");
  await expect(main(["install", "--origin", "https://gateway.example.ts.net", "--no-strat"])).rejects.toThrow(
    "unknown option for install",
  );
  await expect(main(["rotate-publisher-token", "--force"])).rejects.toThrow(
    "unknown option for rotate-publisher-token",
  );
});

test("rejects missing option values before mutation", async () => {
  await expect(main(["install", "--origin", "https://gateway.example.ts.net", "--allow"])).rejects.toThrow(
    "--allow requires a value",
  );
  await expect(main(["install", "--origin", "--allow", "user@example.com"])).rejects.toThrow(
    "--origin requires a value",
  );
});

test("exits promptly and closes staged resources when HTTP startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-startup-"));
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const port = occupied.port;
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "apps/gateway/src/cli.ts",
      "serve",
      "--dev-localhost",
      "--port",
      String(port),
      "--origin",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: join(root, "run"),
        TMPDIR: join(root, "tmp"),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    const result = await Promise.race([
      subprocess.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
    ]);
    if (result.kind === "timeout") {
      subprocess.kill(9);
      throw new Error("gateway remained alive after HTTP startup failed");
    }
    expect(result.exitCode).not.toBe(0);
    expect(await new Response(subprocess.stderr).text()).toMatch(/address already in use|port \d+ in use/iu);
  } finally {
    occupied.stop(true);
    if (subprocess.exitCode === null) subprocess.kill(9);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
