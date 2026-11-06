import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionEvent } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  approvalResolvedEvent,
  assertDefined,
  forwardedToolCall,
  forwardedToolResult,
  makeAgentCatalog,
  makeAgentResource,
  makeNaxConfig,
  makeScriptedSession,
  questionEvent,
  type ScriptedSession,
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  turnEndEvent,
  turnStartEvent,
  usageEvent,
  waitForCondition,
  withDepsRestore,
} from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { generalAgent } from "@/chat/builtin-agent";
import type { ChatLedger } from "@/chat/chat-ledger";
import { _subagentRunsDeps, createSubagentRuns, type SubagentRunsDeps } from "@/chat/subagent-runs";
import { _subagentSessionDeps } from "@/chat/subagent-session";

const reviewer = makeAgentResource({ name: "reviewer" });

function runsDeps(overrides: Partial<SubagentRunsDeps> & Pick<SubagentRunsDeps, "asks">): SubagentRunsDeps {
  return {
    current: () => ({ sessionId: "chat-1", mode: "guarded", model: "anthropic/chat" }),
    catalog: makeAgentCatalog([reviewer]),
    config: makeNaxConfig(),
    cwd: "/repo",
    repoRoot: "/repo",
    toolProviders: [],
    loopHandlers: [],
    ledger: () => undefined,
    turnListener: () => undefined,
    ...overrides,
  };
}

interface Fixture {
  runs: ReturnType<typeof createSubagentRuns>;
  asks: ReturnType<typeof createChatAskController>;
  nested: ScriptedSession;
  /** Resolves once the nested script has yielded every event and is holding its turn open. */
  reached: Promise<void>;
  finish(): void;
}

/** One nested session that emits `events`, then holds its turn open until `finish()`. */
function fixture(
  events: readonly SessionEvent[],
  answer: (id: string) => void = () => {},
  extra: { endCostUsd?: number; deps?: Partial<SubagentRunsDeps> } = {},
): Fixture {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const nested = makeScriptedSession("nested-1", async function* () {
    for (const event of events) yield event;
    reached.resolve();
    await gate.promise;
    yield turnEndEvent("nested done", extra.endCostUsd ?? 0);
  });
  _subagentSessionDeps.createAgentSession = async () => nested;
  _subagentSessionDeps.nativeBackend = () => ({
    kind: "native",
    async open() {
      throw new Error("unused");
    },
  });
  _subagentSessionDeps.resolveRuleSet = async () => ({
    rules: [],
    repoRulesTotal: 0,
    repoRulesMatchedPaths: 0,
    packageRulesCount: 0,
  });
  const asks = createChatAskController({ mode: "guarded", answer });
  const runs = createSubagentRuns(runsDeps({ asks, ...extra.deps }));
  return { runs, asks, nested, reached: reached.promise, finish: gate.resolve };
}

