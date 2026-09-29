export interface EnduranceOptions {
  hosts: number;
  subscribers: number;
  durationSeconds: number;
  sampleSeconds: number;
  pollSeconds: number;
  metadataSeconds: number;
  churnSeconds: number;
  launchSeconds: number;
  port: number;
  output: string;
}

export function parseEnduranceOptions(args: readonly string[]): EnduranceOptions {
  const options: EnduranceOptions = {
    hosts: 50, subscribers: 4, durationSeconds: 300, sampleSeconds: 15, pollSeconds: 10,
    metadataSeconds: 30, churnSeconds: 120, launchSeconds: 4, port: 4319,
    output: `endurance-output-${Date.now()}`,
  };
  const flags: Record<string, readonly [Exclude<keyof EnduranceOptions, "output">, number, number]> = {
    "--hosts": ["hosts", 1, 100], "--subscribers": ["subscribers", 1, 32],
    "--duration-seconds": ["durationSeconds", 30, 86_400], "--sample-seconds": ["sampleSeconds", 1, 300],
    "--poll-seconds": ["pollSeconds", 2, 60], "--metadata-seconds": ["metadataSeconds", 6, 3_600],
    "--churn-seconds": ["churnSeconds", 0, 3_600], "--launch-seconds": ["launchSeconds", 4, 300],
    "--port": ["port", 1_024, 65_535],
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (seen.has(flag) || value === undefined || value.startsWith("--")) throw new Error("invalid arguments");
    seen.add(flag);
    if (flag === "--output") {
      if (value.length === 0 || value.length > 4_096 || value.includes("\0")) throw new Error("invalid output path");
      options.output = value;
      continue;
    }
    const bound = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!bound || !/^[0-9]+$/u.test(value)) throw new Error("invalid option");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < bound[1] || number > bound[2]) throw new Error("option out of range");
    options[bound[0]] = number;
  }
  if (options.port === 4317 || options.sampleSeconds > options.durationSeconds || options.launchSeconds > options.durationSeconds
    || options.durationSeconds < 3 * options.pollSeconds || options.metadataSeconds < 3 * options.pollSeconds
    || (options.churnSeconds !== 0 && options.churnSeconds < 6 * options.pollSeconds)) {
    throw new Error("incompatible measurement bounds");
  }
  return options;
}

/** Exact nearest-rank percentiles of millisecond upper bounds; constant memory even for a day of fanout. */
export class LatencyDistribution {
  readonly #buckets = new Uint32Array(300_001);
  #count = 0;
  #max = 0;
  observe(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 300_000) throw new Error("latency out of range");
    this.#buckets[Math.ceil(milliseconds)]!++;
    this.#count++;
    this.#max = Math.max(this.#max, milliseconds);
  }
  summary() {
    const percentile = (fraction: number): number => {
      if (!this.#count) return 0;
      const rank = Math.ceil(this.#count * fraction);
      let count = 0;
      for (let value = 0; value < this.#buckets.length; value++) {
        count += this.#buckets[value]!;
        if (count >= rank) return value;
      }
      throw new Error("invalid latency histogram");
    };
    return { count: this.#count, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: this.#max, resolutionMs: 1 };
  }
}

/** Centered online least-squares fit: no growing sample array and no cancellation from epoch timestamps. */
export class SampleSeries {
  #count = 0;
  #start = 0;
  #end = 0;
  #min = Infinity;
  #max = -Infinity;
  #meanX = 0;
  #meanY = 0;
  #xx = 0;
  #xy = 0;
  #lastTime = -Infinity;
  observe(elapsedSeconds: number, value: number): void {
    if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(value) || elapsedSeconds < 0 || elapsedSeconds <= this.#lastTime) {
      throw new Error("invalid time series sample");
    }
    this.#lastTime = elapsedSeconds;
    if (this.#count === 0) this.#start = value;
    this.#count++;
    const dx = elapsedSeconds - this.#meanX;
    const dy = value - this.#meanY;
    this.#meanX += dx / this.#count;
    this.#meanY += dy / this.#count;
    this.#xx += dx * (elapsedSeconds - this.#meanX);
    this.#xy += dx * (value - this.#meanY);
    this.#end = value;
    this.#min = Math.min(this.#min, value);
    this.#max = Math.max(this.#max, value);
  }
  summary() {
    return {
      count: this.#count, start: this.#start, end: this.#end, min: this.#count ? this.#min : 0,
      max: this.#count ? this.#max : 0, mean: this.#meanY, slopePerSecond: this.#xx === 0 ? 0 : this.#xy / this.#xx,
    };
  }
}

export function parseCpuTime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(value);
  if (!match) throw new Error("invalid process CPU time");
  const [, days, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) throw new Error("invalid process CPU time");
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

export function parseLinuxStat(text: string, ticksPerSecond: number, pageBytes: number): { cpuSeconds: number; rssKiB: number } {
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const pages = Number(fields[21]);
  if (end < 0 || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0 || !Number.isFinite(pageBytes) || pageBytes <= 0
    || ![utime, stime, pages].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid process counters");
  return { cpuSeconds: (utime + stime) / ticksPerSecond, rssKiB: pages * pageBytes / 1_024 };
}

/** Gateway SSE is bounded JSON; frames may straddle arbitrary byte/UTF-8 chunk boundaries. */
export class SseFrames {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #pending = "";
  push(bytes: Uint8Array): { event: string; data: string }[] {
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    const frames: { event: string; data: string }[] = [];
    while (true) {
      const separator = /\r?\n\r?\n/u.exec(this.#pending);
      if (!separator) break;
      if (separator.index > 1_048_576) throw new Error("SSE frame exceeds bound");
      const block = this.#pending.slice(0, separator.index);
      this.#pending = this.#pending.slice(separator.index + separator[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      }
      if (data.length) frames.push({ event, data: data.join("\n") });
    }
    if (this.#pending.length > 1_048_576) throw new Error("SSE frame exceeds bound");
    return frames;
  }
}
