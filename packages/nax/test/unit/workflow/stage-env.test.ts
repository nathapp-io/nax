import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
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

function setup(opts: { costUsd?: number } = {}) {
  const outputDir = makeTempDir("wf-env-out-");
  const workdir = makeTempDir("wf-env-work-");
  dirs.push(outputDir, workdir);
  const config = makeNaxConfig({
    outputDir,
    execution: { costLimit: 5 },
    workflow: { maxFixRounds: 4 },
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
  return { ctx, runtime, outputDir, runDir: workflowRunDir(runtime.outputDir, "feat", runtime.runId) };
}

async function seedPrior(runtimeOutputDir: string, storyId: string, phase: "implement" | "fix", round: number) {
  const priorDir = workflowRunDir(runtimeOutputDir, "feat", "prior-run");
  await upsertStoryRecord(
    priorDir,
    { runId: "prior-run", feature: "feat" },
    { ...newStoryRecord(storyId, 9, "t0"), phase, round },
  );
}

describe("buildStoryEnv", () => {
  test("a prior record still in the first implement turn does not resume", async () => {
    const { ctx, runtime } = setup();
    await seedPrior(runtime.outputDir, ctx.story.id, "implement", 0);
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).toBeNull();
  });

  test("a mid-loop prior record resumes with maxRounds from the current workflow config", async () => {
    const { ctx, runtime, runDir } = setup();
    await seedPrior(runtime.outputDir, ctx.story.id, "fix", 2);
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
    await seedPrior(runtime.outputDir, ctx.story.id, "fix", 2);
    const priorStoryDir = workflowStoryDir(workflowRunDir(runtime.outputDir, "feat", "prior-run"), ctx.story.id);
    await Bun.write(join(priorStoryDir, "brief.md"), "prior brief");
    await Bun.write(join(priorStoryDir, "report.md"), "prior report");
    expect(runtime.runId).not.toBe("prior-run");
    const { sc, env } = await buildStoryEnv(ctx, makeMockCallContext());
    expect(env.resume).not.toBeNull();
    expect(await Bun.file(sc.briefPath).text()).toBe("prior brief");
    expect(await Bun.file(sc.reportPath).text()).toBe("prior report");
  });

  test("resuming with no prior brief or report leaves them absent (the stage rewrites the brief)", async () => {
    const { ctx, runtime } = setup();
    await seedPrior(runtime.outputDir, ctx.story.id, "fix", 1);
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
    const { ctx, runtime, runDir } = setup();
    const priorDir = workflowRunDir(runtime.outputDir, "feat", "prior-run");
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
