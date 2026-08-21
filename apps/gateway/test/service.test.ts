import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { GatewayConfig } from "../src/config.ts";
import { serviceDefinition, serviceProgramBelongsTo } from "../src/service.ts";

const config: GatewayConfig = {
  http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
  auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
  registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxPublishers: 100, maxSessions: 100 },
  paths: {
    configDir: "/Users/test/.config/omp-session-gateway",
    stateDir: "/Users/test/.local/state/omp-session-gateway",
    runtimeDir: "/private/tmp/omp-session-gateway-501",
    socketPath: "/private/tmp/omp-session-gateway-501/registry.sock",
    tokenPath: "/Users/test/.config/omp-session-gateway/publisher-token",
    configPath: "/Users/test/.config/omp-session-gateway/config.json",
  },
};

/** A generated CLI path shaped like the one `install` passes: under the state dir it is rooted in. */
const installedCliPath = join(config.paths.stateDir, "installation", "versions", "0.1.0-a1b2c3d4e5f6", "apps", "gateway", "src", "cli.js");
/** 43 url-safe characters: one unpadded 256-bit base64url value, the only shape the code accepts. */
const boundInstance = "readiness_Instance-9".padEnd(43, "x");

function withEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/*
 * The helpers below stand in for the consumers of these generated files: systemd's unit parser,
 * launchd's plist reader, Task Scheduler's XML loader. Asserting on the whole document as one string
 * cannot distinguish a directive that landed in the wrong section, or an escaped payload from an
 * injected element, from a correct file. Parsing it the way the consumer does can.
 */

/** Directive lines grouped by `[Section]`; systemd silently ignores a directive in the wrong one. */
function unitSections(unit: string): ReadonlyMap<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of unit.split("\n")) {
    if (line.trim() === "") continue;
    const name = /^\[([^\]]+)\]$/u.exec(line)?.[1];
    if (name === undefined) {
      current.push(line);
      continue;
    }
    current = [];
    sections.set(name, current);
  }
  return sections;
}

function unitSection(unit: string, name: string): readonly string[] {
  const lines = unitSections(unit).get(name);
  if (lines === undefined) throw new Error(`unit has no [${name}] section`);
  return lines;
}

/** The values a `[Service]` directive resolves to once systemd's quoting is undone. */
function unitTokens(unit: string, directive: string): readonly string[] {
  const line = unitSection(unit, "Service").find(entry => entry.startsWith(`${directive}=`));
  if (line === undefined) throw new Error(`unit has no ${directive}`);
  const quoted = line.slice(directive.length + 1).matchAll(/"(?:[^"\\]|\\.)*"/gu);
  return [...quoted].map(match => JSON.parse(match[0]) as string);
}

function xmlUnescape(value: string): string {
  // `&amp;` last, or `&amp;lt;` would decode twice.
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/**
 * Element names in document order, rejecting what a real parser rejects: unbalanced tags, raw markup
 * in text, or a bare ampersand. A dropped escape surfaces here as a structural difference rather
 * than as a string that merely looks odd.
 */
function xmlElements(document: string): readonly string[] {
  const body = document.replace(/<\?[^?]*\?>/gu, "").replace(/<!DOCTYPE[^>]*>/gu, "");
  const opened: string[] = [];
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<", cursor);
    const text = start === -1 ? body.slice(cursor) : body.slice(cursor, start);
    if (/[<>]/u.test(text)) throw new Error(`unescaped markup in text: ${text}`);
    if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(text)) throw new Error(`unescaped ampersand in text: ${text}`);
    if (start === -1) break;
    const end = body.indexOf(">", start);
    if (end === -1) throw new Error("unterminated tag");
    const tag = body.slice(start + 1, end);
    cursor = end + 1;
    if (tag.startsWith("/")) {
      if (stack.pop() !== tag.slice(1)) throw new Error(`unbalanced close tag: <${tag}>`);
      continue;
    }
    const name = tag.replace(/\/$/u, "").split(/\s/u)[0] ?? "";
    opened.push(name);
    if (!tag.endsWith("/")) stack.push(name);
  }
  if (stack.length > 0) throw new Error(`unclosed elements: ${stack.join(", ")}`);
  return opened;
}

