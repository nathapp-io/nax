import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { textDeltaEvent, toolCallEvent, toolResultEvent, turnEndEvent } from "@test/helpers";
import type { BackgroundAgentRun } from "@/chat/background";
import {
  AGENT_VIEW_HINT,
  agentStateLabel,
  agentViewEntries,
  agentViewFooter,
  agentViewTitle,
  missingAgentTitle,
} from "@/tui/chat/agent-view-model";
import { plainText } from "@/tui/chat/styled-line";

function run(patch: Partial<BackgroundAgentRun> = {}, events: readonly SessionEvent[] = []): BackgroundAgentRun {
  return { id: "agent-1a2b3c4d", agent: "reviewer", prompt: "Do the thing", state: "running", events, ...patch };
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