describe("createSubagentRuns", () => {
  withDepsRestore(_subagentSessionDeps);
  let pending: Promise<unknown> | undefined;
  afterEach(async () => {
    await pending;
    pending = undefined;
  });

  test("does not read the chat session at construction", () => {
    const asks = createChatAskController({ mode: "guarded", answer: () => {} });
    const runs = createSubagentRuns(
      runsDeps({
        asks,
        current: () => {
          throw new Error("no session is open");
        },
      }),
    );
    expect(runs.takeCost()).toBe(0);
  });

  test("AC-11/12 prefixes a nested approval's reason and remembers the owning session", async () => {
    const f = fixture([approvalRequestedEvent("n1", "edit file")]);
    pending = f.runs.run(reviewer, "check it");
    await f.reached;
    const ask = f.asks.pending().find((entry) => entry.requestId === "n1");
    expect(ask?.type === "approval_requested" ? ask.reason : undefined).toBe("[agent reviewer] edit file");
    expect(f.runs.sessionFor("n1")).toBe(f.nested);
    f.finish();
  });

  test("AC-16 prefixes a nested question's text", async () => {
    const f = fixture([questionEvent("q1", "which file?")]);
    pending = f.runs.run(reviewer, "check it");
    await f.reached;
    const ask = f.asks.pending().find((entry) => entry.requestId === "q1");
    expect(ask?.type === "question" ? ask.text : undefined).toBe("[agent reviewer] which file?");
    expect(f.runs.sessionFor("q1")).toBe(f.nested);
    f.finish();
  });

  test("AC-20 approval_resolved removes the request's owner", async () => {
    const f = fixture([approvalRequestedEvent("n1", "edit file"), approvalResolvedEvent("n1")]);
    pending = f.runs.run(reviewer, "check it");
    await f.reached;
    expect(f.runs.sessionFor("n1")).toBeUndefined();
    expect(f.asks.pending()).toEqual([]);
    f.finish();
  });

  test("AC-21 the nested session closing removes every request id it issued", async () => {
    const f = fixture([approvalRequestedEvent("n1", "edit file"), questionEvent("q1", "which file?")]);
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    expect(f.runs.sessionFor("n1")).toBe(f.nested);
    expect(f.runs.sessionFor("q1")).toBe(f.nested);
    f.finish();
    await running;
    expect(f.nested.closeCalls).toBe(1);
    expect(f.runs.sessionFor("n1")).toBeUndefined();
    expect(f.runs.sessionFor("q1")).toBeUndefined();
  });

  test("completion removes the nested session's unresolved asks but keeps the parent's", async () => {
    const answers: string[] = [];
    const f = fixture([approvalRequestedEvent("n1", "edit file"), questionEvent("q1", "which file?")], (id) =>
      answers.push(id),
    );
    f.asks.handle(approvalRequestedEvent("p1", "chat asks"));
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    expect(f.asks.pending().map((ask) => ask.requestId)).toEqual(["p1", "n1", "q1"]);
    f.finish();
    await running;
    expect(f.asks.pending().map((ask) => ask.requestId)).toEqual(["p1"]);
    f.asks.answerQuestion("q1", "a.ts");
    f.asks.resolve("n1", "allow_once");
    expect(answers).toEqual([]);
  });

  test("registers ownership before the ask controller can answer synchronously", async () => {
    const owners: (AgentSession | undefined)[] = [];
    let owner: (id: string) => AgentSession | undefined = () => undefined;
    const f = fixture([approvalRequestedEvent("n2", "edit file")]);
    const asks = createChatAskController({
      mode: "full",
      answer: (id) => {
        owners.push(owner(id));
      },
    });
    const runs = createSubagentRuns(
      runsDeps({ asks, current: () => ({ sessionId: "chat-1", mode: "full", model: "anthropic/chat" }) }),
    );
    owner = (id) => runs.sessionFor(id);
    pending = runs.run(reviewer, "check it");
    await f.reached;
    await waitForCondition(() => owners.length > 0);
    expect(owners).toEqual([f.nested]);
    f.finish();
  });

  test("cancelAll cancels a running nested session and closeAll closes it", async () => {
    const f = fixture([]);
    pending = f.runs.run(reviewer, "check it");
    await f.reached;
    f.runs.cancelAll();
    expect(f.nested.cancelCalls).toBe(1);
    f.finish();
    await pending;
    await f.runs.closeAll();
    expect(f.nested.closeCalls).toBe(1);
  });
});

function recordingLedger(): { ledger: ChatLedger; record: ReturnType<typeof mock<ChatLedger["record"]>> } {
  const record = mock<ChatLedger["record"]>(() => {});
  return { ledger: { record, drain: async () => {} }, record };
}

