/**
 * US-003: the feature workflow's bus events. `runWorkflowFeature` emits `workflow:started` and
 * `workflow:published`; the real sink `buildFeatureEnv` returns emits `workflow:step`. No hook is
 * wired yet (US-004 does that), so these tests read the singleton bus directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertNaxError,
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeTempDir,
  makeTestPRD,
  makeTestRuntime,
  makeTestStory,
} from "@test/helpers";
import { NaxError } from "@/errors";
import { type PipelineEvent, pipelineEventBus } from "@/pipeline/event-bus";
import type { NaxRuntime } from "@/runtime";
import { _featureRunDeps, runWorkflowFeature } from "@/workflow/feature";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const originalRun = { ..._featureRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];

let events: PipelineEvent[] = [];
/** What happened in what order: every `workflow:*` type emitted, plus the machine's own call/return. */
let marks: string[] = [];
let off: (() => void) | undefined;

beforeEach(() => {
  pipelineEventBus.clear();
  events = [];
  marks = [];
  off = pipelineEventBus.onAll((event) => {
    events.push(event);
    if (event.type.startsWith("workflow:")) marks.push(event.type);
  });
});

afterEach(async () => {
  off?.();
  off = undefined;
  pipelineEventBus.clear();
  Object.assign(_featureRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** The events of one type, narrowed — a typed alternative to `events.filter(...)`. */
function ofType<T extends PipelineEvent["type"]>(type: T): Extract<PipelineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<PipelineEvent, { type: T }> => e.type === type);
}

const workflowEvents = (): PipelineEvent[] => events.filter((e) => e.type.startsWith("workflow:"));

/** The machine stub, marked around its call so a test can place an emission before or after it. */
function stubMachine(envs: FeatureEnv[], make: (env: FeatureEnv) => WorkflowFeatureRecord): void {
  _featureRunDeps.runFeatureMachine = async (env) => {
    envs.push(env);
    marks.push("machine:call");
    const rec = make(env);
    marks.push("machine:return");
    return rec;
  };
}

function setup(over: { dryRun?: boolean } = {}) {
  const out = makeTempDir("wf-events-");
  dirs.push(out);
  const config = makeNaxConfig({ outputDir: out });
  const runtime = makeTestRuntime({ config, workdir: "/repo", ...(over.dryRun ? { dryRun: true } : {}) });
  runtimes.push(runtime);
  const prd = makeTestPRD([makeTestStory({ id: "US-001", status: "passed", passes: true })]);
  const featureDir = join(out, "workflow", prd.feature);
  const fc = makeFeatureContext({
    prd,
    feature: prd.feature,
    featureDir,
    runDir: join(featureDir, "r-now"),
    runId: "r-now",
  });
  _featureRunDeps.buildFeatureContext = async () => ({ fc, dispose: async () => {} });
  _workflowDeps.git = async (args) =>
    args[0] === "rev-parse" ? { stdout: "headX\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
  const envs: FeatureEnv[] = [];
  stubMachine(envs, (env) => ({ ...env.record, step: "done" }));
  const input = {
    runtime,
    config,
    prd,
    feature: prd.feature,
    workdir: "/repo",
    branch: "feat/x",
    runId: "r-now",
    agentName: "claude",
  };
  return { fc, input, envs, featureDir, runtime };
}

/** A prior record finished at the current HEAD (`headX`), so the workflow takes its skip return. */
async function seedFinished(featureDir: string, feature: string): Promise<void> {
  const prior = join(featureDir, "r-old");
  await upsertStoryRecord(prior, { runId: "r-old", feature }, newStoryRecord("US-001", 5, "t"));
  await upsertFeatureRecord(
    prior,
    { runId: "r-old", feature },
    {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      step: "done",
      head: "headX",
      passed: true,
      outcome: "ready",
    },
  );
}

describe("runWorkflowFeature workflow:started (US-003)", () => {
  test("AC-1: a fresh feature emits exactly one workflow:started at repo-gates, before the machine runs", async () => {
    const { input } = setup();
    await runWorkflowFeature(input);
    expect(ofType("workflow:started")).toEqual([{ type: "workflow:started", step: "repo-gates" }]);
    expect(marks.indexOf("workflow:started")).toBeLessThan(marks.indexOf("machine:call"));
  });

  // The requirement behind AC-1's step: a resumed record names its own starting step.
  test("the started step is the resumed record's own step, not a hardcoded repo-gates", async () => {
    const { input, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "branch-fix",
        startHead: "headX",
      },
    );
    await runWorkflowFeature(input);
    expect(ofType("workflow:started")).toEqual([{ type: "workflow:started", step: "branch-fix" }]);
  });

  test("AC-2: a context build failure rejects and emits no workflow:started", async () => {
    const { input } = setup();
    _featureRunDeps.buildFeatureContext = async () => {
      throw new Error("context broke");
    };
    await expect(runWorkflowFeature(input)).rejects.toThrow("context broke");
    expect(ofType("workflow:started")).toEqual([]);
  });

  test("AC-11: an already-aborted signal returns null and emits no workflow:* event", async () => {
    const { input, envs } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await runWorkflowFeature({ ...input, abortSignal: controller.signal })).toBeNull();
    expect(workflowEvents()).toEqual([]);
    expect(envs).toHaveLength(0);
  });
});

