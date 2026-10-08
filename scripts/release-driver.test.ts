import { describe, expect, test } from "bun:test";
import { botEnvironment, driverConfig, StudioDriver } from "./release-driver-runtime.ts";
import { compareVersions, isOrder, nextCandidate, nextStep, ORDER_SCOPE, outsideOrderScope, REPOSITORY, selectRequest, StaleIntentError, tick } from "./release-driver.ts";
import type { Decision, DriverPort, DriverState, Operation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";

const config = { bot: "alphastorm-release", founder: "alphastorm" };
const issue: TrackingIssue = { number: 400, title: "Upstream tracking: v18.8.3", author: "github-actions[bot]", request: "42:1", url: "https://github.com/alphastorm/omp-session-gateway/issues/400" };
function state(phase: DriverState["phase"] = "selected"): DriverState {
  return { schemaVersion: 1, sequence: 1, phase, issue: { ...issue }, version: "0.7.5", candidate: "v0.7.5-prealpha.1", selectedMain: "a".repeat(40), date: "2026-10-07" };
}
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return { number: 401, author: config.bot, authorType: "User", headRepository: REPOSITORY, base: "main", headRef: "release-driver/400/v0.7.5-prealpha.1-approve", head: "b".repeat(40), tree: "c".repeat(40), draft: false, state: "open", merged: false, behind: false, checksPassed: true, files: [], url: "https://github.com/alphastorm/omp-session-gateway/pull/401", ...overrides };
}
function order(overrides: Partial<PullRequest> = {}): PullRequest {
  return pr({ author: "alpha-founder-source-alphastorm[bot]", authorType: "Bot", headRef: "alpha-founder/order-400", draft: true, files: ORDER_SCOPE.map(filename => ({ filename })), ...overrides });
}
function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return { main: "a".repeat(40), upstreamTag: "v18.8.3", latestStable: "v0.7.4", tags: ["v0.7.4", "v0.7.4-prealpha.1"], issues: [{ ...issue }], ...overrides };
}
class FakeDriver implements DriverPort {
  state: DriverState | undefined;
  repo = snapshot();
  effects = new Map<string, Partial<DriverState>>();
  prepareSources: string[] = [];
  comments = new Map<string, string>();
  saves = 0;
  failSave = 0;
  crashAfterComment = false;
  commentWrites = 0;
  performed: Operation[] = [];
  async load() { return structuredClone(this.state); }
  async save(next: DriverState) {
    this.saves++;
    if (this.saves === this.failSave) throw new Error("simulated crash before state save");
    this.state = structuredClone(next);
  }
  async snapshot() { return structuredClone(this.repo); }
  async perform(step: Decision, current: DriverState) {
    const key = `${current.candidate}:${step.operation}`;
    const existing = this.effects.get(key);
    if (existing !== undefined) return existing;
    this.performed.push(step.operation);
    let patch: Partial<DriverState> = {};
    switch (step.operation) {
      case "update-order": this.repo.order!.behind = false; this.repo.order!.head = "d".repeat(40); break;
      case "ready-order": this.repo.order!.draft = false; break;
      case "merge-order": this.repo.upstreamTag = "v18.8.3"; this.repo.main = "9".repeat(40); break;
      case "open-prepare": this.prepareSources.push(current.selectedMain); this.repo.prepare = pr({ number: 402 }); patch = { preparePr: 402 }; break;
      case "merge-prepare": patch = { candidateCommit: "e".repeat(40) }; break;
      case "tag-candidate": this.repo.candidateWorkflow = "passed"; break;
      case "verify-candidate": patch = { candidateDigest: "f".repeat(64) }; break;
      case "start-campaign": this.repo.campaign = { status: "passed" }; break;
      case "open-approve": this.repo.approve = pr(); patch = { approvePr: 401 }; break;
      case "start-approve-checks": this.repo.approveChecks = { status: "passed" }; break;
      case "tag-stable": this.repo.stableWorkflow = "passed"; break;
      case "verify-stable": patch = { stableDigest: "1".repeat(64) }; break;
      case "start-smoke": this.repo.smoke = { status: "passed" }; break;
      case "open-record": this.repo.record = pr({ number: 403 }); patch = { recordPr: 403 }; break;
      case "close": this.repo.issues = []; break;
    }
    this.effects.set(key, patch);
    return patch;
  }
  async announce(_issue: number, body: string, marker: string) {
    if (!this.comments.has(marker)) { this.comments.set(marker, body); this.commentWrites++; }
    if (this.crashAfterComment) { this.crashAfterComment = false; throw new Error("simulated accepted comment then crash"); }
  }
}

