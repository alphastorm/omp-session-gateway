import type { AssistantMessage, ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { Composer, photoPromptAcknowledged } from "../upstream/src/components/shell/Composer";
import { recommendedOptionIndex } from "../upstream/src/components/shell/ask-recommendation";
import type { ActiveTool, GuestClient, GuestSnapshot } from "../upstream/src/lib/client";
import {
  type MiniElement,
  click,
  mount,
  query,
  queryAll,
  restoreDomGlobals,
  textOf,
  unmountAll,
} from "./react-dom-harness";

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

const PHOTO: ImageContent = { type: "image", data: "normalized-photo", mimeType: "image/jpeg" };

function photoPromptEntry(id: string, text: string, image: ImageContent = PHOTO): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-07-25T00:00:02.000Z",
    type: "custom_message",
    customType: "collab-prompt",
    content: [{ type: "text", text }, image],
    details: { from: "guest" },
    display: true,
  };
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
	uiResponsePending: false,
	gatewayHealth: { state: "healthy", rttMs: 20, lastSuccessAt: 0, failureSince: null, retryAt: null },
	relayHealth: { state: "healthy", rttMs: 30, lastSuccessAt: 0, failureSince: null, retryAt: null },
    notices: [],
    ...overrides,
  };
}

afterEach(async () => {
  await unmountAll();
});

afterAll(() => {
  restoreDomGlobals();
});

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

describe("photo prompt acknowledgements", () => {
  const pending = { text: "Please inspect this photo.", images: [PHOTO], afterEntryId: "baseline" };

  test("never lets an older identical entry replace a missing baseline", () => {
    expect(photoPromptAcknowledged([photoPromptEntry("older", pending.text)], pending)).toBeFalse();
  });

  test("requires an exact matching entry after the baseline", () => {
    const entries = [
      photoPromptEntry("baseline", "Earlier prompt"),
      photoPromptEntry("wrong", pending.text, { ...PHOTO, data: "different-photo" }),
      photoPromptEntry("acknowledged", pending.text),
    ];
    expect(photoPromptAcknowledged(entries, pending)).toBeTrue();
    expect(photoPromptAcknowledged(entries.slice(0, 2), pending)).toBeFalse();
  });

  test("accepts the first exact entry when the send had no baseline", () => {
    expect(
      photoPromptAcknowledged([photoPromptEntry("acknowledged", pending.text)], {
        ...pending,
        afterEntryId: null,
      }),
    ).toBeTrue();
  });
});

describe("photo source chooser", () => {
  test("routes explicit camera and library choices to separate inputs", async () => {
    const client = {
      sendAbort(): void {},
      sendAgentCmd(): void {},
      sendPrompt(): void {},
      sendUiResponse(): void {},
    } as unknown as GuestClient;
    const tree = await mount(
      createElement(Composer, {
        client,
        snapshot: snapshot({ uiRequest: null, working: false }),
        embedded: true,
      }),
    );
    const trigger = query(tree.container, "sh-photo-trigger");
    const cameraInput = query(tree.container, "sh-photo-input-camera");
    const libraryInput = query(tree.container, "sh-photo-input-library");
    if (trigger === null || cameraInput === null || libraryInput === null) {
      throw new Error("photo chooser controls did not render");
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(libraryInput.getAttribute("capture")).toBeNull();

    let cameraClicks = 0;
    let libraryClicks = 0;
    (cameraInput as MiniElement & { click(): void }).click = () => {
      cameraClicks += 1;
    };
    (libraryInput as MiniElement & { click(): void }).click = () => {
      libraryClicks += 1;
    };

    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const choices = queryAll(tree.container, "sh-photo-source-option");
    expect(choices.map(choice => textOf(choice))).toEqual([
      "Take photoOpen rear camera",
      "Choose existingPhoto library or files",
    ]);
    await click(choices[0] as MiniElement);
    expect(cameraClicks).toBe(1);
    expect(libraryClicks).toBe(0);
    expect(query(tree.container, "sh-photo-source-options")).toBeNull();

    await click(trigger);
    await click(queryAll(tree.container, "sh-photo-source-option")[1] as MiniElement);
    expect(cameraClicks).toBe(1);
    expect(libraryClicks).toBe(1);
    expect(query(tree.container, "sh-photo-source-options")).toBeNull();
  });
});
