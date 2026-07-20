import { expect, test } from "bun:test";
import { parseRelaySoakConfig } from "./relay-soak.ts";

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