test("stock numeric requests choose highest trusted exact title; fixes-only requests are selected", () => {
  const newer = { ...issue, number: 402, title: "Upstream tracking: v18.10.1" };
  expect(selectRequest([issue, { ...newer, author: "attacker" }, newer])).toEqual(newer);
  expect(selectRequest([{ ...issue, title: "Upstream tracking: v18.8.3 trailing" }])).toBeUndefined();
  expect(compareVersions("v18.10.1", "18.8.3")).toBe(1);
  expect(() => compareVersions("v18.8.3-rc.1", "18.8.3")).toThrow();
  expect(nextStep(state(), snapshot(), config).operation).toBe("open-prepare");
  expect(nextCandidate("0.7.5", ["v0.7.5-prealpha.2", "v0.7.5-prealpha.10", "v0.7.5-prealpha.0"])).toBe("v0.7.5-prealpha.11");
});

test("one tick advances at most one step across the complete happy path", async () => {
  const fake = new FakeDriver();
  fake.repo.upstreamTag = "v18.5.1";
  fake.repo.order = order({ behind: true });
  const expected: Operation[] = ["select", "update-order", "ready-order", "merge-order", "open-prepare", "merge-prepare", "tag-candidate", "observe-candidate", "verify-candidate", "start-campaign", "finish-campaign", "open-approve", "start-approve-checks", "finish-approve-checks", "accept-approval", "tag-stable", "observe-stable", "verify-stable", "start-smoke", "finish-smoke", "open-record", "merge-record", "close"];
  for (const operation of expected) {
    if (operation === "accept-approval") {
      expect((await tick(fake, config)).operation).toBe("idle");
      Object.assign(fake.repo.approve!, { state: "closed", merged: true, mergedBy: config.founder, mergeTree: fake.state!.approvedTree, mergeCommit: "2".repeat(40) });
    }
    const previous = fake.state?.sequence ?? 0;
    expect((await tick(fake, config)).operation).toBe(operation);
    expect(fake.state!.sequence).toBe(previous + 1);
    expect(fake.comments.size).toBe(previous + 1);
  }
  expect(fake.state!.phase).toBe("closed");
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.performed).toEqual(expected);
  expect(fake.prepareSources).toEqual(["9".repeat(40)]);
  for (const comment of fake.comments.values()) expect(comment.split("\n")[0]).toMatch(/^release-driver: [a-z-]+ — [^\n]+$/u);
});

describe("Alpha Founder order authority and scope", () => {
  test.each([
    { filename: "scripts/build-release.ts" },
    { filename: "CHANGELOG.md", previous_filename: "scripts/build-release.ts" },
    { filename: "apps/gateway/src/http.ts", previous_filename: "docs/COMPATIBILITY.md" },
  ])("holds out-of-scope content and both sides of renames: %j", async file => {
    const fake = new FakeDriver(); fake.state = state(); fake.repo.upstreamTag = "v18.5.1"; fake.repo.order = order({ files: [file] });
    expect(outsideOrderScope(fake.repo.order).length).toBeGreaterThan(0);
    expect((await tick(fake, config)).operation).toBe("hold");
    expect(fake.state.phase).toBe("held");
    expect((await tick(fake, config)).operation).toBe("idle");
    fake.repo.order.files = [{ filename: "CHANGELOG.md" }];
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.performed).not.toContain("merge-order");
    expect(fake.comments.size).toBe(1);
  });
  test.each([
    { author: "alphastorm" }, { authorType: "User" }, { headRepository: "attacker/fork" },
    { headRef: "other/order" }, { base: "other" },
  ])("rejects an order outside the exact identity contract: %j", change => {
    expect(isOrder(order(change))).toBe(false);
    expect(nextStep(state(), snapshot({ upstreamTag: "v18.5.1", order: order(change) }), config).operation).toBe("idle");
  });
  test("requires every head check before update/ready/merge and waits after update", () => {
    expect(nextStep(state(), snapshot({ upstreamTag: "v18.5.1", order: order({ checksPassed: false }) }), config).operation).toBe("idle");
    const updated = { ...state("order-updated"), updatedHead: "b".repeat(40) };
    expect(nextStep(updated, snapshot({ upstreamTag: "v18.5.1", order: order({ behind: true }) }), config).operation).toBe("idle");
  });
});

