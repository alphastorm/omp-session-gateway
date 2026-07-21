import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";

let activeRoot: Root | undefined;
let activeDispose: (() => void) | undefined;

export function startCollabWithCapability(
	container: HTMLElement,
	capability: string,
	onDispose: () => void,
): () => void {
	if (activeRoot !== undefined) throw new Error("collaboration client already started");
	const root = createRoot(container);
	activeRoot = root;
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		root.unmount();
		if (activeRoot === root) {
			activeRoot = undefined;
			activeDispose = undefined;
		}
	};
	activeDispose = dispose;
	root.render(createElement(App, {
		capability,
		onDispose: () => {
			dispose();
			onDispose();
		},
	}));
	return dispose;
}

export function disposeActiveCollab(): void {
	activeDispose?.();
}