describe("runWorkflowFeature workflow:published (US-003)", () => {
  test("AC-3: the final record's outcome, ci, url, passed and reasons, after the machine resolved", async () => {
    const { input, envs } = setup();
    stubMachine(envs, (env) => ({
      ...env.record,
      step: "done",
      outcome: "ready",
      ci: "green",
      url: "https://github.com/o/r/pull/295",
      passed: true,
      reasons: [],
    }));
    await runWorkflowFeature(input);
    expect(ofType("workflow:published")).toEqual([
      {
        type: "workflow:published",
        outcome: "ready",
        ci: "green",
        url: "https://github.com/o/r/pull/295",
        passed: true,
        reasons: [],
      },
    ]);
    expect(marks.indexOf("workflow:published")).toBeGreaterThan(marks.indexOf("machine:return"));
  });

  test("AC-4: local-only with no url carries its reasons", async () => {
    const { input, envs } = setup();
    stubMachine(envs, (env) => ({
      ...env.record,
      step: "done",
      outcome: "local-only",
      reasons: ["no forge detected"],
    }));
    await runWorkflowFeature(input);
    expect(ofType("workflow:published")).toEqual([
      {
        type: "workflow:published",
        outcome: "local-only",
        passed: false,
        reasons: ["no forge detected"],
      },
    ]);
  });

  test("AC-5: a record with no outcome and no passed defaults to local-only / false", async () => {
    const { input, envs } = setup();
    stubMachine(envs, (env) => ({ ...env.record, step: "done" }));
    const result = await runWorkflowFeature(input);
    expect(result).toEqual({ passed: false, outcome: "local-only", reasons: [] });
    expect(ofType("workflow:published")).toEqual([
      { type: "workflow:published", outcome: "local-only", passed: false, reasons: [] },
    ]);
  });

  test("AC-6: a machine throw rejects and emits no workflow:published", async () => {
    const { input, envs } = setup();
    stubMachine(envs, () => {
      throw new Error("boom");
    });
    await expect(runWorkflowFeature(input)).rejects.toThrow("boom");
    // The machine was reached, so the throw is the only reason no publish followed.
    expect(ofType("workflow:started")).toHaveLength(1);
    expect(ofType("workflow:published")).toEqual([]);
  });

  test("AC-12: a throw after the start leaves the started and step events unmatched", async () => {
    const { input } = setup();
    _featureRunDeps.runFeatureMachine = async (env) => {
      env.sink.step("branch-review", env.record);
      throw new Error("boom");
    };
    await expect(runWorkflowFeature(input)).rejects.toThrow("boom");
    expect(workflowEvents().map((e) => e.type)).toEqual(["workflow:started", "workflow:step"]);
    expect(ofType("workflow:published")).toEqual([]);
  });

  test("AC-13: WORKFLOW_ABORTED propagates and emits no workflow:published", async () => {
    const { input, envs } = setup();
    stubMachine(envs, () => {
      throw new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
        stage: "workflow",
        storyId: "_run",
      });
    });
    const rejected = await runWorkflowFeature(input).then(
      () => null,
      (err: unknown) => err,
    );
    assertNaxError(rejected, "WORKFLOW_ABORTED rejection");
    expect(rejected.code).toBe("WORKFLOW_ABORTED");
    expect(ofType("workflow:started")).toHaveLength(1);
    expect(ofType("workflow:published")).toEqual([]);
  });
});

describe("runWorkflowFeature early returns emit nothing (US-003)", () => {
  test("AC-7: the already-finished skip emits no workflow:started and no workflow:published", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature);
    const result = await runWorkflowFeature(input);
    // The skip really was taken — the machine never ran — so the silence is the early return's.
    expect(result?.outcome).toBe("already-finished");
    expect(envs).toHaveLength(0);
    expect(ofType("workflow:started")).toEqual([]);
    expect(ofType("workflow:published")).toEqual([]);
  });

  test("AC-14: the already-finished skip emits no workflow:step event", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature);
    await runWorkflowFeature(input);
    expect(ofType("workflow:step")).toEqual([]);
  });

  test("AC-8: a dry run returns null and emits no workflow:* event", async () => {
    const { input, envs } = setup({ dryRun: true });
    expect(await runWorkflowFeature(input)).toBeNull();
    expect(workflowEvents()).toEqual([]);
    expect(envs).toHaveLength(0);
  });
});
