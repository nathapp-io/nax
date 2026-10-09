import { describe, expect, test } from "bun:test";
import { rewriteToolCallInput } from "#src/native/session/handle-invalid-tool-call";

describe("rewriteToolCallInput keeps the origin (S5-3 M-19)", () => {
  test("the rebuilt assistant message keeps origin and thinking", () => {
    const out = rewriteToolCallInput(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "Read", input: { path: 1 } }],
          thinking: [{ text: "t", signature: "s" }],
          origin: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      ],
      "c1",
      { path: "a.ts" },
    );
    expect(out[1]).toMatchObject({
      origin: { provider: "anthropic", model: "claude-haiku-4-5" },
      thinking: [{ text: "t", signature: "s" }],
      toolCalls: [{ id: "c1", input: { path: "a.ts" } }],
    });
  });
});
