import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOmpStdinDriver, OmpLifecycleFailure, runOmpLifecycle, type OmpLifecycleEvidence, type OmpLifecycleHost } from "./omp-lifecycle-qualification.ts";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { parseJsonRecord } from "./post-release-smoke.ts";
import { verifyLaunchContracts, waitForPublishedSession, waitForRevocation } from "./stable-qualification.ts";
import upstream from "../UPSTREAM.lock.json";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

// A pipe on the controller side, a real controlling terminal on OMP's side: the same
// byte transport as ssh -tt. No terminal output is retained, parsed, printed, or recorded.
// Unlike `script`, this bridge explicitly waits for its child after forwarding shutdown.
const PTY_BRIDGE = `import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, master = pty.fork()
if pid == 0:
    sink = os.open(os.devnull, os.O_WRONLY)
    os.dup2(sink, 1)
    os.dup2(sink, 2)
    os.close(sink)
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
stopping = None
def stop(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            sys.exit(os.waitstatus_to_exitcode(status))
        if stopping is not None and time.monotonic() - stopping > 10:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        ready, _, _ = select.select([master] + ([] if stopping is not None else [0]), [], [], 0.1)
        for fd in ready:
            try: data = os.read(fd, 65536)
            except OSError:
                stop()
                continue
            if not data:
                stop()
            elif fd == 0:
                while data:
                    written = os.write(master, data)
                    data = data[written:]
finally:
    stop()
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    os.close(master)
`;

async function stopProcess(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])) {
    throw new Error("lifecycle development process did not stop");
  }
}

async function runDevelopment(omp: string): Promise<void> {
  let root: string | undefined;
  let daemon: Bun.Subprocess | undefined;
  let host: OmpLifecycleHost | undefined;
  const children: Bun.Subprocess[] = [];
  let phase = "setup";
  let failed = false;
  let evidence: OmpLifecycleEvidence | undefined;
  let rootRemoved = false;
  try {
    if (process.platform !== "darwin" || !isAbsolute(omp) || !await Bun.file(omp).exists()) throw new Error();
    root = await mkdtemp("/tmp/omp-lifecycle-dev-");
    const home = join(root, "home");
    const discovery = join(home, ".omp/run/collab-hosts");
    const label = "omp-lifecycle-development";
    const cwd = join(root, label);
    for (const path of [home, cwd, join(root, "config/omp-session-gateway"), join(root, "state"), join(root, "run")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const environment = {
      HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", TERM: "xterm-256color",
      ...OMP_FIXTURE_ENV,
    };
    phase = "OMP version";
    const version = Bun.spawn([process.execPath, omp, "--version"], { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    children.push(version);
    const versionText = await new Response(version.stdout).text();
    if (await version.exited !== 0 || versionText.trim() !== `omp/${upstream.packageVersion}`) throw new Error();
    phase = "OMP configuration";
    const config = Bun.spawn([process.execPath, omp, "config", "set", "collab.autoStart", "control"], { cwd, env: environment, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(config);
    if (await config.exited !== 0) throw new Error();
    // A settings write can exit 0 without persisting; OMP's own read-back is the proof.
    const readBack = Bun.spawn([process.execPath, omp, "config", "get", "collab.autoStart", "--json"], { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    children.push(readBack);
    const readBackText = await new Response(readBack.stdout).text();
    if (await readBack.exited !== 0 || parseJsonRecord(readBackText, "OMP auto-start").value !== "control") throw new Error();
    phase = "gateway startup";
    if (!await Bun.file(join(REPOSITORY, "apps/web/dist/index.html")).exists()) throw new Error();
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = reservation.port;
    reservation.stop(true);
    if (port === undefined || port === 4317) throw new Error();
    const origin = `http://127.0.0.1:${port}`;
    await writeFile(join(root, "config/omp-session-gateway/config.json"), JSON.stringify({
      http: { hostname: "127.0.0.1", port, publicOrigin: origin },
      auth: { mode: "dev-localhost", allowedLogins: [] },
      omp: { discoveryDir: discovery },
      registry: { heartbeatSeconds: 2, ttlSeconds: 11, maxSessions: 10 },
    }), { mode: 0o600, flag: "wx" });
    await writeFile(join(root, "config/omp-session-gateway/readiness-token"), `${"synthetic-readiness-".padEnd(43, "x")}\n`, { mode: 0o600, flag: "wx" });
    daemon = Bun.spawn([process.execPath, "apps/gateway/src/cli.ts", "serve"], {
      cwd: REPOSITORY, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: { ...environment, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), TMPDIR: join(root, "run") },
    });
    children.push(daemon);
    const deadline = performance.now() + 30_000;
    let ready = false;
    while (performance.now() < deadline && daemon.exitCode === null) {
      try {
        const response = await fetch(`${origin}/api/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(1_000) });
        const body: unknown = await response.json();
        if (response.status === 200 && typeof body === "object" && body !== null && "status" in body && body.status === "ready") { ready = true; break; }
      } catch { /* The isolated daemon may not yet have bound its port. */ }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error();
    phase = "host startup";
    const start = (continued: boolean) => {
      const child = Bun.spawn(["/usr/bin/env", "python3", "-c", PTY_BRIDGE, process.execPath, omp, ...OMP_FIXTURE_ARGS, ...(continued ? ["--continue"] : [])], {
        cwd, env: environment, stdin: "pipe", stdout: "ignore", stderr: "ignore",
      });
      children.push(child);
      return child;
    };
    host = createOmpStdinDriver(start(false), () => start(true), async child => {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await stopProcess(child);
    });
    phase = "lifecycle";
    evidence = await runOmpLifecycle({ host, observer: { origin, waitForPublishedSession, verifyLaunchContracts, waitForRevocation }, label });
  } catch (error) {
    if (error instanceof OmpLifecycleFailure) phase = error.step;
    failed = true;
  }
  // The catch above keeps every outcome, so cleanup always runs from here.
  let cleanupFailed = false;
  try { await host?.stopAll(); } catch { cleanupFailed = true; }
  for (const child of children) {
    try { await stopProcess(child); } catch { cleanupFailed = true; }
  }
  if (root !== undefined && !cleanupFailed) {
    // Only OMP may remove its publications. Do not recursively erase a live/stale discovery entry.
    try {
      if (host !== undefined) {
        const prune = Bun.spawn([process.execPath, omp, "collab", "list"], {
          cwd: root, env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...OMP_FIXTURE_ENV },
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
        });
        children.push(prune);
        if (!await Promise.race([prune.exited.then(code => code === 0), Bun.sleep(15_000).then(() => false)])) {
          await stopProcess(prune);
          throw new Error();
        }
      }
      const entries = await readdir(join(root, "home/.omp/run/collab-hosts")).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length !== 0) throw new Error();
      await rm(root, { recursive: true, force: true });
      rootRemoved = true;
    } catch { cleanupFailed = true; }
  }
  const cleanupPassed = !cleanupFailed && children.every(child => child.exitCode !== null);
  if (failed || !cleanupPassed) {
    console.log(JSON.stringify({ passed: false, reason: `lifecycle development ${failed ? phase : "cleanup"} failed`, cleanup: { stopped: children.every(child => child.exitCode !== null), privateRootRemoved: root === undefined || rootRemoved } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(evidence));
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--omp" || args[1] === undefined) {
    console.error("usage: bun scripts/omp-lifecycle-development.ts --omp <absolute stock OMP dist/cli.js>");
    process.exitCode = 1;
  } else {
    await runDevelopment(args[1]);
  }
}
