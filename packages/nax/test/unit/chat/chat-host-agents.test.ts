import { afterEach, describe, expect, test } from "bun:test";
import { CHAT_MODEL, makeAgentResource, makeSubagentHostHarness, type SubagentHostHarness } from "@test/helpers";
import type { ChatAgentRow } from "@/chat";

let harness: SubagentHostHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function agentRows(options: Parameters<typeof makeSubagentHostHarness>[0]): Promise<readonly ChatAgentRow[]> {
  harness = makeSubagentHostHarness(options);
  await harness.host.start({ mode: "guarded", model: CHAT_MODEL });
  return harness.host.agents?.() ?? [];
}

describe("native chat host agents()", () => {
  test("AC-7 returns no rows when the catalog has no agents", async () => {
    expect(await agentRows({ agents: [] })).toEqual([]);
  });

  test("AC-8 AC-9 resolves a model label through agent.modelAliases with source alias", async () => {
    const rows = await agentRows({
      agents: [makeAgentResource({ name: "reviewer", model: "sonnet" })],
      modelAliases: { sonnet: "a/s" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe("a/s");
    expect(rows[0]?.modelSource).toBe("alias");
  });

  test("AC-10 an agent without a model inherits the chat session's current model", async () => {
    const rows = await agentRows({ agents: [makeAgentResource()] });
    expect(rows[0]?.model).toBe(CHAT_MODEL);
    expect(rows[0]?.modelSource).toBe("inherit");
  });

  test("an inherited model follows a model switch made after construction", async () => {
    const rows = await agentRows({ agents: [makeAgentResource()] });
    expect(rows[0]?.model).toBe(CHAT_MODEL);
    await harness?.host.switchTo({ model: "anthropic/other-model" });
    expect(harness?.host.agents?.()[0]?.model).toBe("anthropic/other-model");
  });

  test("AC-11 an agent without tools lists tools all", async () => {
    const rows = await agentRows({ agents: [makeAgentResource()] });
    expect(rows[0]?.tools).toBe("all");
  });

  test("an agent with an empty tools list lists no tools", async () => {
    const rows = await agentRows({ agents: [makeAgentResource({ tools: [] })] });
    expect(rows[0]?.tools).toEqual([]);
  });

  test("AC-12 a shadowed plugin agent keeps its qualified name, in catalog order", async () => {
    const rows = await agentRows({
      agents: [
        makeAgentResource({ name: "reviewer" }),
        makeAgentResource({
          name: "reviewer",
          qualifiedName: "p:reviewer",
          origin: { kind: "claude-plugin", plugin: "p", marketplace: "m" },
        }),
      ],
    });
    expect(rows.map((row) => row.name)).toEqual(["reviewer", "p:reviewer"]);
  });

  test("AC-18 an unknown model label falls back to the chat model", async () => {
    const rows = await agentRows({ agents: [makeAgentResource({ model: "claude-opus-4" })] });
    expect(rows[0]?.model).toBe(CHAT_MODEL);
    expect(rows[0]?.modelSource).toBe("fallback");
  });

  test("AC-19 exposes tools with no nax equivalent as dropped", async () => {
    const rows = await agentRows({ agents: [makeAgentResource({ tools: ["Read", "WebFetch"] })] });
    expect(rows[0]?.tools).toEqual(["Read"]);
    expect(rows[0]?.dropped).toEqual([{ name: "WebFetch", reason: "no nax equivalent" }]);
  });
});
