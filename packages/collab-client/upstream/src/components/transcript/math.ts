import type { MarkedExtension, Tokens } from "marked";
import { type MathSpan, mathBlockAt, mathSpanAt, mathStartIndex } from "./math-delimiters";
import { renderToString } from "katex";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

/**
 * npm marked resumes scanning after a rejected extension hint, unlike OMP's
 * compatible parser. Stop at the first unescaped rejected opener so currency
 * and half-streamed `$$` runs cannot expose a later delimiter as fresh math.
 * Escaped openers remain ordinary Markdown escapes and do not block later math.
 */
function mathTokenStart(source: string): number | undefined {
	let from = 0;
	while (true) {
		const at = mathStartIndex(source, from);
		if (at === undefined) return undefined;

		let backslashes = 0;
		for (let index = at - 1; index >= 0 && source.charCodeAt(index) === 0x5c; index--) backslashes++;
		if (backslashes % 2 === 1) {
			from = at + 1;
			continue;
		}

		const span = mathSpanAt(source, at);
		return span !== undefined && typesettable(span) ? at : undefined;
	}
}

function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	if (token.literal === true) return escapeHtml(token.text);
	try {
		const math = renderToString(token.text, {
			displayMode: token.display,
			// KaTeX's HTML output needs katex.min.css, which bundles to ~940 KB
			// gzipped here because Bun inlines its 60 @font-face sources.
			output: "mathml",
			throwOnError: false,
			// `trust: false` refuses \href, \htmlClass, \includegraphics.
			strict: false,
			trust: false,
		});
		// A display equation gets a wrapper to scroll in (`.tr-math`), because
		// scrolling the `math` element itself traps a few pixels of vertical scroll:
		// its ink — fraction bars, radical overlines — overflows its own box.
		return token.display ? `<span class="tr-math">${math}</span>` : math;
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit):
		// show the source rather than let one span blank the whole message.
		return escapeHtml(typeof token.raw === "string" ? token.raw : token.text);
	}
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from the pinned upstream delimiter grammar, so this renderer
 * and the TUI agree on what counts as math; only presentation policy lives here.
 *
 * Two limits follow from that shared behavior, both matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing because that opener terminates the line's math scan), and a display block
 * whose body contains a blank line must be preceded by one — attached blocks are
 * tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockAt(source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			start: mathTokenStart,
			tokenizer(source) {
				const span = mathSpanAt(source, 0);
				if (!span || !typesettable(span)) {
					// npm marked otherwise consumes the first `$` and re-opens the second
					// half of an unclosed `$$`, turning a streaming fragment into inline math.
					if (source.startsWith("$$")) return { type: "math", raw: "$$", text: "$$", display: false, literal: true };
					return undefined;
				}
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
