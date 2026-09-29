import { expect, test } from "bun:test";
import { LatencyDistribution, parseCpuTime, parseEnduranceOptions, parseLinuxStat, SampleSeries, SseFrames } from "./endurance-metrics.ts";

test("endurance bounds admit an eight-hour fifty-host run and the maximum workload", () => {
  const overnight = parseEnduranceOptions(["--hosts", "50", "--duration-seconds", "28800", "--output", "/tmp/synthetic-endurance"]);
  expect(overnight.hosts).toBe(50);
  expect(overnight.durationSeconds).toBe(28_800);
  const maximum = parseEnduranceOptions(["--hosts", "100", "--subscribers", "32", "--duration-seconds", "86400", "--sample-seconds", "300"]);
  expect(maximum.durationSeconds).toBe(86_400);
  expect(maximum.hosts).toBe(100);
  expect(parseEnduranceOptions(["--hosts", "1", "--sample-seconds", "1", "--churn-seconds", "0"]).churnSeconds).toBe(0);
});

test.each([
  ["--hosts", "0"], ["--hosts", "101"], ["--hosts", "1.5"], ["--hosts", "1e2"], ["--hosts", "NaN"],
  ["--duration-seconds", "29"], ["--duration-seconds", "86401"], ["--duration-seconds", "Infinity"],
  ["--sample-seconds", "0"], ["--sample-seconds", "301"], ["--subscribers", "0"], ["--subscribers", "33"],
  ["--port", "4317"], ["--port", "0"], ["--port", "65536"], ["--launch-seconds", "3"],
  ["--metadata-seconds", "29"], ["--churn-seconds", "59"], ["--unknown", "1"], ["--hosts"],
  ["--hosts", "2", "--hosts", "3"], ["--duration-seconds", "30", "--sample-seconds", "31"],
  ["--duration-seconds", "30", "--poll-seconds", "60", "--metadata-seconds", "180", "--churn-seconds", "360"],
].map(args => ({ args })))("rejects unsafe or ambiguous arguments %j", ({ args }) => {
  expect(() => parseEnduranceOptions(args)).toThrow();
});

test("nearest-rank latency percentiles round upward without hiding the measured maximum", () => {
  const latency = new LatencyDistribution();
  for (const value of [20.1, 1.2, 9.1, 5.4]) latency.observe(value);
  expect(latency.summary()).toEqual({ count: 4, p50Ms: 6, p95Ms: 21, p99Ms: 21, maxMs: 20.1, resolutionMs: 1 });
  const boundary = new LatencyDistribution();
  for (let index = 1; index <= 100; index++) boundary.observe(index);
  expect(boundary.summary()).toEqual({ count: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100, resolutionMs: 1 });
  expect(() => latency.observe(-1)).toThrow();
  expect(() => latency.observe(NaN)).toThrow();
  expect(() => latency.observe(300_001)).toThrow();
});

test("time-series regression uses elapsed time, not row number, and handles a constant series", () => {
  const series = new SampleSeries();
  series.observe(0, 100);
  series.observe(5, 110);
  series.observe(20, 140);
  expect(series.summary()).toMatchObject({ count: 3, start: 100, end: 140, min: 100, max: 140, mean: 350 / 3 });
  expect(series.summary().slopePerSecond).toBeCloseTo(2, 12);
  expect(() => series.observe(20, 142)).toThrow();
  expect(() => series.observe(19, 140)).toThrow();
  const constant = new SampleSeries();
  constant.observe(1, 7);
  expect(constant.summary().slopePerSecond).toBe(0);
  constant.observe(4, 7);
  expect(constant.summary().slopePerSecond).toBe(0);
  expect(new SampleSeries().summary().count).toBe(0);
  expect(new LatencyDistribution().summary().count).toBe(0);
});

test("CPU counters parse macOS hundredths, Linux hours/days, and process names with parentheses", () => {
  expect(parseCpuTime("2:03.45")).toBe(123.45);
  expect(parseCpuTime("01:02:03")).toBe(3_723);
  expect(parseCpuTime("2-01:02:03.5")).toBe(176_523.5);
  expect(() => parseCpuTime("01:99:00")).toThrow();
  expect(() => parseCpuTime("not-a-counter")).toThrow();
  const fields = Array<string>(22).fill("0");
  fields[0] = "S";
  fields[11] = "150";
  fields[12] = "25";
  fields[21] = "128";
  expect(parseLinuxStat(`42 (name with ) parentheses) ${fields.join(" ")}`, 100, 4_096)).toEqual({ cpuSeconds: 1.75, rssKiB: 512 });
  expect(() => parseLinuxStat("42 (truncated) S", 100, 4_096)).toThrow();
  expect(() => parseLinuxStat(`42 (name) ${fields.join(" ")}`, 0, 4_096)).toThrow();
});

test("SSE decoding preserves split UTF-8, multiple frames and CRLF without retaining completed frames", () => {
  const frames = new SseFrames();
  const wire = new TextEncoder().encode('event: session_upsert\r\ndata: {"title":"café"}\r\n\r\nevent: keepalive\ndata: {}\n\n');
  const received = [];
  for (const byte of wire) received.push(...frames.push(Uint8Array.of(byte)));
  expect(received).toEqual([
    { event: "session_upsert", data: '{"title":"café"}' }, { event: "keepalive", data: "{}" },
  ]);
  expect(frames.push(new TextEncoder().encode(": comment\n\ndata: first\ndata: second\n\n"))).toEqual([
    { event: "message", data: "first\nsecond" },
  ]);
  expect(() => new SseFrames().push(new TextEncoder().encode("x".repeat(1_048_577)))).toThrow("bound");
  expect(() => new SseFrames().push(new TextEncoder().encode(`${"x".repeat(1_048_577)}\n\n`))).toThrow("bound");
});
