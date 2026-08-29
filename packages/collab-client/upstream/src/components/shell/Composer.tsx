import { Camera, SendHorizontal, Square, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import {
	disposePhotoAttachment,
	MAX_PHOTO_ATTACHMENTS,
	PhotoAttachmentError,
	preparePhotoAttachment,
	type PreparedPhoto,
} from "../../lib/photo-attachment";
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

function captureComposerPointer(event: ReactPointerEvent<HTMLButtonElement>): void {
	event.currentTarget.setPointerCapture(event.pointerId);
	event.preventDefault();
}

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	disabled: boolean;
	sending: boolean;
	onSubmit(value: string): void;
	submitLabel?: string;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ disabled, prefill, sending, onSubmit, submitLabel = "Submit" }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			if (!disabled) onSubmit(draft);
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
				disabled={disabled}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					disabled={disabled}
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">{sending ? "Sending…" : submitLabel}</span>
				</button>
			</div>
		</div>
	);
}
type SelectRequest = Extract<NonNullable<GuestSnapshot["uiRequest"]>, { kind: "select" }>;

interface SelectAskProps {
	client: GuestClient;
	disabled: boolean;
	embedded: boolean;
	recommendedIndex: number | undefined;
	request: SelectRequest;
	sending: boolean;
}

function SelectAsk({ client, disabled, embedded, recommendedIndex, request, sending }: SelectAskProps): ReactNode {
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
					const checked = embedded || sending
						? selectedIndex === index
						: request.checkedIndices?.includes(index) ?? false;
					return (
						<button
							key={`${request.reqId}-${index}-${label}`}
							type="button"
							className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
							aria-pressed={checked}
							disabled={disabled}
							onClick={() => {
								setSelectedIndex(index);
								if (!embedded) client.sendUiResponse(request.reqId, label);
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
					disabled={disabled || selectedLabel === undefined}
					onClick={() => client.sendUiResponse(request.reqId, selectedLabel)}
				>
					{sending ? "Sending…" : "Send"}
				</button>
			)}
		</>
	);
}

