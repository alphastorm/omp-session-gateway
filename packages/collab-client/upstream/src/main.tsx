import { createRoot, type Root } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");
const rootContainer: HTMLElement = rootElement;
const handoff = new URL(location.href).searchParams.get("handoff");
history.replaceState(null, "", "/client/");
let root: Root | undefined;
let activePort: MessagePort | undefined;

export function startCollabWithCapability(capability: string, onDispose: () => void): void {
	if (root !== undefined) throw new Error("collaboration client already started");
	root = createRoot(rootContainer);
	root.render(<App capability={capability} onDispose={onDispose} />);
}

if (handoff === null || handoff.length > 128 || window.opener === null) {
	const heading = document.createElement("h1");
	heading.textContent = "No session selected";
	const link = document.createElement("a");
	link.href = "/";
	link.textContent = "Return to OMP Sessions";
	rootContainer.replaceChildren(heading, link);
} else {
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
		activePort = port;
		port.onmessage = portEvent => {
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
			startCollabWithCapability(payload.capability, () => {
				root?.unmount();
				root = undefined;
			});
			port.postMessage({ type: "omp-client-accepted", handoff });
			port.close();
			activePort = undefined;
		};
		port.start();
	};
	window.addEventListener("message", receivePort);
}

window.addEventListener("pagehide", () => {
	activePort?.close();
	root?.unmount();
	root = undefined;
});
