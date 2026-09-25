const PROVIDER_READ_ATTEMPTS = 3;

/**
 * Qualification drives third-party control planes (Vultr, Tailscale, Scaleway) whose APIs answer an
 * occasional transient 5xx. Vultr returned HTTP 502 twice in one day: once at Windows admission, and
 * once on the instance lookup after the lane's reboot, which failed the attempt with its VM running.
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
    await sleep(2_000 * attempt);
  }
}
