/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. OMP 18.3.0 replaced the hub-family tools with `wait`, and
 * upstream dropped their renderers, but the older OMP releases the gateway supports still
 * emit `hub`, `irc`, `job`, `await`, `poll`, and `cancel_job`, so those stay registered.
 * Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astEditRenderer } from "./tools/ast-edit";
import { astGrepRenderer } from "./tools/ast-grep";
import { bashRenderer } from "./tools/bash";
import { browserRenderer } from "./tools/browser";
import { debugRenderer } from "./tools/debug";
import { editRenderer } from "./tools/edit";
import { evalRenderer } from "./tools/eval";
import { fetchRenderer } from "./tools/fetch";
import { generateImageRenderer } from "./tools/generate-image";
import { githubRenderer } from "./tools/github";
import { globRenderer } from "./tools/glob";
import { goalRenderer } from "./tools/goal";
import { grepRenderer } from "./tools/grep";
import { hubRenderer } from "./tools/hub";
import { ircRenderer } from "./tools/irc";
import { jobRenderer } from "./tools/job";
import { lspRenderer } from "./tools/lsp";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { waitRenderer } from "./tools/wait";
import { webSearchRenderer } from "./tools/web-search";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast_edit: astEditRenderer,
	ast_grep: astGrepRenderer,
	bash: bashRenderer,
	browser: browserRenderer,
	puppeteer: browserRenderer,
	debug: debugRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	eval: evalRenderer,
	js: evalRenderer,
	python: evalRenderer,
	notebook: evalRenderer,
	fetch: fetchRenderer,
	glob: globRenderer,
	find: globRenderer,
	generate_image: generateImageRenderer,
	github: githubRenderer,
	goal: goalRenderer,
	hub: hubRenderer,
	irc: ircRenderer,
	job: jobRenderer,
	await: jobRenderer,
	poll: jobRenderer,
	cancel_job: jobRenderer,
	wait: waitRenderer,
	lsp: lspRenderer,
	recall: recallRenderer,
	reflect: reflectRenderer,
	retain: retainRenderer,
	read: readRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	propose: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return RENDERERS[name] ?? genericRenderer;
}
