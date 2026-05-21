import { describe, test, expect, mock } from "bun:test";
import { CostAggregator, _costAggDeps, createNoOpCostAggregator, type CostEvent } from "../../../src/runtime/cost-aggregator";
import { withTempDir } from "../../helpers/temp";
import { join } from "node:path";

function makeEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    costUsd: 0.001,
    confidence: "estimated",
    durationMs: 500,
    ...overrides,
  };
}

describe("CostAggregator", () => {
  test("snapshot() returns zero totals when no events recorded", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const snap = agg.snapshot();
    expect(snap.callCount).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.errorCount).toBe(0);
  });

  test("snapshot() accumulates recorded events", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ costUsd: 0.001, tokens: { input: 100, output: 50 } }));
    agg.record(makeEvent({ costUsd: 0.002, tokens: { input: 200, output: 80 } }));
    const snap = agg.snapshot();
    expect(snap.callCount).toBe(2);
    expect(snap.totalCostUsd).toBeCloseTo(0.003);
    expect(snap.totalInputTokens).toBe(300);
    expect(snap.totalOutputTokens).toBe(130);
  });

  test("snapshot() counts errors separately", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent());
    agg.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 100 });
    const snap = agg.snapshot();
    expect(snap.callCount).toBe(1);
    expect(snap.errorCount).toBe(1);
  });

  test("byCall() includes errorCount for matching callId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ callId: "call-1", costUsd: 0.01 }));
    agg.recordError({
      ts: Date.now(),
      runId: "r-001",
      agentName: "claude",
      callId: "call-1",
      errorCode: "TIMEOUT",
      durationMs: 100,
    });
    const by = agg.byCall();
    expect(by["call-1"].callCount).toBe(1);
    expect(by["call-1"].errorCount).toBe(1);
  });

  test("byScope() includes errorCount for matching scopeId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ scopeId: "scope-1", costUsd: 0.01 }));
    agg.recordError({
      ts: Date.now(),
      runId: "r-001",
      agentName: "claude",
      scopeId: "scope-1",
      errorCode: "TIMEOUT",
      durationMs: 100,
    });
    const by = agg.byScope();
    expect(by["scope-1"].callCount).toBe(1);
    expect(by["scope-1"].errorCount).toBe(1);
  });

  test("byAgent() groups events by agentName", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ agentName: "claude", costUsd: 0.001 }));
    agg.record(makeEvent({ agentName: "claude", costUsd: 0.002 }));
    agg.record(makeEvent({ agentName: "codex", costUsd: 0.005 }));
    const by = agg.byAgent();
    expect(by["claude"].callCount).toBe(2);
    expect(by["claude"].totalCostUsd).toBeCloseTo(0.003);
    expect(by["codex"].callCount).toBe(1);
    expect(by["codex"].totalCostUsd).toBeCloseTo(0.005);
  });

  test("byStage() groups events by stage", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ stage: "run", costUsd: 0.01 }));
    agg.record(makeEvent({ stage: "verify", costUsd: 0.02 }));
    agg.record(makeEvent({ stage: undefined }));
    const by = agg.byStage();
    expect(by["run"].callCount).toBe(1);
    expect(by["verify"].callCount).toBe(1);
    expect(by["unknown"].callCount).toBe(1);
  });

  test("byStory() groups events by storyId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ storyId: "s-1", costUsd: 0.01 }));
    agg.record(makeEvent({ storyId: "s-1", costUsd: 0.02 }));
    agg.record(makeEvent({ storyId: "s-2", costUsd: 0.05 }));
    const by = agg.byStory();
    expect(by["s-1"].callCount).toBe(2);
    expect(by["s-2"].callCount).toBe(1);
  });

  test("drain() does nothing when no events", async () => {
    const writes: string[] = [];
    const origWrite = _costAggDeps.write;
    _costAggDeps.write = async (p) => { writes.push(p); return 0; };
    const agg = new CostAggregator("r-001", "/tmp/drain");
    await agg.drain();
    expect(writes).toHaveLength(0);
    _costAggDeps.write = origWrite;
  });

  test("drain() writes sorted JSONL to <drainDir>/<runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let captured = "";
      let capturedPath = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (p, data) => { capturedPath = p; captured = String(data); return 0; };
      const agg = new CostAggregator("my-run-id", drainDir);
      agg.record(makeEvent({ ts: 2000 }));
      agg.record(makeEvent({ ts: 1000 }));
      await agg.drain();
      expect(capturedPath).toBe(join(drainDir, "my-run-id.jsonl"));
      const lines = captured.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).ts).toBe(1000);
      expect(JSON.parse(lines[1]).ts).toBe(2000);
      _costAggDeps.write = origWrite;
    });
  });

  test("drain() captures events recorded during async write (in-flight buffer)", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      const written: string[] = [];
      let resolveWrite: () => void;
      const writePromise = new Promise<number>((r) => { resolveWrite = r; });
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, d) => { written.push(String(d)); return writePromise; };
      const agg = new CostAggregator("r-test", drainDir);
      agg.record(makeEvent({ ts: 1000 }));

      const drainTask = agg.drain();
      agg.record(makeEvent({ ts: 2000 }));
      resolveWrite!();
      await drainTask;

      expect(written).toHaveLength(2);
      // The second write is the complete merged file — both events must appear in it.
      const allLines = written[1].trim().split("\n").filter(Boolean);
      expect(allLines).toHaveLength(2);
      expect(JSON.parse(allLines[0]).ts).toBe(1000);
      expect(JSON.parse(allLines[1]).ts).toBe(2000);
      _costAggDeps.write = origWrite;
    });
  });

  test("drain() captures error events recorded during async write", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      const written: string[] = [];
      let resolveWrite: () => void;
      const writePromise = new Promise<number>((r) => { resolveWrite = r; });
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, d) => { written.push(String(d)); return writePromise; };
      const agg = new CostAggregator("r-test", drainDir);
      agg.record(makeEvent({ ts: 1000 }));

      const drainTask = agg.drain();
      agg.recordError({ ts: 2000, runId: "r-test", agentName: "claude", errorCode: "TIMEOUT", durationMs: 100 });
      resolveWrite!();
      await drainTask;

      expect(written).toHaveLength(2);
      // The second write is the complete merged file — all events must appear in it.
      const allLines = written[1].trim().split("\n").filter(Boolean);
      expect(allLines).toHaveLength(2);
      expect(JSON.parse(allLines[1]).errorCode).toBe("TIMEOUT");
      _costAggDeps.write = origWrite;
    });
  });

  test("snapshot() includes in-flight events during drain", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let resolveWrite: () => void;
      const writePromise = new Promise<number>((r) => { resolveWrite = r; });
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, _d) => writePromise;
      const agg = new CostAggregator("r-test", drainDir);
      agg.record(makeEvent({ ts: 1000, costUsd: 0.01 }));

      const drainTask = agg.drain();
      agg.record(makeEvent({ ts: 2000, costUsd: 0.02 }));

      const snap = agg.snapshot();
      expect(snap.callCount).toBe(1);
      expect(snap.totalCostUsd).toBeCloseTo(0.02);

      resolveWrite!();
      await drainTask;
      _costAggDeps.write = origWrite;
    });
  });

  test("snapshot() returns zero totalExactCostUsd when empty and accumulates across events", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    expect(agg.snapshot().totalExactCostUsd).toBe(0);
    agg.record(makeEvent({ exactCostUsd: 0.005, costUsd: 0.005 }));
    agg.record(makeEvent({ exactCostUsd: 0.003, costUsd: 0.003 }));
    expect(agg.snapshot().totalExactCostUsd).toBeCloseTo(0.008);
  });

  test("drain() includes exactCostUsd in JSONL output", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let captured = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, data) => { captured = String(data); return 0; };
      const agg = new CostAggregator("r-test", drainDir);
      agg.record(makeEvent({ exactCostUsd: 0.012 }));
      await agg.drain();
      const lines = captured.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.exactCostUsd).toBe(0.012);
      _costAggDeps.write = origWrite;
    });
  });

  // --- AC3: byScope ---
  test("byScope() returns events grouped by scopeId, excluding events with no scopeId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ scopeId: "scope-A", costUsd: 0.01 }));
    agg.record(makeEvent({ scopeId: "scope-A", costUsd: 0.02 }));
    agg.record(makeEvent({ scopeId: "scope-B", costUsd: 0.05 }));
    agg.record(makeEvent({ costUsd: 0.1 })); // no scopeId — excluded
    const by = agg.byScope();
    expect(Object.keys(by)).toHaveLength(2);
    expect(by["scope-A"].callCount).toBe(2);
    expect(by["scope-A"].totalCostUsd).toBeCloseTo(0.03);
    expect(by["scope-B"].callCount).toBe(1);
    expect(by["scope-B"].totalCostUsd).toBeCloseTo(0.05);
    expect(by["unknown"]).toBeUndefined();
  });

  // --- AC4: byCall ---
  test("byCall() returns events grouped by callId, excluding events with no callId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ callId: "call-1", costUsd: 0.01 }));
    agg.record(makeEvent({ callId: "call-1", costUsd: 0.02 }));
    agg.record(makeEvent({ callId: "call-2", costUsd: 0.04 }));
    agg.record(makeEvent({ costUsd: 0.1 })); // no callId — excluded
    const by = agg.byCall();
    expect(Object.keys(by)).toHaveLength(2);
    expect(by["call-1"].callCount).toBe(2);
    expect(by["call-1"].totalCostUsd).toBeCloseTo(0.03);
    expect(by["call-2"].callCount).toBe(1);
    expect(by["call-2"].totalCostUsd).toBeCloseTo(0.04);
  });

  // --- AC5: openScope ---
  test("openScope() uses provided scopeId or generates one when omitted", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const h1 = agg.openScope("my-scope");
    expect(h1.scopeId).toBe("my-scope");
    h1.close();
    const h2 = agg.openScope();
    expect(typeof h2.scopeId).toBe("string");
    expect(h2.scopeId.length).toBeGreaterThan(0);
    h2.close();
  });

  // --- AC6: CostScopeHandle.snapshot() filters by scopeId ---
  test("CostScopeHandle.snapshot() returns totals only for events with matching scopeId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("region-X");
    agg.record(makeEvent({ scopeId: "region-X", costUsd: 0.01 }));
    agg.record(makeEvent({ scopeId: "region-X", costUsd: 0.02 }));
    agg.record(makeEvent({ scopeId: "region-Y", costUsd: 0.99 })); // different scope
    agg.record(makeEvent({ costUsd: 0.5 })); // no scope
    const snap = handle.snapshot();
    expect(snap.callCount).toBe(2);
    expect(snap.totalCostUsd).toBeCloseTo(0.03);
    handle.close();
  });

  test("CostScopeHandle.snapshot() includes errorCount for matching scopeId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("region-X");
    agg.record(makeEvent({ scopeId: "region-X", costUsd: 0.01 }));
    agg.recordError({
      ts: Date.now(),
      runId: "r-001",
      agentName: "claude",
      scopeId: "region-X",
      errorCode: "TIMEOUT",
      durationMs: 100,
    });
    const snap = handle.snapshot();
    expect(snap.callCount).toBe(1);
    expect(snap.errorCount).toBe(1);
    handle.close();
  });

  // --- AC7: CostScopeHandle.snapshot() returns EMPTY_SNAPSHOT when no matching events ---
  test("CostScopeHandle.snapshot() returns zero totals when no events have matching scopeId", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("empty-scope");
    const snap = handle.snapshot();
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.callCount).toBe(0);
    expect(snap.errorCount).toBe(0);
    handle.close();
  });

  // --- AC8: CostScopeHandle.close() is idempotent ---
  test("CostScopeHandle.close() can be called multiple times without throwing", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("idempotent-scope");
    expect(() => {
      handle.close();
      handle.close();
      handle.close();
    }).not.toThrow();
  });

  // --- AC9: drain() warns when open scopes remain ---
  test("drain() logs warn with openScopeCount when scopes are still open", async () => {
    const warnCalls: Array<[string, string, Record<string, unknown>]> = [];
    const origGetSafeLogger = _costAggDeps.getSafeLogger;
    _costAggDeps.getSafeLogger = mock(() => ({
      warn: (stage: string, msg: string, data: Record<string, unknown>) => { warnCalls.push([stage, msg, data]); },
      info: () => {},
      error: () => {},
      debug: () => {},
    })) as never;
    const origWrite = _costAggDeps.write;
    _costAggDeps.write = async () => 0;

    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.openScope("unclosed-scope");
    await agg.drain();

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const drainWarn = warnCalls.find(([, , data]) => typeof (data as Record<string, unknown>)["openScopeCount"] === "number");
    expect(drainWarn).toBeDefined();
    expect((drainWarn![2] as Record<string, unknown>)["openScopeCount"]).toBe(1);

    _costAggDeps.getSafeLogger = origGetSafeLogger;
    _costAggDeps.write = origWrite;
  });

  // --- AC9: drain() does NOT warn when no scopes are open ---
  test("drain() does not call warn for openScopeCount when no scopes are open", async () => {
    const warnCalls: Array<Record<string, unknown>> = [];
    const origGetSafeLogger = _costAggDeps.getSafeLogger;
    _costAggDeps.getSafeLogger = mock(() => ({
      warn: (_stage: string, _msg: string, data: Record<string, unknown>) => { warnCalls.push(data); },
      info: () => {},
      error: () => {},
      debug: () => {},
    })) as never;
    const origWrite = _costAggDeps.write;
    _costAggDeps.write = async () => 0;

    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("closed-scope");
    handle.close();
    await agg.drain();

    const scopeWarn = warnCalls.find((d) => typeof d["openScopeCount"] === "number");
    expect(scopeWarn).toBeUndefined();

    _costAggDeps.getSafeLogger = origGetSafeLogger;
    _costAggDeps.write = origWrite;
  });

  // --- AC10: createNoOpCostAggregator ---
  test("createNoOpCostAggregator() returns zero snapshots and empty byScope/byCall records", () => {
    const noOp = createNoOpCostAggregator();
    const snap = noOp.openScope("any-scope").snapshot();
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.callCount).toBe(0);
    expect(snap.errorCount).toBe(0);
    expect(snap.totalInputTokens).toBe(0);
    expect(snap.totalOutputTokens).toBe(0);
    expect(noOp.byScope()).toEqual({});
    expect(noOp.byCall()).toEqual({});
  });
});
