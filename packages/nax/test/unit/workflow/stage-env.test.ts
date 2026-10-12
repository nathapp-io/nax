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
import type { ICostAggregator } from "@/runtime";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { ledgerFilePath } from "@/workflow/ledger";
import { workflowRunDir } from "@/workflow/paths";
import { newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";
import { buildStoryEnv } from "@/workflow/stage-env";

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

  test("sink.ledger appends a story line", async () => {
    const { ctx, runDir } = setup();
    const { env } = await buildStoryEnv(ctx, makeMockCallContext());
    await env.sink.ledger("hello");
    expect(await Bun.file(ledgerFilePath(runDir)).text()).toContain(`${ctx.story.id}: hello`);
  });
});
