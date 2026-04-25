import { describe, test, expect } from "bun:test";
import { CostAggregator, _costAggDeps, type CostEvent } from "../../../src/runtime/cost-aggregator";
import { withTempDir } from "../../helpers/temp";
import { join } from "node:path";

function makeEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    costUsd: 0.001,
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

  test("drain() writes JSONL file with all events sorted by ts", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let captured = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, data) => { captured = String(data); return 0; };
      const agg = new CostAggregator("r-test", drainDir);
      agg.record(makeEvent({ ts: 2000 }));
      agg.record(makeEvent({ ts: 1000 }));
      await agg.drain();
      const lines = captured.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).ts).toBe(1000);
      expect(JSON.parse(lines[1]).ts).toBe(2000);
      _costAggDeps.write = origWrite;
    });
  });

  test("drain() writes to <drainDir>/<runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let capturedPath = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (p, _d) => { capturedPath = p; return 0; };
      const agg = new CostAggregator("my-run-id", drainDir);
      agg.record(makeEvent());
      await agg.drain();
      expect(capturedPath).toBe(join(drainDir, "my-run-id.jsonl"));
      _costAggDeps.write = origWrite;
    });
  });
});
