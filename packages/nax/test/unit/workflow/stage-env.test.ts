import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  type DeepPartial,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
import type { NaxConfig } from "@/config";
import { _workflowResumeDeps } from "@/execution";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { ICostAggregator } from "@/runtime";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { ledgerFilePath } from "@/workflow/ledger";
import { workflowRunDir, workflowStoryDir } from "@/workflow/paths";
import { newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";
import { buildStoryEnv } from "@/workflow/stage-env";
import { _workflowDeps } from "@/workflow/step-context";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function costAggregatorAt(totalCostUsd: number): ICostAggregator {
  const base = createNoOpCostAggregator();
  return { ...base, snapshot: () => ({ ...base.snapshot(), totalCostUsd }) };
}

function setup(opts: { costUsd?: number; workflow?: DeepPartial<NaxConfig>["workflow"] } = {}) {
  const outputDir = makeTempDir("wf-env-out-");
  const workdir = makeTempDir("wf-env-work-");
  dirs.push(outputDir, workdir);
  const config = makeNaxConfig({
    outputDir,
    execution: { costLimit: 5 },
    workflow: { maxFixRounds: 4, ...opts.workflow },
  });
  const runtime = makeMockRuntime({ config, workdir, costAggregator: costAggregatorAt(opts.costUsd ?? 0) });
  const ctx = makeTestContext({
    config,
    rootConfig: config,
    runtime,
    projectDir: workdir,
    workdir,
    storyGitRef: "base123",
    prd: { ...makeTestContext().prd, feature: "feat" },
  });
  return { ctx, runtime, outputDir, runDir: workflowRunDir(workdir, "feat", runtime.runId) };
}

async function seedPrior(projectDir: string, storyId: string, phase: "implement" | "fix", round: number) {
  const priorDir = workflowRunDir(projectDir, "feat", "prior-run");
  await upsertStoryRecord(
    priorDir,
    { runId: "prior-run", feature: "feat" },
    { ...newStoryRecord(storyId, 9, "t0"), phase, round },
  );
}

describe("buildStoryEnv", () => {
  test("a prior record still in the first implement turn does not resume", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "implement", 0);
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).toBeNull();
  });

  test("a mid-loop prior record resumes with maxRounds from the current workflow config", async () => {
    const { ctx, runDir } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume?.round).toBe(2);
    expect(env.resume?.phase).toBe("fix");
    expect(env.resume?.maxRounds).toBe(4);
    expect(env.maxFixRounds).toBe(4);
    const written = (await readResult(runDir))?.stories[ctx.story.id];
    expect(written?.maxRounds).toBe(4);
    expect(await Bun.file(ledgerFilePath(runDir)).text()).toContain("resumed at round 2");
  });

  test("resuming across two runIds carries the prior brief and report into this run's story dir", async () => {
    const { ctx, runtime } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    const priorStoryDir = workflowStoryDir(workflowRunDir(ctx.projectDir, "feat", "prior-run"), ctx.story.id);
    await Bun.write(join(priorStoryDir, "brief.md"), "prior brief");
    await Bun.write(join(priorStoryDir, "report.md"), "prior report");
    expect(runtime.runId).not.toBe("prior-run");
    const { sc, env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).not.toBeNull();
    expect(await Bun.file(sc.briefPath).text()).toBe("prior brief");
    expect(await Bun.file(sc.reportPath).text()).toBe("prior report");
  });

  test("resuming with no prior brief or report leaves them absent (the stage rewrites the brief)", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 1);
    const { sc } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await Bun.file(sc.briefPath).exists()).toBe(false);
    expect(await Bun.file(sc.reportPath).exists()).toBe(false);
  });

  test("closeOnError closes the record gate-open with the error reason", async () => {
    const { ctx, runDir } = setup();
    const { closeOnError } = await buildStoryEnv(ctx, makeMockCallContext());
    await closeOnError("disk full");
    const rec = (await readResult(runDir))?.stories[ctx.story.id];
    expect(rec).toMatchObject({ state: "complete-gate-open", reason: "workflow error: disk full", phase: "closed" });
    expect(typeof rec?.endedAt).toBe("string");
  });

  test("closeOnError reports the closed phase", async () => {
    const { ctx } = setup();
    const phases: string[] = [];
    ctx.reportPhase = (phase) => phases.push(phase);
    const { closeOnError } = await buildStoryEnv(ctx, makeMockCallContext());
    phases.length = 0;
    await closeOnError("disk full");
    expect(phases).toEqual(["closed"]);
  });

  test("ensures the ledger and a fresh result record", async () => {
    const { ctx, runDir } = setup();
    const { sc } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await Bun.file(ledgerFilePath(runDir)).text()).toContain("# Workflow ledger");
    expect((await readResult(runDir))?.stories[ctx.story.id]?.phase).toBe("implement");
    expect(sc.base).toBe("base123");
    expect(sc.briefPath).toBe(join(sc.storyDir, "brief.md"));
    expect(sc.feature).toBe("feat");
  });

  test("costExceeded is false below the limit and true at or above it", async () => {
    const below = setup({ costUsd: 4.99 });
    expect((await buildStoryEnv(below.ctx, makeMockCallContext())).env.steps.costExceeded()).toBe(false);
    const at = setup({ costUsd: 5 });
    expect((await buildStoryEnv(at.ctx, makeMockCallContext())).env.steps.costExceeded()).toBe(true);
    const above = setup({ costUsd: 7 });
    expect((await buildStoryEnv(above.ctx, makeMockCallContext())).env.steps.costExceeded()).toBe(true);
  });

  test("sink.update persists a merged record to result.json", async () => {
    const { ctx, runDir } = setup();
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    await env.sink.update({ phase: "gates", round: 1 });
    await env.sink.update({ rulings: 2 });
    const rec = (await readResult(runDir))?.stories[ctx.story.id];
    expect(rec).toMatchObject({ phase: "gates", round: 1, rulings: 2, maxRounds: 4 });
  });

  test("sink.update merges tokensByRole into a resumed record's prior totals", async () => {
    const { ctx, runDir } = setup();
    const priorDir = workflowRunDir(ctx.projectDir, "feat", "prior-run");
    await upsertStoryRecord(
      priorDir,
      { runId: "prior-run", feature: "feat" },
      {
        ...newStoryRecord(ctx.story.id, 9, "t0"),
        phase: "fix",
        round: 1,
        tokensByRole: { "wf-implementer": { inputTokens: 100, outputTokens: 10, costUsd: 1, calls: 2 } },
      },
    );
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    await env.sink.update({
      tokensByRole: {
        "wf-implementer": { inputTokens: 5, outputTokens: 1, costUsd: 0.5, calls: 1 },
        "wf-reviewer": { inputTokens: 7, outputTokens: 2, costUsd: 0.25, calls: 1 },
      },
    });
    const rec = (await readResult(runDir))?.stories[ctx.story.id];
    expect(rec?.tokensByRole).toEqual({
      "wf-implementer": { inputTokens: 105, outputTokens: 11, costUsd: 1.5, calls: 3 },
      "wf-reviewer": { inputTokens: 7, outputTokens: 2, costUsd: 0.25, calls: 1 },
    });
  });

  test("sink.ledger appends a story line", async () => {
    const { ctx, runDir } = setup();
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    await env.sink.ledger("hello");
    expect(await Bun.file(ledgerFilePath(runDir)).text()).toContain(`${ctx.story.id}: hello`);
  });

  test("sc.outputDir is the runtime output dir", async () => {
    const { ctx } = setup();
    const { sc } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(sc.outputDir).toBe(ctx.runtime.outputDir);
  });

  // US-006 (nax#2527): the loop's gate states survive the timed/toolErrors adapters into the prompt.
  test("the storyReview step forwards the loop's gate states into the review prompt", async () => {
    const { ctx } = setup();
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    const seen: unknown[] = [];
    const original = { ..._workflowDeps };
    _workflowDeps.callOp = makeScriptedCallOp((_op, input) => {
      seen.push(input);
      return { spec: "pass", quality: "approved", findings: [], cannotVerify: [], inspectedFiles: [] };
    });
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    try {
      await env.steps.storyReview([], { lint: "red" });
    } finally {
      Object.assign(_workflowDeps, original);
    }
    expect((seen[0] as { prompt: string }).prompt).toContain("lint red");
  });

  test("env.advisor is the live advisor: an implementer question reaches createAdvisor", async () => {
    const { ctx } = setup();
    const asked: QuestionDraft[] = [];
    const fake: Advisor = {
      advise: async (q) => {
        asked.push(q);
        return { decision: null };
      },
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
    };
    const original = _workflowDeps.createAdvisor;
    _workflowDeps.createAdvisor = () => fake;
    try {
      const { env } = await buildStoryEnv(ctx, makeMockCallContext());
      const answer = await env.advisor.answerQuestion({
        storyId: ctx.story.id,
        status: "BLOCKED",
        concerns: "which db?",
      });
      expect(answer).toBeNull();
      expect(asked[0]?.kind).toBe("implementer-question");
    } finally {
      _workflowDeps.createAdvisor = original;
    }
  });
});

