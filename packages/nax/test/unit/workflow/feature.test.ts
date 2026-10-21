import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import type { WorkflowStatusBlock } from "@/execution";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { NaxRuntime } from "@/runtime";
import { _featureRunDeps, runWorkflowFeature } from "@/workflow/feature";
import { type FeatureEnv, runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord, readResult, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { toolErrorClaimsHeld, withToolErrorOutcome } from "@/workflow/tool-error-outcome";

const originalRun = { ..._featureRunDeps };
const originalWf = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  Object.assign(_featureRunDeps, originalRun);
  Object.assign(_workflowDeps, originalWf);
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(over: { dryRun?: boolean } = {}) {
  const out = makeTempDir("wf-feat-");
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
  let disposed = 0;
  _featureRunDeps.buildFeatureContext = async () => ({
    fc,
    dispose: async () => {
      disposed++;
    },
  });
  _workflowDeps.git = async (args) =>
    args[0] === "rev-parse" ? { stdout: "headX\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
  const envs: FeatureEnv[] = [];
  _featureRunDeps.runFeatureMachine = async (env) => {
    envs.push(env);
    return { ...env.record, step: "done", outcome: "draft", passed: false, reasons: ["CI failed"], url: "u" };
  };
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
  return { fc, input, envs, featureDir, runtime, disposed: () => disposed };
}

async function seedFinished(
  featureDir: string,
  feature: string,
  over: {
    outcome: "ready" | "draft" | "local-only" | "pushed";
    url?: string;
    head?: string;
    passed?: boolean;
    finalGates?: { ran: string[]; failing: string[] };
    flaggedDecisions?: readonly string[];
  },
): Promise<void> {
  const prior = join(featureDir, "r-old");
  await upsertStoryRecord(prior, { runId: "r-old", feature }, newStoryRecord("US-001", 5, "t"));
  await upsertFeatureRecord(
    prior,
    { runId: "r-old", feature },
    { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), step: "done", head: "headX", passed: true, ...over },
  );
}

describe("runWorkflowFeature releases the run's tool-error claims (nax#2491 P8)", () => {
  test("the claimed-row ledger for the run is dropped when the feature workflow ends", async () => {
    const { input, runtime } = setup();
    const out = makeTempDir("wf-claims-");
    dirs.push(out);
    const calls = [1, 2, 3].map(() => ({ tool: "Edit", outcome: "error", input: { file_path: "a.ts" } }));
    await Bun.write(join(out, "tool-audit", "f", `${runtime.runId}-9999999999999-s.json`), JSON.stringify({ calls }));
    await withToolErrorOutcome(
      { outputDir: out, feature: "f", runId: runtime.runId, storyId: "_run", now: () => 0 },
      "x",
      async () => {},
    );
    expect(toolErrorClaimsHeld(runtime.runId)).toBe(true);
    await runWorkflowFeature(input);
    expect(toolErrorClaimsHeld(runtime.runId)).toBe(false);
  });
});

describe("runWorkflowFeature", () => {
  test("dry run: skipped before any context is built", async () => {
    const { input, envs, disposed } = setup({ dryRun: true });
    expect(await runWorkflowFeature(input)).toBeNull();
    expect(envs).toHaveLength(0);
    expect(disposed()).toBe(0);
  });

  test("a fresh feature: new record at repo-gates; the result comes from the final record", async () => {
    const { input, envs, disposed } = setup();
    const result = await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("repo-gates");
    expect(result).toEqual({ passed: false, outcome: "draft", url: "u", reasons: ["CI failed"] });
    expect(disposed()).toBe(1);
  });

  test("an unfinished prior record is resumed (P4-R1)", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "branch-fix",
      },
    );
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("branch-fix");
  });

  // nax#2550: the record remembers the HEAD it started on; a moved HEAD voids its gates and review.
  test("a resumed record whose HEAD moved restarts at repo-gates, keeping its counters", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t0", seed: "s", minors: [] }),
        step: "branch-fix",
        startHead: "oldHead",
        repoGates: { ran: ["test"], failing: [] },
        reviewOpen: [{ id: "B3", kind: "spec", severity: "important", issue: "stale" }],
        nextFindingId: 4,
        fixBase: "oldBase",
        timings: { "repo-gates": 7 },
      },
    );
    await runWorkflowFeature(input);
    const rec = envs[0]?.record;
    expect(rec?.step).toBe("repo-gates");
    expect(rec?.startHead).toBe("headX");
    expect(rec?.repoGates).toBeUndefined();
    expect(rec?.reviewOpen).toEqual([]);
    expect(rec?.fixBase).toBeUndefined();
    expect(rec?.startedAt).toBe("t0");
    expect(rec?.nextFindingId).toBe(4);
    expect(rec?.timings).toEqual({ "repo-gates": 7 });
  });

  // The workflow's own fix commit moves HEAD; the resume compares against the HEAD it recorded.
  test("a crash after branch-fix with HEAD at the fix commit resumes at branch-rereview, not a restart", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "branch-rereview",
        startHead: "oldHead",
        lastHead: "headX",
        fixBase: "oldHead",
        fixRan: true,
        fixRounds: 1,
      },
    );
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("branch-rereview");
    expect(envs[0]?.record.fixRounds).toBe(1);
  });

  test("a human commit on top of the recorded lastHead restarts at repo-gates", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "branch-rereview",
        startHead: "oldHead",
        lastHead: "fixCommit",
        fixRan: true,
        fixRounds: 1,
      },
    );
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("repo-gates");
    expect(envs[0]?.record.lastHead).toBeUndefined();
  });

  test("a resumed record on the same HEAD resumes where it was", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), step: "branch-fix", startHead: "headX" },
    );
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("branch-fix");
  });

  test("a resume whose HEAD cannot be read restarts at repo-gates rather than trusting stale state", async () => {
    const { input, envs, featureDir } = setup();
    _workflowDeps.git = async () => ({ stdout: "", stderr: "boom", exitCode: 128 });
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), step: "branch-fix", startHead: "headX" },
    );
    await runWorkflowFeature(input);
    expect(envs[0]?.record.step).toBe("repo-gates");
  });

  test("an already-finished skip recomputes passed from the current stories and gates", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, {
      outcome: "ready",
      passed: true,
      finalGates: { ran: ["test"], failing: ["test"] },
    });
    const result = await runWorkflowFeature(input);
    expect(result).toMatchObject({ outcome: "already-finished", passed: false });
    expect(envs).toHaveLength(0);
  });

  test("a failed HEAD read is never a match for a prior record stored with an empty head", async () => {
    const { input, envs, featureDir } = setup();
    _workflowDeps.git = async () => ({ stdout: "", stderr: "boom", exitCode: 128 });
    await seedFinished(featureDir, input.feature, { outcome: "ready", head: "" });
    const result = await runWorkflowFeature(input);
    expect(result?.outcome).not.toBe("already-finished");
    expect(envs).toHaveLength(1);
  });

  test("a finished prior record at the same HEAD skips the machine (already finished)", async () => {
    const { input, envs, featureDir } = setup();
    const prior = join(featureDir, "r-old");
    await upsertStoryRecord(prior, { runId: "r-old", feature: input.feature }, newStoryRecord("US-001", 5, "t"));
    await upsertFeatureRecord(
      prior,
      { runId: "r-old", feature: input.feature },
      {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        step: "done",
        head: "headX",
        passed: true,
        outcome: "ready",
        url: "https://gh/pr/1",
      },
    );
    expect(await runWorkflowFeature(input)).toEqual({
      passed: true,
      outcome: "already-finished",
      url: "https://gh/pr/1",
      reasons: [],
    });
    expect(envs).toHaveLength(0);
  });

  test("an already-finished skip still emits the done status block", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "draft", url: "https://gh/pr/2" });
    const blocks: WorkflowStatusBlock[] = [];
    await runWorkflowFeature({ ...input, statusWriter: { setWorkflowStatus: (b) => blocks.push(b) } });
    expect(blocks).toEqual([
      {
        step: "done",
        stories: { "US-001": { state: "complete", round: 0 } },
        outcome: "draft",
        url: "https://gh/pr/2",
        // US-004: the prior record is a passed workflow, so its verdict rides the block.
        passed: true,
      },
    ]);
  });

  test("an already-finished skip carries the prior record's flagged rulings into the done block (US-005)", async () => {
    const { input, featureDir } = setup();
    await seedFinished(featureDir, input.feature, {
      outcome: "draft",
      url: "https://gh/pr/2",
      flaggedDecisions: ["D-1", "D-3"],
    });
    const blocks: WorkflowStatusBlock[] = [];
    await runWorkflowFeature({ ...input, statusWriter: { setWorkflowStatus: (b) => blocks.push(b) } });
    expect(blocks).toEqual([
      {
        step: "done",
        stories: { "US-001": { state: "complete", round: 0 } },
        outcome: "draft",
        url: "https://gh/pr/2",
        passed: true,
        flagged: ["D-1", "D-3"],
      },
    ]);
  });

  test("a draft prior at the same HEAD is also skipped", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "draft" });
    expect((await runWorkflowFeature(input))?.outcome).toBe("already-finished");
    expect(envs).toHaveLength(0);
  });

  test("AC-18: a pushed prior at the same HEAD is also skipped", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "pushed" });
    expect((await runWorkflowFeature(input))?.outcome).toBe("already-finished");
    expect(envs).toHaveLength(0);
  });

  test("a local-only prior at the same HEAD runs again (nothing was published)", async () => {
    const { input, envs, featureDir } = setup();
    await seedFinished(featureDir, input.feature, { outcome: "local-only" });
    const result = await runWorkflowFeature(input);
    expect(envs).toHaveLength(1);
    expect(envs[0]?.record.step).toBe("repo-gates");
    expect(result?.outcome).toBe("draft");
  });

  test("the token meter is unsubscribed even when the context build throws", async () => {
    const { input, runtime } = setup();
    const bus = runtime.dispatchEvents;
    const realOn = bus.onDispatch.bind(bus);
    let unsubscribed = 0;
    spyOn(bus, "onDispatch").mockImplementation((listener) => {
      const stop = realOn(listener);
      return () => {
        unsubscribed++;
        stop();
      };
    });
    _featureRunDeps.buildFeatureContext = async () => {
      throw new Error("context broke");
    };
    await expect(runWorkflowFeature(input)).rejects.toThrow("context broke");
    expect(unsubscribed).toBe(1);
  });

  test("a machine throw still disposes and propagates", async () => {
    const { input, disposed } = setup();
    _featureRunDeps.runFeatureMachine = async () => {
      throw new Error("boom");
    };
    await expect(runWorkflowFeature(input)).rejects.toThrow("boom");
    expect(disposed()).toBe(1);
  });

  test("logs the hand-off from the story loops to the feature workflow, with the stories' duration", async () => {
    const { input } = setup();
    resetLogger();
    const logs: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    try {
      await runWorkflowFeature({ ...input, storiesDurationMs: 8_393_000 });
    } finally {
      resetLogger();
    }
    expect(logs.map((e) => e.message)).toContain("stories done 1/1 (139m 53s) - feature workflow start");
  });
});

