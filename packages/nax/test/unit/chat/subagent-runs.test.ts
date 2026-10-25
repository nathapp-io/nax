import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionEvent } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  approvalResolvedEvent,
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
import type { ChatLedger } from "@/chat/chat-ledger";
import { createSubagentRuns, type SubagentRunsDeps } from "@/chat/subagent-runs";
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
    expect(seen).toEqual([call, result]);
  });
});
