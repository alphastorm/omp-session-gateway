import { describe, expect, test } from "bun:test";
import {
  canarySummary,
  isSupportedOmpVersion,
  parseCanaryArgs,
  parseCanarySummary,
  parseOmpVersion,
  windowsArgument,
  windowsHostScript,
} from "./upstream-canary.ts";

describe("upstream canary arguments", () => {
  test("accepts a binary path with spaces and an explicit diagnostic model", () => {
    expect(parseCanaryArgs(["--omp", "/tmp/stock omp", "--model", "provider/model"])).toEqual({
      omp: "/tmp/stock omp", model: "provider/model",
    });
  });

  test("refuses missing, duplicate, unknown, and truncated arguments without echoing their values", () => {
    for (const args of [
      [], ["--omp"], ["--omp", ""], ["--model", "provider/model"],
      ["--omp", "--model"], ["--omp", "binary", "--omp", "other"],
      ["--omp", "binary", "--unknown", "private-value"],
      ["--omp", "binary", "--model", "one", "--model", "two"],
      ["--omp", "binary\0suffix"], ["--omp", "binary", "unexpected"],
    ]) {
      expect(() => parseCanaryArgs(args)).toThrow(/^(?:invalid arguments|--omp is required)$/u);
    }
  });
});

describe("stock OMP version gate", () => {
  test("enforces the mainline minimum and rejects prereleases", () => {
    expect(isSupportedOmpVersion("18.1.19")).toBe(false);
    expect(isSupportedOmpVersion("18.1.20")).toBe(true);
    expect(isSupportedOmpVersion("18.3.0")).toBe(true);
    expect(isSupportedOmpVersion("19.0.0")).toBe(true);
    expect(isSupportedOmpVersion("18.1.20-rc.1")).toBe(false);
    expect(isSupportedOmpVersion("18.3.0-rc.1")).toBe(false);
  });

  test("extracts bare and prefixed banners without forwarding extra output", () => {
    expect(parseOmpVersion("18.1.20\n")).toBe("18.1.20");
    expect(parseOmpVersion("omp/18.3.0")).toBe("18.3.0");
    expect(parseOmpVersion("omp 18.3.0")).toBe("18.3.0");
    expect(parseOmpVersion("18.3.0\nprivate diagnostic")).toBeUndefined();
    expect(parseOmpVersion("18.3.0 private diagnostic")).toBeUndefined();
    expect(isSupportedOmpVersion("not-a-version")).toBe(false);
    expect(isSupportedOmpVersion("omp/18.3.0")).toBe(false);
  });
});

describe("canary public reports", () => {
  test("stops at the first failure and does not claim later stages ran", () => {
    expect(canarySummary("18.3.0", 123, "snapshot")).toEqual({
      ompVersion: "18.3.0", durationMs: 123, failedStage: "snapshot", discoveryFileRemoved: false,
      stages: { publish: "passed", snapshot: "failed", "stale-generation": "skipped", view: "skipped", control: "skipped", unregister: "skipped" },
    });
    expect(canarySummary("", 1, "publish").stages).toEqual({
      publish: "failed", snapshot: "skipped", "stale-generation": "skipped", view: "skipped", control: "skipped", unregister: "skipped",
    });
    expect(canarySummary("18.1.20", 123).stages).toEqual({
      publish: "passed", snapshot: "passed", "stale-generation": "passed", view: "passed", control: "passed", unregister: "passed",
    });
  });

  test("projects only approved fields before writing CI summaries", () => {
    const summary = canarySummary("18.3.0", 321, "control", true);
    expect(parseCanarySummary(JSON.stringify({ ...summary, hostDiagnostic: "private-value" }))).toEqual(summary);
  });

  test("rejects unsafe versions, inconsistent progress, and malformed reports with a fixed reason", () => {
    const summary = canarySummary("18.3.0", 321, "view");
    for (const text of [
      "private-value", "null", "{}", `${JSON.stringify(summary)}\n${JSON.stringify(summary)}`,
      JSON.stringify({ ...summary, ompVersion: "18.3.0\nprivate-value" }),
      JSON.stringify({ ...summary, durationMs: -1 }),
      JSON.stringify({ ...summary, durationMs: 1.5 }),
      JSON.stringify({ ...summary, discoveryFileRemoved: "false" }),
      JSON.stringify({ ...summary, failedStage: "private-value" }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, control: "passed" } }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, snapshot: "failed" } }),
    ]) {
      expect(() => parseCanarySummary(text)).toThrow("invalid canary summary");
    }
  });
});

describe("Windows host launch", () => {
  test("quotes arguments by the Windows command-line rules", () => {
    expect(windowsArgument("plain")).toBe("plain");
    expect(windowsArgument("")).toBe('""');
    expect(windowsArgument("C:\\stock omp\\cli.js")).toBe('"C:\\stock omp\\cli.js"');
    // A trailing backslash would otherwise escape the closing quote.
    expect(windowsArgument("C:\\stock omp\\")).toBe('"C:\\stock omp\\\\"');
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    // Backslashes before a quote double, then the quote itself is escaped.
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });

  test("escapes PowerShell literals and refuses a variable name it cannot set safely", () => {
    const script = windowsHostScript("C:\\bun.exe", ["C:\\omp\\cli.js"], "C:\\work", { USERPROFILE: "C:\\it's" });
    expect(script).toContain("Set-Item -LiteralPath 'Env:USERPROFILE' -Value 'C:\\it''s'");
    expect(() => windowsHostScript("C:\\bun.exe", [], "C:\\work", { "PATH;Remove-Item": "x" })).toThrow("invalid host environment");
  });
});
