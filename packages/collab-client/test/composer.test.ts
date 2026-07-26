import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, test } from "bun:test";
import { recommendedOptionIndex } from "../upstream/src/components/shell/ask-recommendation";
import type { ActiveTool, GuestSnapshot } from "../upstream/src/lib/client";

const QUESTION = "How should ADR-0036 proceed?";
const OPTIONS = [
  { label: "Implement ADR-0036 locally", description: "Apply the compatibility fix in Alpha Founder." },
  { label: "Wait for upstream", description: "Leave the current behavior unchanged." },
];

function askArgs(recommended?: number): Record<string, unknown> {
  return {
    questions: [
      {
        id: "adr-0036",
        question: QUESTION,
        options: OPTIONS,
        multi: false,
        ...(recommended === undefined ? {} : { recommended }),
      },
    ],
  };
}

function assistantEntry(toolCallId: string, args: Record<string, unknown>): SessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "ask", arguments: args }],
    model: "test/model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  return {
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "message",
    message,
  };
}

function toolResultEntry(toolCallId: string): SessionEntry {
  return {
    id: `result-${toolCallId}`,
    parentId: `entry-${toolCallId}`,
    timestamp: "2026-07-25T00:00:01.000Z",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "ask",
      content: [{ type: "text", text: "answered" }],
      isError: false,
      timestamp: 1,
    },
  };
}

function activeAsk(toolCallId: string, args: Record<string, unknown>): ActiveTool {
  return { toolCallId, toolName: "ask", args, startedAt: 0 };
}

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    phase: "live",
    endedReason: null,
    header: null,
    entries: [],
    state: null,
    agents: [],
    progress: new Map(),
    lifecycle: new Map(),
    stream: null,
    streamDone: false,
    activeTools: new Map(),
    working: true,
    readOnly: false,
    uiRequest: {
      reqId: 7,
      kind: "select",
      title: QUESTION,
      options: OPTIONS,
      initialIndex: 0,
      selectionMarker: "radio",
    },
    notices: [],
    ...overrides,
  };
}

describe("collaboration ask recommendations", () => {
  test("finds an explicit recommendation on the matching active option", () => {
    const current = snapshot({
      activeTools: new Map([["ask-active", activeAsk("ask-active", askArgs(0))]]),
    });

    expect(recommendedOptionIndex(current)).toBe(0);
  });

  test("recovers recommendation metadata from an unresolved persisted tool call after late join", () => {
    const current = snapshot({ entries: [assistantEntry("ask-persisted", askArgs(1))] });

    expect(recommendedOptionIndex(current)).toBe(1);
  });

  test("does not mistake initialIndex or a resolved historical ask for a recommendation", () => {
    const current = snapshot({
      entries: [assistantEntry("ask-old", askArgs(0)), toolResultEntry("ask-old")],
      activeTools: new Map([["ask-current", activeAsk("ask-current", askArgs())]]),
    });

    expect(recommendedOptionIndex(current)).toBeUndefined();
  });
});
