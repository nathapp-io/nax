import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { piProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEvent } from "../../src/protocols/types.ts";
import { piProviders } from "../../src/providers/pi-catalog.ts";
import { record } from "./support/record.ts";

const KEY = process.env.DEEPSEEK_API_KEY;
const PROVIDER = "deepseek";

async function client() {
  return createClient({ providers: await piProviders([PROVIDER]), protocols: piProtocols() });
}

describe.skipIf(!KEY)("live completion against deepseek", () => {
  it("returns text and non-zero usage", async () => {
    const c = await client();
    const models = await c.listModels(PROVIDER);
    const model = models[0];
    if (!model) throw new Error("No deepseek model in the catalog.");

    const events: ProtocolEvent[] = [];
    for await (const event of c.stream(model, {
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 16,
    })) {
      events.push(event);
    }
    record(`${PROVIDER}-text`, events);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done" });

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.usage.inputTokens).toBeGreaterThan(0);
      expect(usage.usage.outputTokens).toBeGreaterThan(0);
    }

    const text = events
      .filter((e): e is Extract<ProtocolEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("round-trips a tool call", async () => {
    const c = await client();
    const models = await c.listModels(PROVIDER);
    const model = models[0];
    if (!model) throw new Error("No deepseek model in the catalog.");

    const events: ProtocolEvent[] = [];
    for await (const event of c.stream(model, {
      messages: [{ role: "user", content: "Read the file a.ts using the read tool." }],
      tools: [
        {
          name: "read",
          description: "Read a file from disk",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      maxTokens: 128,
    })) {
      events.push(event);
    }
    record(`${PROVIDER}-tool`, events);

    const call = events.find((e) => e.type === "tool-call");
    expect(call).toBeDefined();
    if (call?.type === "tool-call") {
      expect(call.call.name).toBe("read");
      expect(call.call.input).toBeTypeOf("object");
    }
  });
});
