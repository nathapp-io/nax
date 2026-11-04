import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionEvent, ToolProvider } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  assertDefined,
  CHAT_MODEL,
  forwardedToolCall,
  forwardedToolResult,
  makeAgentResource,
  makeSubagentHostHarness,
  questionEvent,
  type SubagentHostHarness,
  type SubagentHostOptions,
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  turnStartEvent,
  usageEvent,
  waitForCondition,
} from "@test/helpers";
import type { AgentResource } from "@/resources";

const reviewer = makeAgentResource({ name: "reviewer" });
/** The task the harness's scripted chat turn hands the `run` tool unless a test overrides it. */
const DEFAULT_TASK = "check it";
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
    expect(h.chatBackends.at(-1)?.toolProviders?.slice(0, -1)).toEqual([...h.resources.toolProviders]);
    expect(h.chatBackends.at(-1)?.toolProviders?.at(-1)?.id).toBe("nax-tasks");
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

  test("AC-8 a guarded host opens the nested session with profile full", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.nestedSessionOptions.map((options) => options.profile)).toEqual(["full"]);
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

async function subagentRows(h: SubagentHostHarness): Promise<Record<string, unknown>[]> {
  const cost = join(h.config.outputDir ?? "", "cost");
  const rows: Record<string, unknown>[] = [];
  for (const file of new Bun.Glob("*.jsonl").scanSync({ cwd: cost })) {
    const text = await Bun.file(join(cost, file)).text();
    for (const line of text.trim().split("\n")) rows.push(JSON.parse(line));
  }
  return rows.filter((row) => row.sessionRole === "subagent");
}

async function spent(h: SubagentHostHarness): Promise<number> {
  return h.host.current().meta.costUsd ?? 0;
}

describe("chat host nested usage, spend and tool events", () => {
  test("nested usage reaches the ledger as a subagent row on the chat session id", async () => {
    const h = setup({
      agents: [reviewer],
      nestedEvents: [turnStartEvent("2026-10-01T00:00:00.000Z"), usageEvent("2026-10-01T00:00:02.000Z", 0.3)],
    });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const chatId = h.host.current().sessionId;
    await h.host.send("go", () => {});
    await h.host.close();
    const rows = await subagentRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionRole: "subagent", costUsd: 0.3, durationMs: 2000 });
    expect(rows[0]?.runId).toContain(`chat-${chatId}-`);
  });

  test("AC-11 nested and chat turn spend both reach the session metadata", async () => {
    const h = setup({ agents: [reviewer], nestedCostUsd: 0.4, chatCostUsd: 1 });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const before = await spent(h);
    await h.host.send("go", () => {});
    expect((await spent(h)) - before).toBeCloseTo(1.4);
  });

  test("forwards nested tool events to the send's onEvent but not text", async () => {
    const call = toolCallEvent();
    const result = toolResultEvent();
    const h = setup({ agents: [reviewer], nestedEvents: [textDeltaEvent(), call, result] });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const seen: SessionEvent[] = [];
    await h.host.send("go", (event) => seen.push(event));
    const delivered = forwardedToolCall(seen, call.callId);
    const deliveredResult = forwardedToolResult(seen, result.callId);
    assertDefined(delivered, "forwarded tool_call");
    assertDefined(deliveredResult, "forwarded tool_result");
    // AC-15: the tags are additive — the tool-activity fields are the fixture's own.
    expect(delivered.name).toBe(call.name);
    expect(deliveredResult.isError).toBe(result.isError);
    expect(delivered.metadata.subagentTask).toBe(DEFAULT_TASK);
    expect(seen.some((event) => event.type === "text_delta")).toBe(false);
  });

  test("AC-15 nested spend from a send that threw is not added to the next send", async () => {
    const h = setup({ agents: [reviewer], nestedCostUsd: 0.4, chatThrows: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await expect(h.host.send("go", () => {})).rejects.toThrow("chat send failed");
    h.control.chatThrows = false;
    h.control.skipRun = true;
    h.control.chatCostUsd = 1;
    const before = await spent(h);
    await h.host.send("again", () => {});
    expect((await spent(h)) - before).toBeCloseTo(1);
  });
});