describe("createSubagentRuns usage, cost and tool events", () => {
  withDepsRestore(_subagentSessionDeps);

  test("AC-3/4/5/6 records nested usage on the chat session id with the agent's model, role and turn start", async () => {
    const { ledger, record } = recordingLedger();
    const startAt = "2026-10-01T00:00:00.500Z";
    const usage = usageEvent("2026-10-01T00:00:01.000Z");
    const f = fixture([turnStartEvent(startAt), usage], () => {}, { deps: { ledger: () => ledger } });
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    await running;
    expect(record).toHaveBeenCalledTimes(1);
    const [event, previousAt, model, role] = record.mock.calls[0] ?? [];
    expect(event).toMatchObject({ type: "usage", at: usage.at, costUsd: 0.1, sessionId: "chat-1" });
    expect(model).toBe("anthropic/chat");
    expect(role).toBe("subagent");
    expect(previousAt).toBe(startAt);
  });

  test("a second usage in the same nested turn uses the previous usage's time", async () => {
    const { ledger, record } = recordingLedger();
    const first = usageEvent("2026-10-01T00:00:01.000Z");
    const second = usageEvent("2026-10-01T00:00:03.000Z");
    const f = fixture([turnStartEvent("2026-10-01T00:00:00.500Z"), first, second], () => {}, {
      deps: { ledger: () => ledger },
    });
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    await running;
    expect(record.mock.calls.map((call) => call[1])).toEqual(["2026-10-01T00:00:00.500Z", first.at]);
  });

  test("usage without a ledger is dropped without throwing", async () => {
    const f = fixture([usageEvent()]);
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    expect((await running).isError).toBeUndefined();
    expect(f.runs.takeCost()).toBe(0);
  });

  test("AC-7/8 takeCost returns the nested turn_end cost once, then 0", async () => {
    const f = fixture([usageEvent()], () => {}, { endCostUsd: 0.4 });
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    await running;
    expect(f.runs.takeCost()).toBe(0.4);
    expect(f.runs.takeCost()).toBe(0);
  });

  test("usage rows do not add to takeCost", async () => {
    const f = fixture([usageEvent(undefined, 0.9)], () => {}, { endCostUsd: 0.4 });
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    await running;
    expect(f.runs.takeCost()).toBe(0.4);
  });

  test("forwards only tool_call and tool_result to the turn listener", async () => {
    const seen: SessionEvent[] = [];
    const call = toolCallEvent();
    const result = toolResultEvent();
    const f = fixture([turnStartEvent(), textDeltaEvent(), call, usageEvent(), result], () => {}, {
      deps: { turnListener: () => (event) => seen.push(event) },
    });
    const running = f.runs.run(reviewer, "check it");
    await f.reached;
    f.finish();
    await running;
    expect(seen.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
    const forwardedCall = forwardedToolCall(seen, call.callId);
    const forwardedResult = forwardedToolResult(seen, result.callId);
    assertDefined(forwardedCall, "forwarded tool_call");
    assertDefined(forwardedResult, "forwarded tool_result");
    // The tags are additive: the tool-activity fields are the originating fixture's.
    expect(forwardedCall.name).toBe(call.name);
    expect(forwardedResult.isError).toBe(result.isError);
    expect(forwardedCall.metadata).toEqual({ subagent: reviewer.qualifiedName, subagentTask: "check it" });
    expect(forwardedResult.metadata).toEqual({ subagent: reviewer.qualifiedName, subagentTask: "check it" });
  });
});

describe("SubagentRuns.run model override", () => {
  withDepsRestore(_subagentRunsDeps);
  const haiku = makeAgentResource({ name: "haiku-agent", model: "haiku" });

  function setup(config = makeNaxConfig()) {
    const runSubagent = mock(async (_input: { model: string }) => ({ content: "ok" }));
    _subagentRunsDeps.runSubagent = runSubagent as unknown as typeof _subagentRunsDeps.runSubagent; // test-ratchet-allow: as-unknown-as
    const asks = createChatAskController({ mode: "guarded", answer: () => {} });
    return { runSubagent, runs: createSubagentRuns(runsDeps({ asks, config })) };
  }

  test.each([
    ["AC-7", "openai-codex/gpt-6-luna", "openai-codex/gpt-6-luna"],
    ["AC-8", "acp:codex", "acp:codex"],
  ])("%s passes %s through", async (_ac, requested, expected) => {
    const { runSubagent, runs } = setup();
    await runs.run(haiku, "t", undefined, requested);
    expect(runSubagent.mock.calls[0]?.[0].model).toBe(expected);
  });

  test("AC-9 a tier name resolves through models.native", async () => {
    const config = makeNaxConfig({ models: { native: { balanced: "openai/gpt-x" } } });
    const { runSubagent, runs } = setup(config);
    await runs.run(haiku, "t", undefined, "sonnet");
    expect(runSubagent.mock.calls[0]?.[0].model).toBe("openai/gpt-x");
  });

  test("AC-10 an unresolvable override is refused before any session", async () => {
    const { runSubagent, runs } = setup();
    const result = await runs.run(haiku, "t", undefined, "gpt-6-luna");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] unknown model gpt-6-luna");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("AC-11 without an override the frontmatter model resolves", async () => {
    const config = makeNaxConfig({ models: { native: { fast: "openai/fast-x" } } });
    const { runSubagent, runs } = setup(config);
    await runs.run(haiku, "t");
    expect(runSubagent.mock.calls[0]?.[0].model).toBe("openai/fast-x");
  });

  // The general agent has no model: of its own, so an unresolvable override on it is
  // refused exactly like one on a catalog agent — no nested session is opened.
  test("AC-13 a refused override on the general agent returns an error naming the model", async () => {
    const { runs } = setup();
    const result = await runs.run(generalAgent(), "t", undefined, "bogus");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] unknown model bogus");
  });

  test("AC-14 a refused override on the general agent never calls the injected runSubagent", async () => {
    const { runSubagent, runs } = setup();
    await runs.run(generalAgent(), "t", undefined, "bogus");
    expect(runSubagent).not.toHaveBeenCalled();
  });
});

describe("SubagentRuns.modelFor", () => {
  const asks = () => createChatAskController({ mode: "guarded", answer: () => {} });
  const make = () => createSubagentRuns(runsDeps({ asks: asks() }));

  test("AC-11 an agent without a model resolves to the parent session's model, labelled inherited", () => {
    expect(make().modelFor("reviewer")).toEqual({ model: "anthropic/chat", label: "inherited" });
  });

  test("AC-12 an explicit provider/model override is returned, labelled override", () => {
    expect(make().modelFor("reviewer", "openai-codex/gpt-6-luna")).toEqual({
      model: "openai-codex/gpt-6-luna",
      label: "override",
    });
  });

  // An absent name is the general agent, never a catalog lookup: `nax-agents__run`
  // with a model and no agent has no agent file to run on.
  test("AC-10 an absent agent name resolves against the general agent", () => {
    expect(make().modelFor(undefined, "openai/gpt-x")).toEqual({ model: "openai/gpt-x", label: "override" });
  });

  test("AC-21 an unknown agent returns undefined", () => {
    expect(make().modelFor("nobody")).toBeUndefined();
  });

  test("AC-22 a refused override returns undefined", () => {
    expect(make().modelFor("reviewer", "gpt-6-luna")).toBeUndefined();
  });
});
