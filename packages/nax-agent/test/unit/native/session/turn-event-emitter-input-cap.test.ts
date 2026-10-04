/**
 * S3-4 (carried from the S3-3 final review): `tool_call.input` redaction must
 * not walk megabytes. String values are cut to the redaction scan size before
 * `redactSecrets` runs, and key-named secrets are still masked.
 */
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@nathapp/nax-ai";
import { createTurnEventEmitter, TOOL_CALL_INPUT_BYTES } from "#src/native/session/turn-event-emitter";
import type { TurnEvent } from "#src/session/turn-event";

function toolCallInput(input: Record<string, unknown>): unknown {
  const events: TurnEvent[] = [];
  const call: ToolCall = { id: "c1", name: "Write", input };
  createTurnEventEmitter((event) => events.push(event)).toolCall(call, undefined);
  const first = events[0];
  if (first?.type !== "tool_call") throw new Error("expected a tool_call event");
  return first.input;
}

describe("tool_call.input redaction bound", () => {
  test("a multi-MB string is cut before redaction; the key-named secret is still masked", () => {
    const input = toolCallInput({ path: "big.txt", content: "x".repeat(2_000_000), apiKey: "plainsecret" });
    expect(input).toMatchObject({ truncated: true });
    const preview = (input as { preview: string }).preview;
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(TOOL_CALL_INPUT_BYTES);
    expect(preview).not.toContain("plainsecret");
  });

  test("a small input keeps its structure, with secret-named keys masked", () => {
    const input = toolCallInput({ path: "a.ts", apiKey: "plainsecret" });
    expect(input).toEqual({ path: "a.ts", apiKey: "[REDACTED]" });
  });

  test("a large input that holds a secret-named key masks it in the preview", () => {
    const input = toolCallInput({ apiKey: "plainsecret", content: "y".repeat(100_000) });
    const preview = (input as { preview: string }).preview;
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("plainsecret");
  });

  test("a cyclic input does not recurse forever", () => {
    const cyclic: Record<string, unknown> = { path: "a.ts" };
    cyclic.self = cyclic;
    expect(() => toolCallInput(cyclic)).not.toThrow();
  });
});
