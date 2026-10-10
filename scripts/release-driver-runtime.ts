import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORDER_AUTHOR, ORDER_HEAD_PREFIX, REPOSITORY, REQUIRED_CHECKS, StaleIntentError, compareVersions, isOrder, outsideOrderScope, requestVersion, tick } from "./release-driver.ts";
import type { Decision, DriverConfig, DriverPort, DriverState, JobObservation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";
import { assertReleaseTagState } from "./release-tag-state.ts";
import { releaseAssetNames, verifyReleaseSignatures } from "./post-release-smoke.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { compareReleaseArchives } from "./release-runtime-compare.ts";
import type { StableQualificationReceipt } from "./stable-qualification.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface RuntimeConfig extends DriverConfig {
  ghConfig: string;
  signingKey: string;
  stateDir: string;
  dryRun: boolean;
}
export function driverConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (env.OMP_RELEASE_DRY_RUN !== undefined && !["0", "1", "false", "true"].includes(env.OMP_RELEASE_DRY_RUN)) throw new Error("OMP_RELEASE_DRY_RUN must be 0, 1, false or true");
  const config = {
    bot: env.OMP_RELEASE_BOT_LOGIN ?? "alphastorm-release",
    founder: env.OMP_RELEASE_FOUNDER_LOGIN ?? "alphastorm",
    ghConfig: env.OMP_RELEASE_GH_CONFIG_DIR ?? join(homedir(), ".config/gh-release-bot"),
    signingKey: env.OMP_RELEASE_SIGNING_KEY ?? join(homedir(), ".ssh/omp-gateway-release-signing"),
    stateDir: env.OMP_RELEASE_STATE_DIR ?? join(homedir(), ".local/state/omp-session-gateway/release-driver"),
    dryRun: env.OMP_RELEASE_DRY_RUN === "1" || env.OMP_RELEASE_DRY_RUN === "true",
  };
  for (const login of [config.bot, config.founder]) if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(login)) throw new Error("invalid release identity login");
  for (const path of [config.ghConfig, config.signingKey, config.stateDir]) if (!isAbsolute(path)) throw new Error("driver paths must be absolute");
  return config;
}
/** Never let ambient founder tokens or git identity override the dedicated machine account. */
export function botEnvironment(config: RuntimeConfig, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ambient, GH_CONFIG_DIR: config.ghConfig, GH_HOST: "github.com", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_COUNT", "OMP_STABLE_PREVIOUS_TAG", "OMP_STABLE_MAC_SUDO_PASSWORD_FILE", "OMP_STABLE_QUALIFICATION_DIR"]) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_/u.test(key)) delete env[key];
  return env;
}
async function command(argv: string[], cwd: string, env: NodeJS.ProcessEnv, allowedFailure = false): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !allowedFailure) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${code}; inspect the private release-driver job logs`, { cause: { out: out.slice(-262144), err: err.slice(-262144) } });
  return { code, out: out.trim(), err };
}
async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("release-driver state directory must be private and owned by this account");
}
interface ApiPr {
  number: number; user: { login: string; type: string }; head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string }; draft: boolean; state: "open" | "closed"; merged: boolean;
  merged_by: { login: string } | null; merge_commit_sha: string | null; mergeable_state: string; html_url: string;
}
interface WorkflowRun { id: number; run_attempt: number; head_sha: string; head_branch: string; conclusion: string | null; status: string; html_url: string; created_at: string }
interface JobSpec { kind: "campaign" | "approve" | "smoke"; state: DriverState; root: string }

export class StudioDriver implements DriverPort {
  private env: NodeJS.ProcessEnv;
  private email = "";
  constructor(readonly config: RuntimeConfig, readonly plan: boolean) {
    // A plan may use the founder's existing read-only CLI session before the bot exists.
    this.env = plan ? { ...process.env, GH_PROMPT_DISABLED: "1" } : botEnvironment(config);
  }
  async gh<T>(args: string[], optional = false): Promise<T | undefined> {
    const result = await command(["gh", ...args], ROOT, this.env, optional);
    if (result.code !== 0) {
      if (optional && /\bHTTP 404\b/u.test(result.err)) return undefined;
      throw new Error("GitHub read failed; refusing to infer missing provider state");
    }
    return result.out === "" ? undefined : JSON.parse(result.out) as T;
  }
  async api<T>(path: string, optional = false): Promise<T | undefined> {
    return this.gh<T>(["api", `repos/${REPOSITORY}/${path}`], optional);
  }
  async pages<T>(path: string): Promise<T[]> {
    const pages = await this.gh<T[][]>(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/${path}`]);
    return pages!.flat();
  }
  async authenticate(): Promise<void> {
    if (this.plan) throw new Error("plan mode cannot authenticate for writes");
    const identity = await this.gh<{ login: string; id: number }>(["api", "user"]);
    if (identity?.login !== this.config.bot) throw new Error("dedicated gh config is not authenticated as the configured release bot");
    this.email = `${identity.id}+${identity.login}@users.noreply.github.com`;
    this.env = { ...this.env, GIT_AUTHOR_NAME: this.config.bot, GIT_COMMITTER_NAME: this.config.bot,
      GIT_AUTHOR_EMAIL: this.email, GIT_COMMITTER_EMAIL: this.email };
    // HTTPS git's only credential source is gh under the same isolated configuration.
    this.env.GIT_CONFIG_COUNT = "3";
    this.env.GIT_CONFIG_KEY_0 = "credential.helper"; this.env.GIT_CONFIG_VALUE_0 = "";
    this.env.GIT_CONFIG_KEY_1 = "credential.https://github.com.helper"; this.env.GIT_CONFIG_VALUE_1 = "!gh auth git-credential";
    this.env.GIT_CONFIG_KEY_2 = "gpg.ssh.allowedSignersFile"; this.env.GIT_CONFIG_VALUE_2 = join(this.config.stateDir, "allowed-signers");
    const keyParts = (await command(["ssh-keygen", "-y", "-f", this.config.signingKey], ROOT, this.env)).out.split(/\s+/u);
    const publicKey = `${keyParts[0]} ${keyParts[1]}`; // Never persist a key comment containing a host/account identifier.
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(publicKey)) throw new Error("release signing key must be an unattended ed25519 SSH key");
    await writeFile(join(this.config.stateDir, "allowed-signers"), `${this.email} ${publicKey}\n`, { mode: 0o600 });
  }
  async load(): Promise<DriverState | undefined> {
    const state = await jsonFile<DriverState>(join(this.config.stateDir, "state.json"));
    if (state !== undefined && (state.schemaVersion !== 1 || !Number.isSafeInteger(state.sequence) || requestVersion(state.issue) === undefined)) throw new Error("unsupported/corrupt release-driver state");
    return state;
  }
  async save(state: DriverState): Promise<void> {
    if (this.plan) throw new Error("plan attempted state mutation");
    await atomicJson(join(this.config.stateDir, "state.json"), state);
  }
  async readPr(number: number): Promise<PullRequest> {
    const pr = (await this.api<ApiPr>(`pulls/${number}`))!;
    const [head, files, checks, merge] = await Promise.all([
      this.api<{ tree: { sha: string } }>(`git/commits/${pr.head.sha}`),
      this.pages<{ filename: string; previous_filename?: string }>(`pulls/${number}/files?per_page=100`),
      this.gh<{ check_runs: { name: string; status: string; conclusion: string; app: { slug: string } }[] }[]>(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/commits/${pr.head.sha}/check-runs?per_page=100&filter=latest`]),
      pr.merged && pr.merge_commit_sha !== null ? this.api<{ tree: { sha: string } }>(`git/commits/${pr.merge_commit_sha}`) : undefined,
    ]);
    const runs = checks!.flatMap(page => page.check_runs);
    return { number, author: pr.user.login, authorType: pr.user.type, headRepository: pr.head.repo?.full_name ?? "",
      base: pr.base.ref, headRef: pr.head.ref, head: pr.head.sha, tree: head!.tree.sha, draft: pr.draft,
      state: pr.state, merged: pr.merged, mergedBy: pr.merged_by?.login, mergeCommit: pr.merge_commit_sha ?? undefined,
      mergeTree: merge?.tree.sha, behind: pr.mergeable_state === "behind" || pr.mergeable_state === "unknown",
      checksPassed: REQUIRED_CHECKS.every(name => runs.some(run => run.name === name && run.status === "completed" && run.conclusion === "success" && run.app.slug === "github-actions")), files, url: pr.html_url };
  }
  async issues(): Promise<TrackingIssue[]> {
    const raw = await this.pages<{ number: number; title: string; user: { login: string }; html_url: string; created_at: string; pull_request?: unknown }>("issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
    const issues = raw.filter(issue => issue.pull_request === undefined).map(issue => ({ number: issue.number, title: issue.title, author: issue.user.login, request: issue.created_at, url: issue.html_url })).filter(issue => requestVersion(issue) !== undefined);
    if (issues.length === 0) return issues;
    const requests = await this.api<{ workflow_runs: WorkflowRun[] }>("actions/workflows/release-request.yml/runs?status=success&per_page=100", true);
    const unmatched = new Set(issues.map(issue => requestVersion(issue)!));
    for (const run of requests?.workflow_runs ?? []) {
      if (unmatched.size === 0) break;
      const jobs = await this.api<{ jobs: { name: string; conclusion: string }[] }>(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      for (const version of unmatched) {
        if (!jobs!.jobs.some(job => job.name === `Request OMP ${version}` && job.conclusion === "success")) continue;
        for (const issue of issues) if (requestVersion(issue) === version) issue.request = `${run.id}:${run.run_attempt}`;
        unmatched.delete(version);
      }
    }
    return issues;
  }
  async workflow(tag: string, source: string): Promise<"passed" | "failed" | "pending"> {
    const result = await this.api<{ workflow_runs: WorkflowRun[] }>(`actions/workflows/signed-release.yml/runs?event=push&head_sha=${source}&per_page=100`);
    const run = result!.workflow_runs.find(run => run.head_branch === tag && run.head_sha === source);
    return run?.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed" : "failed";
  }
  async job(kind: JobSpec["kind"], state: DriverState): Promise<JobObservation> {
    const directory = this.jobDirectory(kind, state);
    const result = await jsonFile<JobObservation>(join(directory, "result.json"));
    if (result !== undefined) return result;
    const running = await command(["tmux", "has-session", "-t", this.session(kind, state)], ROOT, this.env, true);
    return { status: running.code === 0 ? "running" : "absent", detail: `${kind} job has no exit receipt and no tmux session; no automatic retry` };
  }
  jobDirectory(kind: JobSpec["kind"], state: DriverState): string { return join(this.config.stateDir, "jobs", `${state.issue.number}-${state.candidate}-${kind}`); }
  session(kind: JobSpec["kind"], state: DriverState): string { return `omp-release-${state.issue.number}-${state.candidate.replaceAll(".", "-")}-${kind}`; }
  async snapshot(state: DriverState | undefined): Promise<RepositorySnapshot> {
    const [main, upstream, latest, tags, issues] = await Promise.all([
      this.api<{ sha: string }>("commits/main"), this.api<{ content: string }>("contents/UPSTREAM.lock.json?ref=main"),
      this.api<{ tag_name: string }>("releases/latest"), this.pages<{ name: string }>("tags?per_page=100"), this.issues(),
    ]);
    const lock: { tag: string } = JSON.parse(Buffer.from(upstream!.content, "base64").toString());
    compareVersions(lock.tag, lock.tag);
    const stableTags = tags.map(tag => tag.name).filter(tag => /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(tag)).sort(compareVersions);
    const repo: RepositorySnapshot = { main: main!.sha, upstreamTag: lock.tag, latestStable: stableTags.at(-1) ?? latest!.tag_name, tags: tags.map(tag => tag.name), issues };
    if (state === undefined || state.phase === "closed") return repo;
    if (compareVersions(repo.upstreamTag, requestVersion(state.issue)!) < 0) {
      const prs = await this.pages<ApiPr>("pulls?state=open&base=main&per_page=100");
      const matching = prs.filter(pr => pr.user.login === ORDER_AUTHOR && pr.user.type === "Bot" && pr.head.repo?.full_name === REPOSITORY && pr.head.ref.startsWith(ORDER_HEAD_PREFIX));
      // Multiple matching orders are ambiguous. Never select by attacker-controlled title/body.
      if (matching.length === 1) repo.order = await this.readPr(matching[0]!.number);
    }
    if (state.preparePr !== undefined) repo.prepare = await this.readPr(state.preparePr);
    if (state.approvePr !== undefined) repo.approve = await this.readPr(state.approvePr);
    if (state.recordPr !== undefined) repo.record = await this.readPr(state.recordPr);
    if (state.phase === "candidate-tagged") repo.candidateWorkflow = await this.workflow(state.candidate, state.candidateCommit!);
    if (state.phase === "stable-tagged") repo.stableWorkflow = await this.workflow(`v${state.version}`, state.stableCommit!);
    if (state.phase === "qualifying") repo.campaign = await this.job("campaign", state);
    if (state.phase === "approve-checking") repo.approveChecks = await this.job("approve", state);
    if (state.phase === "smoking") repo.smoke = await this.job("smoke", state);
    if (state.phase === "diagnostic-required") {
      const path = join(homedir(), ".local/state/omp-session-gateway/release-host/lease.sqlite");
      if (await Bun.file(path).exists()) {
        try {
          const db = new Database(path, { readonly: true });
          try { repo.hostRecoveryRequired = db.query("SELECT owner FROM campaign WHERE id = 1").get() !== null; }
          finally { db.close(); }
        } catch { repo.hostRecoveryRequired = true; }
      }
    }
    return repo;
  }
  async announce(issue: number, body: string, marker: string): Promise<void> {
    const comments = await this.pages<{ body: string; user: { login: string } }>(`issues/${issue}/comments?per_page=100`);
    if (comments.some(comment => comment.user.login === this.config.bot && comment.body.includes(marker))) return;
    await this.gh(["api", "--method", "POST", `repos/${REPOSITORY}/issues/${issue}/comments`, "-f", `body=${body}`]);
  }
  async git(args: string[], cwd = ROOT): Promise<string> {
    return (await command(["git", ...args], cwd, this.env)).out;
  }
  async checkout(name: string, commit: string, branch?: string): Promise<string> {
    const directory = join(this.config.stateDir, "work", name);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await this.git(["fetch", "origin", "main", commit]);
    if (!await Bun.file(join(directory, ".git")).exists()) {
      const existingBranch = branch === undefined ? undefined : await command(["git", "rev-parse", "--verify", `refs/heads/${branch}`], ROOT, this.env, true);
      if (existingBranch?.code === 0) {
        if (existingBranch.out !== commit) throw new Error("orphaned driver branch differs from its pinned checkout source");
        await this.git(["worktree", "add", directory, branch!]);
      } else await this.git(["worktree", "add", ...(branch === undefined ? ["--detach"] : ["-b", branch]), directory, commit]);
    }
    return directory;
  }
  signingArgs(): string[] { return ["-c", "gpg.format=ssh", "-c", `user.signingkey=${this.config.signingKey}`]; }
  async push(ref: string, cwd = ROOT): Promise<void> {
    if (!(ref.startsWith("refs/heads/release-driver/") || /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(?:-prealpha\.[1-9][0-9]*)?$/u.test(ref))) throw new Error("driver refuses push outside owned release branches/tags");
    await this.git(["push", `https://github.com/${REPOSITORY}.git`, `${ref}:${ref}`], cwd);
  }
  async openPr(kind: "prepare" | "approve" | "record", state: DriverState): Promise<PullRequest> {
    const branch = `release-driver/${state.issue.number}/${state.candidate}-${kind}`;
    const existing = await this.pages<ApiPr>(`pulls?state=all&base=main&head=carrythroughsystems:${encodeURIComponent(branch)}&per_page=100`);
    if (existing.length > 1) throw new Error("multiple PRs use the deterministic release branch");
    if (existing.length === 1) {
      const pr = await this.readPr(existing[0]!.number);
      if (pr.author !== this.config.bot || pr.headRepository !== REPOSITORY) throw new Error("release PR is not bot-owned");
      return pr;
    }
    const source = kind === "prepare" ? state.selectedMain : kind === "approve" ? state.candidateCommit! : state.stableCommit!;
    const remote = await this.api<{ object: { sha: string } }>(`git/ref/heads/${branch}`, true);
    const directory = await this.checkout(`${state.issue.number}-${state.candidate}-${kind}`, remote?.object.sha ?? source, branch);
    if (remote === undefined) {
      const args = [process.execPath, "scripts/release-generate.ts", kind, kind === "prepare" ? state.version : `v${state.version}`, "--date", state.date];
      if (kind === "prepare") args.push("--candidate-tag", state.candidate);
      if (kind === "approve") args.push("--receipt", this.receipt(state), "--candidate-tag", state.candidate);
      if (kind === "record") args.push("--smoke", join(this.jobDirectory("smoke", state), "smoke.json"), "--status", join(this.jobDirectory("smoke", state), "status.json"), "--publication", join(this.config.stateDir, `${state.candidate}-publication.json`));
      // A committed local head is the crash checkpoint before a push; never regenerate its content.
      if (await this.git(["rev-parse", "HEAD"], directory) === source) {
        await command([process.execPath, "install", "--frozen-lockfile"], directory, this.env);
        await command(args, directory, this.env);
        await this.git(["add", "--all"], directory);
        const changed = await this.git(["diff", "--cached", "--name-only"], directory);
        if (changed === "") throw new Error("release generator produced no changes; refusing an empty release PR");
        await this.git([...this.signingArgs(), "commit", "-S", "-m", `${kind === "record" ? "docs" : "chore"}(release): ${kind} v${state.version}`], directory);
      }
      await this.push(`refs/heads/${branch}`, directory);
    }
    const created = await this.gh<ApiPr>(["api", "--method", "POST", `repos/${REPOSITORY}/pulls`, "-f", `title=${kind === "record" ? "docs" : "chore"}(release): ${kind} v${state.version}`, "-f", `head=${branch}`, "-f", "base=main", "-f", `body=Generated release ${kind} for #${state.issue.number}. ${kind === "approve" ? "Only the founder may merge after the release-driver approval-required comment." : "The release driver pins the head when merging."}`]);
    return this.readPr(created!.number);
  }
  receipt(state: DriverState): string { return join(homedir(), ".local/share/omp-session-gateway/qualification", state.candidate, "stable-qualification.json"); }
  async merge(pr: PullRequest, order: boolean): Promise<PullRequest> {
    const current = await this.readPr(pr.number);
    if (current.head !== pr.head || current.tree !== pr.tree) {
      if (current.merged) throw new Error("PR merged at a head other than the pinned one");
      throw new StaleIntentError("PR head changed before pinned merge");
    }
    if (order ? !isOrder(current) || outsideOrderScope(current).length > 0 : current.author !== this.config.bot || current.base !== "main" || current.headRepository !== REPOSITORY) throw new Error("PR identity/scope changed");
    if (current.merged) {
      if (current.mergedBy !== this.config.bot) throw new Error("driver-owned PR merged by another identity");
      return current;
    }
    if (current.state !== "open" || current.draft || current.behind || !current.checksPassed) throw new StaleIntentError("PR is not eligible for strict checked merge");
    await command(["gh", "pr", "merge", String(pr.number), "--repo", REPOSITORY, "--squash", "--match-head-commit", pr.head], ROOT, this.env);
    const merged = await this.readPr(pr.number);
    if (!merged.merged || merged.mergedBy !== this.config.bot) throw new Error("pinned merge is not observable as the release bot");
    return merged;
  }
  async tag(tag: string, source: string): Promise<void> {
    const remote = await this.api<{ ref: string; object: { sha: string; type: string } }>(`git/ref/tags/${tag}`, true);
    if (remote !== undefined) {
      const object = await this.api<{ tag: string; object: unknown; verification: unknown; tagger: { email: string } }>(`git/tags/${remote.object.sha}`);
      assertReleaseTagState(remote, object!, tag, source);
      if (object!.tagger.email !== this.email) throw new Error("existing release tag has another tagger");
      return;
    }
    await this.git(["fetch", "origin", "main", source]);
    const local = await command(["git", "rev-parse", "--verify", `refs/tags/${tag}^{commit}`], ROOT, this.env, true);
    if (local.code === 0) {
      if (local.out !== source) throw new Error("local release tag points at another source");
      await this.git(["tag", "-v", tag]);
    } else await this.git([...this.signingArgs(), "tag", "-s", "-m", `omp-session-gateway ${tag}`, tag, source]);
    await this.push(`refs/tags/${tag}`);
  }
  async verify(tag: string, source: string, stable: boolean, state: DriverState): Promise<string> {
    const version = state.version, names = releaseAssetNames(version);
    const directory = stable ? join(this.config.stateDir, `${tag}-assets`) : join(dirname(this.receipt(state)), "assets");
    const reference = (await this.api<{ ref: string; object: { sha: string; type: string } }>(`git/ref/tags/${tag}`))!;
    assertReleaseTagState(reference, (await this.api(`git/tags/${reference.object.sha}`)) as Parameters<typeof assertReleaseTagState>[1], tag, source);
    await downloadReleaseAssets(directory, () => command(["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", directory], ROOT, this.env));
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names.all].sort())) throw new Error("published release has an unexpected asset set");
    await command(["gh", "release", "verify", tag, "--repo", REPOSITORY], ROOT, this.env);
    for (const asset of names.all) await command(["gh", "release", "verify-asset", tag, join(directory, asset), "--repo", REPOSITORY], ROOT, this.env);
    await command(["shasum", "-a", "256", "-c", "SHA256SUMS"], directory, this.env);
    for (const asset of names.attested) {
      await verifyReleaseSignatures(join(directory, asset), REPOSITORY, tag, argv => command(argv, ROOT, this.env));
    }
    const digest = createHash("sha256").update(await readFile(join(directory, names.archive))).digest("hex");
    const release = (await this.api<{ draft: boolean; prerelease: boolean; published_at: string; html_url: string; assets: { name: string; digest: string }[] }>(`releases/tags/${tag}`))!;
    if (release.draft || release.prerelease === stable || release.assets.find(asset => asset.name === names.archive)?.digest !== `sha256:${digest}`) throw new Error("published release flags or archive digest disagree");
    const latest = (await this.api<{ tag_name: string }>("releases/latest"))!;
    if ((latest.tag_name === tag) !== stable) throw new Error("release GitHub Latest state disagrees with its channel");
    if (stable) {
      const checkout = await this.checkout(`${tag}-rebuild`, source);
      if (await this.git(["rev-parse", "HEAD"], checkout) !== source) throw new Error("stable rebuild source changed");
      await command([process.execPath, "install", "--frozen-lockfile"], checkout, this.env);
      await command([process.execPath, "run", "release:build"], checkout, { ...this.env, OMP_RELEASE_CHANNEL: "stable" });
      const rebuilt = createHash("sha256").update(await readFile(join(checkout, "dist/release", names.archive))).digest("hex");
      if (rebuilt !== digest) throw new Error("stable rebuilt digest differs from published archive");
      const runs = (await this.api<{ workflow_runs: WorkflowRun[] }>(`actions/workflows/signed-release.yml/runs?event=push&head_sha=${source}&per_page=100`))!;
      const run = runs.workflow_runs.find(run => run.head_branch === tag && run.head_sha === source && run.conclusion === "success");
      if (run === undefined) throw new Error("stable publication workflow disappeared");
      await atomicJson(join(this.config.stateDir, `${state.candidate}-publication.json`), { tag, sourceCommit: source, archiveSha256: digest, runUrl: run.html_url, releaseUrl: release.html_url, publishedAt: release.published_at });
    }
    return digest;
  }
  async launch(kind: JobSpec["kind"], state: DriverState): Promise<void> {
    const directory = this.jobDirectory(kind, state);
    await privateDirectory(directory);
    if (await Bun.file(join(directory, "result.json")).exists()) return;
    if ((await command(["tmux", "has-session", "-t", this.session(kind, state)], ROOT, this.env, true)).code === 0) return;
    if (await Bun.file(join(directory, "started")).exists()) return; // Observe missing exit/session next tick; never relaunch.
    await atomicJson(join(directory, "spec.json"), { kind, state, root: ROOT } satisfies JobSpec);
    const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
    const launcher = `${quote(process.execPath)} ${quote(join(ROOT, "scripts/release-driver.ts"))} worker ${quote(join(directory, "spec.json"))} >${quote(join(directory, "out.log"))} 2>${quote(join(directory, "err.log"))}`;
    const workerEnvironment = { PATH: this.env.PATH ?? "", OMP_RELEASE_BOT_LOGIN: this.config.bot, OMP_RELEASE_FOUNDER_LOGIN: this.config.founder, OMP_RELEASE_GH_CONFIG_DIR: this.config.ghConfig, OMP_RELEASE_SIGNING_KEY: this.config.signingKey, OMP_RELEASE_STATE_DIR: this.config.stateDir, OMP_STABLE_MAC_HOST: this.env.OMP_STABLE_MAC_HOST ?? "", OMP_STABLE_MAC_MODEL: this.env.OMP_STABLE_MAC_MODEL ?? "VirtualMac2,1" };
    await command(["tmux", "new-session", "-d", "-s", this.session(kind, state), ...Object.entries(workerEnvironment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), launcher], ROOT, this.env);
  }
  async perform(step: Decision, state: DriverState): Promise<Partial<DriverState>> {
    if (this.plan) throw new Error("plan attempted a release effect");
    switch (step.operation) {
      case "update-order":
      case "update-release-pr": {
        const pr = await this.readPr(step.pr!.number);
        if (step.operation === "update-order" ? !isOrder(pr) || outsideOrderScope(pr).length > 0 : pr.author !== this.config.bot || pr.base !== "main" || pr.headRepository !== REPOSITORY) throw new Error("PR scope/identity changed");
        if (pr.head !== step.pr!.head || !pr.behind) return {};
        if (!pr.checksPassed) throw new Error("order checks no longer pass");
        await this.gh(["api", "--method", "PUT", `repos/${REPOSITORY}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${pr.head}`]);
        return {};
      }
      case "ready-order": {
        const pr = await this.readPr(step.pr!.number);
        if (!isOrder(pr) || outsideOrderScope(pr).length > 0) throw new Error("order identity/scope changed before ready");
        if (pr.head !== step.pr!.head || !pr.checksPassed) throw new StaleIntentError("order moved before ready");
        if (pr.draft) await command(["gh", "pr", "ready", String(pr.number), "--repo", REPOSITORY], ROOT, this.env);
        return {};
      }
      case "merge-order": await this.merge(step.pr!, true); return {};
      case "open-prepare": return { preparePr: (await this.openPr("prepare", state)).number };
      case "merge-prepare": return { candidateCommit: (await this.merge(step.pr!, false)).mergeCommit };
      case "tag-candidate": await this.tag(state.candidate, state.candidateCommit!); return {};
      case "verify-candidate": return { candidateDigest: await this.verify(state.candidate, state.candidateCommit!, false, state) };
      case "start-campaign": await this.launch("campaign", state); return {};
      case "open-approve": return { approvePr: (await this.openPr("approve", state)).number };
      case "start-approve-checks": await this.launch("approve", { ...state, ...step.patch }); return {};
      case "tag-stable": {
        const pr = await this.readPr(state.approvePr!);
        if (!pr.merged || pr.mergedBy !== this.config.founder || pr.mergeCommit !== state.stableCommit || pr.mergeTree !== state.approvedTree || pr.head !== state.approvedHead) throw new Error("founder approval binding changed before stable tag");
        await this.tag(`v${state.version}`, state.stableCommit!); return {};
      }
      case "verify-stable": return { stableDigest: await this.verify(`v${state.version}`, state.stableCommit!, true, state) };
      case "start-smoke": await this.launch("smoke", state); return {};
      case "open-record": return { recordPr: (await this.openPr("record", state)).number };
      case "merge-record": await this.merge(step.pr!, false); return {};
      case "close":
        for (const issue of await this.issues()) if (compareVersions(requestVersion(issue)!, requestVersion(state.issue)!) <= 0) {
          const body = `release-driver: closed — fulfilled by v${state.version}\nhttps://github.com/${REPOSITORY}/releases/tag/v${state.version}\n<!-- release-driver-close:${state.issue.number}:${issue.number}:${state.version} -->`;
          // The selected issue receives its single transition comment through the state outbox.
          if (issue.number !== state.issue.number) await this.announce(issue.number, body, `<!-- release-driver-close:${state.issue.number}:${issue.number}:${state.version} -->`);
          await this.gh(["api", "--method", "PATCH", `repos/${REPOSITORY}/issues/${issue.number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
        }
        return {};
      default: return {};
    }
  }
  async worker(specPath: string): Promise<void> {
    const spec = await jsonFile<JobSpec>(specPath);
    if (spec === undefined || spec.root !== ROOT || specPath !== join(this.jobDirectory(spec.kind, spec.state), "spec.json")) throw new Error("worker specification is outside its owned job directory");
    const directory = dirname(specPath), state = spec.state;
    const claim = await open(join(directory, "started"), "wx", 0o600);
    await claim.close();
    try {
      await this.authenticate();
      const source = spec.kind === "campaign" ? state.candidateCommit! : spec.kind === "approve" ? state.approvedHead! : state.stableCommit!;
      const branch = spec.kind === "campaign" ? `release-driver/${state.issue.number}/${state.candidate}-campaign` : undefined;
      const checkout = await this.checkout(`${state.issue.number}-${state.candidate}-${spec.kind}-job`, source, branch);
      if (await this.git(["rev-parse", "HEAD"], checkout) !== source) throw new Error("job checkout is not its pinned source");
      await command([process.execPath, "install", "--frozen-lockfile"], checkout, this.env);
      if (spec.kind === "campaign") {
        await this.push(`refs/heads/${branch!}`, checkout);
        const macHost = this.env.OMP_STABLE_MAC_HOST;
        if (!macHost || macHost.includes(".example.")) throw new Error("configure OMP_STABLE_MAC_HOST with the retained qualification target before arming");
        const env = { ...this.env, OMP_STABLE_MAC_HOST: macHost, OMP_STABLE_MAC_MODEL: this.env.OMP_STABLE_MAC_MODEL ?? "VirtualMac2,1", OMP_STABLE_OP_TOKEN_FILE: join(homedir(), ".local/state/omp-session-gateway/op-service-account.token") };
        await command(["security", "unlock-keychain", "-p", "", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        await command(["security", "set-keychain-settings", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        await command([process.execPath, "run", "qualify:stable", "--", "--tag", state.candidate, "--preflight"], checkout, env);
        await command([process.execPath, "run", "qualify:stable", "--", "--tag", state.candidate], checkout, env);
        const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
        if (receipt?.status !== "passed" || receipt.schemaVersion !== 3 || receipt.tag !== state.candidate || receipt.candidate?.sourceCommit !== state.candidateCommit || receipt.candidate?.archiveSha256 !== state.candidateDigest || Object.values(receipt.lanes).some(lane => lane.status !== "passed")) throw new Error("qualification receipt is not fully passed and candidate-bound");
      } else if (spec.kind === "approve") {
        await command([process.execPath, "run", "release:build"], checkout, { ...this.env, OMP_RELEASE_CHANNEL: "stable" });
        const names = releaseAssetNames(state.version);
        const compared = await compareReleaseArchives(join(dirname(this.receipt(state)), "assets", names.archive), state.candidateDigest!, join(checkout, "dist/release", names.archive));
        if (compared.differing.length !== 0) throw new Error("approve runtime differs from the qualified candidate");
        await command([process.execPath, "scripts/release-policy.ts", `v${state.version}`, state.version, "STABLE_RELEASE.lock.json"], checkout, this.env);
        await command([process.execPath, "run", "smoke:release", "--", "--tag", `v${state.version}`, "--plan"], checkout, this.env);
        await command([process.execPath, "run", "check"], checkout, this.env);
      } else {
        await command(["security", "unlock-keychain", "-p", "", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, this.env);
        await command(["security", "set-keychain-settings", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, this.env);
        // --force-reinstall: a retried smoke finds the release already active from the failed run,
        // and the record requires smoke evidence that this run installed the published bytes.
        const smoke = await command([process.execPath, "run", "smoke:release", "--", "--tag", `v${state.version}`, "--archive-sha256", state.stableDigest!, "--force-reinstall", "--rebuild-omp"], checkout, this.env);
        await atomicJson(join(directory, "smoke.json"), JSON.parse(smoke.out));
        const installation = join(homedir(), ".local/state/omp-session-gateway/installation");
        const active = (await jsonFile<{ versionDirectory?: string }>(join(installation, "current.json")))?.versionDirectory;
        if (active === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/u.test(active)) throw new Error("installed gateway active version is missing or invalid");
        const status = await command([join(homedir(), ".local/lib/omp-session-gateway/bun/v1.4.0/bun"), join(installation, "versions", active, "apps/gateway/src/cli.js"), "status"], checkout, this.env);
        await atomicJson(join(directory, "status.json"), JSON.parse(status.out));
      }
      await atomicJson(join(directory, "result.json"), { status: "passed" } satisfies JobObservation);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.cause !== undefined) await atomicJson(join(directory, "diagnostic.json"), error.cause);
      let detail = `${spec.kind} failed; inspect private job logs; no retry`;
      if (spec.kind === "campaign") {
        const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
        if (receipt !== undefined) detail = `campaign failed lanes: ${Object.entries(receipt.lanes).filter(([, lane]) => lane.status !== "passed").map(([name, lane]) => `${name} (${lane.status})`).join(", ")}; no retry`;
      }
      await atomicJson(join(directory, "result.json"), { status: "failed", detail } satisfies JobObservation);
      process.exitCode = 1;
    } finally { await writeFile(join(directory, "exit"), `${process.exitCode === 1 ? 1 : 0}\n`, { mode: 0o600 }); }
  }
}

async function drive(args: string[]): Promise<unknown> {
  const [mode, spec, ...extra] = args;
  if (!["plan", "tick", "worker"].includes(mode ?? "") || extra.length > 0 || (mode === "worker") !== (spec !== undefined)) throw new Error("usage: bun scripts/release-driver.ts plan|tick|worker <private-spec-path>");
  const config = driverConfig(), plan = mode === "plan" || config.dryRun;
  const driver = new StudioDriver(config, plan);
  if (plan) return tick(driver, config, true);
  if (process.platform !== "darwin" || (await command([process.execPath, "--version"], ROOT, process.env)).out !== "1.4.0") throw new Error("release driver writes require the Studio Darwin host and Bun 1.4.0");
  if (await Bun.file(join(config.stateDir, "disabled")).exists()) return { operation: "idle", detail: "kill switch is enabled" };
  await privateDirectory(config.stateDir);
  if (mode === "worker") { await driver.worker(spec!); return { operation: "worker", completed: true }; }
  const lockPath = join(config.stateDir, "tick.sqlite");
  try { const file = await open(lockPath, "wx", 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = new Database(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout=1000");
    lock.exec("BEGIN IMMEDIATE");
    await driver.authenticate();
    return await tick(driver, config);
  } finally { lock.close(); }
}

/** Keep one bounded operator log; campaign/device evidence stays in private per-job receipts. */
export async function runDriver(args: string[]): Promise<unknown> {
  const config = driverConfig();
  const log = async (entry: unknown) => {
    if (args[0] === "plan" || config.dryRun) return;
    try { if (!(await lstat(config.stateDir)).isDirectory()) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const path = join(config.stateDir, "driver.log");
    let previous = "";
    try { previous = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const line = JSON.stringify({ at: new Date().toISOString(), ...(typeof entry === "object" && entry !== null ? entry : { entry }) }) + "\n";
    await writeFile(path, (previous + line).slice(-262144), { mode: 0o600 });
  };
  try { const result = await drive(args); await log(result); return result; }
  catch (error) { await log({ error: error instanceof Error ? error.message : String(error) }); throw error; }
}
