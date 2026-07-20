import { expect, test } from "bun:test";
import {
  createRegistryAuthNonce,
  createRegistryClientProof,
  createRegistryServerProof,
  registryAuthProofMatches,
  type RegistryAuthBinding,
} from "../src/ipc-auth.ts";

const token = "A".repeat(43);
const binding: RegistryAuthBinding = {
  clientNonce: "B".repeat(43),
  serverNonce: "C".repeat(43),
  instanceId: "instance-test-0001",
  pid: 1234,
};

const serverProof = "NT4hA8hoCUXMiqxyLsFZ6iS_9ltMu29fwwO15eysGTE";
const clientProof = "PKJ2B96ezRFtwFaZuZhtAR23nOw_TtahkxSo32AOQuQ";

test("registry mutual authentication matches the pinned protocol vectors", () => {
  expect(createRegistryServerProof(token, binding)).toBe(serverProof);
  expect(createRegistryClientProof(token, binding)).toBe(clientProof);
  const mutableKey = Buffer.from(token, "ascii");
  expect(createRegistryServerProof(mutableKey, binding)).toBe(serverProof);
  expect(mutableKey.toString("ascii")).toBe(token);
  expect(serverProof).not.toBe(clientProof);
  expect(registryAuthProofMatches(serverProof, serverProof)).toBeTrue();
  expect(registryAuthProofMatches(serverProof, `${serverProof.slice(0, -1)}A`)).toBeFalse();
});

test("registry authentication binds fresh nonces, instance, and pid", () => {
  expect(createRegistryAuthNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(createRegistryAuthNonce()).not.toBe(createRegistryAuthNonce());
  expect(createRegistryServerProof(token, { ...binding, clientNonce: "D".repeat(43) })).not.toBe(serverProof);
  expect(createRegistryServerProof(token, { ...binding, serverNonce: "E".repeat(43) })).not.toBe(serverProof);
  expect(createRegistryServerProof(token, { ...binding, instanceId: "instance-test-0002" })).not.toBe(serverProof);
  expect(createRegistryServerProof(token, { ...binding, pid: 1235 })).not.toBe(serverProof);
  expect(() => createRegistryClientProof("short", binding)).toThrow("invalid registry authentication token");
});
