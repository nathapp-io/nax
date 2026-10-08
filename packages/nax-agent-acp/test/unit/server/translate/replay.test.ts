import { describe, expect, test } from "bun:test";
import { TOOL_RESULT_PREVIEW_BYTES } from "@nathapp/nax-agent";
import { textContent as text } from "#src/server/translate/events";
import { NO_RESULT_TEXT, replayTranscript, type TranscriptMessage } from "#src/server/translate/replay";

describe("replayTranscript (spec §5.4)", () => {
  test("user, thinking, assistant text and a completed Edit with its diff, in order", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "rename a to b" },
      {
        role: "assistant",
        content: "Done.",
        thinking: [{ text: "Edit needed" }],
        toolCalls: [{ id: "c1", name: "Edit", input: { path: "src/x.ts", old_string: "a", new_string: "b" } }],
      },
      { role: "tool-result", toolCallId: "c1", content: "edited" },
    ];
    expect(replayTranscript(messages, "/repo")).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "rename a to b" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Edit needed" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit src/x.ts",
        kind: "edit",
        status: "completed",
        rawInput: { path: "src/x.ts", old_string: "a", new_string: "b" },
        locations: [{ path: "/repo/src/x.ts" }],
        content: [text("edited"), { type: "diff", path: "/repo/src/x.ts", oldText: "a", newText: "b" }],
      },
    ]);
  });

  test("Write replays without a diff; a failed result is failed; a missing result is failed with a note", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "w", name: "Write", input: { path: "n.ts", content: "x" } },
          { id: "b", name: "Bash", input: { command: "false" } },
          { id: "lost", name: "Read", input: { path: "r.ts" } },
        ],
      },
      { role: "tool-result", toolCallId: "w", content: "wrote" },
      { role: "tool-result", toolCallId: "b", content: "exit 1", isError: true },
    ];
    const updates = replayTranscript(messages, "/repo");
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({ toolCallId: "w", status: "completed", content: [text("wrote")] });
    expect(updates[1]).toMatchObject({ toolCallId: "b", status: "failed", content: [text("exit 1")] });
    expect(updates[2]).toMatchObject({ toolCallId: "lost", status: "failed", content: [text(NO_RESULT_TEXT)] });
  });

  test("empty user and assistant text are skipped", () => {
    expect(
      replayTranscript(
        [
          { role: "user", content: "" },
          { role: "assistant", content: "" },
        ],
        "/r",
      ),
    ).toEqual([]);
  });

  test("results are capped to the live preview size", () => {
    const messages: TranscriptMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "Read", input: { path: "big" } }] },
      { role: "tool-result", toolCallId: "c", content: "z".repeat(TOOL_RESULT_PREVIEW_BYTES * 4) },
    ];
    const [update] = replayTranscript(messages, "/r");
    const shown = update?.sessionUpdate === "tool_call" ? update.content?.[0] : undefined;
    const shownText = shown?.type === "content" && shown.content.type === "text" ? shown.content.text : "";
    expect(shownText.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(shownText, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
  });

  test("secrets in stored inputs and results are masked as live events mask them (M-7)", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const messages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c", name: "Write", input: { path: ".env", content: `KEY=${secret}` } }],
      },
      { role: "tool-result", toolCallId: "c", content: `wrote KEY=${secret}` },
    ];
    expect(JSON.stringify(replayTranscript(messages, "/r"))).not.toContain(secret);
  });
});
