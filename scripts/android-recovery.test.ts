import { expect, test } from "bun:test";
import { measureAndroidRecovery } from "./android-recovery.ts";

function clock() {
  let time = 10_000;
  return {
    now: () => time,
    advance: (milliseconds: number) => { time += milliseconds; },
    sleep: async (milliseconds: number) => { time += milliseconds; },
  };
}

test("recovery records the first successful probe without an initial sleep", async () => {
  const time = clock();
  const recovered = await measureAndroidRecovery(time.now(), 48_000, async () => {
    time.advance(40);
    return true;
  }, time.now, time.sleep);
  expect(recovered).toBe(40);
});

test("recovery detects readiness at a fine cadence between completed probes", async () => {
  const time = clock();
  const since = time.now();
  const recovered = await measureAndroidRecovery(since, 48_000, async () => {
    time.advance(40);
    return time.now() - since >= 500;
  }, time.now, time.sleep);
  expect(recovered).toBe(620);
});

for (const [scenario, attempts, delayMs] of [["lock", 12, 3_000], ["airplane", 20, 8_000], ["doze", 6, 8_000]] as const) {
  test(`${scenario} recovery keeps its deadline when probes consume time`, async () => {
    const time = clock();
    const since = time.now();
    const recovered = await measureAndroidRecovery(since, attempts * delayMs, async () => {
      time.advance(40);
      return false;
    }, time.now, time.sleep);
    expect(recovered).toBeNull();
    expect(time.now() - since).toBe(attempts * delayMs);
  });
}

test("recovery does not accept a successful probe completed after the deadline", async () => {
  const time = clock();
  const recovered = await measureAndroidRecovery(time.now(), 48_000, async () => {
    time.advance(48_001);
    return true;
  }, time.now, time.sleep);
  expect(recovered).toBeNull();
});