describe("US-002 transient drafts", () => {
  test.each([
    ["AC-6/7", "unavailable", []],
    ["AC-8", "green", ["PR update failed: timeout"]],
    ["AC-9", "green", ["review unread: src/a.ts"]],
    // US-003 (AC-11): a pending CI keeps the PR a draft, so the draft is published again.
    ["AC-11", "pending", ["no CI result within 1200000ms"]],
  ] as const)("%s", async (_ac, ci, reasons) => {
    const { input, featureDir } = setup();
    const prior = {
      ...newFeatureRecord({ now: "original", seed: "s", minors: [] }),
      step: "done" as const,
      outcome: "draft" as const,
      ci,
      reasons,
      head: "headX",
      url: "old-url",
      reviewRan: true,
      repoGates: { ran: ["test"], failing: [] },
      timings: { "branch-review": 7 },
    };
    await upsertFeatureRecord(join(featureDir, "r-old"), { runId: "r-old", feature: input.feature }, prior);
    const calls: string[] = [];
    _featureRunDeps.runFeatureMachine = async (env) => {
      expect(env.record).toEqual({ ...prior, step: "publish" });
      return runFeatureMachine({
        ...env,
        steps: {
          ...env.steps,
          branchReview: async () => {
            calls.push("review");
            throw new Error("unexpected review");
          },
          publish: async () => {
            calls.push("publish");
            return { outcome: "draft", ci: "green", reasons: [] };
          },
          head: async () => "headX",
        },
      });
    };
    const result = await runWorkflowFeature(input);
    if (_ac === "AC-9") {
      expect(result?.outcome).toBe("already-finished");
      expect(calls).toEqual([]);
    } else {
      expect(calls).toEqual(["publish"]);
      expect(result?.url).toBe("old-url");
    }
  });

  // US-003 (AC-12/AC-13): only the pending CI alone makes the draft retryable. A draft held for a
  // second reason is finished at this HEAD, so no machine runs.
  test("AC-12/AC-13: a pending draft with two reasons is already finished: no machine runs", async () => {
    const { input, envs, featureDir } = setup();
    const prior = {
      ...newFeatureRecord({ now: "original", seed: "s", minors: [] }),
      step: "done" as const,
      outcome: "draft" as const,
      ci: "pending" as const,
      reasons: ["no CI result within 1200000ms", "branch review did not read 1 changed file(s): src/a.ts"],
      head: "headX",
      url: "old-url",
      reviewRan: true,
      repoGates: { ran: ["test"], failing: [] },
    };
    await upsertFeatureRecord(join(featureDir, "r-old"), { runId: "r-old", feature: input.feature }, prior);
    const result = await runWorkflowFeature(input);
    expect(result?.outcome).toBe("already-finished");
    expect(envs).toHaveLength(0);
  });

  test("B1: the verdict of a re-publish that asked no advisor lists no earlier hold", async () => {
    const { input, featureDir } = setup();
    const prior = {
      ...newFeatureRecord({ now: "original", seed: "s", minors: [] }),
      step: "done" as const,
      outcome: "draft" as const,
      ci: "unavailable" as const,
      reasons: ["PR update failed: timeout"],
      head: "headX",
      url: "old-url",
      reviewRan: true,
      repoGates: { ran: ["test"], failing: [] },
      approval: { approved: false, rationale: "advisor held: earlier", decisionId: "D-1" },
      ciDetail: "gh: 502",
    };
    await upsertFeatureRecord(join(featureDir, "r-old"), { runId: "r-old", feature: input.feature }, prior);
    _featureRunDeps.runFeatureMachine = async (env) => {
      // The premise: the resume hands the earlier publish's own facts to this one.
      expect(env.record.approval).toEqual(prior.approval);
      return runFeatureMachine({
        ...env,
        steps: {
          ...env.steps,
          // This publish asked no advisor: a failed CI is a deterministic reason.
          publish: async () => ({ outcome: "draft", ci: "failed", reasons: ["CI failed"] }),
          head: async () => "headX",
        },
      });
    };
    await runWorkflowFeature(input);
    const written = await readResult(join(featureDir, "r-now"));
    expect("approval" in (written?.featureWorkflow ?? {})).toBe(false);
    expect("ciDetail" in (written?.featureWorkflow ?? {})).toBe(false);
    expect(written?.verdict?.openItems.filter((i) => i.kind === "advisor")).toEqual([]);
  });
});