describe("approve is a founder-only exact-tree gate", () => {
  const approved = { ...state("approval-required"), approvePr: 401, approvedHead: "b".repeat(40), approvedTree: "c".repeat(40) };
  test.each([
    [{ merged: true, state: "closed", mergedBy: config.bot, mergeTree: "c".repeat(40) }, "non-founder"],
    [{ merged: true, state: "closed", mergedBy: config.founder, mergeTree: "d".repeat(40) }, "tree differs"],
    [{ state: "closed", merged: false }, "closed without"],
    [{ head: "d".repeat(40) }, "head/tree differs"],
    [{ author: "attacker" }, "identity changed"],
  ] as const)("refuses unsafe approval %j", (change, reason) => {
    const result = nextStep(approved, snapshot({ approve: pr(change) }), config);
    expect(result.operation).toBe("stop"); expect(result.detail).toContain(reason);
  });
  test("cannot bypass Studio checks by merging early", () => {
    expect(nextStep(state("approve-open"), snapshot({ approve: pr({ merged: true }) }), config).operation).toBe("stop");
  });
});

test.each(["qualifying", "approve-checking", "smoking"] as const)("%s failure stops without retry; campaign reports failing lanes", async phase => {
  const fake = new FakeDriver(); fake.state = state(phase);
  const job = { status: "failed" as const, detail: "campaign failed lanes: android (failed), cleanup (failed); no retry" };
  fake.repo.campaign = job; fake.repo.approveChecks = job; fake.repo.smoke = job;
  expect((await tick(fake, config)).operation).toBe("stop");
  expect(fake.state.phase).toBe("diagnostic-required");
  expect([...fake.comments.values()][0]).toContain("android (failed)");
  if (phase !== "approve-checking") expect([...fake.comments.values()][0]!.split("\n")[0]).toContain("recover the exact owning release-host lease");
  expect((await tick(fake, config)).operation).toBe("idle");
});

test("diagnostic rerequest requires a new green dispatch, main fix, and recovered host lease", () => {
  const failed = { ...state("diagnostic-required"), failedMain: "a".repeat(40), candidateCommit: "b".repeat(40) };
  const repo = snapshot({ main: "d".repeat(40), tags: ["v0.7.5-prealpha.1"], issues: [{ ...issue, request: "43:1" }] });
  expect(nextStep(failed, { ...repo, hostRecoveryRequired: true }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, main: failed.failedMain }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, issues: [issue] }, config).operation).toBe("idle");
  const step = nextStep(failed, repo, config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") { expect(step.patch?.candidate).toBe("v0.7.5-prealpha.2"); expect(step.patch?.candidateCommit).toBeUndefined(); }
});

test.each(["candidate-tagged", "stable-tagged"] as const)("%s waits for workflow and stops on red", phase => {
  const repo = snapshot();
  expect(nextStep(state(phase), repo, config).operation).toBe("idle");
  repo.candidateWorkflow = "failed"; repo.stableWorkflow = "failed";
  expect(nextStep(state(phase), repo, config).operation).toBe("stop");
});

test("prepare and record PRs require bot identity, open/merged state and strict checks", () => {
  for (const phase of ["prepare-open", "record-open"] as const) {
    expect(nextStep(state(phase), snapshot({ prepare: pr({ state: "closed" }), record: pr({ state: "closed" }) }), config).operation).toBe("stop");
    expect(nextStep(state(phase), snapshot({ prepare: pr({ checksPassed: false }), record: pr({ checksPassed: false }) }), config).operation).toBe("idle");
    expect(nextStep(state(phase), snapshot({ prepare: pr({ behind: true }), record: pr({ behind: true }) }), config).operation).toBe("update-release-pr");
  }
});