describe("chat host overlapping sends", () => {
  test("a busy-rejected send keeps the active send's nested spend", async () => {
    const h = setup({ agents: [reviewer], nestedCostUsd: 0.4, chatCostUsd: 1, holdChat: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const before = await spent(h);
    const first = h.host.send("go", () => {});
    await waitForCondition(() => h.nestedSessions[0]?.closeCalls === 1);
    await expect(h.host.send("again", () => {})).rejects.toThrow();
    h.releaseChat();
    await first;
    expect((await spent(h)) - before).toBeCloseTo(1.4);
  });

  test("a busy-rejected send keeps the active send's tool listener", async () => {
    const lateCall = toolCallEvent("late");
    const h = setup({
      agents: [reviewer],
      holdNested: true,
      nestedLateEvents: [lateCall],
    });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const seen: SessionEvent[] = [];
    const first = h.host.send("go", (event) => seen.push(event));
    await waitForCondition(() => h.nestedSessions.length > 0);
    await expect(h.host.send("again", () => {})).rejects.toThrow();
    h.releaseNested();
    await first;
    const delivered = forwardedToolCall(seen, lateCall.callId);
    assertDefined(delivered, "forwarded late tool_call");
    expect(delivered.name).toBe(lateCall.name);
    expect(delivered.metadata.subagentTask).toBe(DEFAULT_TASK);
  });
});

describe("chat host nested cancel and close", () => {
  test("AC-16 host.cancel() cancels the running nested session", async () => {
    const { h, sending } = await sendWithNested([]);
    h.host.cancel();
    expect(h.nestedSessions[0]?.cancelCalls).toBeGreaterThan(0);
    await sending;
  });

  test("AC-17 host.close() resolves only after the nested session's close resolved", async () => {
    const h = setup({ agents: [reviewer], holdNested: true, holdNestedClose: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const sending = h.host.send("go", () => {}).catch(() => {});
    await waitForCondition(() => h.nestedSessions.length > 0);
    h.releaseNested();
    await waitForCondition(() => h.nestedSessions[0]?.closeCalls === 1);
    let closed = false;
    const closing = h.host.close().then(() => {
      closed = true;
    });
    // closeAll asks the still-closing nested session to close again, then waits on it.
    await waitForCondition(() => (h.nestedSessions[0]?.closeCalls ?? 0) >= 2);
    expect(closed).toBe(false);
    expect(h.chatSessions[0]?.closeCalls).toBe(0);
    h.releaseNestedClose();
    await closing;
    expect(closed).toBe(true);
    expect(h.chatSessions[0]?.closeCalls).toBe(1);
    await sending;
  });

  test("AC-18 a subagent cancelled by host.cancel() is closed before the send settles", async () => {
    const h = setup({ agents: [reviewer], holdNested: true, nestedStatus: "cancelled" });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const sending = h.host.send("go", () => {});
    await waitForCondition(() => h.nestedSessions.length > 0);
    h.host.cancel();
    await sending;
    expect(h.nestedSessions[0]?.closeCalls).toBe(1);
  });

  test("a send whose tool batch abandons the nested run waits for it, so its late spend and events stay out of the next send", async () => {
    const lateCall = toolCallEvent("late");
    const h = setup({
      agents: [reviewer],
      holdNested: true,
      holdNestedPastCancel: true,
      abandonToolOnAbort: true,
      nestedLateEvents: [lateCall],
      nestedCostUsd: 0.4,
    });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const beforeFirst = await spent(h);
    const firstSeen: SessionEvent[] = [];
    let settled = false;
    const first = h.host
      .send("go", (event) => firstSeen.push(event))
      .finally(() => {
        settled = true;
      });
    await waitForCondition(() => h.nestedSessions.length > 0 && h.turnSignal() !== undefined);
    h.abortTurn();
    h.host.cancel();
    await waitForCondition(() => h.toolResults.length > 0);
    // The chat turn already stopped waiting for the tool; the nested turn is still running.
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.nestedSessions[0]?.closeCalls).toBe(0);
    h.releaseNested();
    await first;
    expect(h.nestedSessions[0]?.closeCalls).toBe(1);
    // The cancelled turn keeps the spend its abandoned nested run finished with late.
    expect((await spent(h)) - beforeFirst).toBeCloseTo(0.4);

    h.control.skipRun = true;
    h.control.chatCostUsd = 1;
    const nextSeen: SessionEvent[] = [];
    const before = (await spent(h)) ?? 0;
    await h.host.send("again", (event) => nextSeen.push(event));
    expect((await spent(h)) - before).toBeCloseTo(1);
    expect(forwardedToolCall(nextSeen, lateCall.callId)).toBeUndefined();
    const firstLate = forwardedToolCall(firstSeen, lateCall.callId);
    assertDefined(firstLate, "forwarded late tool_call");
    expect(firstLate.name).toBe(lateCall.name);
    expect(firstLate.metadata.subagentTask).toBe(DEFAULT_TASK);
  });
});

describe("chat host forwarded subagent event tags", () => {
  const TASK = "scan";

  /** Send one turn whose nested session emits `events`, collecting what the turn listener saw. */
  async function forwarded(events: readonly SessionEvent[], agent = reviewer): Promise<SessionEvent[]> {
    const h = setup({ agents: [agent], task: TASK, nestedEvents: events });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const seen: SessionEvent[] = [];
    await h.host.send("go", (event) => seen.push(event));
    return seen;
  }

  test("AC-11 AC-12 a forwarded nested tool_call is tagged with the task and the agent's qualified name", async () => {
    const call = toolCallEvent();
    const seen = await forwarded([call]);
    const delivered = forwardedToolCall(seen, call.callId);
    assertDefined(delivered, "forwarded tool_call");
    expect(delivered.metadata.subagentTask).toBe(TASK);
    expect(delivered.metadata.subagent).toBe(reviewer.qualifiedName);
  });

  test("AC-13 a forwarded nested tool_result carries the same task and agent tags", async () => {
    const result = toolResultEvent();
    const seen = await forwarded([result]);
    const delivered = forwardedToolResult(seen, result.callId);
    assertDefined(delivered, "forwarded tool_result");
    expect(delivered.metadata.subagentTask).toBe(TASK);
    expect(delivered.metadata.subagent).toBe(reviewer.qualifiedName);
  });

  test("AC-14 the nested event's own metadata is kept alongside the tags", async () => {
    const call = { ...toolCallEvent(), metadata: { k: "v" } };
    const seen = await forwarded([call]);
    const delivered = forwardedToolCall(seen, call.callId);
    assertDefined(delivered, "forwarded tool_call");
    expect(delivered.metadata).toEqual({ k: "v", subagent: reviewer.qualifiedName, subagentTask: TASK });
  });
});

const CODEX_ALIAS = "acp:codex/gpt-6.1-terra";

/** An agent file that names its model through `agent.modelAliases`; `tools:` stays absent when undefined. */
function acpAgent(tools?: readonly string[]): AgentResource {
  return makeAgentResource({ name: "reviewer", model: "reviewer", ...(tools !== undefined ? { tools } : {}) });
}

function scriptedProvider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["*"], tools: async () => [] };
}

/** Start a guarded chat turn whose `run` tool resolves to the given agent, and let it finish. */
async function runThroughTool(options: SubagentHostOptions): Promise<SubagentHostHarness> {
  const h = setup(options);
  await h.host.start({ mode: "guarded", model: CHAT_MODEL });
  await h.host.send("go", () => {});
  return h;
}

describe("chat host ACP subagents", () => {
  test("AC-1 an alias resolving to acp:codex opens one ACP session with profile review", async () => {
    const h = await runThroughTool({
      agents: [acpAgent(["Read", "Grep"])],
      modelAliases: { reviewer: CODEX_ALIAS },
    });
    expect(h.acpBackendCalls).toHaveLength(1);
    expect(h.acpBackendCalls[0]).toMatchObject({ agent: "codex", model: "gpt-6.1-terra" });
    expect(h.nestedSessionOptions.map((options) => options.profile)).toEqual(["review"]);
    // The native transport is untouched by an ACP subagent.
    expect(h.nestedBackends).toHaveLength(0);
  });

  test("AC-2 agent.acpSubagents.profile overrides the derived read-only profile", async () => {
    const h = await runThroughTool({
      agents: [acpAgent(["Read", "Grep"])],
      modelAliases: { reviewer: CODEX_ALIAS },
      acpSubagents: { profile: "ask" },
    });
    expect(h.nestedSessionOptions.map((options) => options.profile)).toEqual(["ask"]);
    expect(h.acpBackendCalls).toHaveLength(1);
  });

  test("AC-3 a read-only cursor subagent is refused and creates no nested session", async () => {
    const h = await runThroughTool({
      agents: [acpAgent(["Read"])],
      modelAliases: { reviewer: "acp:cursor" },
    });
    const result = h.toolResults[0];
    assertDefined(result, "run tool result");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not start read-only: Cursor has no read-only enforcement of its own");
    expect(h.nestedSessionOptions).toHaveLength(0);
    expect(h.acpBackendCalls).toHaveLength(0);
  });

  test("AC-4 the delivered provider list excludes nax-jobs rather than narrowing everything away", async () => {
    const h = await runThroughTool({
      agents: [acpAgent()],
      modelAliases: { reviewer: CODEX_ALIAS },
      toolProviders: [scriptedProvider("nax-workflow"), scriptedProvider("nax-jobs"), scriptedProvider("nax-memory")],
    });
    expect(h.acpBackendCalls).toHaveLength(1);
    const delivered = h.acpToolProviders.at(-1);
    assertDefined(delivered, "chatAcpTools providers");
    expect(delivered.map((provider) => provider.id)).toEqual(["nax-workflow", "nax-memory"]);
  });

  test("AC-5 an unpriced nested ACP usage event reaches the ledger as an estimated subagent row", async () => {
    const h = await runThroughTool({
      agents: [acpAgent(["Read", "Grep"])],
      modelAliases: { reviewer: CODEX_ALIAS },
      nestedEvents: [turnStartEvent("2026-10-01T00:00:00.000Z"), usageEvent("2026-10-01T00:00:02.000Z", 0, "unpriced")],
    });
    expect(h.acpBackendCalls).toHaveLength(1);
    await h.host.close();
    const rows = await subagentRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionRole: "subagent", confidence: "estimated", costUsd: 0 });
  });

  test("AC-6 a native provider/model opens the native nested backend and never the ACP one", async () => {
    const h = await runThroughTool({
      agents: [acpAgent(["Read"])],
      modelAliases: { reviewer: "anthropic/claude-sonnet-5-5" },
    });
    expect(h.nestedBackends.map((options) => options.model)).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(h.acpBackendCalls).toHaveLength(0);
  });
});

describe("usageEvent costSource", () => {
  test("AC-7 costSource is computed when the argument is omitted", () => {
    expect(usageEvent()).toMatchObject({ type: "usage", costSource: "computed" });
  });

  test("the costSource argument overrides the computed default", () => {
    expect(usageEvent("2026-10-01T00:00:02.000Z", 0, "unpriced")).toMatchObject({
      costSource: "unpriced",
      costUsd: 0,
    });
  });
});
