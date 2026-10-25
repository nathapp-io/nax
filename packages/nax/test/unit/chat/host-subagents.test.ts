import { afterEach, describe, expect, test } from "bun:test";
import {
  approvalRequestedEvent,
  CHAT_MODEL,
  makeAgentResource,
  makeSubagentHostHarness,
  questionEvent,
  type SubagentHostHarness,
  type SubagentHostOptions,
  waitForCondition,
} from "@test/helpers";

const reviewer = makeAgentResource({ name: "reviewer" });
let harness: SubagentHostHarness | undefined;

function setup(options: SubagentHostOptions = { agents: [reviewer] }): SubagentHostHarness {
  harness = makeSubagentHostHarness(options);
  return harness;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function lastProviderId(h: SubagentHostHarness): string | undefined {
  return h.chatBackends.at(-1)?.toolProviders?.at(-1)?.id;
}

describe("chat host agents provider composition", () => {
  test("AC-1 start attaches the nax-agents provider last", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    expect(lastProviderId(h)).toBe("nax-agents");
  });

  test("AC-2 start passes the resources' own providers when the catalog has no agents", async () => {
    const h = setup({ agents: [] });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    expect(h.chatBackends.at(-1)?.toolProviders).toBe(h.resources.toolProviders);
  });

  test("AC-3 resume attaches the nax-agents provider last", async () => {
    const h = setup();
    await h.storeSession("prior");
    await h.host.resume({ id: "prior" });
    expect(h.chatBackends).toHaveLength(1);
    expect(lastProviderId(h)).toBe("nax-agents");
  });

  test("AC-4 switching mode reopens with the nax-agents provider last", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.switchTo({ mode: "full" });
    expect(h.chatBackends).toHaveLength(2);
    expect(lastProviderId(h)).toBe("nax-agents");
  });
});

describe("chat host nested session options", () => {
  test("AC-5 resolves the agent's model through agent.modelAliases", async () => {
    const h = setup({
      agents: [makeAgentResource({ name: "reviewer", model: "sonnet" })],
      modelAliases: { sonnet: "anthropic/claude-sonnet-5-5" },
    });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedBackends.map((options) => options.model)).toEqual(["anthropic/claude-sonnet-5-5"]);
  });

  test("an agent without a model inherits the chat session's model", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedBackends.map((options) => options.model)).toEqual([CHAT_MODEL]);
  });

  test("AC-6 maps the agent's tools into allowedTools", async () => {
    const h = setup({ agents: [makeAgentResource({ name: "reviewer", tools: ["Read", "WebFetch"] })] });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedBackends.map((options) => options.allowedTools)).toEqual([["Read"]]);
  });

  test("AC-7 the nested backend never receives the nax-agents provider", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedBackends).toHaveLength(1);
    const ids = h.nestedBackends[0]?.toolProviders?.map((provider) => provider.id);
    expect(ids).toEqual(["base"]);
  });

  test("AC-8 a guarded host opens the nested session with profile ask", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedSessionOptions.map((options) => options.profile)).toEqual(["ask"]);
  });

  test("AC-9 after switching to full the nested session opens with profile full", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.switchTo({ mode: "full" });
    await h.host.send("go", () => {});
    expect(h.nestedSessionOptions.map((options) => options.profile)).toEqual(["full"]);
  });

  test("AC-10 aborting the turn's signal cancels the nested session", async () => {
    const h = setup({ agents: [reviewer], holdNested: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const sending = h.host.send("go", () => {});
    await waitForCondition(() => h.nestedSessions.length > 0 && h.turnSignal() !== undefined);
    expect(h.nestedSessions[0]?.cancelCalls).toBe(0);
    h.abortTurn();
    await sending;
    expect(h.nestedSessions[0]?.cancelCalls).toBeGreaterThan(0);
  });
});

/** Start a send whose nested session emits `events` and then waits for the test to release it. */
async function sendWithNested(
  events: NonNullable<SubagentHostOptions["nestedEvents"]>,
  mode: "guarded" | "full" = "guarded",
) {
  const h = setup({ agents: [reviewer], nestedEvents: events, holdNested: true });
  await h.host.start({ mode: "guarded", model: CHAT_MODEL });
  if (mode === "full") await h.host.switchTo({ mode: "full" });
  const sending = h.host.send("go", () => {});
  await waitForCondition(() => h.nestedSessions.length > 0);
  return { h, sending };
}

describe("chat host nested asks", () => {
  test("AC-13/14 resolving a nested approval answers the nested session, not the chat session", async () => {
    const { h, sending } = await sendWithNested([approvalRequestedEvent("n1", "edit file")]);
    await waitForCondition(() => h.host.asks.pending().some((ask) => ask.requestId === "n1"));
    h.host.asks.resolve("n1", "allow_once");
    expect(h.nestedSessions[0]?.answers).toEqual([["n1", { decision: "allow" }]]);
    expect(h.chatSessions.at(-1)?.answers).toEqual([]);
    h.releaseNested();
    await sending;
  });

  test("AC-15 resolving a chat-session ask while a nested session runs answers the chat session", async () => {
    const { h, sending } = await sendWithNested([approvalRequestedEvent("n1", "edit file")]);
    await waitForCondition(() => h.host.asks.pending().some((ask) => ask.requestId === "n1"));
    h.host.asks.handle(approvalRequestedEvent("p1", "chat asks"));
    h.host.asks.resolve("p1", "allow_once");
    expect(h.chatSessions.at(-1)?.answers).toEqual([["p1", { decision: "allow" }]]);
    expect(h.nestedSessions[0]?.answers).toEqual([]);
    h.releaseNested();
    await sending;
  });

  test("AC-17 answering a nested question answers the nested session with the text", async () => {
    const { h, sending } = await sendWithNested([questionEvent("q1", "which file?")]);
    await waitForCondition(() => h.host.asks.pending().some((ask) => ask.requestId === "q1"));
    h.host.asks.answerQuestion("q1", "a.ts");
    expect(h.nestedSessions[0]?.answers).toEqual([["q1", { text: "a.ts" }]]);
    expect(h.chatSessions.at(-1)?.answers).toEqual([]);
    h.releaseNested();
    await sending;
  });

  test("AC-18/19 full mode auto-allows a nested approval on the nested session without surfacing it", async () => {
    const { h, sending } = await sendWithNested([approvalRequestedEvent("n2", "edit file")], "full");
    await waitForCondition(() => (h.nestedSessions[0]?.answers.length ?? 0) > 0);
    expect(h.nestedSessions[0]?.answers).toEqual([["n2", { decision: "allow" }]]);
    expect(h.chatSessions.at(-1)?.answers).toEqual([]);
    expect(h.host.asks.pending()).toEqual([]);
    h.releaseNested();
    await sending;
    expect(h.host.asks.pending()).toEqual([]);
  });
});
