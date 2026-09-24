/** Measure the first completed successful probe; probe time counts against the recovery window. */
export async function measureAndroidRecovery(
  since: number,
  timeoutMs: number,
  probe: (index: number) => Promise<boolean>,
  now: () => number = () => performance.now(),
  sleep: (milliseconds: number) => Promise<void> = async milliseconds => {
    await Bun.sleep(milliseconds);
  },
): Promise<number | null> {
  const deadline = since + timeoutMs;
  for (let index = 1; now() < deadline; index++) {
    const ready = await probe(index);
    const elapsed = now() - since;
    if (elapsed > timeoutMs) return null;
    if (ready) return Math.round(elapsed);
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await sleep(Math.min(250, remaining));
  }
  return null;
}
