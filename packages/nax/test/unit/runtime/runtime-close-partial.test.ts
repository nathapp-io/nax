/**
 * US-005 — Record in-flight residual spend as partial cost rows at close.
 *
 * A SIGINT during a long native session can leave only finished turns in the
 * ledger while the usage sidecar shows substantial in-flight spend. These
 * integration tests exercise the `createRuntime` wiring end to end: the in-flight
 * tracker is subscribed next to the other subscribers (independently of
 * `agent.usageAudit.enabled`), and `close()` records whatever is still in flight
 * as a `partial: true` cost row before the ledger drains.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import {
  type AgentCallStartedEvent,
  type AgentUsageUpdateEvent,
  createRuntime,
  type NaxRuntime,
  totalSpendUsd,
} from "@/runtime";

const SESSION_NAME = "nax-abc-feat-US-005-implementer";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

function makeRuntime(config: Parameters<typeof createRuntime>[0], workdir: string): NaxRuntime {
  const runtime = createRuntime(config, workdir);
  createdRuntimes.push(runtime);
  return runtime;
}

function callStarted(runtime: NaxRuntime, overrides: Partial<AgentCallStartedEvent> = {}): AgentCallStartedEvent {
  return {
    kind: "agent.call_started",
    callId: "c1",
    runId: runtime.runId,
    agentName: "native",
    sessionName: SESSION_NAME,
    timestamp: 1_700_000_000_000,
    model: "m1",
    timeoutSeconds: 300,
    ...overrides,
  };
}

function usageBeat(
  runtime: NaxRuntime,
  costUsd: number,
  overrides: Partial<AgentUsageUpdateEvent> = {},
): AgentUsageUpdateEvent {
  return {
    kind: "agent.usage_update",
    callId: "c1",
    runId: runtime.runId,
    agentName: "native",
    sessionName: SESSION_NAME,
    timestamp: 1_700_000_000_000,
    cadence: "round-trip",
    roundTrip: 1,
    costUsd,
    ...overrides,
  };
}

function costFilePath(runtime: NaxRuntime): string {
  return join(runtime.outputDir, "cost", `${runtime.runId}.jsonl`);
}

async function readCostRows(runtime: NaxRuntime): Promise<Record<string, unknown>[]> {
  const file = costFilePath(runtime);
  if (!(await Bun.file(file).exists())) return [];
  return (await Bun.file(file).text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function partialConfig(dir: string, usageEnabled: boolean) {
  return makeNaxConfig({ name: "probe", outputDir: dir, agent: { usageAudit: { enabled: usageEnabled } } });
}

describe("US-005 close() partial in-flight cost rows", () => {
  test("AC1: close() writes one partial row for in-flight round-trip spend when usageAudit is disabled", async () => {
    await withTempDir(async (dir) => {
      const runtime = makeRuntime(partialConfig(dir, false), dir);
      runtime.agentStreamEvents.emitAgentStream(callStarted(runtime));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.4));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.6));

      await runtime.close();

      const rows = await readCostRows(runtime);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: runtime.runId,
        partial: true,
        costUsd: 1,
        agentName: "native",
        model: "m1",
        callId: "c1",
      });
    });
  });

  test("AC2: close() partial spend is reflected in totalSpendUsd(costAggregator.snapshot())", async () => {
    await withTempDir(async (dir) => {
      const runtime = makeRuntime(partialConfig(dir, false), dir);
      runtime.agentStreamEvents.emitAgentStream(callStarted(runtime));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.4));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.6));

      await runtime.close();

      expect(totalSpendUsd(runtime.costAggregator.snapshot())).toBe(1);
    });
  });

  test("AC3: a stream that ended with success before close() leaves no partial row", async () => {
    await withTempDir(async (dir) => {
      const runtime = makeRuntime(partialConfig(dir, false), dir);
      runtime.agentStreamEvents.emitAgentStream(callStarted(runtime));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.5));
      runtime.agentStreamEvents.emitAgentStream({
        kind: "agent.call_ended",
        callId: "c1",
        runId: runtime.runId,
        agentName: "native",
        sessionName: SESSION_NAME,
        timestamp: 1_700_000_000_000,
        status: "success",
      });

      await runtime.close();

      const partials = (await readCostRows(runtime)).filter((row) => row.partial === true);
      expect(partials).toHaveLength(0);
    });
  });

  test("AC4: a second close() does not add a further partial row", async () => {
    await withTempDir(async (dir) => {
      const runtime = makeRuntime(partialConfig(dir, false), dir);
      runtime.agentStreamEvents.emitAgentStream(callStarted(runtime));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.4));
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.6));

      await runtime.close();
      const afterFirst = await readCostRows(runtime);
      expect(afterFirst.filter((row) => row.partial === true)).toHaveLength(1);

      // A late beat arriving after the first close must not be recorded by the
      // second close, which returns before any residual is recorded.
      runtime.agentStreamEvents.emitAgentStream(usageBeat(runtime, 0.5, { callId: "c2" }));
      await runtime.close();

      const afterSecond = await readCostRows(runtime);
      expect(afterSecond.filter((row) => row.partial === true)).toHaveLength(1);
    });
  });
});
