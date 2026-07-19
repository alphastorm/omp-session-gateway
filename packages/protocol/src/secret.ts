import { MAX_CAPABILITY_BYTES } from "./types.ts";

const SECRET_VALUE = Symbol("secret-capability-value");
const UTF8_ENCODER = new TextEncoder();

/**
 * Deliberately non-serializable wrapper for an OMP collaboration bearer value.
 * Only capability release code should call `reveal()`.
 */
export class SecretCapability {
  readonly #value: string;
  readonly [SECRET_VALUE] = true;

  private constructor(value: string) {
    this.#value = value;
  }

  static from(value: unknown): SecretCapability {
    if (typeof value !== "string") throw new ProtocolValidationError("invalid capability");
    const byteLength = UTF8_ENCODER.encode(value).byteLength;
    if (byteLength < 16 || byteLength > MAX_CAPABILITY_BYTES || value.includes("\0")) {
      throw new ProtocolValidationError("invalid capability");
    }
    return new SecretCapability(value);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): never {
    throw new Error("SecretCapability must not be serialized");
  }

  toString(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SecretCapability([REDACTED])";
  }
}

export interface SecretSessionRecord {
  readonly instanceId: string;
  readonly generation: number;
  readonly view: SecretCapability;
  readonly control?: SecretCapability;
}

export class ProtocolValidationError extends Error {
  constructor(message = "invalid protocol message") {
    super(message);
    this.name = "ProtocolValidationError";
  }
}
