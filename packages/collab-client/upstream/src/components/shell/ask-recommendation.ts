import type { GuestSnapshot } from "../../lib/client";

interface AskOptionSignature {
	label: string;
	description?: string;
}

interface AskQuestionRecommendation {
	question: string;
	options: AskOptionSignature[];
	recommended: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionSignatures(raw: unknown): AskOptionSignature[] | null {
	if (!Array.isArray(raw)) return null;
	const options: AskOptionSignature[] = [];
	for (const value of raw) {
		if (typeof value === "string") {
			options.push({ label: value });
			continue;
		}
		if (!isRecord(value) || typeof value.label !== "string") return null;
		if (value.description === undefined) options.push({ label: value.label });
		else if (typeof value.description === "string") options.push({ label: value.label, description: value.description });
		else return null;
	}
	return options;
}

function askQuestionRecommendations(rawArgs: unknown): AskQuestionRecommendation[] {
	if (!isRecord(rawArgs)) return [];
	let rawQuestions = rawArgs.questions;
	if (typeof rawQuestions === "string") {
		try {
			rawQuestions = JSON.parse(rawQuestions);
		} catch {
			return [];
		}
	}
	const candidates = Array.isArray(rawQuestions) ? rawQuestions : [rawArgs];
	const recommendations: AskQuestionRecommendation[] = [];
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const question = typeof candidate.question === "string" ? candidate.question : null;
		const options = optionSignatures(candidate.options);
		const recommended = candidate.recommended;
		if (
			question === null ||
			options === null ||
			typeof recommended !== "number" ||
			!Number.isInteger(recommended) ||
			recommended < 0 ||
			recommended >= options.length
		) {
			continue;
		}
		recommendations.push({ question, options, recommended });
	}
	return recommendations;
}

function optionsEqual(left: readonly AskOptionSignature[], right: readonly AskOptionSignature[]): boolean {
	return (
		left.length === right.length &&
		left.every((option, index) => {
			const candidate = right[index];
			return candidate !== undefined && option.label === candidate.label && option.description === candidate.description;
		})
	);
}

/**
 * `initialIndex` is not recommendation metadata: OMP also defaults it to zero when no option is
 * recommended. Correlate the pending select with the latest unresolved `ask` call instead.
 */
export function recommendedOptionIndex(snapshot: GuestSnapshot): number | undefined {
	const request = snapshot.uiRequest;
	if (request?.kind !== "select") return undefined;
	const requestOptions = optionSignatures(request.options);
	if (requestOptions === null) return undefined;

	const resolvedToolCalls = new Set<string>();
	for (const entry of snapshot.entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			resolvedToolCalls.add(entry.message.toolCallId);
		}
	}

	const calls: Array<{ id: string; args: unknown }> = [];
	const appendAskCalls = (message: GuestSnapshot["stream"]): void => {
		if (message === null) return;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "ask") calls.push({ id: block.id, args: block.arguments });
		}
	};
	for (const entry of snapshot.entries) {
		if (entry.type === "message" && entry.message.role === "assistant") appendAskCalls(entry.message);
	}
	appendAskCalls(snapshot.stream);
	for (const tool of snapshot.activeTools.values()) {
		if (tool.toolName === "ask") calls.push({ id: tool.toolCallId, args: tool.args });
	}

	for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
		const call = calls[callIndex];
		if (call === undefined || resolvedToolCalls.has(call.id)) continue;
		const questions = askQuestionRecommendations(call.args);
		for (let questionIndex = questions.length - 1; questionIndex >= 0; questionIndex -= 1) {
			const question = questions[questionIndex];
			if (
				question !== undefined &&
				question.question === request.title &&
				optionsEqual(question.options, requestOptions)
			) {
				return question.recommended;
			}
		}
	}
	return undefined;
}
