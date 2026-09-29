const PROVIDER_READ_ATTEMPTS = 5;

/**
 * Qualification drives third-party control planes (Vultr, Tailscale, Scaleway) whose APIs answer an
 * occasional transient 5xx. Vultr returned HTTP 502 twice in one day: once at Windows admission, and
 * once on the instance lookup after the lane's reboot, which failed the attempt with its VM running.
 * On 2026-09-29 it returned 502 to three reads spanning six seconds while the lane staged its guest,
 * so reads now back off 2, 4, 8 and 16 seconds, about half a minute in all.
 * A read is idempotent, so it gets a bounded retry. A create, change, or delete never comes through
 * here, because a write that reached the provider must not run twice. The last response is returned,
 * so each caller keeps its own status handling.
 */
export async function readProvider(
  read: () => Promise<Response>,
  options: { readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<Response> {
  const sleep = options.sleep ?? (async (milliseconds: number) => void (await Bun.sleep(milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    const response = await read();
    if (response.status < 500 || attempt >= PROVIDER_READ_ATTEMPTS) return response;
    await response.body?.cancel();
    await sleep(2_000 * 2 ** (attempt - 1));
  }
}

/**
 * Absence is a different transient: Vultr once answered its own running instance's lookup as missing,
 * between two WinRM calls a minute apart (2026-09-27), which failed the lane with its VM healthy. An
 * owned resource is absent only when a second read, after a pause, agrees. A real deletion stays
 * absent, so a caller waiting for one sees it a pause later.
 */
export async function confirmAbsence<T>(
  read: () => Promise<T | undefined>,
  options: { readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<T | undefined> {
  const first = await read();
  if (first !== undefined) return first;
  await (options.sleep ?? (async (milliseconds: number) => void (await Bun.sleep(milliseconds))))(5_000);
  return read();
}
