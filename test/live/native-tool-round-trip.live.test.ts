// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { getNativeClient } from "@/agents/native/client";

// Live: costs money and needs a credential. Opt in with NAX_LIVE=1.
const live = process.env.NAX_LIVE === "1" ? test : test.skip;

describe("nax-ai tool round-trip (live)", () => {
  live(
    "a tool result fed back produces a coherent continuation",
    async () => {
      const client = await getNativeClient();
      const model = await client.model("openrouter", "deepseek/deepseek-v4-flash");

      const tools = [
        {
          name: "get_secret_number",
          description: "Returns the secret number. Call this when asked for it.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
        },
      ];

      const first = await client.complete(model, {
        messages: [{ role: "user", content: "What is the secret number? Use the tool." }],
        tools,
      });

      expect(first.toolCalls?.length ?? 0).toBeGreaterThan(0);
      const call = first.toolCalls?.[0];
      if (!call) throw new Error("expected a tool call");
      expect(call.name).toBe("get_secret_number");

      const second = await client.complete(model, {
        messages: [
          { role: "user", content: "What is the secret number? Use the tool." },
          { role: "assistant", content: first.text, toolCalls: first.toolCalls },
          { role: "tool-result", toolCallId: call.id, content: "42" },
        ],
        tools,
      });

      expect(second.text).toContain("42");
    },
    60_000,
  );
});
