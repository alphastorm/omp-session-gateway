import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pins from "./windows-qualification-pins.json";
import { cleanupWindows, preflightWindows, runWindows, windowsCampaignLabel, windowsNeedsCleanup } from "./windows-stable-qualification.ts";
import type { WindowsAdmission, WindowsArtifact, WindowsContext, WindowsFirewall, WindowsIdentity, WindowsInstance, WindowsPreflightInput, WindowsRuntime } from "./windows-stable-qualification.ts";
import { parseQualificationPins, parseStableQualificationArgs, releaseArchivePath, verifyLaunchContracts, verifyRelease, waitForPublishedSession, waitForRevocation } from "./stable-qualification.ts";
import { windowsHostScript } from "./upstream-canary.ts";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { parseKeyguardShowing, requireSingleDevice, withAndroidChrome } from "./android-device.ts";
import { runAndroidCollabSmoke } from "./android-collab-smoke.ts";
import { releaseVersion } from "./release-policy.ts";
import { firewallEligibility, instanceEligibility, QUAL_LABEL_PREFIX } from "./vultr-target.ts";
import { readProvider } from "./provider-read.ts";

const root = resolve(import.meta.dir, "..");
const privateRoot = join(homedir(), ".local/share/omp-session-gateway/qualification");
const devRoot = join(privateRoot, "dev/windows");
const python = join(privateRoot, "venv/bin/python");
const SHA = /^[0-9a-f]{64}$/u;
const sessionLabel = "omp-winqual-fixture";
interface Access extends Record<string, unknown> {
  instance: string;
  host: string;
  password: string;
  origin?: string;
  machine?: string;
  configDigest?: string;
  credentialDigest?: string;
  ompPath?: string;
  ompPid?: number;
  pixelState?: { serial: string; component: string; launcherPackage: string; launcherCategory: string; wakefulness: string; keyguard: boolean };
}
/** What restoration relaunches: the app that owns the resumed task, or the home app when the Pixel sat at home. */
export function windowsPixelLauncher(activities: string, component: string): { packageName: string; category: string } {
  const lines = activities.split(/\r?\n/u);
  const tasks = new Set(lines.filter(line => line.includes(` ${component} `)).flatMap(line => /\bt(\d+)\b/u.exec(line)?.[1] ?? []));
  const launchers = new Map<string, string>();
  for (const line of lines) {
    const task = /Task\{[^}]*#(\d+)\b/u.exec(line)?.[1];
    if (!task || !tasks.has(task)) continue;
    // A home task has no affinity, so Android prints its intent component instead, and the home
    // app answers the HOME category: `monkey` finds no LAUNCHER activity in it.
    const home = /\btype=home\b/u.test(line);
    const name = /\bA=\d+:([A-Za-z0-9_.]+)/u.exec(line)?.[1] ?? (home ? /\bI=([A-Za-z0-9_.]+)\//u.exec(line)?.[1] : undefined);
    if (name) launchers.set(name, home ? "android.intent.category.HOME" : "android.intent.category.LAUNCHER");
  }
  const [launcher] = launchers;
  if (launchers.size !== 1 || !launcher) throw new Error("Pixel foreground launcher is ambiguous");
  return { packageName: launcher[0], category: launcher[1] };
}
async function command(argv: readonly string[], options: { cwd?: string; input?: string; timeoutMs?: number; allowedExitCodes?: readonly number[] } = {}): Promise<string> {
  const proc = Bun.spawn([...argv], { cwd: options.cwd ?? root, stdin: options.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => proc.kill(), options.timeoutMs ?? 120_000);
  try {
    if (options.input !== undefined) {
      if (proc.stdin === undefined || typeof proc.stdin === "number") throw new Error("subprocess input pipe unavailable");
      proc.stdin.write(options.input); proc.stdin.end();
    }
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (!(options.allowedExitCodes ?? [0]).includes(code)) throw new Error(`${argv[0]?.split(/[\\/]/u).at(-1)} exited ${code}; output withheld`);
    return out.trim();
  } finally { clearTimeout(deadline); }
}
async function privateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("qualification input must be a private current-user regular file");
  return readFile(path, "utf8");
}
async function atomicPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error("unsafe qualification vault directory");
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
function digest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function vaultPath(epoch: string): string { windowsCampaignLabel(epoch); return join(privateRoot, "windows-vault", `${epoch}.json`); }
async function loadAccess(epoch: string): Promise<Access> {
  const text = await privateFile(vaultPath(epoch));
  try { return JSON.parse(text) as Access; }
  catch { throw new Error("qualification vault is malformed"); }
}

/** Failure text is independent of HTTP bodies, which can contain credentials and identifiers. */
async function request<T>(url: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<T | undefined> {
  const send = () => fetch(url, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const response = method === "GET" ? await readProvider(send) : await send();
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`qualification provider ${method} HTTP ${response.status}`);
  const text = response.status === 204 ? "" : await response.text();
  try { return text === "" ? undefined : JSON.parse(text) as T; }
  catch { throw new Error("qualification provider response is malformed"); }
}

/** Checks stale View and Control independently and discards launch values before returning. */
export async function verifyWindowsStaleLaunch(origin: string, session: Record<string, unknown>, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<Record<string, unknown>> {
  if (typeof session.instanceId !== "string" || typeof session.generation !== "number") throw new Error("invalid published identity");
  for (const mode of ["view", "control"] as const) {
    const response = await fetcher(`${origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
      method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ mode, generation: session.generation + 1 }), cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    const released = Object.hasOwn(payload, "capability");
    delete payload.capability;
    if (response.status !== 409 || released || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("stale generation did not fail closed with 409");
  }
  return { staleViewStatus: 409, staleControlStatus: 409 };
}

export async function waitForStableWindowsTransport(
  probe: () => Promise<Record<string, unknown>>,
  clock: Pick<WindowsRuntime, "now" | "sleep">,
  deadline: number,
): Promise<Record<string, unknown>> {
  let samples = 0; let firstSuccess = 0;
  while (clock.now() < deadline) {
    try {
      const observation = await probe();
      const observedAt = clock.now();
      if (observedAt >= deadline) break;
      if (samples === 0) firstSuccess = observedAt;
      samples += 1;
      if (samples >= 3 && observedAt - firstSuccess >= 60_000) {
        return { ...observation, transportStabilitySamples: samples, transportStabilityDurationMs: observedAt - firstSuccess };
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("WinRM transport not yet ready:")) throw error;
      samples = 0; firstSuccess = 0;
    }
    await clock.sleep(Math.min(30_000, Math.max(0, deadline - clock.now())));
  }
  throw new Error("authenticated WinRM stability window timed out");
}

export async function createWindowsRuntime(options: { development?: boolean } = {}): Promise<WindowsRuntime> {
  const environment: Record<string, string | undefined> = { ...process.env };
  const vultrKey = (await privateFile(join(homedir(), ".vultr-apikey"))).trim();
  let joinValue = ""; let apiValue = "";
  for (const name of [".ts-qual-authkey", ".ts-authkey-qual", ".ts-qual-apikey"]) {
    let value: string;
    try { value = (await privateFile(join(homedir(), name))).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (value.startsWith("tskey-auth-")) joinValue = value;
    if (value.startsWith("tskey-api-")) apiValue = value;
  }
  if (!joinValue || !apiValue) throw new Error("tagged join credential and tailnet API credential are required");
  const headers = { Authorization: `Bearer ${vultrKey}` };
  const tsHeaders = { Authorization: `Bearer ${apiValue}` };
  const api = <T>(path: string, method = "GET", body?: unknown) => request<T>(`https://api.vultr.com/v2/${path}`, headers, method, body);
  const list = async <T>(path: string, key: string): Promise<T[]> => {
    let cursor = ""; const items: T[] = [];
    do {
      const page = await api<Record<string, unknown>>(`${path}?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!page || !Array.isArray(page[key])) throw new Error("invalid provider listing");
      items.push(...page[key] as T[]);
      cursor = ((page.meta as { links?: { next?: string } } | undefined)?.links?.next ?? "");
    } while (cursor);
    return items;
  };
  let egress = "";
  let activeTag = "";
  const provider = {
    instances: () => list<WindowsInstance>("instances", "instances"),
    firewalls: () => list<WindowsFirewall>("firewalls", "firewall_groups"),
    instance: async (id: string) => (await api<{ instance: WindowsInstance }>(`instances/${encodeURIComponent(id)}`))?.instance,
    firewall: async (id: string) => (await api<{ firewall_group: WindowsFirewall }>(`firewalls/${encodeURIComponent(id)}`))?.firewall_group,
    async createFirewall(label: string) {
      if (!egress) throw new Error("Windows preflight was not performed");
      const item = await api<{ firewall_group: WindowsFirewall }>("firewalls", "POST", { description: label });
      if (!item) throw new Error("firewall create response lost"); return item.firewall_group;
    },
    async configureFirewall(id: string, label: string) {
      for (const port of ["3389", "5985"]) {
        const fresh = await provider.firewall(id);
        if (!fresh || fresh.description !== label || !firewallEligibility(id, fresh.description, environment).eligible) throw new Error("firewall ownership changed");
        await api(`firewalls/${id}/rules`, "POST", { ip_type: "v4", protocol: "tcp", subnet: egress, subnet_size: 32, port, notes: "qualification operator" });
      }
    },
    async createInstance(label: string, firewall: string) {
      const group = await provider.firewall(firewall);
      if (!group || group.description !== label || !firewallEligibility(group.id, group.description, environment).eligible) throw new Error("attached firewall ownership changed");
      const counterPath = join(devRoot, `creations-${activeTag}.json`);
      let creations = 0;
      try { creations = JSON.parse(await privateFile(counterPath)) as number; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const creationLimit = options.development ? 6 : 4;
      if (!Number.isInteger(creations) || creations < 0 || creations >= creationLimit) throw new Error("Windows creation cap reached");
      await atomicPrivate(counterPath, creations + 1);
      const item = await api<{ instance: WindowsInstance }>("instances", "POST", { region: pins.region, plan: pins.plan, os_id: pins.osId, label, hostname: label, firewall_group_id: firewall, backups: "disabled", enable_ipv6: false });
      if (!item) throw new Error("instance create response lost"); return item.instance;
    },
    async destroyInstance(id: string, label: string) {
      const fresh = await provider.instance(id);
      if (!fresh) return;
      if (fresh.label !== label || fresh.os_id !== pins.osId || fresh.region !== pins.region || fresh.plan !== pins.plan || !instanceEligibility(id, fresh.label, environment).eligible) throw new Error("instance deletion refused");
      await api(`instances/${id}`, "DELETE");
    },
    async destroyFirewall(id: string, label: string) {
      const fresh = await provider.firewall(id);
      if (!fresh) return;
      if (fresh.description !== label || !firewallEligibility(id, fresh.description, environment).eligible) throw new Error("firewall deletion refused");
      await api(`firewalls/${id}`, "DELETE");
    },
  };
  const guestScript = await readFile(join(import.meta.dir, "windows-qualification-guest.ps1"), "utf8");
  const winrm = async (context: WindowsContext, script: string, input?: unknown, timeoutMs = 300_000, upload?: { sourcePath: string; destinationPath: string }, mutation = true): Promise<Record<string, unknown>> => {
    const access = await loadAccess(context.epoch);
    if (mutation || !access.host) {
      const current = await provider.instance(access.instance);
      if (!current) throw new Error("owned guest is absent from provider lookup");
      const mismatches = [current.id !== access.instance && "identity", current.label !== windowsCampaignLabel(context.epoch) && "label", current.os_id !== pins.osId && "image", current.plan !== pins.plan && "plan", current.region !== pins.region && "region", !instanceEligibility(current.id, current.label, environment).eligible && "protection"].filter(Boolean);
      if (mismatches.length) throw new Error(`guest ownership changed: ${mismatches.join(", ")}`);
      if (!current.main_ip) throw new Error("WinRM transport not yet ready: address allocation");
      if (access.host !== current.main_ip) {
        access.host = current.main_ip; await context.beforeEffect(); await atomicPrivate(vaultPath(context.epoch), access);
      }
    }
    const result = JSON.parse(await command([python, join(import.meta.dir, "windows-winrm.py")], { input: JSON.stringify({ host: access.host, password: access.password, script, input, upload }), timeoutMs, allowedExitCodes: [0, 1] })) as { exitCode: number; stdout: string; diagnostic: string };
    if (result.exitCode === -1) throw new Error(`WinRM transport not yet ready: ${result.diagnostic}`);
    if (result.exitCode !== 0) throw new Error(`WinRM guest failed (${result.exitCode}): ${result.diagnostic}`);
    try { return JSON.parse(result.stdout.trim()) as Record<string, unknown>; }
    catch { throw new Error("WinRM response is not a bounded observation"); }
  };
  const ps = async (context: WindowsContext, action: string, extra: Record<string, unknown> = {}, timeoutMs?: number) => {
    const access = await loadAccess(context.epoch);
    try {
      return await winrm(context, guestScript, { origin: access.origin, configDigest: access.configDigest, credentialDigest: access.credentialDigest,
        ompPath: access.ompPath, ompPid: access.ompPid, ...extra, action, epoch: context.epoch, pins,
        candidateVersion: releaseVersion(context.identity.candidate.tag), previousVersion: releaseVersion(context.identity.predecessor.tag),
        login: environment.OMP_STABLE_WINDOWS_LOGIN ?? "alphastorm@github" }, timeoutMs, undefined, !["transport", "prelogin", "ready", "interactive", "publication"].includes(action));
    } catch (error) { throw new Error(`Windows ${action}: ${error instanceof Error ? error.message : "guest operation failed"}`); }
  };
  const upload = async (context: WindowsContext, local: string, name: string) => {
    const expected = digest(await readFile(local));
    const destinationPath = `C:\\omp-winqual-${context.epoch}\\${name}`;
    const found = await winrm(context, "param($p)\n$exists = Test-Path -LiteralPath $p.path\n@{ exists=$exists; matches=$exists -and (Get-FileHash -Algorithm SHA256 -LiteralPath $p.path).Hash.ToLowerInvariant() -eq $p.digest } | ConvertTo-Json -Compress", { path: destinationPath, digest: expected });
    if (found.matches === true) return;
    if (found.exists === true) {
      await context.beforeEffect();
      await winrm(context, "param($p)\nRemove-Item -LiteralPath $p.path -Force\n'{\"removed\":true}'", { path: destinationPath });
    }
    await context.beforeEffect();
    await winrm(context, "", undefined, 900_000, { sourcePath: local, destinationPath });
  };
  const poll = async (action: () => Promise<boolean>, ms: number, name: string) => {
    const deadline = Date.now() + ms;
    do { if (await action()) return; await Bun.sleep(5_000); } while (Date.now() < deadline);
    throw new Error(`${name} timed out`);
  };
  const restorePixel = async (context: WindowsContext) => {
    const access = await loadAccess(context.epoch);
    const baseline = access.pixelState;
    if (!baseline) return;
    try {
    const serial = await requireSingleDevice();
    if (serial !== baseline.serial) throw new Error("Pixel changed during Windows attempt");
    await context.beforeEffect();
    await withAndroidChrome(async driver => {
      const targets = await driver.send("Target.getTargets");
      for (const target of (targets.targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>) {
        if (target.type === "page" && target.url.startsWith(`${access.origin}/`)) await driver.send("Target.closeTarget", { targetId: target.targetId });
      }
    });
    await context.beforeEffect();
    await command(["adb", "-s", serial, "shell", "monkey", "-p", baseline.launcherPackage, "-c", baseline.launcherCategory, "1"], { timeoutMs: 30_000 });
    if (baseline.keyguard || baseline.wakefulness !== "Awake") {
      await context.beforeEffect(); await command(["adb", "-s", serial, "shell", "input", "keyevent", "223"]);
      if (baseline.wakefulness === "Awake") {
        await context.beforeEffect(); await command(["adb", "-s", serial, "shell", "input", "keyevent", "224"]);
      }
    }
    const restoredKeyguard = parseKeyguardShowing(await command(["adb", "-s", serial, "shell", "dumpsys", "window"]));
    const power = await command(["adb", "-s", serial, "shell", "dumpsys", "power"]);
    const awake = /mWakefulness=Awake/u.test(power);
    if (restoredKeyguard !== baseline.keyguard || awake !== (baseline.wakefulness === "Awake")) throw new Error("Pixel display baseline restoration failed");
    const activities = await command(["adb", "-s", serial, "shell", "dumpsys", "activity", "activities"]);
    const component = /(?:topResumedActivity|mResumedActivity|ResumedActivity).*?\bu\d+\s+([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/u.exec(activities)?.[1];
    if (component !== baseline.component) throw new Error("Pixel foreground baseline restoration failed");
    delete access.pixelState; await atomicPrivate(vaultPath(context.epoch), access);
    } catch (error) {
      throw Object.assign(new Error("Windows Pixel baseline restoration failed", { cause: error }), { pixelUnrestored: true });
    }
  };
  return {
    development: options.development === true, environment, provider, now: Date.now, sleep: Bun.sleep, uuid: randomUUID,
    async admit(input: WindowsPreflightInput): Promise<WindowsAdmission> {
      if (process.platform !== "darwin" || Bun.version !== pins.bunVersion) throw new Error("Windows controller requires macOS and pinned Bun");
      activeTag = input.identity?.tag ?? "preflight";
      const external = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(15_000) });
      egress = (await external.text()).trim();
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(egress) || egress.split(".").some(part => Number(part) > 255)) throw new Error("operator IPv4 egress unavailable");
      if (environment.OMP_STABLE_WINDOWS_OPERATOR_CIDR && environment.OMP_STABLE_WINDOWS_OPERATOR_CIDR !== `${egress}/32`) throw new Error("operator egress no longer matches admitted /32");
      const instances = await provider.instances(); const groups = await provider.firewalls();
      const ownLabel = input.epoch && options.development ? windowsCampaignLabel(input.epoch) : undefined;
      if (instances.some(item => item.label?.startsWith(QUAL_LABEL_PREFIX) && item.label !== ownLabel) || groups.some(item => item.description?.startsWith(QUAL_LABEL_PREFIX) && item.description !== ownLabel)) throw new Error("unreconciled Windows qualification resources exist");
      environment.OMP_QUAL_PROTECTED_INSTANCES = [...new Set([...(environment.OMP_QUAL_PROTECTED_INSTANCES ?? "").split(",").filter(Boolean), ...instances.filter(item => item.label !== ownLabel).map(item => item.id)])].join(",");
      environment.OMP_QUAL_PROTECTED_FIREWALLS = [...new Set([...(environment.OMP_QUAL_PROTECTED_FIREWALLS ?? "").split(",").filter(Boolean), ...groups.filter(item => item.description !== ownLabel).map(item => item.id)])].join(",");
      const os = await list<{ id: number; name: string }>("os", "os");
      if (!os.some(item => item.id === pins.osId && item.name === pins.osName)) throw new Error("pinned Windows image unavailable");
      const availability = await api<{ available_plans: string[] }>(`regions/${pins.region}/availability`);
      if (!availability?.available_plans.includes(pins.plan)) throw new Error("pinned Vultr plan unavailable");
      if ((await command([python, "-c", "import importlib.metadata; print(importlib.metadata.version('pywinrm'))"])) !== pins.pywinrmVersion) throw new Error("pywinrm version mismatch");
      const rdpHelp = await command(["sdl-freerdp", "/help"]);
      if (!rdpHelp.includes("/from-stdin") || !rdpHelp.includes("fingerprint:<hash>")) throw new Error("FreeRDP pin/stdin support missing");
      const rdpVersion = await command(["sdl-freerdp", "/version"]);
      if (!rdpVersion.includes(`version ${pins.freerdpVersion} `)) throw new Error("FreeRDP version mismatch");
      await requireSingleDevice(); // Read-only device enumeration; navigation is behind pixel().
      const tailnet = await request<{ devices: unknown[] }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders);
      if (!tailnet || !Array.isArray(tailnet.devices)) throw new Error("qualification tailnet admission failed");
      if (input.identity) for (const artifact of [input.identity.candidate, input.identity.predecessor]) {
        const info = await lstat(artifact.archivePath);
        if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(artifact.archivePath)) !== artifact.archiveSha256) throw new Error("verified gateway archive changed or is not a regular file");
      }
      return { admitted: true, protectionVerified: true, toolchainVerified: true };
    },
    async saveAccess(epoch, instance) {
      if (!instance.default_password) throw new Error("create response lacks guest access; destroy required");
      await atomicPrivate(vaultPath(epoch), { instance: instance.id, host: instance.main_ip ?? "", password: instance.default_password });
    },
    async removeAccess(epoch) { await rm(vaultPath(epoch), { force: true }); },
    async guest(context, action) {
      const access = await loadAccess(context.epoch);
      const save = async (changes: Record<string, unknown>) => atomicPrivate(vaultPath(context.epoch), { ...await loadAccess(context.epoch), ...changes });
      if (action === "transport") {
        const deadline = Date.now() + 12 * 60_000;
        // Creation can return a provisional address. Wait for provider allocation,
        // then authenticate the guest at that freshly observed address.
        await poll(async () => {
          const current = (await provider.instances()).find(item => item.id === access.instance);
          if (!current || current.label !== windowsCampaignLabel(context.epoch) || current.os_id !== pins.osId || current.plan !== pins.plan || current.region !== pins.region || !instanceEligibility(current.id, current.label, environment).eligible) throw new Error("guest ownership changed");
          if (current.status !== "active" || current.server_status !== "ok" || current.power_status !== "running" || !current.main_ip) return false;
          await context.beforeEffect(); await save({ host: current.main_ip });
          return true;
        }, Math.max(0, deadline - Date.now()), "provider Windows allocation");
        return waitForStableWindowsTransport(
          () => ps(context, "transport", {}, Math.max(1, Math.min(75_000, deadline - Date.now()))),
          { now: Date.now, sleep: Bun.sleep }, deadline,
        );
      }
      if (action === "stage") {
        if (access.toolsReady !== true) {
          await context.beforeEffect(); await ps(context, "stage", {}, 600_000); await save({ toolsReady: true });
        }
        const sourceDir = join(devRoot, "source");
        try { await lstat(join(sourceDir, "HEAD")); }
        catch { await context.beforeEffect(); await command(["git", "clone", "--bare", "--filter=blob:none", "https://github.com/can1357/oh-my-pi.git", sourceDir], { timeoutMs: 600_000 }); }
        await context.beforeEffect(); await command(["git", "--git-dir", sourceDir, "fetch", "origin", pins.omp.sourceCommit], { timeoutMs: 300_000 });
        const commit = await command(["git", "--git-dir", sourceDir, "rev-parse", `${pins.omp.sourceCommit}^{commit}`]);
        const tree = await command(["git", "--git-dir", sourceDir, "rev-parse", `${commit}^{tree}`]);
        if (commit !== pins.omp.sourceCommit || tree !== pins.omp.sourceTree) throw new Error("locked OMP source identity mismatch");
        const archive = join(devRoot, "source.tar.gz");
        await context.beforeEffect(); await command(["git", "--git-dir", sourceDir, "archive", "--format=tar.gz", "--prefix=source/", `--output=${archive}`, commit], { timeoutMs: 300_000 });
        await upload(context, context.identity.candidate.archivePath, "candidate.tar");
        await upload(context, context.identity.predecessor.archivePath, "predecessor.tar");
        await upload(context, archive, "source.tar");
        if (access.unpacked !== true) {
          await context.beforeEffect(); await ps(context, "unpack", { candidate: context.identity.candidate.archiveSha256, predecessor: context.identity.predecessor.archiveSha256, source: digest(await readFile(archive)) });
          await save({ unpacked: true });
        }
        await context.beforeEffect(); const joined = await ps(context, "join", { joinValue }, 300_000);
        await save({ origin: joined.origin, machine: joined.machine });
        if (!access.ompPath) {
          await context.beforeEffect(); const built = await ps(context, "build", {}, 1_200_000); await save(built);
        }
        return { taggedNode: joined.taggedNode, tunMode: joined.tunMode, funnelOff: joined.funnelOff };
      }
      if (action === "reboot") {
        await context.beforeEffect(); const result = await ps(context, "reboot");
        await Bun.sleep(20_000);
        return result;
      }
      if (action === "publish") {
        if (!access.ompPath) throw new Error("owned OMP build is absent");
        const inherited = await winrm(context, `@{ SystemRoot=$env:SystemRoot; SystemDrive=$env:SystemDrive; windir=$env:windir; ComSpec=$env:ComSpec; PATHEXT=$env:PATHEXT; PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE; NUMBER_OF_PROCESSORS=$env:NUMBER_OF_PROCESSORS; PATH=$env:PATH; USERPROFILE=$env:USERPROFILE; HOME=$env:USERPROFILE; TEMP=$env:TEMP; TMP=$env:TMP; APPDATA=$env:APPDATA; LOCALAPPDATA=$env:LOCALAPPDATA } | ConvertTo-Json -Compress`);
        const environment = { ...inherited, ...OMP_FIXTURE_ENV } as Record<string, string>;
        const script = windowsHostScript(access.ompPath, OMP_FIXTURE_ARGS, `C:\\omp-winqual-${context.epoch}\\${sessionLabel}`, environment);
        await context.beforeEffect();
        const started = await ps(context, "startOmp", { launcher: script });
        await save({ ompPid: started.ompPid });
        const session = await waitForPublishedSession(String(access.origin), sessionLabel);
        const publication = await ps(context, "publication");
        return { namedPipe: publication.namedPipe, generation: session.generation };
      }
      if (action === "launch") {
        const session = await waitForPublishedSession(String(access.origin), sessionLabel);
        await verifyLaunchContracts(String(access.origin), session);
        return { viewStatus: 200, controlStatus: 200, noStore: true, ...await verifyWindowsStaleLaunch(String(access.origin), session) };
      }
      if (action === "revoked") { await waitForRevocation(String(access.origin), sessionLabel); return { revoked: true }; }
      if (options.development && action === "installPredecessor" && access.configDigest && access.credentialDigest) {
        return ps(context, "inspectPredecessor");
      }
      await context.beforeEffect(); const result = await ps(context, action);
      if (action === "installPredecessor" || action === "rotate") await save({ configDigest: result.configDigest ?? access.configDigest, credentialDigest: result.credentialDigest });
      return result;
    },
    async rdp(context) {
      const access = await loadAccess(context.epoch);
      const cert = await ps(context, "fingerprint");
      if (typeof cert.fingerprint !== "string" || !SHA.test(cert.fingerprint)) throw new Error("RDP certificate SHA-256 unavailable");
      await context.beforeEffect();
      const child = Bun.spawn(["sdl-freerdp", `/v:${access.host}`, "/u:Administrator", "/from-stdin:force", `/cert:fingerprint:sha256:${cert.fingerprint}`, "/size:800x600", "/log-level:OFF"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      child.stdin.write(`${access.password}\n`); child.stdin.end();
      try { await poll(async () => (await ps(context, "interactive")).interactive === true, 120_000, "certificate-pinned interactive RDP"); }
      finally { child.kill(); await child.exited; }
    },
    async pixel(context) {
      const access = await loadAccess(context.epoch);
      const serial = await requireSingleDevice();
      const activities = await command(["adb", "-s", serial, "shell", "dumpsys", "activity", "activities"]);
      const component = /(?:topResumedActivity|mResumedActivity|ResumedActivity).*?\bu\d+\s+([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/u.exec(activities)?.[1];
      const power = await command(["adb", "-s", serial, "shell", "dumpsys", "power"]);
      const wakefulness = /mWakefulness=(Awake|Asleep|Dozing|Dreaming)/u.exec(power)?.[1];
      const keyguard = parseKeyguardShowing(await command(["adb", "-s", serial, "shell", "dumpsys", "window"]));
      if (!component || !wakefulness) throw new Error("Pixel baseline is incomplete");
      const launcher = windowsPixelLauncher(activities, component);
      if ((await command(["adb", "forward", "--list"])).includes("tcp:9222")) throw new Error("Pixel debugging port already has an owner");
      await context.beforeEffect(); await atomicPrivate(vaultPath(context.epoch), { ...access, pixelState: { serial, component, launcherPackage: launcher.packageName, launcherCategory: launcher.category, wakefulness, keyguard } });
      let result: Record<string, unknown> | undefined;
      let primary: unknown;
      try {
        const smoke = await runAndroidCollabSmoke({ origin: String(access.origin), label: sessionLabel, allowDisposableTarget: true });
        // Serve must supply the user identity for this exact-login, production-mode gateway.
        result = { pixelIdentityAccepted: true, viewReadOnly: smoke.viewReadOnly, controlWritable: smoke.controlWritable, promptAccepted: smoke.promptAccepted, returnedToDirectory: smoke.returnedToDirectory };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown failure";
        primary = new Error(`Windows Pixel: ${message.replaceAll(String(access.origin), "[origin]").replaceAll(serial, "[device]")}`);
      }
      try { await restorePixel(context); }
      catch (error) {
        if (primary) throw Object.assign(new AggregateError([primary, error], "Windows Pixel and restoration failed"), { pixelUnrestored: true });
        throw error;
      }
      if (primary) throw primary;
      if (!result) throw new Error("Windows Pixel produced no observation");
      return result;
    },
    restorePixel,
    async deleteTailnet(context) {
      const listing = await request<{ devices: Array<{ id: string; hostname: string }> }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders);
      if (!listing) throw new Error("tailnet listing failed");
      const matches = listing.devices.filter(item => item.hostname === windowsCampaignLabel(context.epoch));
      for (const match of matches) {
        const fresh = await request<{ id: string; hostname: string }>(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(match.id)}`, tsHeaders);
        if (!fresh) continue;
        if (fresh.hostname !== windowsCampaignLabel(context.epoch)) throw new Error("tailnet ownership changed");
        await context.beforeEffect(); await request(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(match.id)}`, tsHeaders, "DELETE");
      }
      const after = await request<{ devices: Array<{ hostname: string }> }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders);
      if (!after || after.devices.some(item => item.hostname === windowsCampaignLabel(context.epoch))) throw new Error("tailnet node remains");
    },
  };
}

/** The campaign's own release verification, so the probe installs exactly the bytes a campaign would. */
async function verifiedDevelopmentArtifact(tag: string, stable: boolean, ghToken: string): Promise<WindowsArtifact> {
  const directory = join(devRoot, "assets", tag);
  const release = await verifyRelease(tag, directory, stable, ghToken);
  const archivePath = releaseArchivePath(directory, tag);
  await chmod(directory, 0o700); await chmod(archivePath, 0o600);
  return { tag, sourceCommit: release.sourceCommit, archivePath, archiveSha256: release.archiveSha256 };
}

export async function windowsDevelopmentCli(args: readonly string[]): Promise<void> {
  const [mode = "", ...rest] = args;
  const usage = "usage: bun scripts/windows-stable-qualification.ts preflight|cleanup, or artifacts|run --tag vX.Y.Z-prealpha.N";
  if (!["preflight", "artifacts", "run", "cleanup"].includes(mode)) throw new Error(usage);
  // The campaign's tag grammar and published predecessor: the probe never installs a pair a campaign would not.
  const options = mode === "artifacts" || mode === "run" ? parseStableQualificationArgs(rest, {}) : undefined;
  if ((options === undefined && rest.length > 0) || options?.preflight === true) throw new Error(usage);
  const runtime = await createWindowsRuntime({ development: true });
  if (mode === "preflight") { console.log(JSON.stringify(await preflightWindows({}, runtime))); return; }
  await mkdir(devRoot, { recursive: true, mode: 0o700 }); await chmod(devRoot, 0o700);
  const progressPath = join(devRoot, "progress.json"); const identityPath = join(devRoot, "identity.json");
  let progress: unknown;
  try { progress = JSON.parse(await privateFile(progressPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (mode === "artifacts" && windowsNeedsCleanup(progress)) throw new Error("cannot replace artifact inputs while a Windows attempt needs cleanup");
  let identity: WindowsIdentity;
  if (mode === "cleanup" || windowsNeedsCleanup(progress)) {
    identity = JSON.parse(await privateFile(identityPath)) as WindowsIdentity;
    if (options !== undefined && identity.tag !== options.tag) throw new Error(`the retained attempt belongs to ${identity.tag}; run cleanup before probing ${options.tag}`);
  } else {
    if (options === undefined) throw new Error(usage);
    const ghToken = await command(["gh", "auth", "token"]);
    identity = { tag: options.tag, candidate: await verifiedDevelopmentArtifact(options.tag, false, ghToken),
      predecessor: await verifiedDevelopmentArtifact(options.previousTag, true, ghToken), omp: parseQualificationPins(await readFile(join(root, "UPSTREAM.lock.json"), "utf8")) };
    await atomicPrivate(identityPath, identity); progress = undefined;
  }
  if (mode === "artifacts") {
    console.log(JSON.stringify({ candidate: identity.candidate.tag, predecessor: identity.predecessor.tag, verified: true }));
    return;
  }
  const checkpoint = async (next: Record<string, unknown>) => { progress = next; await atomicPrivate(progressPath, next); };
  const pixel = async <T>(_owner: string, action: () => Promise<T>): Promise<T> => {
    const lock = "/tmp/omp-gw-pixel.lock"; const deadline = Date.now() + 60 * 60_000;
    const epoch = (progress as { epoch: string }).epoch;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await readFile(join(lock, "owner"), "utf8").catch(() => "");
        const fields = owner.trim().split(" ");
        if (mode === "cleanup" && fields[0] === "WindowsLane" && fields[2] === epoch && /^\d+$/u.test(fields[3] ?? "")) {
          try { process.kill(Number(fields[3]), 0); }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") break; }
        }
        if (Date.now() > deadline) throw new Error("shared Pixel lock held over 60 minutes");
        await Bun.sleep(5_000);
      }
    }
    try {
      await writeFile(join(lock, "owner"), `WindowsLane ${new Date().toISOString()} ${epoch} ${process.pid}\n`, { mode: 0o600 });
      const result = await action();
      if ((await loadAccess(epoch)).pixelState) throw new Error("Pixel restoration incomplete; owned lease retained for cleanup");
      return result;
    } finally {
      // Never hand an unrestored phone to the other lane. Only cleanup may recover
      // this exact epoch's lease after the owning controller process has exited.
      if (!(await loadAccess(epoch)).pixelState) await rm(lock, { recursive: true });
    }
  };
  if (mode === "cleanup") { console.log(JSON.stringify(await cleanupWindows({ identity, progress, checkpoint, pixel, runtime }))); return; }
  const result = await runWindows({ identity, progress, checkpoint, pixel, runtime });
  const cleanup = await cleanupWindows({ identity, progress, checkpoint, pixel, runtime });
  const evidence = { claim: "tested-development-only", ...result, cleanup };
  await atomicPrivate(join(devRoot, "evidence.json"), evidence); console.log(JSON.stringify(evidence, null, 2));
}
