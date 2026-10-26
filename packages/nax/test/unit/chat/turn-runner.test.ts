import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  createSessionStorage,
  type SessionEvent,
  type SessionMeta,
  type SessionStorage,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import type { ChatSessionHandle } from "@/chat";
import * as chat from "@/chat";

const { createChatLedger, runChatTurn } = chat;

import type { CostEvent } from "@/runtime";
import { COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware";

const ID = "chat-test";
const MODEL = "anthropic/test-model";
const START = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-01T00:01:00.000Z";
const base = { sessionId: ID, turnId: "turn-1", at: START, metadata: {} };
const start: SessionEvent = { ...base, type: "turn_start" };
const usageEvent: Extract<SessionEvent, { type: "usage" }> = {
  ...base,
  at: "2026-10-01T00:00:01.500Z",
  type: "usage",
  round: 1,
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.01,
  costSource: "computed",
};
const usage: SessionEvent = usageEvent;
const end: SessionEvent = {
  ...base,
  type: "turn_end",
  status: "completed",
  output: "done",
  usage: { inputTokens: 100, outputTokens: 20 },
  costUsd: 0.02,
};
let dir: string;
let storage: SessionStorage;
let handle: ChatSessionHandle;
let events: SessionEvent[];
let sendError: Error | undefined;

beforeEach(async () => {
  dir = makeTempDir("chat-turn-");
  storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => new Date(NOW),
    logger: makeLogger(),
  });
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: ID,
    cwd: dir,
    model: MODEL,
    mode: "ask",
    bashApproval: "gated",
    title: null,
    createdAt: START,
    updatedAt: null,
    costUsd: 0.05,
  };
  await storage.writeMeta(meta);
  events = [start, usage, end];
  sendError = undefined;
  const session: AgentSession = {
    id: ID,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      if (sendError) throw sendError;
      yield* events;
    },
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
  handle = { session, meta, release: async () => {} };
});
afterEach(() => cleanupTempDir(dir));

