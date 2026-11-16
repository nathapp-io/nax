/**
 * US-007: background nested runs that outlive the turn that started them.
 *
 * The registry is the real one — `createBackgroundTasks` with its log deps stubbed — so the
 * task id, the sink and the adopted record are the ones the chat shows. Nested runs are
 * driven two ways: the real `runSubagent` over a scripted nested session when the test is
 * about the session's lifecycle, and `_subagentRunsDeps.runSubagent` when the run must
 * resolve, reject or hang on demand.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, ToolResult } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  makeAgentCatalog,
  makeAgentResource,
  makeLogger,
  makeNaxConfig,
  makeScriptedSession,
  toolCallEvent,
  turnEndEvent,
  usageEvent,
  waitForCondition,
  withDepsRestore,
} from "@test/helpers";
import { type ChatAskController, createChatAskController } from "@/chat/ask-controller";
import {
  _backgroundTaskDeps,
  type BackgroundAgentEnd,
  type BackgroundAgentHandle,
  type BackgroundAgentSink,
  createBackgroundTasks,
} from "@/chat/background";
import type { ChatLedger } from "@/chat/chat-ledger";
import { _subagentRunsDeps, createSubagentRuns, type SubagentRunsDeps } from "@/chat/subagent-runs";
import { _subagentSessionDeps, type RunSubagentInput, type RunSubagentResult } from "@/chat/subagent-session";

const reviewer = makeAgentResource({ name: "reviewer" });
const OUT_DIR = "/out";
const SINK_ID = "agent-0123abcd";
const UNKNOWN_MODEL =
  "[chat] unknown model typo; pass provider/model (a nax native model such as openai-codex/gpt-6-luna), acp:<agent>, or a configured alias";

const originalLogDeps = { ..._backgroundTaskDeps };
let logs: Map<string, string>;

beforeEach(() => {
  logs = new Map();
  Object.assign(_backgroundTaskDeps, {
    randomHex: () => "0123abcd",
    mkdir: () => {},
    appendLog: async (path: string, chunk: Uint8Array) => {
      logs.set(path, (logs.get(path) ?? "") + new TextDecoder().decode(chunk));
    },
    readLog: async (path: string) => logs.get(path) ?? "",
  });
});
afterEach(() => {
  Object.assign(_backgroundTaskDeps, originalLogDeps);
});

/** The real registry, with its `adoptAgent` spied so the handle and the sink are visible. */
function registry() {
  const tasks = createBackgroundTasks({ outputDir: OUT_DIR, now: () => new Date(0), logger: makeLogger() });
  const adopt = tasks.adoptAgent.bind(tasks);
  const lines: string[] = [];
  const appendLine = mock((line: string) => {
    lines.push(line);
  });
  const adoptAgent = mock((handle: BackgroundAgentHandle): BackgroundAgentSink => {
    adopt(handle);
    return { id: SINK_ID, appendLine };
  });
  tasks.adoptAgent = adoptAgent;
  return { tasks, adoptAgent, appendLine, lines };
}

/** Every ask the controller saw, whether it was answered or only routed. */
function askFixture() {
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const forward = asks.handle.bind(asks);
  const handled = mock((event: SessionEvent) => {
    forward(event);
  });
  asks.handle = handled;
  return { asks, handled };
}

function createRuns(overrides: Partial<SubagentRunsDeps> & { asks: ChatAskController }) {
  return createSubagentRuns({
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
  });
}

/** A nested run whose resolution the test decides; the input it received stays readable. */
function controlledRun() {
  const settled = Promise.withResolvers<RunSubagentResult>();
  let captured: RunSubagentInput | undefined;
  _subagentRunsDeps.runSubagent = mock((input: RunSubagentInput) => {
    captured = input;
    return settled.promise;
  });
  return {
    input: () => captured,
    resolve: (result: RunSubagentResult) => settled.resolve(result),
    reject: (cause: unknown) => settled.reject(cause),
  };
}

/** A nested run that never settles, exposing the signal it was handed. */
function hangingRun(onStart?: (input: RunSubagentInput) => void) {
  const never = new Promise<RunSubagentResult>(() => {});
  _subagentRunsDeps.runSubagent = mock((input: RunSubagentInput) => {
    onStart?.(input);
    return never;
  });
}

/** The real `runSubagent` over a nested session that holds its turn open until `finish()`. */
function nestedSession() {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const session = makeScriptedSession("nested-1", async function* () {
    reached.resolve();
    await gate.promise;
    yield turnEndEvent("nested done", 0);
  });
  _subagentSessionDeps.createAgentSession = async () => session;
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
  return { session, reached: reached.promise, finish: gate.resolve };
}

