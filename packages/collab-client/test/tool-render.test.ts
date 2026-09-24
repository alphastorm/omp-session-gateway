import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView, type ToolViewProps } from "../upstream/src/tool-render/ToolView";

const render = (props: ToolViewProps): string => renderToStaticMarkup(createElement(ToolView, { defaultOpen: true, ...props }));

describe("tool renderers across supported OMP releases", () => {
  test("renders a received wait message without falling back to JSON", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [{ type: "text", text: "[42] Worker: ready" }],
        details: { op: "wait", waited: { id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 } },
      },
    });
    expect(html).toContain("← Worker");
    expect(html).toContain("ready");
    expect(html).not.toContain("tv-out-title");
  });

  test("renders settled wait job output", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [],
        details: {
          op: "wait",
          jobs: [{ id: "a1b2", type: "bash", status: "completed", label: "build", durationMs: 25, resultText: "Built", errorText: "" }],
        },
      },
    });
    expect(html).toContain("Built");
    expect(html).toContain("1 done");
  });

  // OMP 18.3.0 replaced these tools with `wait` and upstream dropped their renderers, but hosts on
  // the older releases the gateway supports still emit them.
  test("keeps rendering the hub-family tools that older supported hosts emit", () => {
    expect(render({ name: "irc", args: { op: "send", to: "Main", message: "hi" }, result: { content: [] } })).toContain("→ Main");
    const job = render({ name: "job", args: { poll: ["a1b2"] }, result: { content: [] } });
    expect(job).toContain("poll a1b2");
    expect(job).not.toContain("tv-out-title");
  });
});
