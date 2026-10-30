import { describe, expect, test } from "bun:test";
import { acpAgentOfMessage, type ChatHistory } from "@/chat";
import { replayHistory } from "@/tui/chat/history-replay";

const ORIGIN = { provider: "acp:cursor", model: "default" };
const TIMESTAMP = "1970-01-01T00:00:00.000Z";

function acpMessage(content: string): ChatHistory["messages"][number] {
  return { role: "assistant", content, origin: ORIGIN };
}

function replayAcp(content: string) {
  return replayHistory({ messages: [{ role: "user", content: "go" }, acpMessage(content)] }).slice(1);
}

describe("replayHistory of an ACP assistant message", () => {
  test("AC-7: replays the text as a reply followed by one tool entry per line", () => {
    expect(replayAcp("Done.\n[tool] Read\n[tool] Edit")).toEqual([
      { kind: "reply", turnId: "history-1", text: "Done." },
      {
        kind: "tool",
        turnId: "history-1",
        callId: "history-1-acp-0",
        name: "Read",
        input: {},
        status: "ok",
        startedAt: TIMESTAMP,
        endedAt: TIMESTAMP,
        children: [],
      },
      {
        kind: "tool",
        turnId: "history-1",
        callId: "history-1-acp-1",
        name: "Edit",
        input: {},
        status: "ok",
        startedAt: TIMESTAMP,
        endedAt: TIMESTAMP,
        children: [],
      },
    ]);
  });

  test("AC-8: an (error) suffix becomes status error and is dropped from the name", () => {
    expect(replayAcp("[tool] Edit (error)")).toMatchObject([{ kind: "tool", name: "Edit", status: "error" }]);
  });

  test("AC-9: an overflow line becomes a notice", () => {
    expect(replayAcp("[tool] … and 3 more")).toEqual([{ kind: "notice", text: "… and 3 more tool calls" }]);
  });

  test("AC-10: tool entries carry empty input, no preview, no children and indexed call ids", () => {
    const entries = replayAcp("[tool] Read\n[tool] Edit");
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind === "tool" && entry.callId)).toEqual([
      "history-1-acp-0",
      "history-1-acp-1",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ kind: "tool", input: {}, children: [] });
      expect("preview" in entry).toBe(false);
    }
  });

  test("AC-11: a message of only tool lines replays no reply", () => {
    const entries = replayAcp("[tool] Read");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", name: "Read" });
  });

  test("AC-12: only the trailing run of tool lines is parsed", () => {
    expect(replayAcp("Use [tool] syntax here.\n[tool] Read")).toMatchObject([
      { kind: "reply", text: "Use [tool] syntax here." },
      { kind: "tool", name: "Read" },
    ]);
  });

  test("a tool-looking line before the reply's last text line stays in the reply", () => {
    expect(replayAcp("[tool] Read\nthen text")).toEqual([
      { kind: "reply", turnId: "history-1", text: "[tool] Read\nthen text" },
    ]);
  });

  test("keeps blank lines between reply segments and drops the blank before the tool run", () => {
    expect(replayAcp("a\n\nb\n[tool] Read")).toMatchObject([
      { kind: "reply", text: "a\n\nb" },
      { kind: "tool", name: "Read" },
    ]);
  });

  test("numbers call ids by line index in the run, so a notice leaves a gap", () => {
    const entries = replayAcp("[tool] A\n[tool] … and 2 more");
    expect(entries).toMatchObject([
      { kind: "tool", callId: "history-1-acp-0" },
      { kind: "notice", text: "… and 2 more tool calls" },
    ]);
  });

  test("AC-13: a native assistant message keeps its text and gets no tool entry", () => {
    expect(replayHistory({ messages: [{ role: "assistant", content: "x\n[tool] Read" }] })).toEqual([
      { kind: "reply", turnId: "history-0", text: "x\n[tool] Read" },
    ]);
  });

  test("an assistant message with a non-ACP origin replays as native", () => {
    const origin = { provider: "openai", model: "gpt" };
    expect(replayHistory({ messages: [{ role: "assistant", content: "x\n[tool] Read", origin }] })).toEqual([
      { kind: "reply", turnId: "history-0", text: "x\n[tool] Read" },
    ]);
  });
});

describe("acpAgentOfMessage from @/chat", () => {
  test("AC-14: returns the agent of an acp origin", () => {
    expect(acpAgentOfMessage(acpMessage("x"))).toBe("cursor");
  });
});