function recordingLedger(): { ledger: ChatLedger; record: ReturnType<typeof mock<ChatLedger["record"]>> } {
  const record = mock<ChatLedger["record"]>(() => {});
  return { ledger: { record, drain: async () => {} }, record };
}

function taskIdOf(result: ToolResult): string {
  return result.content.replace("started in the background as ", "");
}

describe("SubagentRuns.runInBackground", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("AC-1 adopts the run under the agent's qualified name and returns the task id", async () => {
    const reg = registry();
    hangingRun();
    const { asks } = askFixture();
    const result = await createRuns({ asks, backgroundTasks: () => reg.tasks }).runInBackground(reviewer, "check it");
    expect(result).toEqual({ isError: false, content: `started in the background as ${SINK_ID}` });
    expect(reg.adoptAgent).toHaveBeenCalledTimes(1);
    const handle = reg.adoptAgent.mock.calls[0]?.[0];
    expect(handle?.agent).toBe(reviewer.qualifiedName);
    expect(handle?.task).toBe("check it");
  });

  test("AC-2 resolves while the nested run never resolves", async () => {
    const reg = registry();
    hangingRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    expect((await runs.runInBackground(reviewer, "check it")).isError).toBe(false);
  });

  test("AC-3 a chat with no registry refuses and starts nothing", async () => {
    const runSubagent = mock(async (_input: RunSubagentInput) => ({ content: "ok" }));
    _subagentRunsDeps.runSubagent = runSubagent;
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => undefined });
    expect(await runs.runInBackground(reviewer, "check it")).toEqual({
      isError: true,
      content: "[chat] runInBackground is not available in this chat",
    });
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("AC-4 a refused model override returns the unknown-model result and adopts nothing", async () => {
    const reg = registry();
    const runSubagent = mock(async (_input: RunSubagentInput) => ({ content: "ok" }));
    _subagentRunsDeps.runSubagent = runSubagent;
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    expect(await runs.runInBackground(reviewer, "check it", "typo")).toEqual({
      isError: true,
      content: UNKNOWN_MODEL,
    });
    expect(reg.adoptAgent).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
  });
});

describe("SubagentRuns background runs and turn end", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("AC-5 settle() leaves a background run's signal unaborted", async () => {
    const reg = registry();
    let signal: AbortSignal | undefined;
    hangingRun((input) => {
      signal = input.signal;
    });
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    await runs.settle();
    await waitForCondition(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);
  });

  test("AC-6 settle() does not cancel a background run's open session", async () => {
    const reg = registry();
    const nested = nestedSession();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    await nested.reached;
    await runs.settle();
    expect(nested.session.cancelCalls).toBe(0);
    nested.finish();
  });

  test("AC-7 cancelAll() leaves a background run's signal unaborted", async () => {
    const reg = registry();
    let signal: AbortSignal | undefined;
    hangingRun((input) => {
      signal = input.signal;
    });
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    await waitForCondition(() => signal !== undefined);
    runs.cancelAll();
    expect(signal?.aborted).toBe(false);
  });
});

describe("SubagentRuns background run end states", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("AC-8 stopping after the session opened cancels that session once", async () => {
    const reg = registry();
    const nested = nestedSession();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    const id = taskIdOf(await runs.runInBackground(reviewer, "check it"));
    await nested.reached;
    reg.tasks.stop(id);
    expect(nested.session.cancelCalls).toBe(1);
    nested.finish();
  });

  test("AC-9 after stop() the run's ended resolves stopped", async () => {
    const reg = registry();
    hangingRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    const id = taskIdOf(await runs.runInBackground(reviewer, "check it"));
    const handle = reg.adoptAgent.mock.calls[0]?.[0];
    reg.tasks.stop(id);
    const end: BackgroundAgentEnd | undefined = await handle?.ended;
    expect(end?.outcome).toBe("stopped");
  });

  test("AC-10 stopping before the session opened aborts the run's signal", async () => {
    const reg = registry();
    let signal: AbortSignal | undefined;
    hangingRun((input) => {
      signal = input.signal;
    });
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    const id = taskIdOf(await runs.runInBackground(reviewer, "check it"));
    await waitForCondition(() => signal !== undefined);
    reg.tasks.stop(id);
    expect(signal?.aborted).toBe(true);
  });

  test("AC-11 a completed run ends succeeded with its text", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    const handle = reg.adoptAgent.mock.calls[0]?.[0];
    run.resolve({ content: "No findings." });
    expect(await handle?.ended).toEqual({ outcome: "succeeded", text: "No findings." });
  });

  test("AC-12 an error result ends failed with its content", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    const handle = reg.adoptAgent.mock.calls[0]?.[0];
    run.resolve({ isError: true, content: "bad input" });
    expect(await handle?.ended).toEqual({ outcome: "failed", text: "bad input" });
  });

  test("AC-13 a rejected run ends failed with the rejection's message", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    const handle = reg.adoptAgent.mock.calls[0]?.[0];
    run.reject(new Error("boom"));
    expect(await handle?.ended).toEqual({ outcome: "failed", text: "boom" });
  });
});