function xmlText(document: string, element: string): string {
  const text = new RegExp(`<${element}>([^<]*)</${element}>`, "u").exec(document)?.[1];
  if (text === undefined) throw new Error(`document has no <${element}>`);
  return text;
}

function plistString(plist: string, key: string): string {
  const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(plist)?.[1];
  if (value === undefined) throw new Error(`plist has no ${key} string`);
  return value;
}

/** The argv launchd would exec, entities decoded. */
function plistProgramArguments(plist: string): readonly string[] {
  const body = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)?.[1];
  if (body === undefined) throw new Error("plist has no ProgramArguments array");
  return [...body.matchAll(/<string>([^<]*)<\/string>/gu)].map(match => xmlUnescape(match[1] ?? ""));
}

/** The `<Arguments>` string split back into the argv Task Scheduler would append to `<Command>`. */
function taskArguments(taskXml: string): readonly string[] {
  const quoted = xmlText(taskXml, "Arguments").matchAll(/&quot;(.*?)&quot;/gu);
  return [...quoted].map(match => xmlUnescape(match[1] ?? ""));
}

describe("service packaging", () => {
  test("generates hardened Linux systemd user service", () => {
    const definition = serviceDefinition(config, "linux");
    expect(definition.path).toEndWith("omp-session-gateway.service");
    expect(definition.content).toContain("WantedBy=default.target");
    expect(definition.content).toContain("NoNewPrivileges=true");
    expect(definition.content).toContain("ProtectSystem=strict");
    expect(definition.content).not.toContain("0.0.0.0");
  });

  test("lets systemd own a runtime directory that does not exist at boot", () => {
    // Regression for #69. ReadWritePaths= naming a missing path makes systemd refuse to start the
    // unit. The runtime directory only exists once the daemon has bound its socket, so the unit
    // installed fine and then failed after every reboot, leaving the gateway silently absent.
    // `serviceDefinition` compares against `join(XDG_RUNTIME_DIR, …)`, which uses the host
    // separator, so the fixture must be built the same way or this silently stops asserting
    // anything on Windows. The same separator assumption already broke the ownership fixtures once.
    const previous = process.env.XDG_RUNTIME_DIR;
    const xdgRuntimeDir = join("/run", "user", "1000");
    const runtimeDir = join(xdgRuntimeDir, "omp-session-gateway");
    process.env.XDG_RUNTIME_DIR = xdgRuntimeDir;
    try {
      const linuxConfig: GatewayConfig = {
        ...config,
        paths: { ...config.paths, runtimeDir, socketPath: join(runtimeDir, "registry.sock") },
      };
      const definition = serviceDefinition(linuxConfig, "linux");
      expect(definition.content).toContain("RuntimeDirectory=omp-session-gateway");
      // systemd defaults this to 0755, which the gateway's private-directory assertion rejects.
      expect(definition.content).toContain("RuntimeDirectoryMode=0700");
      // A RuntimeDirectory= path is implicitly writable; repeating it here is what broke boot.
      expect(definition.content).not.toContain(JSON.stringify(runtimeDir));
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("keeps a persistent runtime directory in ReadWritePaths", () => {
    // Without XDG_RUNTIME_DIR the runtime directory lives under the state directory, persists
    // across reboots, and must stay writable the ordinary way.
    const previous = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const definition = serviceDefinition(config, "linux");
      expect(definition.content).not.toContain("RuntimeDirectory=");
      expect(definition.content).toContain(JSON.stringify(config.paths.runtimeDir));
    } finally {
      if (previous !== undefined) process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("binds managed service readiness to the installed instance", () => {
    const readinessInstance = "R".repeat(43);
    const definition = serviceDefinition(config, "linux", "/private/runtime/cli.js", readinessInstance);
    expect(definition.content).toContain('"--readiness-instance"');
    expect(definition.content).toContain(`"${readinessInstance}"`);
    expect(() => serviceDefinition(config, "linux", "/private/runtime/cli.js", "invalid")).toThrow(
      "invalid service readiness instance",
    );
  });

  test("generates current-user macOS LaunchAgent", () => {
    const definition = serviceDefinition(config, "darwin");
    expect(definition.path).toEndWith("omp-session-gateway.plist");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
    expect(definition.content).toContain("<key>KeepAlive</key>");
    expect(definition.content).not.toContain("LaunchDaemons");
  });

  test("generates least-privilege Windows logon task", () => {
    const definition = serviceDefinition(config, "win32");
    expect(definition.path).toEndWith("omp-session-gateway-task.xml");
    expect(definition.content).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(definition.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(definition.content).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
    expect(definition.content).not.toContain("HighestAvailable");
    expect(definition.content).not.toContain("cmd.exe");
  });
});

/**
 * Regression for a live outage on 2026-08-19. Service managers key their registry on identity no
 * filesystem override can scope — launchd on `gui/<uid>/<label>`, systemd on the unit name, Task
 * Scheduler on the task name — so an install rooted in a sandbox sees the real machine's service and
 * previously reported it as its own. An isolated archive smoke then ran `rotate-publisher-token`,
 * which took the active branch and booted out the production daemon.
 */
describe("loaded service ownership", () => {
  // Build fixtures with the host separator: the predicate compares against `stateDir + sep`, so a
  // hard-coded POSIX fixture would vacuously fail on Windows and pass for the wrong reason on macOS.
  const stateDir = join(sep, "Users", "example", ".local", "state", "omp-session-gateway");
  const installedCli = join(stateDir, "installation", "versions", "0.1.0-77e3a6914cea", "apps", "gateway", "src", "cli.js");
  const otherRoot = join(sep, "tmp", "smoke.abc123", "state", "omp-session-gateway");
  const launchctlPrint = `gui/501/omp-session-gateway = {
	program = /opt/homebrew/Cellar/bun/1.3.14/bin/bun
	arguments = {
		/opt/homebrew/Cellar/bun/1.3.14/bin/bun
		${installedCli}
		serve
	}
}`;

  test("claims a loaded service whose program lives under this install root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, stateDir)).toBe(true);
  });

  test("disclaims a service installed from a different root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, otherRoot)).toBe(false);
  });

  test("disclaims a sibling root that shares a path prefix", () => {
    // Without the trailing separator this matches, and a second install silently adopts the first.
    expect(serviceProgramBelongsTo(launchctlPrint, `${stateDir}-2`)).toBe(false);
    expect(serviceProgramBelongsTo(join(`${stateDir}-2`, "installation", "x", "cli.js"), stateDir)).toBe(false);
  });

  test("disclaims when the service manager reports nothing loaded", () => {
    expect(serviceProgramBelongsTo(undefined, stateDir)).toBe(false);
  });

  test("reads a systemd ExecStart line", () => {
    const execStart = `{ path=/usr/bin/bun ; argv[]=/usr/bin/bun ${installedCli} serve ; ignore_errors=no }`;
    expect(serviceProgramBelongsTo(execStart, stateDir)).toBe(true);
    expect(serviceProgramBelongsTo(execStart, otherRoot)).toBe(false);
  });

  test("disclaims a root whose name is a prefix of an unrelated directory's name", () => {
    // `/tmp/state` against `/tmp/statement/...`: the case the trailing separator exists for. A
    // substring test adopts an install that shares nothing but the first characters of its name.
    const root = join(sep, "tmp", "state");
    expect(serviceProgramBelongsTo(join(sep, "tmp", "statement", "installation", "cli.js"), root)).toBe(false);
    expect(serviceProgramBelongsTo(join(root, "installation", "cli.js"), root)).toBe(true);
  });

  test("disclaims a rendering that names the root but no program under it", () => {
    // The install root is not a program. A unit whose ExecStart was cleared, or a launchctl print
    // that only echoes the directory, must not read as ours: `active` gates stop and rotation.
    expect(serviceProgramBelongsTo(stateDir, stateDir)).toBe(false);
    expect(serviceProgramBelongsTo("", stateDir)).toBe(false);
  });
});

describe("systemd unit structure", () => {
  test("puts every directive in the section systemd reads it from", () => {
    // A directive in the wrong section is not an error, it is a silent no-op: `WantedBy=` outside
    // [Install] makes `systemctl --user enable` create no symlink, so the gateway never autostarts.
    const content = serviceDefinition(config, "linux").content;
    expect([...unitSections(content).keys()]).toEqual(["Unit", "Service", "Install"]);
    expect(unitSection(content, "Unit")).toContain("After=network-online.target");
    expect(unitSection(content, "Install")).toContain("WantedBy=default.target");
    const service = unitSection(content, "Service");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ProtectHome=read-only");
    expect(service.filter(line => line.startsWith("ExecStart=")).length).toBe(1);
  });

  test("names the unit file exactly what the systemctl calls address", () => {
    // Every systemctl call in service.ts hardcodes `omp-session-gateway.service`. A file written
    // under any other name is enabled by nothing, and status reports it as not installed.
    const definition = serviceDefinition(config, "linux");
    expect(basename(definition.path)).toBe(`${definition.identifier}.service`);
    expect(definition.path).toEndWith(join("systemd", "user", "omp-session-gateway.service"));
  });

  test("writes the unit where the systemd user manager looks for it", () => {
    const configHome = join(sep, "tmp", "xdg-config-home");
    withEnv("XDG_CONFIG_HOME", configHome, () => {
      expect(serviceDefinition(config, "linux").path).toBe(join(configHome, "systemd", "user", "omp-session-gateway.service"));
    });
    withEnv("XDG_CONFIG_HOME", undefined, () => {
      const fallback = join(homedir(), ".config", "systemd", "user", "omp-session-gateway.service");
      expect(serviceDefinition(config, "linux").path).toBe(fallback);
    });
  });

  test("hands systemd the runtime directory only when it is the one systemd would create", () => {
    // Continuation of #69. `RuntimeDirectory=omp-session-gateway` creates exactly
    // `$XDG_RUNTIME_DIR/omp-session-gateway`, so the decision turns on that exact path and not on
    // XDG_RUNTIME_DIR merely being set. Claiming it for a near-miss would leave the real runtime
    // directory unwritable under ProtectHome=, and create a stray directory nobody uses.
    const xdgRuntimeDir = join(sep, "run", "user", "1000");
    const nearMisses = [
      join(xdgRuntimeDir, "omp-session-gateway-2"),
      join(xdgRuntimeDir, "omp-session-gateway", "nested"),
      join(xdgRuntimeDir, "..", "omp-session-gateway"),
      join(config.paths.stateDir, "run"),
    ];
    withEnv("XDG_RUNTIME_DIR", xdgRuntimeDir, () => {
      for (const runtimeDir of nearMisses) {
        const content = serviceDefinition({ paths: { ...config.paths, runtimeDir } }, "linux").content;
        expect(content).not.toContain("RuntimeDirectory=");
        expect(unitTokens(content, "ReadWritePaths")).toContain(runtimeDir);
      }
      const exact = serviceDefinition({ paths: { ...config.paths, runtimeDir: join(xdgRuntimeDir, "omp-session-gateway") } }, "linux");
      expect(unitSection(exact.content, "Service")).toContain("RuntimeDirectory=omp-session-gateway");
      expect(unitSection(exact.content, "Service")).toContain("RuntimeDirectoryMode=0700");
      expect(unitTokens(exact.content, "ReadWritePaths")).toEqual([config.paths.configDir, config.paths.stateDir]);
    });
  });

  test("keeps the daemon's own directories writable under ProtectHome=read-only", () => {
    // ProtectSystem=strict plus ProtectHome=read-only makes everything read-only by default, so a
    // path dropped from here is a daemon that starts and then fails its first write.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const content = serviceDefinition(config, "linux").content;
      expect(unitTokens(content, "ReadWritePaths")).toEqual([
        config.paths.configDir,
        config.paths.stateDir,
        config.paths.runtimeDir,
      ]);
    });
  });

  test("quotes paths losslessly instead of letting one inject a directive", () => {
    // These paths come from flags and environment, into a file systemd parses line by line. A quote
    // or newline that survives unescaped appends directives of the caller's choosing.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const hostile = `${join(sep, "tmp", "gateway-state")}"\nExecStart=${join(sep, "bin", "sh")}`;
      const content = serviceDefinition({ paths: { ...config.paths, stateDir: hostile } }, "linux").content;
      expect(unitSection(content, "Service").filter(line => line.startsWith("ExecStart=")).length).toBe(1);
      expect(content.split("\n").length).toBe(serviceDefinition(config, "linux").content.split("\n").length);
      // Lossless, not merely safe: systemd must still exec on the exact directory it was given.
      expect(unitTokens(content, "ReadWritePaths")).toContain(hostile);
    });
  });

  test("execs an absolute program with no shell in between", () => {
    // systemd refuses an ExecStart that is not an absolute path, and there is no shell in the chain
    // to re-quote anything, so these tokens are what the kernel receives.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const tokens = unitTokens(serviceDefinition(config, "linux", installedCliPath).content, "ExecStart");
      expect(tokens[0]).toBe(process.execPath);
      expect(tokens.at(-1)).toBe("serve");
      for (const token of tokens.slice(0, -1)) expect(isAbsolute(token)).toBe(true);
    });
  });
});