function ledger(startedAt = new Date(START)) {
  return createChatLedger({ sessionId: ID, projectKey: "test-project", model: MODEL, outputDir: dir, startedAt });
}
function run(
  options: { message?: string; costLedger?: ReturnType<typeof createChatLedger>; extraCostUsd?: () => number } = {},
) {
  const asks = { handle: mock((_event: SessionEvent) => {}) };
  const onEvent = mock((_event: SessionEvent) => {});
  const costLedger = options.costLedger ?? ledger();
  const result = runChatTurn({
    handle,
    storage,
    message: options.message ?? "fix bug",
    asks,
    ledger: costLedger,
    onEvent,
    now: NOW,
    ...(options.extraCostUsd ? { extraCostUsd: options.extraCostUsd } : {}),
  });
  return { result, asks, onEvent };
}
async function rows(startedAt = Date.parse(START)): Promise<CostEvent[]> {
  const text = await Bun.file(join(dir, "cost", `chat-${ID}-${startedAt}.jsonl`)).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("runChatTurn", () => {
  test("AC-1 forwards every event in order", async () => {
    const turn = run();
    await turn.result;
    expect(turn.onEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });
  test("AC-2 routes approvals, resolutions and questions only to asks", async () => {
    const approval: SessionEvent = {
      ...base,
      type: "approval_requested",
      requestId: "r1",
      tool: "Bash",
      summary: "run",
      command: "pwd",
      reason: "test",
      expiresAt: NOW,
    };
    const resolved: SessionEvent = {
      ...base,
      type: "approval_resolved",
      requestId: "r1",
      decision: "allow",
      decidedBy: "human",
    };
    const question: SessionEvent = { ...base, type: "question", requestId: "q1", text: "why?", expiresAt: NOW };
    events = [start, approval, resolved, question, usage, end];
    const turn = run();
    await turn.result;
    expect(turn.asks.handle.mock.calls.map(([event]) => event)).toEqual([approval, resolved, question]);
    expect(turn.onEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });
  test.each([
    ["AC-3 one persisted row", { costUsd: 0.01 }],
    ["AC-4 chat stage and tui role", { stage: "chat", sessionRole: "tui" }],
    ["AC-5 model and process runId", { model: MODEL, runId: `chat-${ID}-${Date.parse(START)}` }],
    ["AC-6 sparse tokens", { tokens: { input: 100, output: 20 } }],
    ["AC-7 computed cost is exact", { confidence: "exact", exactCostUsd: 0.01, estimatedCostUsd: 0 }],
    ["AC-8 duration since turn start", { durationMs: 1500 }],
  ])("%s", async (_name, expected) => {
    await run().result;
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject(expected);
    expect(persisted[0]).toMatchObject({
      ts: Date.parse(usage.at),
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      projectKey: "test-project",
      agentName: "native",
      turnId: base.turnId,
    });
    if (_name.startsWith("AC-6")) expect(persisted[0]?.tokens).toEqual({ input: 100, output: 20 });
  });
  test.each([
    ["AC-9 absent source", undefined, "exact", 0.01, 0],
    ["AC-10 unpriced source", "unpriced", "estimated", 0, 0.01],
    ["reported source", "reported", "exact", 0.01, 0],
  ] as const)("%s", async (_name, costSource, confidence, exactCostUsd, estimatedCostUsd) => {
    events = [start, { ...usage, costSource }, end];
    await run().result;
    expect((await rows())[0]).toMatchObject({ confidence, exactCostUsd, estimatedCostUsd });
  });
  test("AC-11 two turns keep both rows in one process file", async () => {
    const costLedger = ledger();
    await run({ costLedger }).result;
    events = events.map((event) => ({ ...event, turnId: "turn-2" }));
    await run({ costLedger }).result;
    expect((await rows()).map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
    expect([...new Bun.Glob("*.jsonl").scanSync({ cwd: join(dir, "cost") })]).toHaveLength(1);
    expect((await storage.readMeta(ID))?.costUsd).toBeCloseTo(0.09);
  });
  test("resumed process writes a separate ledger without overwriting earlier rows", async () => {
    await run().result;
    const resumedAt = new Date(NOW);
    await run({ costLedger: ledger(resumedAt) }).result;
    expect(await rows()).toHaveLength(1);
    expect(await rows(resumedAt.getTime())).toHaveLength(1);
    expect([...new Bun.Glob("*.jsonl").scanSync({ cwd: join(dir, "cost") })]).toHaveLength(2);
  });
  test("later usage duration starts at previous usage and preserves cache counts", async () => {
    events = [start, usage, { ...usage, round: 2, at: "2026-10-01T00:00:02.000Z", cacheRead: 12, cacheWrite: 0 }, end];
    await run().result;
    expect((await rows())[1]).toMatchObject({
      durationMs: 500,
      tokens: { input: 100, output: 20, cacheRead: 12, cacheWrite: 0 },
    });
  });
  test("missing metadata spend defaults to zero", async () => {
    const { costUsd: _cost, ...meta } = handle.meta;
    await storage.writeMeta(meta);
    expect((await run().result).costUsd).toBe(0.02);
  });
  test("a stream without turn_end rejects without updating metadata", async () => {
    events = [start];
    await expect(run().result).rejects.toMatchObject({ code: "CHAT_TURN_INCOMPLETE" });
    expect((await storage.readMeta(ID))?.updatedAt).toBeNull();
  });
  test("AC-12 adds turn-end spend to metadata", async () => {
    const written = await run().result;
    expect(written.costUsd).toBeCloseTo(0.07);
    expect(await storage.readMeta(ID)).toEqual(written);
  });
  test("AC-13 writes injected ISO timestamp", async () => {
    await run().result;
    expect((await storage.readMeta(ID))?.updatedAt).toBe(NOW);
  });
  test.each([
    ["AC-14 collapses whitespace", "  fix   the\nbug  ", "fix the bug"],
    ["AC-15 limits title to 80 code points", "😀".repeat(100), "😀".repeat(80)],
  ])("%s", async (_name, message, title) => {
    await run({ message }).result;
    expect((await storage.readMeta(ID))?.title).toBe(title);
  });
  test("AC-16 second turn preserves title with original handle", async () => {
    const costLedger = ledger();
    await run({ message: "first", costLedger }).result;
    await run({ message: "second", costLedger }).result;
    expect((await storage.readMeta(ID))?.title).toBe("first");
  });
  test("AC-17 errored turn still updates metadata", async () => {
    events = [start, usage, { ...end, status: "errored" }];
    await run().result;
    expect((await storage.readMeta(ID))?.updatedAt).toBe(NOW);
  });
  test("AC-18 send throwing before events preserves metadata", async () => {
    sendError = new Error("turn already running");
    const before = await storage.readMeta(ID);
    await expect(run().result).rejects.toBe(sendError);
    expect(await storage.readMeta(ID)).toEqual(before);
  });
  test("AC-1 a ledger record with role subagent writes sessionRole subagent", async () => {
    const costLedger = ledger();
    costLedger.record(usageEvent, START, MODEL, "subagent");
    await costLedger.drain();
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.sessionRole).toBe("subagent");
  });
  test("AC-2 a ledger record without a role writes sessionRole tui", async () => {
    const costLedger = ledger();
    costLedger.record(usageEvent, START, MODEL);
    await costLedger.drain();
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.sessionRole).toBe("tui");
  });
  test("AC-9 extraCostUsd is added to the turn_end spend in metadata", async () => {
    events = [start, { ...end, costUsd: 1 }];
    const before = (await storage.readMeta(ID))?.costUsd ?? 0;
    const written = await run({ extraCostUsd: () => 0.25 }).result;
    expect(written.costUsd).toBeCloseTo(before + 1.25);
    expect((await storage.readMeta(ID))?.costUsd).toBeCloseTo(before + 1.25);
  });
  test("AC-10 without extraCostUsd only the turn_end spend is added", async () => {
    events = [start, { ...end, costUsd: 1 }];
    const before = (await storage.readMeta(ID))?.costUsd ?? 0;
    const written = await run().result;
    expect(written.costUsd).toBeCloseTo(before + 1);
  });
  test("AC-19 send throwing before events never records or drains ledger", async () => {
    sendError = new Error("turn already running");
    const real = ledger();
    const record = mock(real.record);
    const drain = mock(real.drain);
    await expect(run({ costLedger: { record, drain } }).result).rejects.toBe(sendError);
    expect(record).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    expect(await Bun.file(join(dir, "cost", `chat-${ID}-${Date.parse(START)}.jsonl`)).exists()).toBe(false);
  });
});
