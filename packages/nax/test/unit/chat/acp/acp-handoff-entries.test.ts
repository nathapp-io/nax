import { describe, expect, test } from "bun:test";
import { ACP_HANDOFF_ENTRY_MAX_CHARS, handoffEntries, unseenMessages } from "@/chat/acp/acp-handoff-entries";
import type { ChatMessage } from "@/chat/acp/acp-history";

interface Origin {
  readonly provider: string;
  readonly model: string;
}

interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AssistantExtras {
  readonly origin?: Origin;
  readonly toolCalls?: readonly ToolCallRecord[];
  readonly thinking?: readonly { readonly text: string }[];
}

const user = (content: string): ChatMessage => ({ role: "user", content });

/**
 * Only the properties a case needs are set: the transcript message type keeps
 * `origin`, `toolCalls` and `thinking` optional and `exactOptionalPropertyTypes`
 * forbids assigning `undefined` to them.
 */
function assistant(content: string, extras: AssistantExtras = {}): ChatMessage {
  return {
    role: "assistant",
    content,
    ...(extras.origin !== undefined ? { origin: extras.origin } : {}),
    ...(extras.toolCalls !== undefined ? { toolCalls: extras.toolCalls } : {}),
    ...(extras.thinking !== undefined ? { thinking: extras.thinking } : {}),
  };
}

function toolCall(id: string, name: string): ToolCallRecord {
  return { id, name, input: {} };
}

const CODEX: Origin = { provider: "acp:codex", model: "default" };

describe("unseenMessages", () => {
  test("returns every message, in order, for a fresh agent session", () => {
    const messages = [user("u1"), assistant("a1", { origin: CODEX }), user("u2")];
    expect(unseenMessages(messages, "codex", true)).toEqual(messages);
  });

  test("returns what follows the last turn the agent wrote", () => {
    const messages = [user("u1"), assistant("a1", { origin: CODEX }), user("u2"), assistant("a2")];
    expect(unseenMessages(messages, "codex", false)).toEqual([messages[2], messages[3]]);
  });

  test("returns every message when the agent wrote none of them", () => {
    const messages = [user("u1"), assistant("a1", { origin: { provider: "openai", model: "gpt-6" } }), user("u2")];
    expect(unseenMessages(messages, "codex", false)).toEqual(messages);
  });

  test("returns an empty array when the agent wrote the last message", () => {
    const messages = [user("u1"), assistant("a1", { origin: CODEX })];
    expect(unseenMessages(messages, "codex", false)).toEqual([]);
  });

  test("does not count another acp agent's turn as the opening agent's own", () => {
    const messages = [user("u1"), assistant("a1", { origin: { provider: "acp:cursor", model: "default" } })];
    expect(unseenMessages(messages, "codex", false)).toEqual(messages);
  });

  test("returns an empty array for an empty history", () => {
    expect(unseenMessages([], "codex", false)).toEqual([]);
  });

  test("returns the original message objects", () => {
    const messages = [user("u1"), assistant("a1", { origin: CODEX }), user("u2")];
    expect(unseenMessages(messages, "codex", false)[0]).toBe(messages[2]);
  });
});

describe("handoffEntries", () => {
  test("speaks a user message with the User speaker", () => {
    expect(handoffEntries([user("plan it")])).toEqual([{ speaker: "User", text: "plan it" }]);
  });

  const SPEAKER_CASES: readonly [string, Origin | undefined, string][] = [
    ["no origin", undefined, "nax"],
    ["a native origin", { provider: "openai", model: "gpt-6" }, "nax (gpt-6)"],
    ["an acp chat agent", CODEX, "Codex"],
    ["another acp agent", { provider: "acp:gemini", model: "x" }, "acp:gemini"],
  ];

  test.each(SPEAKER_CASES)("speaks an assistant message with %s as its author", (_label, origin, speaker) => {
    const message = assistant("a", origin === undefined ? {} : { origin });
    expect(handoffEntries([message]).map((entry) => entry.speaker)).toEqual([speaker]);
  });

  test("writes the text, then one tool line per call", () => {
    const message = assistant("ok", { toolCalls: [toolCall("1", "Read"), toolCall("2", "Bash")] });
    expect(handoffEntries([message]).map((entry) => entry.text)).toEqual(["ok\n[tool] Read\n[tool] Bash"]);
  });

  test("writes no leading newline when the content is empty", () => {
    const message = assistant("", { toolCalls: [toolCall("1", "Read")] });
    expect(handoffEntries([message]).map((entry) => entry.text)).toEqual(["[tool] Read"]);
  });

  test("drops a tool-result message", () => {
    const messages: readonly ChatMessage[] = [{ role: "tool-result", toolCallId: "1", content: "r" }];
    expect(handoffEntries(messages)).toEqual([]);
  });

  test("drops an assistant message with neither text nor tool calls", () => {
    expect(handoffEntries([assistant("")])).toEqual([]);
  });

  test("ignores thinking blocks", () => {
    const message = assistant("a", { thinking: [{ text: "secret plan" }] });
    expect(handoffEntries([message]).map((entry) => entry.text)).toEqual(["a"]);
  });

  test("keeps a user message with empty content as an entry", () => {
    expect(handoffEntries([user("")])).toEqual([{ speaker: "User", text: "" }]);
  });

  test("cuts an entry longer than the cap and marks it with an ellipsis", () => {
    const long = "x".repeat(5_000);
    expect(ACP_HANDOFF_ENTRY_MAX_CHARS).toBe(4_000);
    const [entry] = handoffEntries([user(long)]);
    expect(entry?.text).toBe(`${"x".repeat(4_000)}…`);
    expect(entry?.text.length).toBe(4_001);
  });

  test("leaves an entry of exactly the cap unchanged", () => {
    const exact = "y".repeat(4_000);
    expect(handoffEntries([user(exact)]).map((entry) => entry.text)).toEqual([exact]);
  });

  test("applies the cap to the composed text, not to the content alone", () => {
    const composed = `${"z".repeat(3_990)}\n[tool] Read\n[tool] Bash`;
    const message = assistant("z".repeat(3_990), { toolCalls: [toolCall("1", "Read"), toolCall("2", "Bash")] });
    const [entry] = handoffEntries([message]);
    expect(entry?.text).toBe(`${composed.slice(0, 4_000)}…`);
    expect(entry?.text.length).toBe(4_001);
  });

  test("returns the entries in message order", () => {
    expect(handoffEntries([user("q"), assistant("a")])).toEqual([
      { speaker: "User", text: "q" },
      { speaker: "nax", text: "a" },
    ]);
  });
});