describe("macOS launch agent", () => {
  test("installs into the current user's LaunchAgents domain, never a system daemon", () => {
    // A plist under /Library/LaunchDaemons runs as root at boot. This service is a per-user agent by
    // design: it serves one logged-in user's sessions and owns files in that user's home.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(definition.path).toBe(join(homedir(), "Library", "LaunchAgents", "omp-session-gateway.plist"));
    expect(definition.path.startsWith(homedir() + sep)).toBe(true);
    expect(definition.content).not.toContain("UserName");
    expect(plistString(definition.content, "ProcessType")).toBe("Background");
  });

  test("labels the agent exactly what launchctl is asked to print and bootout", () => {
    // install/stop/uninstall all address `gui/<uid>/omp-session-gateway`. If the Label drifts from
    // the identifier, bootout targets a service that does not exist and stop silently does nothing.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(plistString(definition.content, "Label")).toBe(definition.identifier);
  });

  test("emits a plist a consumer can parse", () => {
    const content = serviceDefinition(config, "darwin", installedCliPath).content;
    expect(content).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain("-//Apple//DTD PLIST 1.0//EN");
    // Throws on unbalanced tags or raw markup in text, which is what a plist reader would do.
    const elements = xmlElements(content);
    expect(elements[0]).toBe("plist");
    expect(elements[1]).toBe("dict");
    expect(elements).toContain("array");
  });

  test("carries the paths it was given into the program arguments", () => {
    // The plist embeds argv and nothing else, so the config reaches it through the installed CLI
    // path, which `install` roots under the state directory it was configured with.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(plistProgramArguments(definition.content)).toContain(installedCliPath);
    expect(installedCliPath.startsWith(config.paths.stateDir + sep)).toBe(true);
  });

  test("escapes markup in a program path instead of emitting another plist key", () => {
    const hostile = join(sep, "tmp", 'gateway&"<danger>"', "</string><key>RunAtLoad</key><false/><string>cli.js");
    const benign = serviceDefinition(config, "darwin", join(sep, "tmp", "gateway", "cli.js")).content;
    const injected = serviceDefinition(config, "darwin", hostile).content;
    // Escaping means the payload can only change text: the element structure is byte-for-byte the
    // same shape as a benign path's. Dropping xmlEscape diverges here immediately.
    expect(xmlElements(injected)).toEqual(xmlElements(benign));
    expect(injected).toContain("&lt;/string&gt;");
    expect(injected).toContain("&amp;");
    expect(injected).toContain("&quot;");
    expect(injected).toContain("<key>RunAtLoad</key><true/>");
    expect(injected).not.toContain("<key>RunAtLoad</key><false/>");
    // And launchd still recovers the exact path it has to exec.
    expect(plistProgramArguments(injected)).toEqual([process.execPath, resolve(hostile), "serve"]);
  });
});