/**
 * US-003 (nax#2511) — `run()`'s resume mode reaches workflow resume through the
 * `_workflowResumeDeps.mode` seam (written by `run()`, read by `buildStoryEnv`).
 * `nax run --fresh` / `--no-resume` must ignore a prior run's mid-loop record and
 * start the story over, which is the only signal that tells a deliberate restart
 * apart from a crash (workflow mode leaves the PRD story's status and attempts
 * untouched).
 */
describe("buildStoryEnv — workflow resume mode (US-003)", () => {
  let logs: LogEntry[] = [];
  const defaultMode = _workflowResumeDeps.mode;

  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });

  afterEach(() => {
    _workflowResumeDeps.mode = defaultMode;
    resetLogger();
  });

  const ignoreEntries = () => logs.filter((e) => e.message.startsWith("Ignoring a prior run's workflow record"));

  test("AC-1: mode fresh ignores a seeded mid-loop prior record (env.resume null)", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    _workflowResumeDeps.mode = "fresh";
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).toBeNull();
  });

  test("AC-2: mode fresh logs the ignored record, naming the mode and the story", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    _workflowResumeDeps.mode = "fresh";
    await buildStoryEnv(ctx, makeMockCallContext());
    const entry = logs.find((e) => e.message === "Ignoring a prior run's workflow record (resume mode fresh)");
    expect(entry?.level).toBe("info");
    expect(entry?.stage).toBe("workflow");
    expect(entry?.data?.storyId).toBe(ctx.story.id);
  });

  test("AC-3: mode no-resume ignores a seeded mid-loop prior record (env.resume null)", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    _workflowResumeDeps.mode = "no-resume";
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).toBeNull();
  });

  test("AC-4: the default mode still resumes the mid-loop record", async () => {
    expect(_workflowResumeDeps.mode).toBe("auto");
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume?.round).toBe(2);
  });

  test("AC-5: mode fresh writes a story record at round 0, phase implement", async () => {
    const { ctx, runDir } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    _workflowResumeDeps.mode = "fresh";
    await buildStoryEnv(ctx, makeMockCallContext());
    const written = (await readResult(runDir))?.stories[ctx.story.id];
    expect(written?.round).toBe(0);
    expect(written?.phase).toBe("implement");
  });

  test("AC-6: mode fresh writes no 'resumed at round' ledger line", async () => {
    const { ctx, runDir } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "fix", 2);
    _workflowResumeDeps.mode = "fresh";
    await buildStoryEnv(ctx, makeMockCallContext());
    expect(await Bun.file(ledgerFilePath(runDir)).text()).not.toContain("resumed at round");
  });

  test("AC-7: a prior record still in its first implement turn is not an ignored resume", async () => {
    const { ctx } = setup();
    await seedPrior(ctx.projectDir, ctx.story.id, "implement", 0);
    _workflowResumeDeps.mode = "fresh";
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).toBeNull();
    expect(ignoreEntries()).toHaveLength(0);
  });
});

