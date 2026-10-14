import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import type { Advisor, BatchRequest } from "@/advisor";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { NaxRuntime } from "@/runtime";
import type { SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { preflightPath } from "@/workflow/preflight";
import { _preflightRunDeps, adoptPriorPreflight, runWorkflowPreflight } from "@/workflow/preflight-run";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";

const originalRun = { ..._preflightRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_preflightRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** The advisor's dispatch event (US-004): the accounting fields this story reads, on the real bus contract. */
function advisorEvent(over: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-f-US-001-advisor",
    sessionRole: "advisor",
    prompt: "p",
    response: "r",
    agentName: "claude",
    stage: "run",
    resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
    roundTrips: 0,
    roundTripUnit: "agent-run",
    protocolIds: {},
    origin: "runAsSession",
    durationMs: 1,
    timestamp: 1,
    ...over,
  };
}

function setup(opts: { preflight?: boolean; batchThrows?: boolean; batchEmits?: boolean } = {}) {
  const out = makeTempDir("wf-pfr-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out, workflow: { preflight: opts.preflight ?? true } });
  const runtime = makeTestRuntime({ config, workdir: "/repo" });
  runtimes.push(runtime);
  const featureDir = join(out, "workflow", "f");
  const runDir = join(featureDir, "r-now");
  _preflightRunDeps.buildFeatureContext = async () => ({
    fc: makeFeatureContext({ featureDir, runDir, runId: "r-now" }),
    dispose: async () => {},
  });
  const calls: BatchRequest[] = [];
  const advisor: Advisor = {
    advise: async () => ({ decision: null }),
    recordReuse: async () => null,
    adviseBatch: async (req) => {
      calls.push(req);
      if (opts.batchEmits) {
        runtime.dispatchEvents.emitDispatch(
          advisorEvent({ exactCostUsd: 0.3, tokenUsage: { inputTokens: 10, outputTokens: 5 } }),
        );
      }
      if (opts.batchThrows) throw new Error("ladder down");
      return { kind: "preflight", overlap: [], items: [] };
    },
  };
  _workflowDeps.createAdvisor = () => advisor;
  const prd = makeTestPRD([
    makeTestStory({ id: "US-001" }),
    makeTestStory({ id: "US-002", status: "passed", passes: true }),
    makeTestStory({ id: "US-003", status: "skipped" }),
  ]);
  const input = { runtime, config, prd, feature: "f", workdir: "/repo", runId: "r-now", agentName: "claude" };
  return { input, calls, runDir, featureDir, runtime };
}

describe("runWorkflowPreflight (P4-R14)", () => {
  test("one batch over the stories not yet passed or skipped; preflight.json written", async () => {
    const { input, calls, runDir } = setup();
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "preflight", storyIds: ["US-001"] });
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });

  test("workflow.preflight false -> nothing", async () => {
    const { input, calls } = setup({ preflight: false });
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
  });

  test("a reusable preflight.json from an earlier run is adopted: no second batch", async () => {
    const { input, calls, featureDir, runDir } = setup();
    const old = join(featureDir, "r-old");
    await upsertStoryRecord(old, { runId: "r-old", feature: "f" }, newStoryRecord("US-001", 5, "t"));
    await Bun.write(preflightPath(old), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] }));
    await runWorkflowPreflight(input);
    expect(calls).toHaveLength(0);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual({ schemaVersion: 1, overlap: [], conflicts: [] });
  });

  test("fail-open: an advisor failure never throws", async () => {
    const { input } = setup({ batchThrows: true });
    await expect(runWorkflowPreflight(input)).resolves.toBeUndefined();
  });
});

describe("adoptPriorPreflight", () => {
  test("never overwrites this run's own file", async () => {
    const { featureDir, runDir } = setup();
    await Bun.write(
      preflightPath(runDir),
      JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [], mine: true }),
    );
    expect(await adoptPriorPreflight(featureDir, runDir)).toBe(false);
  });
});

const RESULT = "result.json";
/** The role totals this run's result.json holds, or undefined when it left no file. */
async function storedPreflight(runDir: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(join(runDir, RESULT));
  if (!(await file.exists())) return undefined;
  const parsed = (await file.json()) as { preflightTokensByRole?: Record<string, unknown> };
  return parsed.preflightTokensByRole;
}

describe("runWorkflowPreflight — pre-flight spend lands in the role table (US-004)", () => {
  const ADVISOR = { inputTokens: 10, outputTokens: 5, costUsd: 0.3, calls: 1 };

  test("AC-1: the advisor's meter is written into this run's result.json as preflightTokensByRole", async () => {
    const { input, runDir } = setup({ batchEmits: true });
    await runWorkflowPreflight(input);
    expect(await storedPreflight(runDir)).toEqual({ advisor: ADVISOR });
  });

  test("AC-2: a pre-flight that dispatched nothing leaves no result.json at all", async () => {
    const { input, runDir } = setup();
    await runWorkflowPreflight(input);
    expect(await Bun.file(join(runDir, RESULT)).exists()).toBe(false);
  });

  test("AC-3: an event after the pre-flight returned cannot change the stored role totals", async () => {
    const { input, runDir, runtime } = setup({ batchEmits: true });
    await runWorkflowPreflight(input);
    runtime.dispatchEvents.emitDispatch(
      advisorEvent({ exactCostUsd: 9, tokenUsage: { inputTokens: 900, outputTokens: 900 } }),
    );
    expect(await storedPreflight(runDir)).toEqual({ advisor: ADVISOR });
  });

  test("AC-10: spend from a call made before the pre-flight threw is kept", async () => {
    const { input, runDir } = setup({ batchEmits: true, batchThrows: true });
    await expect(runWorkflowPreflight(input)).resolves.toBeUndefined();
    expect(await storedPreflight(runDir)).toEqual({ advisor: ADVISOR });
  });
});

describe("runWorkflowPreflight — a failing accounting write is contained (US-004)", () => {
  let logs: LogEntry[] = [];
  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(() => resetLogger());

  const breakWrite = () => {
    _preflightRunDeps.writePreflightTokens = async () => {
      throw new Error("disk full");
    };
  };

  test("AC-8: the pre-flight still resolves and still logs 'Pre-flight done'", async () => {
    const { input, runDir } = setup({ batchEmits: true });
    let attempted = 0;
    _preflightRunDeps.writePreflightTokens = async () => {
      attempted += 1;
      throw new Error("disk full");
    };
    await expect(runWorkflowPreflight(input)).resolves.toBeUndefined();
    expect(attempted).toBe(1);
    expect(logs.some((e) => e.stage === "workflow" && e.message === "Pre-flight done")).toBe(true);
    // The pre-flight's own result is unaffected by the accounting write failing.
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });

  test("AC-9: the failure is logged at debug with storyId _run", async () => {
    const { input } = setup({ batchEmits: true });
    breakWrite();
    await runWorkflowPreflight(input);
    const entry = logs.find((e) => e.level === "debug" && e.data?.storyId === "_run");
    expect(entry?.stage).toBe("workflow");
    expect(String(entry?.data?.error)).toContain("disk full");
    // Debug, not warn: the run's own spend is already persisted and the pre-flight result stands.
    expect(logs.filter((e) => e.level === "warn" && String(e.data?.error).includes("disk full"))).toHaveLength(0);
  });
});
