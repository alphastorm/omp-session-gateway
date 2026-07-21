type StartCollabWithCapability = (
	container: HTMLElement,
	capability: string,
	onDispose: () => void,
) => () => void;

interface CollabClientModule {
	startCollabWithCapability: StartCollabWithCapability;
}

declare const __COLLAB_CLIENT_MODULE__: string;

function importCollabClient(moduleUrl: string): Promise<CollabClientModule> {
	return import(moduleUrl) as Promise<CollabClientModule>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");
const rootContainer: HTMLElement = rootElement;
const handoff = new URL(location.href).searchParams.get("handoff");
let disposeCollab: (() => void) | undefined;
let activePort: MessagePort | undefined;

if (handoff === null || handoff.length === 0 || handoff.length > 128 || window.opener === null) {
	window.location.replace("/");
} else {
	history.replaceState(null, "", "/client/");
	const opener = window.opener as Window;
	const announceReady = (): void => {
		opener.postMessage({ type: "omp-client-ready", handoff }, location.origin);
	};
	const readyTimer = window.setInterval(announceReady, 250);
	const abortTimer = window.setTimeout(() => {
		clearInterval(readyTimer);
		window.close();
	}, 10_000);
	announceReady();

	const receivePort = (event: MessageEvent): void => {
		const message = event.data as Record<string, unknown> | null;
		if (
			event.origin !== location.origin ||
			event.source !== opener ||
			message?.type !== "omp-client-port" ||
			message.handoff !== handoff ||
			event.ports.length !== 1
		) {
			return;
		}
		window.removeEventListener("message", receivePort);
		clearInterval(readyTimer);
		clearTimeout(abortTimer);
		const port = event.ports[0];
		if (port === undefined) return;
		const collabClient = importCollabClient(__COLLAB_CLIENT_MODULE__);
		activePort = port;
		port.onmessage = async portEvent => {
			const payload = portEvent.data as Record<string, unknown> | null;
			if (
				payload?.type !== "omp-client-capability" ||
				payload.handoff !== handoff ||
				typeof payload.capability !== "string" ||
				(payload.mode !== "view" && payload.mode !== "control")
			) {
				port.close();
				window.close();
				return;
			}
			try {
				const { startCollabWithCapability } = await collabClient;
				disposeCollab = startCollabWithCapability(rootContainer, payload.capability, () => {
					disposeCollab = undefined;
				});
				port.postMessage({ type: "omp-client-accepted", handoff });
			} catch {
				window.close();
			} finally {
				port.close();
				activePort = undefined;
			}
		};
		port.start();
	};
	window.addEventListener("message", receivePort);
}

window.addEventListener("pagehide", () => {
	activePort?.close();
	disposeCollab?.();
	disposeCollab = undefined;
});

window.addEventListener("pageshow", (event: PageTransitionEvent) => {
	if (event.persisted) window.location.replace("/");
});