/**
 * US-005: `buildStoryEnv` supplies the loop's changed-file evidence, the best-effort auto-commit,
 * the report check and the configured interrupt limits. Every test drives the real `buildStoryEnv`
 * through the `_workflowDeps` seams, so what is asserted is the producer-consumer connection — not
 * that an optional field exists.
 */
describe("buildStoryEnv — evidence and interrupt steps (US-005)", () => {
  const original = { ..._workflowDeps };

  afterEach(() => {
    Object.assign(_workflowDeps, original);
  });

  /** Answer the two reads behind the evidence steps; `diff` is the committed list, `status` the dirty one. */
  function stubGit(diff: string, status: string, diffExitCode = 0): string[][] {
    const calls: string[][] = [];
    let head = 0;
    _workflowDeps.git = async (args, _cwd) => {
      calls.push(args);
      // US-007 F1: the auto-commit seam reports a commit only when HEAD moves, so give it a moving sha.
      if (args[0] === "rev-parse") return { stdout: `h${++head}\n`, exitCode: 0 };
      return args[0] === "diff" ? { stdout: diff, exitCode: diffExitCode } : { stdout: status, exitCode: 0 };
    };
    return calls;
  }

  test("AC-3: interrupt carries the configured attempt count and both step limits", async () => {
    const { ctx } = setup({
      workflow: { interruptRetry: { maxAttempts: 2 }, timeouts: { implementMs: 5_400_000, fixMs: 3_600_000 } },
    });
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.interrupt).toEqual({ maxAttempts: 2, implementMs: 5_400_000, fixMs: 3_600_000 });
  });

  test("AC-3: both limits come from the workflow config, not the defaults", async () => {
    const { ctx } = setup({
      workflow: { interruptRetry: { maxAttempts: 0 }, timeouts: { implementMs: 1_800_000, fixMs: 1_200_000 } },
    });
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.interrupt).toEqual({ maxAttempts: 0, implementMs: 1_800_000, fixMs: 1_200_000 });
  });

  test("AC-4: steps.reportExists follows the story's report.md", async () => {
    const { ctx } = setup();
    const { sc, env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await env.steps.reportExists?.()).toBe(false);
    await Bun.write(sc.reportPath, "# report\n");
    expect(await env.steps.reportExists?.()).toBe(true);
  });

  test("AC-5: steps.workSinceBase reads the diff and the dirty list through _workflowDeps.git", async () => {
    const { ctx } = setup();
    const calls = stubGit("src/a.ts\n", "?? src/b.ts\n");
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await env.steps.workSinceBase?.()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls.some((args) => args[0] === "diff")).toBe(true);
    expect(calls.some((args) => args[0] === "status")).toBe(true);
  });

  test("AC-6: steps.autoCommitDirty commits the dirty tree once and answers true", async () => {
    const { ctx } = setup();
    stubGit("", " M src/a.ts\n");
    const commits: string[][] = [];
    _workflowDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
      commits.push([workdir, stage, role, storyId]);
    };
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await env.steps.autoCommitDirty?.()).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.[3]).toBe(ctx.story.id);
  });

  test("AC-6: steps.autoCommitDirty does not commit a clean tree", async () => {
    const { ctx } = setup();
    stubGit("", "");
    const commits: string[][] = [];
    _workflowDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
      commits.push([workdir, stage, role, storyId]);
    };
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await env.steps.autoCommitDirty?.()).toBe(false);
    expect(commits).toHaveLength(0);
  });

  test("AC-7: workProduced still counts a written report as work when git sees nothing", async () => {
    const { ctx } = setup();
    stubGit("", "");
    const { sc, env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(await env.steps.workProduced?.()).toBe(false);
    await Bun.write(sc.reportPath, "# report\n");
    expect(await env.steps.workProduced?.()).toBe(true);
  });
});
