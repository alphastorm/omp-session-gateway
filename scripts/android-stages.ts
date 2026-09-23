/**
 * Closed stage vocabularies for the physical-device lanes.
 *
 * The post-release smoke withholds lane output: it carries device, origin, and page detail. A lane
 * therefore announces each stage it enters on stderr, and a failure surfaces only the last announced
 * stage, and only when that stage belongs to the lane's vocabulary below. This module has no side
 * effects so the smoke can import the vocabularies without running a lane.
 */
export const ANDROID_COLLAB_STAGES = [
  "target preflight",
  "Android Chrome",
  "installed shell",
  "directory",
  "View",
  "Control",
  "prompt",
  "directory return",
] as const;

export const ANDROID_LEAK_SWEEP_STAGES = [
  "target preflight",
  "Android Chrome",
  "detector control",
  "capability sweep",
  "verdict",
] as const;

export const ANDROID_ACCEPTANCE_STAGES = [
  "target preflight",
  "Android Chrome",
  "authorization matrix",
  "lock resume",
  "airplane recovery",
  "doze recovery",
  "verdict",
] as const;

const STAGE_PREFIX = "android-stage: ";

/** Announces entry into `stage`; the type admits only the lane's own vocabulary. */
export function announceAndroidStage<const Stages extends readonly string[]>(
  _stages: Stages,
  stage: Stages[number],
): void {
  console.error(STAGE_PREFIX + stage);
}

/** The last stage a lane announced in `stderr`, when it is one of `stages`. */
export function lastAndroidStage(stderr: string, stages: readonly string[]): string | undefined {
  const announced = stderr
    .split(/\r?\n/u)
    .filter(line => line.startsWith(STAGE_PREFIX))
    .at(-1)
    ?.slice(STAGE_PREFIX.length);
  return announced !== undefined && stages.includes(announced) ? announced : undefined;
}