describe("SubagentRuns background run activity", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("AC-14 a tool_call appends [tool] Read through the sink", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    run.input()?.onEvent(toolCallEvent("c1"));
    expect(reg.appendLine).toHaveBeenCalledWith("[tool] Read");
    expect(reg.lines).toEqual(["[tool] Read"]);
  });

  test("AC-15 a tool_call never reaches the turn listener", async () => {
    const reg = registry();
    const run = controlledRun();
    const listener = mock((_event: SessionEvent) => {});
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks, turnListener: () => listener });
    await runs.runInBackground(reviewer, "check it");
    run.input()?.onEvent(toolCallEvent("c1"));
    expect(listener).not.toHaveBeenCalled();
  });

  test("AC-16 a usage event is recorded on the ledger as a subagent's", async () => {
    const reg = registry();
    const run = controlledRun();
    const { ledger, record } = recordingLedger();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks, ledger: () => ledger });
    await runs.runInBackground(reviewer, "check it");
    run.input()?.onEvent(usageEvent());
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[3]).toBe("subagent");
  });
});

describe("SubagentRuns background asks", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("AC-17 a background approval reaches the asks and owns its request id", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks, handled } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    const session = makeScriptedSession("nested-1", async function* () {});
    run.input()?.onSession?.(session);
    run.input()?.onEvent(approvalRequestedEvent("n1", "edit file"));
    const asked = handled.mock.calls.map(([event]) => event);
    expect(asked.some((event) => event.type === "approval_requested" && event.requestId === "n1")).toBe(true);
    expect(runs.sessionFor("n1")).toBe(session);
  });

  test("AC-18 stopping releases a pending approval as denied by cancellation", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks, handled } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    const id = taskIdOf(await runs.runInBackground(reviewer, "check it"));
    run.input()?.onSession?.(makeScriptedSession("nested-1", async function* () {}));
    run.input()?.onEvent(approvalRequestedEvent("n1", "edit file"));
    reg.tasks.stop(id);
    const resolved = handled.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "approval_resolved" && event.requestId === "n1");
    expect(resolved?.type === "approval_resolved" ? resolved.decision : undefined).toBe("deny");
    expect(resolved?.type === "approval_resolved" ? resolved.decidedBy : undefined).toBe("cancelled");
  });

  test("AC-19 closeAll() closes a background run's open session", async () => {
    const reg = registry();
    const nested = nestedSession();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    await nested.reached;
    await runs.closeAll();
    expect(nested.session.closeCalls).toBe(1);
    nested.finish();
  });

  test("B2 stopping a run leaves its session owned, so closeAll still closes it", async () => {
    const reg = registry();
    const nested = nestedSession();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    const id = taskIdOf(await runs.runInBackground(reviewer, "check it"));
    await nested.reached;
    reg.tasks.stop(id);
    expect(nested.session.cancelCalls).toBe(1);
    // The stop answers its asks at once; it does not hand the session back to the chat.
    await runs.closeAll();
    expect(nested.session.closeCalls).toBe(1);
    nested.finish();
  });

  test("B2 closeAll() aborts a run whose session has not opened", async () => {
    const reg = registry();
    let signal: AbortSignal | undefined;
    hangingRun((input) => {
      signal = input.signal;
    });
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    await waitForCondition(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);
    await runs.closeAll();
    expect(signal?.aborted).toBe(true);
  });
});

describe("SubagentRuns background spend", () => {
  withDepsRestore(_subagentRunsDeps);
  withDepsRestore(_subagentSessionDeps);

  test("B1 background spend is never the turn's, and only a commit retires it", async () => {
    const reg = registry();
    const run = controlledRun();
    const { asks } = askFixture();
    const runs = createRuns({ asks, backgroundTasks: () => reg.tasks });
    await runs.runInBackground(reviewer, "check it");
    run.input()?.onEvent(turnEndEvent("bg done", 0.25));
    expect(runs.takeCost()).toBe(0);
    expect(runs.costForTurn()).toBeCloseTo(0.25);
    // A completion that lands while the write is in flight stays pending for the next turn.
    run.input()?.onEvent(turnEndEvent("bg again", 0.5));
    runs.commitCost();
    expect(runs.costForTurn()).toBeCloseTo(0.5);
    runs.commitCost();
    expect(runs.costForTurn()).toBe(0);
  });
});
