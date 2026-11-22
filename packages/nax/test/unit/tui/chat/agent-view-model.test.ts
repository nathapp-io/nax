import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, textDeltaEvent, toolCallEvent, toolResultEvent, turnEndEvent } from "@test/helpers";
import type { BackgroundAgentRun } from "@/chat/background";
import {
  AGENT_VIEW_HINT,
  agentStateLabel,
  agentViewEntries,
  agentViewFooter,
  agentViewTitle,
  entryKey,
  LOG_NOT_RETAINED_NOTICE,
  missingAgentTitle,
  toggledEntry,
  withOpened,
} from "@/tui/chat/agent-view-model";
import { plainText } from "@/tui/chat/styled-line";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

function run(patch: Partial<BackgroundAgentRun> = {}, events: readonly SessionEvent[] = []): BackgroundAgentRun {
  return {
    id: "agent-1a2b3c4d",
    agent: "reviewer",
    prompt: "Do the thing",
    state: "running",
    logRetained: true,
    events,
    ...patch,
  };
}

describe("agentViewEntries", () => {
  test("starts with the task prompt as the first user message", () => {
    expect(agentViewEntries(run())).toEqual([{ kind: "user", text: "Do the thing" }]);
  });

  test("folds text, tool calls and results behind the prompt with the chat's own reducer", () => {
    const entries = agentViewEntries(run({}, [toolCallEvent("c1"), toolResultEvent("c1"), textDeltaEvent("All good")]));
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool", "reply"]);
    expect(entries[1]).toMatchObject({ kind: "tool", callId: "c1", name: "Read", status: "ok", preview: "contents" });
    expect(entries[2]).toMatchObject({ kind: "reply", text: "All good" });
  });

  test("a cancelled turn ends with the interrupted row", () => {
    const base = turnEndEvent("", 0);
    if (base.type !== "turn_end") throw new Error("expected a turn_end event");
    const end: SessionEvent = { ...base, status: "cancelled" };
    expect(agentViewEntries(run({}, [end])).at(-1)).toEqual({ kind: "interrupted" });
  });
});

describe("a dropped log", () => {
  test("keeps the prompt and adds the not-retained notice", () => {
    expect(agentViewEntries(run({ logRetained: false, state: "succeeded" }, [toolCallEvent("c1")]))).toEqual([
      { kind: "user", text: "Do the thing" },
      { kind: "notice", text: LOG_NOT_RETAINED_NOTICE },
    ]);
  });
});

function keyAt(entries: readonly TranscriptEntry[], index: number): string | undefined {
  const entry = entries[index];
  assertDefined(entry, `entry ${index}`);
  return entryKey(entry);
}

describe("opened rows keep their identity when older entries drop", () => {
  test("a tool card is keyed by its call, other rows by nothing", () => {
    const entries = agentViewEntries(run({}, [toolCallEvent("c1"), textDeltaEvent("x")]));
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool", "reply"]);
    expect(keyAt(entries, 0)).toBeUndefined();
    expect(keyAt(entries, 1)).toMatch(/^tool:.*:c1$/);
    expect(keyAt(entries, 2)).toBeUndefined();
  });

  test("an opened tool card stays opened after an earlier entry disappears", () => {
    const first = toolCallEvent("c1");
    const second = toolCallEvent("c2");
    const full = agentViewEntries(run({}, [first, second]));
    const key = keyAt(full, 2);
    assertDefined(key, "key of c2");
    const opened = new Map([[key, true]]);
    expect(withOpened(full, opened)[2]).toMatchObject({ callId: "c2", open: true });
    // The oldest call dropped: c2 moves from index 2 to 1 and must still be the opened one.
    const after = withOpened(agentViewEntries(run({}, [second])), opened);
    expect(after[1]).toMatchObject({ callId: "c2", open: true });
    expect(after[0]).toEqual({ kind: "user", text: "Do the thing" });
  });

  test("toggledEntry names the toggled card by key", () => {
    const entries = agentViewEntries(run({}, [toolCallEvent("c1")]));
    const toggled = entries.map((entry) => (entry.kind === "tool" ? { ...entry, open: true } : entry));
    const key = keyAt(entries, 1);
    assertDefined(key, "key of c1");
    expect(toggledEntry(entries, toggled)).toEqual({ key, open: true });
  });
});

describe("agentViewTitle", () => {
  test.each([
    ["running", "running"],
    ["succeeded", "done"],
    ["failed", "failed"],
    ["stopped", "stopped"],
  ] as const)("names the agent, the model and the %s state as %s", (state, label) => {
    expect(agentStateLabel(state)).toBe(label);
    expect(plainText(agentViewTitle(run({ state, model: "openai-codex/gpt-6-luna" })))).toBe(
      `Agent reviewer · openai-codex/gpt-6-luna · ${label}`,
    );
  });

  test("says the model is unknown when the run has none", () => {
    expect(plainText(agentViewTitle(run()))).toContain("model unknown");
  });

  test("a task gone from the registry is named as such", () => {
    expect(plainText(missingAgentTitle("agent-1a2b3c4d"))).toBe("Agent agent-1a2b3c4d · no longer listed");
  });

  test("the footer is the single return hint", () => {
    expect(plainText(agentViewFooter())).toBe(AGENT_VIEW_HINT);
    expect(AGENT_VIEW_HINT).toBe("esc to return");
  });
});