test("crash between provider write and state save reconciles the same effect without duplication", async () => {
  const fake = new FakeDriver(); fake.state = state("selected"); fake.failSave = 2;
  await expect(tick(fake, config)).rejects.toThrow("simulated crash");
  expect(fake.state.intent?.operation).toBe("open-prepare");
  expect(fake.repo.prepare?.number).toBe(402);
  expect((await tick(fake, config)).operation).toBe("open-prepare");
  expect(fake.performed.filter(operation => operation === "open-prepare")).toHaveLength(1);
  expect(fake.state.phase).toBe("prepare-open"); expect(fake.comments.size).toBe(1);
});

test("a pinned merge whose PR moved re-plans from a fresh snapshot instead of replaying its intent", async () => {
  // v0.7.5: #369's head was replaced after the driver pinned it, and every tick replayed the stale merge.
  class MovedHead extends FakeDriver {
    override async perform(step: Decision, current: DriverState) {
      if (step.operation === "merge-prepare" && step.pr?.head !== this.repo.prepare?.head) throw new StaleIntentError("PR head changed before pinned merge");
      return super.perform(step, current);
    }
  }
  const fake = new MovedHead();
  fake.state = { ...state("prepare-open"), preparePr: 402 };
  fake.repo.prepare = pr({ number: 402 });
  fake.state.intent = nextStep(fake.state, fake.repo, config) as Decision;
  expect(fake.state.intent.operation).toBe("merge-prepare");
  fake.repo.prepare = pr({ number: 402, head: "d".repeat(40), checksPassed: false });
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.state.intent).toBeUndefined();
  expect(fake.state.phase).toBe("prepare-open");
  expect((await tick(fake, config)).detail).toContain("waiting for strict required PR checks");
  fake.repo.prepare.checksPassed = true;
  expect((await tick(fake, config)).operation).toBe("merge-prepare");
  expect(fake.performed).toEqual(["merge-prepare"]);
  expect(fake.state.phase).toBe("prepared");
});

test("runtime refuses a moved pinned merge as stale, but a merge at another head as a hard stop", async () => {
  let current = pr({ head: "d".repeat(40) });
  class MovedRuntime extends StudioDriver { override async readPr() { return current; } }
  const runtime = new MovedRuntime(driverConfig(), false);
  await expect(runtime.merge(pr(), false)).rejects.toThrow(StaleIntentError);
  current = pr({ checksPassed: false });
  await expect(runtime.merge(pr(), false)).rejects.toThrow(StaleIntentError);
  current = pr({ head: "d".repeat(40), merged: true, mergedBy: config.bot, state: "closed" });
  const foreign = await runtime.merge(pr(), false).catch((error: unknown) => error);
  expect(foreign).not.toBeInstanceOf(StaleIntentError);
  expect(String(foreign)).toContain("merged at a head other than the pinned one");
});

test("accepted progress comment followed by a crash never posts another comment", async () => {
  const fake = new FakeDriver(); fake.crashAfterComment = true;
  await expect(tick(fake, config)).rejects.toThrow("accepted comment");
  expect(fake.state?.announcement).toBeDefined();
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.comments.size).toBe(1); expect(fake.state?.announcement).toBeUndefined();
  expect(fake.commentWrites).toBe(1);
  expect(fake.performed).toEqual(["select"]);
});

test("plan reads live inputs but writes no state, effects, comments, or bot credentials", async () => {
  const fake = new FakeDriver();
  expect((await tick(fake, config, true)).operation).toBe("select");
  expect(fake.saves).toBe(0); expect(fake.performed).toEqual([]); expect(fake.comments.size).toBe(0);
  fake.repo.issues = [];
  expect((await tick(fake, config, true)).detail).toBe("no open tracking issue; idle");
  const driver = new StudioDriver(driverConfig(), true);
  await expect(driver.authenticate()).rejects.toThrow("plan mode");
  await expect(driver.save(state())).rejects.toThrow("plan attempted");
  await expect(driver.perform({ operation: "tag-stable", phase: "stable-tagged", detail: "x" }, state())).rejects.toThrow("plan attempted");
});