describe("windows scheduled task", () => {
  test("starts at interactive logon rather than at boot (#90)", () => {
    // Deliberate and documented: the gateway serves a logged-in user's sessions with that user's
    // token, so it starts with the session, not with the machine. Moving to boot-start means
    // changing this test on purpose rather than changing behaviour by accident.
    const content = serviceDefinition(config, "win32", installedCliPath).content;
    expect(content).toContain("<LogonTrigger><Enabled>true</Enabled></LogonTrigger>");
    expect(xmlText(content, "LogonType")).toBe("InteractiveToken");
    expect(content).not.toContain("BootTrigger");
    expect(content).not.toContain("ServiceAccount");
    expect(content).not.toContain("S4U");
    expect(content).not.toContain("Password");
  });

  test("declares the UTF-16 encoding the installer writes and carries no BOM of its own", () => {
    // The installer serializes this document as UTF-16LE behind a hand-written BOM. Task Scheduler
    // refuses XML whose declaration disagrees with its bytes, and a BOM already in the string would
    // be encoded a second time and sit as a stray character in front of the declaration.
    const content = serviceDefinition(config, "win32", installedCliPath).content;
    expect(content).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(content).not.toContain("UTF-8");
    expect(content).not.toContain("\uFEFF");
  });

  test("splits the runtime from its arguments the way schtasks expects", () => {
    const content = serviceDefinition(config, "win32", installedCliPath).content;
    expect(xmlText(content, "Command")).toBe(process.execPath);
    expect(taskArguments(content)).toEqual([installedCliPath, "serve"]);
    // Repeating the executable in <Arguments> would launch the runtime with itself as its script.
    expect(xmlText(content, "Arguments")).not.toContain(process.execPath);
  });

  test("writes the task definition inside the config directory it was given", () => {
    // schtasks reads this path, and install mkdirs its parent at 0700. A path outside the config
    // root escapes every sandbox an isolated install sets up.
    const definition = serviceDefinition(config, "win32", installedCliPath);
    expect(definition.path).toBe(join(config.paths.configDir, "omp-session-gateway-task.xml"));
  });

  test("registers one hard-terminable instance with no execution time limit", () => {
    // IgnoreNew keeps a second logon from starting a rival daemon on the same socket;
    // AllowHardTerminate is what makes `schtasks /End` able to stop it; PT0S is what stops Task
    // Scheduler from killing a long-running service when the default execution time limit expires.
    const content = serviceDefinition(config, "win32", installedCliPath).content;
    expect(content).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(content).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
    expect(content).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  test("escapes markup in a program path instead of emitting another task element", () => {
    const hostile = join(sep, "tmp", "gateway&danger", "</Arguments><Exec><Command>evil.exe</Command><Arguments>cli.js");
    const benign = serviceDefinition(config, "win32", join(sep, "tmp", "gateway", "cli.js")).content;
    const injected = serviceDefinition(config, "win32", hostile).content;
    expect(xmlElements(injected)).toEqual(xmlElements(benign));
    expect(injected).toContain("&lt;Exec&gt;");
    expect(injected).toContain("&amp;danger");
    expect(injected).not.toContain("<Exec><Command>evil.exe");
    expect(xmlText(injected, "Command")).toBe(process.execPath);
  });
});

describe("service argv", () => {
  // The runtime here is bun, so the generated argv passes the script path explicitly; that is the
  // shape asserted below. These tokens are what the service manager execs, with no shell to re-split.
  test("threads the installed CLI into every platform's generated command", () => {
    const expected = [process.execPath, installedCliPath, "serve"];
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      expect(unitTokens(serviceDefinition(config, "linux", installedCliPath).content, "ExecStart")).toEqual(expected);
    });
    expect(plistProgramArguments(serviceDefinition(config, "darwin", installedCliPath).content)).toEqual(expected);
    const task = serviceDefinition(config, "win32", installedCliPath).content;
    expect([xmlText(task, "Command"), ...taskArguments(task)]).toEqual(expected);
  });

  test("appends a bound readiness instance as a separate flag and value after the command", () => {
    // Two argv entries, and both after `serve`: the CLI reads argv[0] as the command and rejects an
    // unknown option, so a joined token or a flag ahead of the command is a daemon that will not
    // start. This is the handshake that proves the newly installed instance is the one answering.
    const expected = [process.execPath, installedCliPath, "serve", "--readiness-instance", boundInstance];
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const content = serviceDefinition(config, "linux", installedCliPath, boundInstance).content;
      expect(unitTokens(content, "ExecStart")).toEqual(expected);
    });
    const plist = serviceDefinition(config, "darwin", installedCliPath, boundInstance).content;
    expect(plistProgramArguments(plist)).toEqual(expected);
    const task = serviceDefinition(config, "win32", installedCliPath, boundInstance).content;
    expect([xmlText(task, "Command"), ...taskArguments(task)]).toEqual(expected);
  });

  test("omits the readiness flag entirely when no instance is bound", () => {
    // An empty or dangling `--readiness-instance` would make the daemon refuse to start; the flag
    // has to be absent, not present-and-empty.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(serviceDefinition(config, platform, installedCliPath).content).not.toContain("--readiness-instance");
    }
  });

  test("falls back to the running script when no installed CLI is given", () => {
    // The pre-install path calls this before any runtime directory exists to point at. The fallback
    // still has to produce a complete argv: a missing or empty script argument leaves the runtime
    // with no program, and the service manager starts something that is not the gateway.
    const fallback = plistProgramArguments(serviceDefinition(config, "darwin").content);
    const explicit = plistProgramArguments(serviceDefinition(config, "darwin", installedCliPath).content);
    expect(fallback.length).toBe(explicit.length);
    expect(fallback[0]).toBe(process.execPath);
    expect(fallback.at(-1)).toBe("serve");
    expect(fallback.every(argument => argument.length > 0)).toBe(true);
    // `resolve("")` would yield the working directory, which is absolute and non-empty, and launchd
    // would faithfully hand that directory to bun as the script to run.
    expect(isAbsolute(fallback[1] ?? "")).toBe(true);
    expect(statSync(fallback[1] ?? ".").isFile()).toBe(true);
  });

  test("resolves a relative installed CLI to an absolute program path", () => {
    // Service managers exec from an unspecified working directory, so a relative script path is a
    // service that starts nothing.
    const relative = join("relative", "cli.js");
    const arguments_ = plistProgramArguments(serviceDefinition(config, "darwin", relative).content);
    expect(arguments_[1]).toBe(resolve(relative));
    expect(isAbsolute(arguments_[1] ?? "")).toBe(true);
  });

  test("refuses a readiness instance that is not exactly 43 url-safe characters", () => {
    // The instance is interpolated into a file the service manager parses and into an HMAC input, so
    // a permissive check is both an injection and a silent readiness bypass.
    expect(serviceDefinition(config, "linux", installedCliPath, boundInstance).content).toContain(boundInstance);
    const rejected = [
      boundInstance.slice(0, 42),
      `${boundInstance}x`,
      `${boundInstance.slice(0, 42)}=`,
      `${boundInstance.slice(0, 42)}.`,
      `${boundInstance.slice(0, 30)}\n${"x".repeat(12)}`,
      "",
    ];
    for (const instance of rejected) {
      expect(() => serviceDefinition(config, "linux", installedCliPath, instance)).toThrow(
        "invalid service readiness instance",
      );
    }
  });
});

describe("unsupported platforms", () => {
  test("refuses to invent a service definition for a platform it cannot install on", () => {
    // Returning something plausible here would write a file no service manager reads and report a
    // successful install.
    for (const platform of ["freebsd", "openbsd", "sunos", "aix"] as const) {
      expect(() => serviceDefinition(config, platform)).toThrow(`unsupported platform: ${platform}`);
    }
  });

  test("validates the readiness instance before it looks at the platform", () => {
    // Precedence decides which error the caller sees: a malformed token is the caller's bug and must
    // be named as such, even on a host that could never host the service anyway.
    expect(() => serviceDefinition(config, "sunos", installedCliPath, "short")).toThrow(
      "invalid service readiness instance",
    );
  });
});
