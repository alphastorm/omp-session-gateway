const GATEWAY_PROBE_INTERVAL_MS = 5_000;
const GATEWAY_PROBE_TIMEOUT_MS = 3_000;
const REFRESH_DEBOUNCE_MS = 500;

interface RecoveryEventTarget {
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

interface RecoveryWindow extends RecoveryEventTarget {
	clearTimeout(handle: number): void;
	setTimeout(callback: () => void, delay: number): number;
}

interface RecoveryDocument extends RecoveryEventTarget {
	readonly visibilityState: DocumentVisibilityState;
}

export interface BrowserRecoveryEnvironment {
	readonly connection: RecoveryEventTarget | undefined;
	readonly document: RecoveryDocument;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly now: () => number;
	readonly window: RecoveryWindow;
}

function defaultEnvironment(): BrowserRecoveryEnvironment {
	const connection = (navigator as Navigator & { readonly connection?: EventTarget }).connection;
	return {
		connection,
		document,
		fetch,
		now: Date.now,
		window,
	};
}

/**
 * Refresh a potentially half-open relay transport after browser or radio path changes.
 * The same-origin probe contains no session data and only turns a detected outage into
 * one fresh relay connection when the gateway becomes reachable again.
 */
export function installBrowserConnectionRecovery(
	refreshConnection: () => void,
	environment: BrowserRecoveryEnvironment = defaultEnvironment(),
): () => void {
	let disposed = false;
	let gatewayUnavailable = false;
	let lastRefreshAt = 0;
	let probeController: AbortController | undefined;
	let probeInFlight = false;
	let probeRequested = false;
	let probeTimer: number | undefined;
	let wasHidden = environment.document.visibilityState === "hidden";

	const clearProbeTimer = (): void => {
		if (probeTimer === undefined) return;
		environment.window.clearTimeout(probeTimer);
		probeTimer = undefined;
	};
	const refresh = (): void => {
		const now = environment.now();
		if (now - lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
		lastRefreshAt = now;
		refreshConnection();
	};
	const scheduleProbe = (delay = GATEWAY_PROBE_INTERVAL_MS): void => {
		clearProbeTimer();
		if (disposed || environment.document.visibilityState === "hidden") return;
		probeTimer = environment.window.setTimeout(() => {
			probeTimer = undefined;
			void probeGateway();
		}, delay);
	};
	const probeGateway = async (): Promise<void> => {
		if (disposed || probeInFlight || environment.document.visibilityState === "hidden") return;
		probeInFlight = true;
		const controller = new AbortController();
		probeController = controller;
		const timeout = environment.window.setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
		let healthy = false;
		try {
			const response = await environment.fetch("/api/v1/health", {
				cache: "no-store",
				credentials: "same-origin",
				signal: controller.signal,
			});
			healthy = response.ok;
		} catch {
			// A radio handoff can leave navigator.onLine true while this probe times out.
		} finally {
			environment.window.clearTimeout(timeout);
			if (probeController === controller) probeController = undefined;
			probeInFlight = false;
		}
		if (disposed) return;
		if (healthy) {
			if (gatewayUnavailable) {
				gatewayUnavailable = false;
				refresh();
			}
		} else {
			gatewayUnavailable = true;
		}
		const runImmediately = probeRequested;
		probeRequested = false;
		scheduleProbe(runImmediately ? 0 : GATEWAY_PROBE_INTERVAL_MS);
	};
	const requestProbe = (): void => {
		gatewayUnavailable = true;
		clearProbeTimer();
		if (probeInFlight) {
			probeRequested = true;
			return;
		}
		void probeGateway();
	};
	const visibilityChanged: EventListener = () => {
		if (environment.document.visibilityState === "hidden") {
			wasHidden = true;
			clearProbeTimer();
			probeController?.abort();
			return;
		}
		if (wasHidden) {
			wasHidden = false;
			refresh();
		}
		requestProbe();
	};
	const pageShown: EventListener = event => {
		if ((event as PageTransitionEvent).persisted) refresh();
		requestProbe();
	};
	const online: EventListener = () => requestProbe();
	const offline: EventListener = () => {
		gatewayUnavailable = true;
		probeRequested = false;
		clearProbeTimer();
		probeController?.abort();
	};
	const connectionChanged: EventListener = () => requestProbe();

	environment.window.addEventListener("online", online);
	environment.window.addEventListener("offline", offline);
	environment.window.addEventListener("pageshow", pageShown);
	environment.document.addEventListener("visibilitychange", visibilityChanged);
	environment.connection?.addEventListener("change", connectionChanged);
	scheduleProbe(0);

	return () => {
		disposed = true;
		clearProbeTimer();
		probeController?.abort();
		environment.window.removeEventListener("online", online);
		environment.window.removeEventListener("offline", offline);
		environment.window.removeEventListener("pageshow", pageShown);
		environment.document.removeEventListener("visibilitychange", visibilityChanged);
		environment.connection?.removeEventListener("change", connectionChanged);
	};
}
