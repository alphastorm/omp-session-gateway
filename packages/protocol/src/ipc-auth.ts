import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ProtocolValidationError } from "./secret.ts";
import { IPC_AUTH_NONCE_BYTES, IPC_AUTH_VALUE_LENGTH } from "./types.ts";

const AUTH_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SERVER_DOMAIN = "omp-session-gateway.registry.server.v1";
const CLIENT_DOMAIN = "omp-session-gateway.registry.client.v1";

export interface RegistryAuthBinding {
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly instanceId: string;
  readonly pid: number;
}

function isAuthValue(value: string): boolean {
  return value.length === IPC_AUTH_VALUE_LENGTH && AUTH_VALUE_PATTERN.test(value);
}

function copyTokenKey(token: string | Uint8Array): Buffer {
  if (typeof token === "string") {
    if (!TOKEN_PATTERN.test(token)) throw new ProtocolValidationError("invalid registry authentication token");
    return Buffer.from(token, "ascii");
  }
  if (token.byteLength !== IPC_AUTH_VALUE_LENGTH) {
    throw new ProtocolValidationError("invalid registry authentication token");
  }
  const key = Buffer.from(token);
  for (const value of key) {
    if (
      !(
        (value >= 0x41 && value <= 0x5a) ||
        (value >= 0x61 && value <= 0x7a) ||
        (value >= 0x30 && value <= 0x39) ||
        value === 0x2d ||
        value === 0x5f
      )
    ) {
      key.fill(0);
      throw new ProtocolValidationError("invalid registry authentication token");
    }
  }
  return key;
}

function validateBinding(binding: RegistryAuthBinding): void {
  if (
    !isAuthValue(binding.clientNonce) ||
    !isAuthValue(binding.serverNonce) ||
    !INSTANCE_ID_PATTERN.test(binding.instanceId) ||
    !Number.isSafeInteger(binding.pid) ||
    binding.pid < 1 ||
    binding.pid > 2_147_483_647
  ) {
    throw new ProtocolValidationError("invalid registry authentication binding");
  }
}

function createProof(token: string | Uint8Array, domain: string, binding: RegistryAuthBinding): string {
  validateBinding(binding);
  const key = copyTokenKey(token);
  try {
    const digest = createHmac("sha256", key)
      .update(
        `${domain}\n${binding.clientNonce}\n${binding.serverNonce}\n${binding.instanceId}\n${binding.pid}`,
        "utf8",
      )
      .digest();
    try {
      return digest.toString("base64url");
    } finally {
      digest.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export function createRegistryAuthNonce(): string {
  return randomBytes(IPC_AUTH_NONCE_BYTES).toString("base64url");
}

export function createRegistryServerProof(token: string | Uint8Array, binding: RegistryAuthBinding): string {
  return createProof(token, SERVER_DOMAIN, binding);
}

export function createRegistryClientProof(token: string | Uint8Array, binding: RegistryAuthBinding): string {
  return createProof(token, CLIENT_DOMAIN, binding);
}

export function registryAuthProofMatches(expected: string, actual: string): boolean {
  if (!isAuthValue(expected) || !isAuthValue(actual)) return false;
  const expectedBytes = Buffer.from(expected, "ascii");
  const actualBytes = Buffer.from(actual, "ascii");
  try {
    return timingSafeEqual(expectedBytes, actualBytes);
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
}
