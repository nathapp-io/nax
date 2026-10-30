import { describe, expect, test } from "bun:test";
import { ACP_HANDOFF_MAX_CHARS, ACP_HANDOFF_TRIMMED_NOTICE, acpHandoff } from "@/chat/acp/acp-handoff";
import { handoffEntries } from "@/chat/acp/acp-handoff-entries";
import type { ChatMessage } from "@/chat/acp/acp-history";

const user = (content: string): ChatMessage => ({ role: "user", content });
const users = (count: number, length: number): ChatMessage[] =>
  Array.from({ length: count }, () => user("x".repeat(length)));

describe("acpHandoff", () => {
  test("AC-1: keeps two short user messages in order with omitted 0", () => {
    const result = acpHandoff([user("first"), user("second")]);
    expect(result.entries).toEqual([
      { speaker: "User", text: "first" },
      { speaker: "User", text: "second" },
    ]);
    expect(result.omitted).toBe(0);
  });

  test("AC-2: 12 messages of 4,000 characters keep the last 9 and omit 3", () => {
    const messages = users(12, 4_000);
    const result = acpHandoff(messages);
    expect(result.entries).toEqual(handoffEntries(messages).slice(3));
    expect(result.entries).toHaveLength(9);
    expect(result.omitted).toBe(3);
  });

  test("AC-3: the bound counts each entry's text after the cut", () => {
    const result = acpHandoff(users(10, 5_000));
    expect(result.entries).toHaveLength(9);
    expect(result.omitted).toBe(1);
    expect(result.entries[0]?.text).toHaveLength(4_001);
  });

  test("AC-4: the kept entries are a contiguous newest suffix, so a short older entry is dropped", () => {
    const result = acpHandoff([user("hi"), ...users(10, 4_000)]);
    expect(result.entries).toHaveLength(9);
    expect(result.omitted).toBe(2);
    expect(result.entries.some((entry) => entry.text === "hi")).toBe(false);
  });

  test("AC-5: no messages yield no entries and omitted 0", () => {
    expect(acpHandoff([])).toEqual({ entries: [], omitted: 0 });
  });

  test("keeps entries summing to exactly the bound and drops one when over by a unit", () => {
    const filler = users(9, 4_000); // 9 x 4,004 = 36,036
    const exactLength = ACP_HANDOFF_MAX_CHARS - 36_036 - "User".length;
    const fits = acpHandoff([...filler, user("y".repeat(exactLength))]);
    expect(fits.omitted).toBe(0);
    expect(fits.entries.reduce((sum, e) => sum + e.speaker.length + e.text.length, 0)).toBe(ACP_HANDOFF_MAX_CHARS);
    const over = acpHandoff([...filler, user("y".repeat(exactLength + 1))]);
    expect(over.omitted).toBe(1);
  });
});

describe("ACP_HANDOFF_TRIMMED_NOTICE", () => {
  test("AC-6: names the label and the omitted count", () => {
    expect(ACP_HANDOFF_TRIMMED_NOTICE("Codex", 3)).toBe(
      "Codex was not given the 3 oldest earlier message(s); the handoff is capped",
    );
  });
});
