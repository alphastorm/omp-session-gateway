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
  ["OMP browser capability", /https?:\/\/[^\s"'<>]+\/#(?:[^\s"'<>]*\/)?[A-Za-z0-9_-]{12,}[.#][A-Za-z0-9_-]{32,}/gu],
  ["OMP relay capability", /(?:wss?:\/\/)?[^\s"'<>]+\/r\/[A-Za-z0-9_-]{12,}[.#][A-Za-z0-9_-]{32,}/gu],
  ["long Bearer token", /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{40,}/giu],
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
