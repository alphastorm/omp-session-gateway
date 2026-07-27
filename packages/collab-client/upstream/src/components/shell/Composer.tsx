import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { recommendedOptionIndex } from "./ask-recommendation";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
	embedded?: boolean;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
	submitLabel?: string;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit, submitLabel = "Submit" }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">{submitLabel}</span>
				</button>
			</div>
		</div>
	);
}
type SelectRequest = Extract<NonNullable<GuestSnapshot["uiRequest"]>, { kind: "select" }>;

interface SelectAskProps {
	client: GuestClient;
	embedded: boolean;
	recommendedIndex: number | undefined;
	request: SelectRequest;
}

function SelectAsk({ client, embedded, recommendedIndex, request }: SelectAskProps): ReactNode {
	const initialIndex = request.initialIndex ?? request.checkedIndices?.[0];
	const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
		initialIndex !== undefined && initialIndex >= 0 && initialIndex < request.options.length
			? initialIndex
			: undefined,
	);
	const selected = selectedIndex === undefined ? undefined : request.options[selectedIndex];
	const selectedLabel =
		selected === undefined ? undefined : typeof selected === "string" ? selected : selected.label;

	return (
		<>
			<div className="sh-ask-options">
				{request.options.map((option, index) => {
					const label = typeof option === "string" ? option : option.label;
					const checked = embedded
						? selectedIndex === index
						: request.checkedIndices?.includes(index) ?? false;
					return (
						<button
							key={`${request.reqId}-${index}-${label}`}
							type="button"
							className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
							aria-pressed={checked}
							onClick={() => {
								if (embedded) setSelectedIndex(index);
								else client.sendUiResponse(request.reqId, label);
							}}
						>
							<span
								className={`sh-ask-option-marker sh-ask-option-marker-${request.selectionMarker ?? "radio"}`}
								aria-hidden="true"
							>
								{embedded ? (
									checked && <span className="sh-ask-option-marker-dot" />
								) : request.selectionMarker === "checkbox" ? (
									checked ? "☑" : "☐"
								) : checked ? (
									"◉"
								) : (
									"○"
								)}
							</span>
							<span className="sh-ask-option-copy">
								<span className="sh-ask-option-heading">
									<span className="sh-ask-option-label">
										{embedded ? `${index + 1} · ${label}` : label}
									</span>
									{index === recommendedIndex && (
										<span className="sh-ask-option-recommended">Recommended</span>
									)}
								</span>
								{typeof option !== "string" && option.description && (
									<span className="sh-ask-option-description">{option.description}</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
			{embedded && (
				<button
					type="button"
					className="sh-btn sh-btn-primary sh-ask-send"
					disabled={selectedLabel === undefined}
					onClick={() => client.sendUiResponse(request.reqId, selectedLabel)}
				>
					Send
				</button>
			)}
		</>
	);
}

export function Composer({ client, snapshot, embedded = false }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working || (snapshot.state?.isStreaming ?? false);
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && text.trim().length > 0;
	const recommendedIndex = useMemo(
		() => recommendedOptionIndex(snapshot),
		[uiRequest, snapshot.entries, snapshot.stream, snapshot.activeTools],
	);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className={`sh-composer sh-composer-ask${embedded ? " sh-composer-ask-embedded" : ""}`}>
				{embedded && <div className="sh-ask-kicker">input required</div>}
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<SelectAsk
						key={uiRequest.reqId}
						client={client}
						embedded={embedded}
						recommendedIndex={recommendedIndex}
						request={uiRequest}
					/>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						submitLabel={embedded ? "Send" : "Submit"}
					/>
				)}
				{!embedded && (
					<div className="sh-composer-actions sh-ask-actions">
						<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
							Cancel
						</button>
						{busy && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title="stop the current turn"
							>
								<Square size={11} /> <span className="sh-btn-label">Stop</span>
							</button>
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
}
