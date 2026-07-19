import { createHmac, randomBytes } from "node:crypto";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, number | boolean | undefined>>;

export interface LogSink {
  write(line: string): void;
}

const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(`${line}\n`);
  },
};

export class SafeLogger {
  readonly #salt = randomBytes(32);
  readonly #sink: LogSink;

  constructor(sink: LogSink = stdoutSink) {
    this.#sink = sink;
  }

  event(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(event)) throw new Error("unsafe log event name");
    const safeFields: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[a-z][a-z0-9_.-]{0,31}$/u.test(key)) throw new Error("unsafe log field name");
      if (value !== undefined) safeFields[key] = value;
    }
    this.#sink.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields }));
  }

  hashOpaque(value: string): string {
    return createHmac("sha256", this.#salt).update(value).digest("base64url").slice(0, 16);
  }
}
