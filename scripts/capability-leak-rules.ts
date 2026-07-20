export const CAPABILITY_TEXT_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".jsonc",
  ".hujson",
  ".ts",
  ".tsx",
  ".js",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

const patterns: readonly (readonly [string, RegExp])[] = [
  [
    "OMP browser capability",
    /https?:\/\/[^\s"'<>]+\/#(?:[^\s"'<>]*\/)?[A-Za-z0-9_-]{10,64}(?:[.#]|%23)(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})(?![A-Za-z0-9_-])/giu,
  ],
  [
    "OMP relay capability",
    /(?:wss?:\/\/)?[^\s"'<>]+\/r\/[A-Za-z0-9_-]{10,64}(?:[.#]|%23)(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})(?![A-Za-z0-9_-])/giu,
  ],
  [
    "OMP bare capability",
    /(?<![A-Za-z0-9_./#-])[A-Za-z0-9_-]{10,64}(?:[.#]|%23)(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})(?![A-Za-z0-9_-])/giu,
  ],
  ["long Bearer token", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{40,}/giu],
  [
    "OMP publisher token",
    /(?:["']token["']\s*:\s*["']|publisher-token\s*[=:]\s*)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/giu,
  ],
  ["raw publisher token", /(?:^|[\0\r\n])[A-Za-z0-9_-]{43}(?=$|[\0\r\n])/gu],
];

export interface CapabilityLeakFinding {
  readonly label: string;
  readonly byteOffset: number;
}

export function findCapabilityLeaks(text: string): readonly CapabilityLeakFinding[] {
  const findings: CapabilityLeakFinding[] = [];
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ label, byteOffset: match.index });
  }
  return findings;
}
