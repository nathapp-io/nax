import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type { AgentUsageUpdateEvent, IUsageAuditor, NaxRuntime, UsageAuditEntry } from "@/runtime";
import { createRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];

function makeRuntime(
  config: Parameters<typeof createRuntime>[0],
  workdir: string,
  opts?: Parameters<typeof createRuntime>[2],
): NaxRuntime {
  const runtime = createRuntime(config, workdir, opts);
  createdRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

function usageEvent(runtime: NaxRuntime, overrides: Partial<AgentUsageUpdateEvent> = {}): AgentUsageUpdateEvent {
  return {
    kind: "agent.usage_update",
    callId: "call-001",
    runId: runtime.runId,
    agentName: "claude",
    sessionName: "nax-abc-feat-US-001-implementer",
    timestamp: 1_700_000_000_000,
    scopeId: "scope-1",
    inputTokens: 120,
    outputTokens: 45,
    costUsd: 0.0042,
    ...overrides,
  };
}

describe("createRuntime usage audit wiring (#2045)", () => {
  test("enabled true writes a FLAT usage/<runId>.jsonl under the output dir, with NO featureName", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ name: "probe", outputDir: dir, agent: { usageAudit: { enabled: true } } });
      // featureName is deliberately omitted: unlike promptAudit, the usage sidecar
      // must not be gated on it. The path is also flat (`usage/<runId>.jsonl`,
      // matching `cost/<runId>.jsonl`), not nested under a feature directory.
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      const usageDir = join(rt.outputDir, "usage");
      const file = join(usageDir, `${rt.runId}.jsonl`);
      expect(await Bun.file(file).exists()).toBe(true);
      expect(readdirSync(usageDir)).toEqual([`${rt.runId}.jsonl`]);

      const [row] = (await Bun.file(file).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(row).toMatchObject({
        runId: rt.runId,
        scopeId: "scope-1",
        streamCallId: "call-001",
        input: 120,
        output: 45,
        costUsd: 0.0042,
      });
    });
  });

  test("enabled false (the default) creates NO usage/ directory at all", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({ name: "probe", outputDir: dir });
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      expect(() => readdirSync(join(rt.outputDir, "usage"))).toThrow();
    });
  });

  test("agent.usageAudit.dir overrides the flat output-dir default", async () => {
    await withTempDir(async (dir) => {
      const customDir = join(dir, "custom-usage");
      const config = makeNaxConfig({
        name: "probe",
        outputDir: dir,
        agent: { usageAudit: { enabled: true, dir: customDir } },
      });
      const rt = makeRuntime(config, dir);
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      await rt.close();

      expect(await Bun.file(join(customDir, `${rt.runId}.jsonl`)).exists()).toBe(true);
      expect(() => readdirSync(join(rt.outputDir, "usage"))).toThrow();
    });
  });

  test("accepts an injected IUsageAuditor via CreateRuntimeOptions and exposes it", async () => {
    await withTempDir(async (dir) => {
      const recorded: UsageAuditEntry[] = [];
      const auditor: IUsageAuditor = { record: (entry) => recorded.push(entry), flush: async () => {} };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor: auditor });
      expect(rt.usageAuditor).toBe(auditor);

      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ runId: rt.runId, streamCallId: "call-001" });
      await rt.close();
    });
  });

  test("unsubscribes the usage subscriber on teardown", async () => {
    await withTempDir(async (dir) => {
      let records = 0;
      const auditor: IUsageAuditor = {
        record: () => {
          records++;
        },
        flush: async () => {},
      };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor: auditor });

      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(records).toBe(1);

      await rt.close();
      rt.agentStreamEvents.emitAgentStream(usageEvent(rt));
      expect(records).toBe(1);
    });
  });

  test("awaits usageAuditor.flush() on close, alongside promptAuditor.flush()", async () => {
    await withTempDir(async (dir) => {
      let usageFlushed = false;
      let promptFlushed = false;
      const usageAuditor: IUsageAuditor = {
        record() {},
        async flush() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          usageFlushed = true;
        },
      };
      const promptAuditor = {
        record() {},
        recordError() {},
        async flush() {
          promptFlushed = true;
        },
      };
      const rt = makeRuntime(makeNaxConfig({ name: "probe", outputDir: dir }), dir, { usageAuditor, promptAuditor });

      await rt.close();

      expect(usageFlushed).toBe(true);
      expect(promptFlushed).toBe(true);
    });
  });
});
