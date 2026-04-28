import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { createRuntime } from "../../../src/runtime";
import { _promptAuditorDeps } from "../../../src/runtime/prompt-auditor";
import { _costAggDeps } from "../../../src/runtime/cost-aggregator";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeNaxConfig, makeMockAgentManager, makeTestRuntime } from "../../helpers";
import { withTempDir } from "../../helpers/temp";

const auditEnabledConfig = makeNaxConfig({ agent: { promptAudit: { enabled: true } } });

describe("Wave 2 exit criteria", () => {
  test("EC-1: createRuntime() produces a NaxRuntime with a UUID runId", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/ec1");
    expect(rt.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("EC-2: CostAggregator.snapshot() reflects recorded events", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/ec2");
    expect(rt.costAggregator.snapshot().callCount).toBe(0);
    rt.costAggregator.record({
      ts: Date.now(),
      runId: rt.runId,
      agentName: "claude",
      model: "claude-sonnet-4-6",
      tokens: { input: 200, output: 100 },
      costUsd: 0.01,
      durationMs: 300,
    });
    expect(rt.costAggregator.snapshot().callCount).toBe(1);
    expect(rt.costAggregator.snapshot().totalInputTokens).toBe(200);
  });

  test("EC-3: PromptAuditor.flush() writes to .nax/prompt-audit/<feature>/<runId>.jsonl on close()", async () => {
    await withTempDir(async (dir) => {
      const appendedPaths: string[] = [];
      const origAppend = _promptAuditorDeps.appendLine;
      const origWrite = _promptAuditorDeps.write;
      _promptAuditorDeps.appendLine = async (p, _d) => { appendedPaths.push(p); };
      _promptAuditorDeps.write = async (_p, _d) => 0;

      try {
        const rt = createRuntime(auditEnabledConfig, dir, { featureName: "my-feature" });
        rt.promptAuditor.record({
          ts: Date.now(),
          runId: rt.runId,
          agentName: "claude",
          permissionProfile: "approve-reads",
          prompt: "test",
          response: "ok",
          durationMs: 50,
        });
        await rt.close();

        // JSONL goes to .nax/prompt-audit/<feature>/<runId>.jsonl (written via appendLine)
        expect(appendedPaths[0]).toBe(
          join(dir, ".nax", "prompt-audit", "my-feature", `${rt.runId}.jsonl`),
        );
      } finally {
        _promptAuditorDeps.appendLine = origAppend;
        _promptAuditorDeps.write = origWrite;
      }
    });
  });

  test("EC-4: CostAggregator.drain() writes to .nax/cost/<runId>.jsonl on close()", async () => {
    await withTempDir(async (dir) => {
      let drainedPath = "";
      const orig = _costAggDeps.write;
      _costAggDeps.write = async (p, _d) => {
        drainedPath = p;
        return 0;
      };

      try {
        const rt = createRuntime(DEFAULT_CONFIG, dir);
        rt.costAggregator.record({
          ts: Date.now(),
          runId: rt.runId,
          agentName: "claude",
          model: "m",
          tokens: { input: 10, output: 5 },
          costUsd: 0.001,
          durationMs: 100,
        });
        await rt.close();

        expect(drainedPath).toBe(
          join(dir, ".nax", "cost", `${rt.runId}.jsonl`),
        );
      } finally {
        _costAggDeps.write = orig;
      }
    });
  });

  test("EC-5: makeTestRuntime() creates runtime with overrideable agentManager", () => {
    const mockMgr = makeMockAgentManager();
    const rt = makeTestRuntime({ agentManager: mockMgr });
    expect(rt.agentManager).toBe(mockMgr);
    expect(rt.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("EC-6: close() is idempotent — flush/drain called only once", async () => {
    await withTempDir(async (dir) => {
      let flushCount = 0;
      let drainCount = 0;
      const origFlush = _promptAuditorDeps.write;
      const origDrain = _costAggDeps.write;
      _promptAuditorDeps.write = async () => {
        flushCount++;
        return 0;
      };
      _costAggDeps.write = async () => {
        drainCount++;
        return 0;
      };

      try {
        const rt = createRuntime(auditEnabledConfig, dir, { featureName: "my-feature" });
        rt.promptAuditor.record({
          ts: Date.now(),
          runId: rt.runId,
          agentName: "a",
          permissionProfile: "approve-reads",
          prompt: "p",
          response: "r",
          durationMs: 1,
        });
        rt.costAggregator.record({
          ts: Date.now(),
          runId: rt.runId,
          agentName: "a",
          model: "m",
          tokens: { input: 1, output: 1 },
          costUsd: 0,
          durationMs: 1,
        });

        await rt.close();
        await rt.close(); // second close — should be idempotent

        expect(flushCount).toBe(1);
        expect(drainCount).toBe(1);
      } finally {
        _promptAuditorDeps.write = origFlush;
        _costAggDeps.write = origDrain;
      }
    });
  });
});
