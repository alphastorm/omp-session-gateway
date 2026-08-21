import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

/**
 * The option table in `cli.ts` is the whole guard between a mistyped operator command and a
 * destructive side effect, and `validateCommandOptions` silently accepts *every* option for a
 * command it has no entry for. Restating the surface here turns that silent hole into a failure:
 * `usage advertises exactly the commands whose options are validated` fails when a command is added
 * to the CLI without being added below, and the refusal loop then covers it automatically.
 */
const COMMAND_SURFACE: Readonly<Record<string, readonly string[]>> = {
  serve: ["--dev-localhost", "--port", "--origin", "--readiness-instance"],
  install: ["--origin", "--allow", "--port", "--no-start"],
  uninstall: ["--no-stop"],
  rollback: ["--to"],
  status: [],
  doctor: ["--bundle", "--output"],
  "rotate-publisher-token": [],
  "serve-guidance": [],
  help: [],
  "--help": [],
};

const EVERY_OPTION: readonly string[] = [...new Set(Object.values(COMMAND_SURFACE).flat())];
const REPOSITORY_ROOT = new URL("../../..", import.meta.url).pathname;
const GATEWAY_CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface SandboxRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Sandbox-relative paths of everything the run wrote for the gateway; empty means no mutation. */
  readonly artifacts: readonly string[];
}

/**
 * Runs the CLI with every path it writes to redirected inside a throwaway root, so a refusal that
 * regressed into a side effect shows up as an artifact rather than as damage to the developer's
 * machine. `readdir` is filtered rather than compared wholesale because Bun itself populates
 * `$HOME/Library/Caches/bun` in the sandbox.
 */
