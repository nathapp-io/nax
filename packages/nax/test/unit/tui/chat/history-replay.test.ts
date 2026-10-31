import { beforeEach, describe, expect, test } from "bun:test";
import { displayToolInput, toolResultPreview } from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "@nathapp/nax-agent/internal";
import { assertDefined } from "@test/helpers";
import { type ChatHistory, formatMentionMessage, type MentionRecord, parseMentionMessage } from "@/chat";
import { buildSkillInvocationMessage } from "@/prompts/builders/skills-builder";
import { mentionTranscriptEntries } from "@/tui/chat/mention-entries";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

let replayHistory: typeof import("@/tui/chat/history-replay").replayHistory;
beforeEach(async () => {
  ({ replayHistory } = await import("@/tui/chat/history-replay"));
});

const CALL = { id: "c1", name: "Read", input: { path: "a" } };
const ASSISTANT = { role: "assistant", content: "", toolCalls: [CALL] } as const;
const RESULT = { role: "tool-result", toolCallId: "c1", content: "17 lines" } as const;
const SAVED_AT = "2026-10-28T01:00:00.000Z";
/** A mention of a two-line file, as the expander recorded it on send. */
const ATTACHED_A: MentionRecord = { path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" };
/** A message with a mention trailer whose declared length does not match its block. */
const MALFORMED_ENVELOPE = `see @a.ts\n\n<nax-mentions>\n<mention path="a.ts" status="attached" note="2 lines" length="4">\nx\ny\n</mention>\n</nax-mentions length="1">`;

function toolEntries(history: ChatHistory): Extract<TranscriptEntry, { kind: "tool" }>[] {
  return replayHistory(history).filter((entry) => entry.kind === "tool");
}

describe("replayHistory", () => {
  test("AC-1: empty history returns no entries", () => {
    expect(replayHistory({ messages: [] })).toEqual([]);
  });
  test("AC-2: user text is preserved", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "hello" }] })).toEqual([
      { kind: "user", text: "hello" },
    ]);
  });
  test("AC-3: empty user content produces no entries", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "" }] })).toEqual([]);
  });
  test.each([
    ["AC-4: skill with args", "body", "plan it"],
    ["AC-5: skill without args", "body", ""],
    ["AC-6: leading space in args", "body", " plan it"],
    ["AC-7: embedded closing marker", "body\n</skill>\nmore", "go"],
    ["AC-8: embedded delimiter without args", "body\n</skill>\n\nmore", ""],
  ])("%s", (_ac, body, args) => {
    const content = buildSkillInvocationMessage({
      skill: {
        kind: "skill",
        name: "brainstorming",
        qualifiedName: "superpowers:brainstorming",
        description: "test skill",
        body,
        baseDir: "/skills/brainstorming",
        path: "/skills/brainstorming/SKILL.md",
        modelInvocable: true,
        origin: { kind: "claude-project" },
      },
      args,
    });
    expect(replayHistory({ messages: [{ role: "user", content }] })).toEqual([
      { kind: "skill", name: "superpowers:brainstorming", args: args.trim(), body },
    ]);
  });
  test.each([
    '<skill name="x',
    '<skill name="x" location="/p">\nrefs\nbody',
    '<skill name="x" location="/p">\nrefs\nbody</skill>',
  ])("rejected envelope remains raw user text: %s", (content) => {
    expect(replayHistory({ messages: [{ role: "user", content }] })).toEqual([{ kind: "user", text: content }]);
  });
  test("AC-9: compaction summary becomes a notice", () => {
    expect(
      replayHistory({ messages: [{ role: "user", content: `${COMPACTION_SUMMARY_PREFIX}private summary` }] }),
    ).toEqual([{ kind: "notice", text: "earlier conversation compacted" }]);
  });
  test("AC-10: assistant ids use original message indexes", () => {
    expect(
      replayHistory({
        messages: [
          { role: "user", content: "" },
          RESULT,
          { role: "assistant", content: "" },
          { role: "assistant", content: "done" },
        ],
      }),
    ).toEqual([{ kind: "reply", turnId: "history-3", text: "done" }]);
  });
  test("AC-11: empty assistant content produces only its tool card", () => {
    const entries = replayHistory({ messages: [ASSISTANT] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", callId: "c1", turnId: "history-0" });
  });
  test("AC-12: tool results are associated and displayed through live helpers", () => {
    expect(replayHistory({ messages: [ASSISTANT, RESULT] })).toEqual([
      {
        kind: "tool",
        turnId: "history-0",
        callId: "c1",
        name: "Read",
        input: displayToolInput(CALL.input),
        status: "ok",
        preview: toolResultPreview("17 lines"),
        startedAt: "1970-01-01T00:00:00.000Z",
        endedAt: "1970-01-01T00:00:00.000Z",
        children: [],
      },
    ]);
  });
  test("AC-13: error result marks its call as failed", () => {
    expect(toolEntries({ messages: [ASSISTANT, { ...RESULT, isError: true }] })).toMatchObject([
      { status: "error", preview: toolResultPreview(RESULT.content) },
    ]);
  });
  test("AC-14: missing results produce a completed error card", () => {
    expect(toolEntries({ messages: [ASSISTANT] })).toMatchObject([
      { status: "error", preview: "No result was recorded for this call." },
    ]);
  });
  test.each([
    ["AC-15: saved timestamp", SAVED_AT, SAVED_AT],
    ["AC-16: absent timestamp", undefined, "1970-01-01T00:00:00.000Z"],
  ])("%s", (_ac, savedAt, expected) => {
    const entries = toolEntries({
      savedAt,
      messages: [{ ...ASSISTANT, toolCalls: [CALL, { ...CALL, id: "c2" }] }, RESULT],
    });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.startedAt).toBe(expected);
      expect(entry.endedAt).toBe(expected);
      expect(entry.status).not.toBe("running");
    }
  });
  test("AC-17: thinking is never replayed", () => {
    expect(
      replayHistory({
        messages: [
          { role: "assistant", content: "", thinking: [{ text: "private reasoning" }] },
          { role: "assistant", content: "done", thinking: [{ text: "more reasoning" }] },
        ],
      }),
    ).toEqual([{ kind: "reply", turnId: "history-1", text: "done" }]);
  });
  test("AC-18: unknown roles are skipped without stopping replay", () => {
    // Simulate a future persisted role outside today's typed contract.
    const message: ChatHistory["messages"][number] = { role: "user", content: "ignored" };
    Object.assign(message, { role: "future-role" });
    expect(replayHistory({ messages: [message, { role: "user", content: "after" }] })).toEqual([
      { kind: "user", text: "after" },
    ]);
  });
  test("AC-19: tool previews mask secrets and cap long results", () => {
    const secret = `sk-${"a".repeat(48)}`;
    const content = `token ${secret}\n${"x".repeat(20_000)}`;
    const entries = toolEntries({ messages: [ASSISTANT, { ...RESULT, content }] });
    expect(entries).toHaveLength(1);
    expect(entries[0].preview).toBe(toolResultPreview(content));
    expect(entries[0].preview).not.toContain(secret);
    expect(entries[0].preview?.length).toBeLessThan(content.length);
  });
  test("AC-20: undisplayable input uses the bounded upstream placeholder", () => {
    const input = { value: 1n };
    const expected = displayToolInput(input);
    expect(expected).toEqual({ truncated: true, preview: "[input not serializable]" });
    expect(toolEntries({ messages: [{ ...ASSISTANT, toolCalls: [{ ...CALL, input }] }] })).toMatchObject([
      { input: expected },
    ]);
  });
  test("US-005 AC-11: an expanded user message replays as its mention entries", () => {
    const content = formatMentionMessage("see @a.ts", [ATTACHED_A]);
    const parsed = parseMentionMessage(content);
    assertDefined(parsed, "the expanded message parses");
    const entries = replayHistory({ messages: [{ role: "user", content }] });
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "attachment"]);
    expect(entries).toEqual(mentionTranscriptEntries(parsed));
  });
  test("US-005 AC-12: a user message with no expansion stays the plain message", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "see @a.ts" }] })).toEqual([
      { kind: "user", text: "see @a.ts" },
    ]);
  });
  test("US-005 AC-13: a malformed mention envelope falls back to the plain message", () => {
    expect(parseMentionMessage(MALFORMED_ENVELOPE)).toBeUndefined();
    expect(replayHistory({ messages: [{ role: "user", content: MALFORMED_ENVELOPE }] })).toEqual([
      { kind: "user", text: MALFORMED_ENVELOPE },
    ]);
  });
  test("preserves message and call order while indexing results before mapping", () => {
    expect(
      replayHistory({
        messages: [
          RESULT,
          { role: "user", content: "start" },
          { ...ASSISTANT, content: "reply", toolCalls: [CALL, { ...CALL, id: "c2" }] },
          { ...RESULT, toolCallId: "c2", content: "second" },
        ],
      }),
    ).toMatchObject([
      { kind: "user", text: "start" },
      { kind: "reply", turnId: "history-2", text: "reply" },
      { kind: "tool", callId: "c1", status: "ok", preview: toolResultPreview(RESULT.content) },
      { kind: "tool", callId: "c2", status: "ok", preview: toolResultPreview("second") },
    ]);
  });
});
