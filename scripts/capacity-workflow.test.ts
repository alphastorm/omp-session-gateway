import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatewayConfig } from "../apps/gateway/src/config.ts";

test.skipIf(process.platform === "win32")("capacity workflow config loads through the real gateway parser", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/capacity-qualification.yml", import.meta.url)).text()) as {
    jobs: Record<string, { steps: { run?: string }[] }>;
  };
  const scripts = Object.values(workflow.jobs).flatMap(job => job.steps.flatMap(step => step.run ?? []));
  const heredocs = scripts.flatMap(script => [...script.matchAll(/cat >"\$evidence\/gateway-config\.json" <<JSON\n([\s\S]*?)\nJSON/g)]);
  expect(heredocs).toHaveLength(1);
  const root = await mkdtemp(join(tmpdir(), "omp-capacity-config-"));
  try {
    const variables: Record<string, string> = {
      CAPACITY_PORT: "4317",
      CAPACITY_ORIGIN: "https://capacity.example.test",
      CAPACITY_LOGIN: "capacity@example.test",
      root,
    };
    const document = heredocs[0]![1]!.replace(/\$(?:\{([A-Za-z_][A-Za-z_0-9]*)\}|([A-Za-z_][A-Za-z_0-9]*))/g, (_match, braced: string | undefined, bare: string | undefined) => {
      const name = (braced ?? bare)!;
      const value = variables[name];
      if (value === undefined) throw new Error(`missing synthetic shell variable: ${name}`);
      return value;
    });
    const configPath = join(root, "config.json");
    await writeFile(configPath, document, { mode: 0o600 });
    const config = await loadGatewayConfig({ configPath });
    expect(config.http.publicOrigin).toBe(variables.CAPACITY_ORIGIN!);
    expect(config.auth).toEqual({
      mode: "tailscale-serve",
      allowedLogins: [variables.CAPACITY_LOGIN!],
      trustIdentityWithoutTailnetDevice: true,
    });
    expect(config.omp.discoveryDir).toBe(join(root, "run", "collab-hosts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