async function runInSandbox(
  build: (root: string) => Promise<readonly string[]> | readonly string[],
): Promise<SandboxRun> {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-argv-"));
  try {
    const command = await build(root);
    const subprocess = Bun.spawn([...command], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: join(root, "run"),
        TMPDIR: join(root, "tmp"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // A real deadline, not a guessed settling delay: every assertion here is about a CLI that
      // must refuse and exit, so the only thing this races is a hang. The passing path never waits,
      // because `exited` wins as soon as the process is gone.
      const exited = await Promise.race([subprocess.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) subprocess.kill(9);
      const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      const exitCode = await subprocess.exited;
      if (!exited) throw new Error(`the gateway CLI never exited: ${stderr}`);
      const entries = await readdir(root, { recursive: true });
      return {
        exitCode,
        stdout,
        stderr,
        artifacts: entries.filter(entry => entry.includes("omp-session-gateway")).sort(),
      };
    } finally {
      if (subprocess.exitCode === null) subprocess.kill(9);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(argv: readonly string[]): Promise<SandboxRun> {
  return runInSandbox(() => [process.execPath, "apps/gateway/src/cli.ts", ...argv]);
}

/**
 * Stands in for the installed `omp-gatewayd` entry point: same import of `main`, same
 * message-only failure reporting as the `import.meta.main` block in `cli.ts`. The file's *name* is
 * the subject under test, so it is written per run rather than reused.
 */
const DAEMON_ENTRY = `import { main } from ${JSON.stringify(GATEWAY_CLI)};
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

describe("command dispatch", () => {
  test("refuses an unrecognised verb rather than dispatching a neighbour", async () => {
    // `omp-gateway ""` is what an unset shell variable expands to, and `-h` is what an operator
    // types before reading the usage text; neither may resolve to a command.
    for (const verb of ["bogus", "uninstal", "roll-back", "Serve", "install-service", "-h", "--hlep", ""]) {
      await expect(main([verb])).rejects.toThrow(`unknown command: ${verb}`);
    }
  });

  test("reports the unknown verb, not its options, when both are wrong", async () => {
    // `validateCommandOptions` returns early for commands it does not know. A mistyped verb must
    // therefore surface as a verb problem, or the operator retypes the option and stays stuck.
    await expect(main(["uninstal", "--no-stop"])).rejects.toThrow("unknown command: uninstal");
    await expect(main(["rollbak", "--to=0.1.0-0123456789ab"])).rejects.toThrow("unknown command: rollbak");
    await expect(main(["insatll", "--origin=https://gateway.example.ts.net"])).rejects.toThrow(
      "unknown command: insatll",
    );
  });

  test("exits non-zero on an unknown verb without creating gateway state", async () => {
    const run = await runCli(["uninstal"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("unknown command: uninstal");
    expect(run.artifacts).toEqual([]);
  }, 10_000);
});

describe("per-command option table", () => {
  test("every command refuses another command's options and an invented one", async () => {
    for (const [command, own] of Object.entries(COMMAND_SURFACE)) {
      for (const option of [...EVERY_OPTION, "--not-an-option"]) {
        if (own.includes(option)) continue;
        await expect(main([command, `${option}=value`])).rejects.toThrow(`unknown option for ${command}: ${option}`);
      }
    }
  });

  test("each command's own options reach its handler instead of being refused as unknown", async () => {
    // Without this control the loop above would still pass if the table refused everything. Each
    // shape below carries all of a command's own options and is refused for a *later*, in-process
    // reason, which proves the option names themselves were accepted.
    // `doctor` has no such shape: `runDoctorChecks` spawns `tailscale` and reaches the network
    // before its options are read, so its accepted-option side stays uncovered here.
    await expect(
      main([
        "serve",
        "--dev-localhost",
        "--port=4317",
        "--origin=http://127.0.0.1:4317",
        "--readiness-instance=short",
      ]),
    ).rejects.toThrow("--readiness-instance must be a 256-bit base64url value");
    await expect(main(["install", "--allow=user@example.com", "--port=4317", "--no-start"])).rejects.toThrow(
      "install requires --origin",
    );
    await expect(main(["uninstall", "--no-stop=yes"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["rollback", "--to"])).rejects.toThrow("--to requires a value");
  });

  test("usage advertises exactly the commands whose options are validated", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    // `omp-gatewayd` is the daemon binary, not a verb, so it must not match.
    const advertised = [...stdout.matchAll(/^\s+omp-gateway ([a-z-]+)/gmu)].flatMap(match => match[1] ?? []);
    expect(advertised.length).toBeGreaterThan(0);
    expect([...new Set(advertised)].sort()).toEqual(
      Object.keys(COMMAND_SURFACE)
        .filter(command => command !== "help" && command !== "--help")
        .sort(),
    );
  }, 10_000);
});

describe("option arity and values", () => {
  test("refuses every value-taking option when its value is absent", async () => {
    // `--output` is missing from this list deliberately: `runDoctor` only reads it inside the
    // `--bundle` branch, after `runDoctorChecks` has already probed the daemon and the network, so
    // the refusal is unreachable without a live host.
    const missing: readonly (readonly [string[], string])[] = [
      [["serve", "--port"], "--port requires a value"],
      [["serve", "--origin"], "--origin requires a value"],
      [["serve", "--readiness-instance"], "--readiness-instance requires a value"],
      [["install", "--origin"], "--origin requires a value"],
      [["install", "--origin=https://gateway.example.ts.net", "--allow"], "--allow requires a value"],
      [["install", "--origin=https://gateway.example.ts.net", "--port"], "--port requires a value"],
      [["rollback", "--to"], "--to requires a value"],
    ];
    for (const [argv, message] of missing) {
      await expect(main(argv)).rejects.toThrow(message);
    }
  });

  test("never swallows the next option as the previous option's value", async () => {
    await expect(main(["serve", "--port", "--origin=http://127.0.0.1:4317"])).rejects.toThrow(
      "--port requires a value",
    );
    await expect(main(["serve", "--origin", "--dev-localhost"])).rejects.toThrow("--origin requires a value");
    // A later value for the same option does not rescue the bare one: the sentinel wins over arity.
    await expect(main(["rollback", "--to", "--to=0.1.0-0123456789ab"])).rejects.toThrow("--to requires a value");
  });

  test("refuses an unknown option before complaining that a known one lacks a value", async () => {
    // Ordering matters for the destructive verbs: the table is checked before any handler runs, so
    // `uninstall --force` must never reach `uninstallUserService`.
    await expect(main(["uninstall", "--force"])).rejects.toThrow("unknown option for uninstall: --force");
    await expect(main(["serve", "--allow"])).rejects.toThrow("unknown option for serve: --allow");
  });

  test("refuses a repeated single-valued option instead of silently picking one", async () => {
    const repeated: readonly (readonly [string[], string])[] = [
      [["serve", "--port=4317", "--port=4318"], "--port may be supplied once"],
      [["serve", "--origin=http://127.0.0.1:4317", "--origin=http://127.0.0.1:4318"], "--origin may be supplied once"],
      [["serve", "--dev-localhost", "--dev-localhost"], "--dev-localhost may be supplied once"],
      [["serve", "--readiness-instance=a", "--readiness-instance=b"], "--readiness-instance may be supplied once"],
      [
        ["install", "--origin=https://gateway.example.ts.net", "--origin=https://other.example.ts.net"],
        "--origin may be supplied once",
      ],
      [["uninstall", "--no-stop", "--no-stop"], "--no-stop may be supplied once"],
      [["rollback", "--to=0.1.0-0123456789ab", "--to=0.1.0-ba9876543210"], "--to may be supplied once"],
    ];
    for (const [argv, message] of repeated) {
      await expect(main(argv)).rejects.toThrow(message);
    }
    // `--allow` is the one option that accumulates: repeating it must not be an arity error. The
    // refusal here is the absent `--origin`, which is only reached once both values are accepted.
    await expect(main(["install", "--allow=user@example.com", "--allow=other@example.com"])).rejects.toThrow(
      "install requires --origin",
    );
  });

  test("refuses a bare positional argument after the command", async () => {
    await expect(main(["serve", "port"])).rejects.toThrow("unexpected argument: port");
    await expect(main(["install", "--origin", "https://gateway.example.ts.net", "extra"])).rejects.toThrow(
      "unexpected argument: extra",
    );
  });
});

describe("numeric options", () => {
  test("refuses a --port that is not a bare decimal integer", async () => {
    for (const value of ["abc", "-1", "1.5", "4317.0", " 4317", "4317 ", "+4317", "4_317", "1e3", "0x10ed", "٤٣١٧"]) {
      await expect(main(["serve", `--port=${value}`])).rejects.toThrow("--port must be an integer");
    }
    // A negative supplied as its own token is the shape an operator actually types, and it exercises
    // the parser branch that treats a non-`--` token as the value.
    await expect(main(["serve", "--port", "-1"])).rejects.toThrow("--port must be an integer");
  });

  test("distinguishes an empty value from an absent one", async () => {
    await expect(main(["serve", "--port="])).rejects.toThrow("--port must be an integer");
    await expect(main(["serve", "--port"])).rejects.toThrow("--port requires a value");
  });

  test("refuses an out-of-range --port before writing config or token material", async () => {
    // 0 and 65536 straddle `validatePort`; both are integers, so only the range check can catch them.
    for (const port of ["0", "65536"]) {
      const run = await runCli(["serve", "--dev-localhost", `--port=${port}`]);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("http.port must be an integer from 1 to 65535");
      expect(run.artifacts).toEqual([]);
    }
  }, 20_000);
});

describe("usage and daemon invocation", () => {
  test("--help and a bare invocation print the same usage, exit zero, and write nothing", async () => {
    const [help, bare] = await Promise.all([runCli(["--help"]), runCli([])]);
    expect(help.exitCode).toBe(0);
    expect(bare.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(bare.stdout).toBe(help.stdout);
    expect(help.artifacts).toEqual([]);
    expect(bare.artifacts).toEqual([]);
  }, 15_000);

  test("a bare invocation means serve only under the daemon binary name", async () => {
    // The substitution keys off `basename(process.argv[1])`, so the only way to exercise it is to
    // enter `main` through a file with that name. Nothing binds: the sandbox has no config file, so
    // the `tailscale-serve` defaults are refused before any listener or file is created.
    const daemon = await runInSandbox(async root => {
      await writeFile(join(root, "omp-gatewayd"), DAEMON_ENTRY);
      return [process.execPath, join(root, "omp-gatewayd")];
    });
    expect(daemon.exitCode).toBe(1);
    expect(daemon.stderr).toContain("tailscale-serve mode requires an exact HTTPS public origin");
    expect(daemon.artifacts).toEqual([]);

    const other = await runInSandbox(async root => {
      await writeFile(join(root, "omp-gateway"), DAEMON_ENTRY);
      return [process.execPath, join(root, "omp-gateway")];
    });
    expect(other.exitCode).toBe(0);
    expect(other.stdout).toContain("Usage:");
    expect(other.artifacts).toEqual([]);
  }, 15_000);
});

describe("destructive verbs", () => {
  test("uninstall refuses a malformed --no-stop before stopping the service", async () => {
    await expect(main(["uninstall", "--no-stop=yes"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["uninstall", "--no-stop=false"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["uninstall", "--no-stop", "--no-stop"])).rejects.toThrow("--no-stop may be supplied once");
    await expect(main(["uninstall", "--to=0.1.0-0123456789ab"])).rejects.toThrow("unknown option for uninstall: --to");
    await expect(main(["uninstall", "yes"])).rejects.toThrow("unexpected argument: yes");
  });

  test("rollback refuses a malformed --to before reading any service state", async () => {
    // `runRollback` reads `--to` first and only then loads the config and the live service status,
    // so these refusals are the ones reachable without an installed gateway. The refusals that do
    // need one — an unmanaged active service, a missing installation, and an unresolvable target —
    // are left uncovered rather than faked, because `userServiceStatus` reads the real OS service
    // even when every path is redirected into a sandbox.
    await expect(main(["rollback", "--to"])).rejects.toThrow("--to requires a value");
    await expect(main(["rollback", "--to=", "--to=0.1.0-0123456789ab"])).rejects.toThrow(
      "--to may be supplied once",
    );
    await expect(main(["rollback", "--no-start"])).rejects.toThrow("unknown option for rollback: --no-start");
    await expect(main(["rollback", "--bundle=1"])).rejects.toThrow("unknown option for rollback: --bundle");
    await expect(main(["rollback", "0.1.0-0123456789ab"])).rejects.toThrow(
      "unexpected argument: 0.1.0-0123456789ab",
    );
  });
});