export function Composer({ client, snapshot, embedded = false }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [photos, setPhotos] = useState<readonly PreparedPhoto[]>([]);
	const [preparingPhoto, setPreparingPhoto] = useState(false);
	const [photoError, setPhotoError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const photoInputRef = useRef<HTMLInputElement | null>(null);
	const photosRef = useRef<readonly PreparedPhoto[]>([]);
	const mountedRef = useRef(true);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const sendingResponse = snapshot.uiResponsePending;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && !preparingPhoto && (text.trim().length > 0 || photos.length > 0);
	const canAddPhoto = canPrompt && !preparingPhoto && photos.length < MAX_PHOTO_ATTACHMENTS;
	const recommendedIndex = useMemo(
		() => recommendedOptionIndex(snapshot),
		[uiRequest, snapshot.entries, snapshot.stream, snapshot.activeTools],
	);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		return () => {
			mountedRef.current = false;
			for (const photo of photosRef.current) disposePhotoAttachment(photo);
			photosRef.current = [];
		};
	}, []);

	const selectPhotos = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
		const files = [...(event.currentTarget.files ?? [])];
		event.currentTarget.value = "";
		if (files.length === 0) return;
		const available = MAX_PHOTO_ATTACHMENTS - photosRef.current.length;
		if (available <= 0) {
			setPhotoError(`You can attach up to ${MAX_PHOTO_ATTACHMENTS} photos.`);
			return;
		}

		setPhotoError(null);
		setPreparingPhoto(true);
		for (const file of files.slice(0, available)) {
			try {
				const prepared = await preparePhotoAttachment(file);
				if (!mountedRef.current) {
					disposePhotoAttachment(prepared);
					return;
				}
				const next = [...photosRef.current, prepared];
				photosRef.current = next;
				setPhotos(next);
			} catch (error) {
				if (!mountedRef.current) return;
				setPhotoError(
					error instanceof PhotoAttachmentError
						? error.message
						: "This photo could not be prepared. Try another image.",
				);
			}
		}
		if (files.length > available) {
			setPhotoError(`Only the first ${available} photos were attached.`);
		}
		if (mountedRef.current) setPreparingPhoto(false);
	}, []);

	const removePhoto = useCallback((index: number): void => {
		const removed = photosRef.current[index];
		if (!removed) return;
		const next = photosRef.current.filter((_, candidate) => candidate !== index);
		photosRef.current = next;
		setPhotos(next);
		setPhotoError(null);
		disposePhotoAttachment(removed);
	}, []);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		const selectedPhotos = photosRef.current;
		if ((!trimmed && selectedPhotos.length === 0) || !live || readOnly || preparingPhoto) return;
		const prompt =
			trimmed || (selectedPhotos.length === 1 ? "Please inspect this photo." : "Please inspect these photos.");
		client.sendPrompt(prompt, selectedPhotos.map(photo => photo.content));
		setText("");
		photosRef.current = [];
		setPhotos([]);
		setPhotoError(null);
		for (const photo of selectedPhotos) disposePhotoAttachment(photo);
	}, [client, live, preparingPhoto, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && !readOnly) {
		const requestDisabled = !live || sendingResponse;
		return (
			<div className={`sh-composer sh-composer-ask${embedded ? " sh-composer-ask-embedded" : ""}`} data-sending={sendingResponse ? "true" : undefined}>
				{(embedded || sendingResponse) && (
					<div
						className="sh-ask-kicker"
						role={embedded ? undefined : "status"}
						aria-live={embedded ? undefined : "polite"}
					>
						{sendingResponse ? "Sending…" : "input required"}
					</div>
				)}
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<SelectAsk
						key={uiRequest.reqId}
						disabled={requestDisabled}
						client={client}
						embedded={embedded}
						recommendedIndex={recommendedIndex}
						request={uiRequest}
						sending={sendingResponse}
					/>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						disabled={requestDisabled}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						submitLabel={embedded ? "Send" : "Submit"}
						sending={sendingResponse}
					/>
				)}
				{!embedded && (
					<div className="sh-composer-actions sh-ask-actions">
						<button type="button" className="sh-btn" disabled={requestDisabled} onClick={() => client.sendUiResponse(uiRequest.reqId)}>
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
			{(photos.length > 0 || preparingPhoto || photoError) && (
				<div className="sh-photo-stage">
					{(photos.length > 0 || preparingPhoto) && (
						<div className="sh-photo-strip" role="list" aria-label="Photos ready to send">
							{photos.map((photo, index) => (
								<figure className="sh-photo" role="listitem" key={photo.previewUrl}>
									<img src={photo.previewUrl} alt={`Photo ${index + 1} ready to send`} />
									<button
										type="button"
										className="sh-photo-remove"
										onClick={() => removePhoto(index)}
										onPointerDown={captureComposerPointer}
										disabled={preparingPhoto}
										aria-label={`Remove photo ${index + 1}`}
									>
										<X size={14} />
									</button>
								</figure>
							))}
							{preparingPhoto && (
								<div className="sh-photo-preparing" role="status" aria-live="polite">
									<span className="sh-photo-progress" aria-hidden="true" />
									Preparing photo…
								</div>
							)}
						</div>
					)}
					{photoError && <div className="sh-photo-error" role="alert">{photoError}</div>}
				</div>
			)}
			<div className="sh-composer-inner">
				<input
					ref={photoInputRef}
					className="sh-photo-input"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					capture="environment"
					hidden
					onChange={selectPhotos}
					disabled={!canAddPhoto}
				/>
				<button
					type="button"
					className={`sh-btn sh-photo-trigger${photos.length > 0 ? " sh-photo-trigger-active" : ""}`}
					onClick={() => {
						setPhotoError(null);
						photoInputRef.current?.click();
					}}
					onPointerDown={captureComposerPointer}
					disabled={!canAddPhoto}
					title={photos.length >= MAX_PHOTO_ATTACHMENTS ? "Photo limit reached" : "Take or attach a photo"}
					aria-label="Take or attach a photo"
				>
					<Camera size={17} /> <span className="sh-btn-label">Photo</span>
				</button>
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? photos.length > 0
									? "add a note (optional)…"
									: "prompt the host agent…"
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
							onPointerDown={captureComposerPointer}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={14} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						onPointerDown={captureComposerPointer}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={15} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
}
