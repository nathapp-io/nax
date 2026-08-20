import { describe, test, expect, mock } from "bun:test";
import { CostAggregator, _costAggDeps, createNoOpCostAggregator, type CostEvent } from "@/runtime/cost-aggregator";
import { withTempDir } from "@test/helpers";
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
  test("snapshot(): zero totals when empty; accumulates events; counts errors separately", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const empty = agg.snapshot();
    expect(empty.callCount).toBe(0);
    expect(empty.totalCostUsd).toBe(0);
    expect(empty.errorCount).toBe(0);

    agg.record(makeEvent({ costUsd: 0.001, tokens: { input: 100, output: 50 } }));
    agg.record(makeEvent({ costUsd: 0.002, tokens: { input: 200, output: 80 } }));
    const accumulated = agg.snapshot();
    expect(accumulated.callCount).toBe(2);
    expect(accumulated.totalCostUsd).toBeCloseTo(0.003);
    expect(accumulated.totalInputTokens).toBe(300);
    expect(accumulated.totalOutputTokens).toBe(130);

    agg.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 100 });
    const withError = agg.snapshot();
    expect(withError.errorCount).toBe(1);
  });

  test("byCall() and byScope() include errorCount for matching id", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeEvent({ callId: "call-1", costUsd: 0.01 }));
    agg.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", callId: "call-1", errorCode: "TIMEOUT", durationMs: 100 });
    const byCall = agg.byCall();
    expect(byCall["call-1"].callCount).toBe(1);
    expect(byCall["call-1"].errorCount).toBe(1);

    agg.record(makeEvent({ scopeId: "scope-1", costUsd: 0.01 }));
    agg.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", scopeId: "scope-1", errorCode: "TIMEOUT", durationMs: 100 });
    const byScope = agg.byScope();
    expect(byScope["scope-1"].callCount).toBe(1);
    expect(byScope["scope-1"].errorCount).toBe(1);
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

  test("snapshot() reflects the full persisted total after drain() completes, not zero (BUG-29)", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      const agg = new CostAggregator("r-test-persist", drainDir);
      agg.record(makeEvent({ ts: 1000, costUsd: 0.01 }));
      agg.record(makeEvent({ ts: 2000, costUsd: 0.02 }));

      await agg.drain();

      // drain() repopulates _events/_errors from the fully-committed set — a
      // post-drain snapshot must still report the real total, not reset to
      // zero, so cost-limit enforcement reading this snapshot after close
      // doesn't under-report spend.
      const snap = agg.snapshot();
      expect(snap.callCount).toBe(2);
      expect(snap.totalCostUsd).toBeCloseTo(0.03);
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

  // --- AC6 + AC7: CostScopeHandle.snapshot() ---
  test("CostScopeHandle.snapshot() filters by scopeId, includes errorCount, returns zero when empty", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const handle = agg.openScope("region-X");
    agg.record(makeEvent({ scopeId: "region-X", costUsd: 0.01 }));
    agg.record(makeEvent({ scopeId: "region-X", costUsd: 0.02 }));
    agg.record(makeEvent({ scopeId: "region-Y", costUsd: 0.99 }));
    agg.record(makeEvent({ costUsd: 0.5 }));
    const snap = handle.snapshot();
    expect(snap.callCount).toBe(2);
    expect(snap.totalCostUsd).toBeCloseTo(0.03);

    agg.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", scopeId: "region-X", errorCode: "TIMEOUT", durationMs: 100 });
    expect(handle.snapshot().errorCount).toBe(1);
    handle.close();

    const emptyHandle = agg.openScope("empty-scope");
    const emptySnap = emptyHandle.snapshot();
    expect(emptySnap.totalCostUsd).toBe(0);
    expect(emptySnap.callCount).toBe(0);
    expect(emptySnap.errorCount).toBe(0);
    emptyHandle.close();
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

  // --- AC9: drain() warns when open scopes remain; does NOT warn when all closed ---
  test("drain() warns with openScopeCount when scopes still open; silent when all closed", async () => {
    const origGetSafeLogger = _costAggDeps.getSafeLogger;
    const origWrite = _costAggDeps.write;
    _costAggDeps.write = async () => 0;

    // Scenario 1: unclosed scope → warn with openScopeCount
    const warnCalls1: Array<[string, string, Record<string, unknown>]> = [];
    _costAggDeps.getSafeLogger = mock(() => ({
      warn: (stage: string, msg: string, data: Record<string, unknown>) => { warnCalls1.push([stage, msg, data]); },
      info: () => {}, error: () => {}, debug: () => {},
    })) as never;
    const agg1 = new CostAggregator("r-001", "/tmp/drain");
    agg1.openScope("unclosed-scope");
    await agg1.drain();
    expect(warnCalls1.length).toBeGreaterThanOrEqual(1);
    const drainWarn = warnCalls1.find(([, , data]) => typeof (data as Record<string, unknown>)["openScopeCount"] === "number");
    expect(drainWarn).toBeDefined();
    expect((drainWarn![2] as Record<string, unknown>)["openScopeCount"]).toBe(1);

    // Scenario 2: closed scope → no warn with openScopeCount
    const warnCalls2: Array<Record<string, unknown>> = [];
    _costAggDeps.getSafeLogger = mock(() => ({
      warn: (_stage: string, _msg: string, data: Record<string, unknown>) => { warnCalls2.push(data); },
      info: () => {}, error: () => {}, debug: () => {},
    })) as never;
    const agg2 = new CostAggregator("r-001", "/tmp/drain");
    agg2.openScope("closed-scope").close();
    await agg2.drain();
    expect(warnCalls2.find((d) => typeof d["openScopeCount"] === "number")).toBeUndefined();

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

  // ── #1433: attribution survives to disk ──────────────────────────────────
  //
  // The drain path is the seam this repo keeps breaking on: a field is added to
  // the type and the producer, and nothing checks it actually lands in the file
  // consumers read. Serialisation is a whole-object JSON.stringify, so a
  // whitelist regression here would silently un-attribute every row again.

  test("#1433: drain writes model, tier, role and schemaVersion into the JSONL", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let captured = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, data) => {
        captured = String(data);
        return 0;
      };
      const agg = new CostAggregator("my-run-id", drainDir);
      agg.record(
        makeEvent({
          ts: 1000,
          model: "haiku",
          modelTier: "fast",
          sessionRole: "test-writer",
          featureName: "kv-cache",
          schemaVersion: 2,
          pricingSource: "model-rates",
        }),
      );
      await agg.drain();
      _costAggDeps.write = origWrite;

      const row = JSON.parse(captured.trim());
      expect(row.model).toBe("haiku");
      expect(row.modelTier).toBe("fast");
      expect(row.sessionRole).toBe("test-writer");
      expect(row.featureName).toBe("kv-cache");
      expect(row.schemaVersion).toBe(2);
      expect(row.pricingSource).toBe("model-rates");
    });
  });
});