test("dedicated bot environment strips founder credential/identity and preserves no arbitrary qualification override", () => {
  expect(() => driverConfig({ OMP_RELEASE_DRY_RUN: "yes" })).toThrow("OMP_RELEASE_DRY_RUN");
  const cfg = driverConfig({ OMP_RELEASE_BOT_LOGIN: "release-user", OMP_RELEASE_FOUNDER_LOGIN: "founder", OMP_RELEASE_GH_CONFIG_DIR: "/private/bot-gh", OMP_RELEASE_SIGNING_KEY: "/private/key", OMP_RELEASE_STATE_DIR: "/private/state" });
  const env = botEnvironment(cfg, { GH_TOKEN: "founder-value", GITHUB_TOKEN: "founder-value", GH_CONFIG_DIR: "/founder", GIT_AUTHOR_EMAIL: "founder@example.com", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "founder-helper", OMP_STABLE_PREVIOUS_TAG: "v0.0.1", PATH: "/bin" });
  expect(env.GH_CONFIG_DIR).toBe("/private/bot-gh");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_AUTHOR_EMAIL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "OMP_STABLE_PREVIOUS_TAG"]) expect(env[key]).toBeUndefined();
  expect(env.PATH).toBe("/bin");
});
test("runtime refuses a changed order scope at the last merge boundary, including rename history", async () => {
  class RefusingRuntime extends StudioDriver {
    override async readPr() { return order({ draft: false, files: [{ filename: "CHANGELOG.md", previous_filename: ".github/workflows/signed-release.yml" }] }); }
  }
  const runtime = new RefusingRuntime(driverConfig(), false);
  await expect(runtime.merge(order({ draft: false }), true)).rejects.toThrow("scope changed");
});

test("runtime rechecks founder, merge commit and checked tree before a stable tag effect", async () => {
  class RefusingRuntime extends StudioDriver {
    override async readPr() { return pr({ merged: true, mergedBy: config.bot, mergeTree: "c".repeat(40), mergeCommit: "e".repeat(40) }); }
  }
  const runtime = new RefusingRuntime(driverConfig(), false);
  const approved = { ...state("approved"), approvePr: 401, stableCommit: "e".repeat(40), approvedHead: "b".repeat(40), approvedTree: "c".repeat(40) };
  await expect(runtime.perform({ operation: "tag-stable", phase: "stable-tagged", detail: "publish" }, approved)).rejects.toThrow("founder approval binding changed");
});

test("runtime adopts an already-accepted pinned bot merge after a crash without another write", async () => {
  const merged = pr({ merged: true, mergedBy: config.bot, mergeCommit: "e".repeat(40), state: "closed" });
  class ReconciledRuntime extends StudioDriver { override async readPr() { return merged; } }
  const runtime = new ReconciledRuntime(driverConfig(), false);
  expect(await runtime.merge(pr(), false)).toEqual(merged);
});

test("runtime comment reconciliation ignores impersonated markers and adopts its own accepted comment", async () => {
  class CommentsRuntime extends StudioDriver {
    writes = 0;
    readonly remote: { body: string; user: { login: string } }[] = [{ body: "marker", user: { login: "attacker" } }];
    override async pages<T>(): Promise<T[]> { return this.remote as T[]; }
    override async gh<T>(): Promise<T | undefined> {
      this.writes++;
      this.remote.push({ body: "marker", user: { login: config.bot } });
      return undefined;
    }
  }
  const runtime = new CommentsRuntime(driverConfig(), false);
  await runtime.announce(400, "release-driver: selected — request", "marker");
  await runtime.announce(400, "release-driver: selected — request", "marker");
  expect(runtime.writes).toBe(1);
});

test("a diagnostic after publication never restarts an immutable stable version", () => {
  const stopped = { ...state("diagnostic-required"), stableCommit: "e".repeat(40), failedMain: "a".repeat(40) };
  const repo = snapshot({ main: "d".repeat(40), issues: [{ ...issue, request: "99:1" }] });
  expect(nextStep(stopped, repo, config).detail).toContain("preserve the immutable release");
});
