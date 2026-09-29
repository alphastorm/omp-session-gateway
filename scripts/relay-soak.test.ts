import { expect, test } from "bun:test";
import { parseGatewayProcessSample, parseRelaySoakConfig, summarizeGatewaySamples } from "./relay-soak.ts";

const requiredEnvironment = {
  OMP_GATEWAY_SOAK_PUBLIC_ORIGIN: "https://gateway.example.ts.net",
  OMP_GATEWAY_SOAK_TAILSCALE_LOGIN: " User@Example.COM ",
};

test("relay soak config defaults to a bounded eight-hour loopback run", () => {
  expect(parseRelaySoakConfig(requiredEnvironment)).toEqual({
    gatewayOrigin: "http://127.0.0.1:4317",
    publicOrigin: "https://gateway.example.ts.net",
    tailscaleLogin: "user@example.com",
    durationSeconds: 28_800,
  });
  expect(
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_GATEWAY_ORIGIN: "http://[::1]:4317",
      OMP_GATEWAY_SOAK_SECONDS: "1",
      OMP_GATEWAY_SOAK_INSTANCE_ID: "instance-1",
    }),
  ).toEqual({
    gatewayOrigin: "http://[::1]:4317",
    publicOrigin: "https://gateway.example.ts.net",
    tailscaleLogin: "user@example.com",
    durationSeconds: 1,
    instanceId: "instance-1",
  });
});

test("relay soak config rejects capability-exfiltration and unbounded-run inputs", () => {
  expect(() =>
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_GATEWAY_ORIGIN: "http://attacker.example",
    }),
  ).toThrow("numeric loopback");
  expect(() =>
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_GATEWAY_ORIGIN: "http://127.0.0.1:4317/path",
    }),
  ).toThrow("without credentials, path, query, or fragment");
  expect(() =>
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_SECONDS: "86401",
    }),
  ).toThrow("must not exceed 86400");
  expect(() =>
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_PUBLIC_ORIGIN: "http://gateway.example.ts.net",
    }),
  ).toThrow("must use HTTPS");
});

test("relay soak config accepts only a real gateway PID and an absolute samples path", () => {
  expect(
    parseRelaySoakConfig({
      ...requiredEnvironment,
      OMP_GATEWAY_SOAK_GATEWAY_PID: "78559",
      OMP_GATEWAY_SOAK_SAMPLES: "/tmp/soak/gateway.csv",
    }),
  ).toMatchObject({ gatewayPid: 78_559, samplesPath: "/tmp/soak/gateway.csv" });
  for (const pid of ["0", "1", "-5", "12abc", ""]) {
    expect(() => parseRelaySoakConfig({ ...requiredEnvironment, OMP_GATEWAY_SOAK_GATEWAY_PID: pid })).toThrow(
      "OMP_GATEWAY_SOAK_GATEWAY_PID",
    );
  }
  expect(() => parseRelaySoakConfig({ ...requiredEnvironment, OMP_GATEWAY_SOAK_SAMPLES: "gateway.csv" })).toThrow(
    "must be an absolute path",
  );
});

test("gateway process samples read macOS and procps CPU time formats", () => {
  expect(parseGatewayProcessSample("43280 00:00\n")).toEqual({ rssKiB: 43_280, cpuSeconds: 0 });
  expect(parseGatewayProcessSample("  51200   0:07.25")).toEqual({ rssKiB: 51_200, cpuSeconds: 7.25 });
  expect(parseGatewayProcessSample("51200 83:12.50")).toEqual({ rssKiB: 51_200, cpuSeconds: 4_992.5 });
  expect(parseGatewayProcessSample("51200 01:02:03")).toEqual({ rssKiB: 51_200, cpuSeconds: 3_723 });
  expect(parseGatewayProcessSample("51200 2-01:00:00")).toEqual({ rssKiB: 51_200, cpuSeconds: 176_400 });
  for (const unreadable of ["", "51200", "51200 12", "rss time", "51200 00:00\n60000 00:01"]) {
    expect(() => parseGatewayProcessSample(unreadable)).toThrow("unreadable");
  }
});

test("gateway sample summary reports resident-memory trend and in-window CPU", () => {
  const growing = [0, 3_600, 7_200, 10_800].map((elapsedSeconds, hour) => ({
    elapsedSeconds,
    rssKiB: 40_000 + hour * 1_500,
    cpuSeconds: 10 + hour * 0.5,
  }));
  expect(summarizeGatewaySamples(growing)).toEqual({
    samples: 4,
    startRssKiB: 40_000,
    endRssKiB: 44_500,
    minRssKiB: 40_000,
    maxRssKiB: 44_500,
    rssSlopeKiBPerHour: 1_500,
    cpuSeconds: 1.5,
  });
  // A transient peak that returns to baseline is not growth.
  const settled = [40_000, 52_000, 40_000].map((rssKiB, index) => ({ elapsedSeconds: index * 60, rssKiB, cpuSeconds: 0 }));
  expect(summarizeGatewaySamples(settled)).toMatchObject({ maxRssKiB: 52_000, rssSlopeKiBPerHour: 0 });
  expect(summarizeGatewaySamples([{ elapsedSeconds: 0, rssKiB: 40_000, cpuSeconds: 3 }])).toMatchObject({
    samples: 1,
    rssSlopeKiBPerHour: 0,
    cpuSeconds: 0,
  });
  expect(() => summarizeGatewaySamples([])).toThrow("no gateway sample");
});
