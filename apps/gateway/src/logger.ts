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

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMITED_EVENTS = new Set([
  "http.authorization_denied",
  "ipc.protocol_rejected",
  "ipc.authentication_denied",
  "ipc.connection_timeout",
  "ipc.connection_error",
]);

interface RateLimitState {
  lastWrittenAt: number;
  suppressed: number;
}

export class SafeLogger {
  readonly #sink: LogSink;
  readonly #now: () => number;
  readonly #rateLimits = new Map<string, RateLimitState>();

  constructor(sink: LogSink = stdoutSink, now: () => number = Date.now) {
    this.#sink = sink;
    this.#now = now;
  }

  event(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(event)) throw new Error("unsafe log event name");
    const safeFields: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[a-z][a-z0-9_.-]{0,31}$/u.test(key)) throw new Error("unsafe log field name");
      if (value !== undefined) safeFields[key] = value;
    }
    if (RATE_LIMITED_EVENTS.has(event)) {
      const now = this.#now();
      const state = this.#rateLimits.get(event);
      if (state !== undefined && now - state.lastWrittenAt < RATE_LIMIT_WINDOW_MS) {
        state.suppressed += 1;
        return;
      }
      if (state !== undefined && state.suppressed > 0) safeFields.suppressed = state.suppressed;
      this.#rateLimits.set(event, { lastWrittenAt: now, suppressed: 0 });
    }
    this.#sink.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields }));
  }
}
