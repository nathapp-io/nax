/** Builds the StepContext and wires the real steps, sink and advisor into a StoryLoopEnv (Task 10's contract). */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveWorkflowConfig } from "@/config";
import { headsUpChannel } from "@/execution";
import { getLogger } from "@/logger";
import type { CallContext } from "@/operations/types";
import type { PipelineContext } from "@/pipeline/types";
import { totalSpendUsd } from "@/runtime";
import { resolveTestFilePatterns } from "@/test-runners";
import { packageDirRelative } from "@/utils/paths";
import { createLiveWorkflowAdvisor, dependentsOf } from "./advisor-live";
import { specPathFor } from "./brief";
import { runStoryGates, runWorkflowSuiteGate } from "./gates";
import { listUncommitted, readHead } from "./git";
import { runImplementerTurn } from "./implement";
import { appendLedger, ensureLedger } from "./ledger";
import { workflowFeatureDir, workflowRunDir, workflowStoryDir } from "./paths";
import { runReReview } from "./re-review";
import { loadPriorStory, newStoryRecord, upsertStoryRecord } from "./result";
import { _workflowDeps, type StepContext } from "./step-context";
import type { StoryLoopEnv, StoryLoopSteps } from "./story-loop";
import { runStoryReview } from "./story-review";
import type { WorkflowStoryRecord } from "./types";

function timed<A extends unknown[], R>(
  name: string,
  add: (step: string, ms: number) => void,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const start = _workflowDeps.now();
    try {
      return await fn(...args);
    } finally {
      add(name, _workflowDeps.now() - start);
    }
  };
}

export async function buildStoryEnv(
  ctx: PipelineContext,
  callCtx: CallContext,
): Promise<{ sc: StepContext; env: StoryLoopEnv; closeOnError: (reason: string) => Promise<void> }> {
  const feature = ctx.prd.feature;
  const { outputDir, runId } = ctx.runtime;
  const runDir = workflowRunDir(outputDir, feature, runId);
  const storyDir = workflowStoryDir(runDir, ctx.story.id);
  const workflow = resolveWorkflowConfig(ctx.rootConfig);
  const base = ctx.storyGitRef ?? (await readHead(ctx.projectDir));
  const sc: StepContext = {
    callCtx,
    story: ctx.story,
    config: ctx.config,
    workflow,
    tierOrder: ctx.rootConfig.autoMode.escalation.tierOrder,
    feature,
    projectDir: ctx.projectDir,
    workdir: ctx.workdir,
    runDir,
    outputDir,
    storyDir,
    briefPath: join(storyDir, "brief.md"),
    reportPath: join(storyDir, "report.md"),
    base,
    runSignal: ctx.abortSignal,
    sessionManager: ctx.sessionManager,
    dryRun: ctx.runtime.dryRun === true,
    sessionScratchDir: ctx.sessionScratchDir,
    naxIgnoreIndex: ctx.naxIgnoreIndex,
    resolvedTestPatterns: await resolveTestFilePatterns(
      ctx.config,
      ctx.projectDir,
      packageDirRelative(ctx.projectDir, ctx.workdir),
    ),
    contextMarkdown: ctx.contextMarkdown,
    featureContextMarkdown: ctx.featureContextMarkdown,
    constitution: ctx.constitution?.content,
  };

  await ensureLedger(runDir, runId, feature);
  const priorStory = await loadPriorStory(workflowFeatureDir(outputDir, feature), runId, ctx.story.id);
  const prior = priorStory?.record ?? null;
  // A crash during the first implement turn leaves nothing to resume into: start the story over
  // (a new session sees the uncommitted edits in the tree). Mid-loop records resume (spec §10).
  const resume = prior && prior.phase !== "implement" ? prior : null;
  const resumeRecord: WorkflowStoryRecord | null = resume ? { ...resume, maxRounds: workflow.maxFixRounds } : null;
  let record: WorkflowStoryRecord =
    resumeRecord ?? newStoryRecord(ctx.story.id, workflow.maxFixRounds, new Date().toISOString());
  const header = { runId, feature };
  await upsertStoryRecord(runDir, header, record);
  if (resume && priorStory) {
    await carryOverArtifacts(workflowStoryDir(priorStory.runDir, ctx.story.id), storyDir, ctx.story.id);
    await appendLedger(runDir, ctx.story.id, `resumed at round ${resume.round} (prior record, warm session gone)`);
    getLogger().info("workflow", "Resuming story from a prior run", { storyId: ctx.story.id, round: resume.round });
  }

  const addTiming = (step: string, ms: number): void => {
    record = { ...record, timings: { ...record.timings, [step]: (record.timings[step] ?? 0) + ms } };
  };
  const costLimit = ctx.rootConfig.execution.costLimit;
  const steps: StoryLoopSteps = {
    implement: timed("implement", addTiming, (turn) => runImplementerTurn(sc, turn)),
    gates: timed("gates", addTiming, () => runStoryGates(sc)),
    fullSuite: timed("full-suite", addTiming, () => runWorkflowSuiteGate(sc)),
    storyReview: timed("story-review", addTiming, (concerns) => runStoryReview(sc, concerns)),
    reReview: timed("re-review", addTiming, (round, findings, fixBase) => runReReview(sc, round, findings, fixBase)),
    head: () => readHead(sc.projectDir),
    uncommitted: () => listUncommitted(sc.projectDir),
    costExceeded: () =>
      typeof costLimit === "number" &&
      costLimit > 0 &&
      totalSpendUsd(ctx.runtime.costAggregator.snapshot()) >= costLimit,
  };
  const env: StoryLoopEnv = {
    storyId: ctx.story.id,
    maxFixRounds: workflow.maxFixRounds,
    steps,
    advisor: createLiveWorkflowAdvisor({
      advisor: _workflowDeps.createAdvisor({
        callCtx,
        repoRoot: ctx.projectDir,
        outputDir,
        feature,
        runId,
        specPath: await specPathFor(feature, ctx.projectDir),
        workdir: ctx.workdir,
        ...headsUpChannel(ctx),
      }),
      feature,
      storyId: ctx.story.id,
      dependents: dependentsOf(ctx.prd, ctx.story.id),
    }),
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
        await upsertStoryRecord(runDir, header, record);
      },
      ledger: (text) => appendLedger(runDir, ctx.story.id, text),
    },
    resume: resumeRecord,
  };
  // Error containment (W-R3): the stage swallowed a non-abort error, so close the record gate-open
  // rather than leave it mid-loop. Best-effort, like the ledger line.
  const closeOnError = async (reason: string): Promise<void> => {
    try {
      record = {
        ...record,
        state: "complete-gate-open",
        reason: `workflow error: ${reason}`,
        phase: "closed",
        endedAt: new Date().toISOString(),
      };
      await upsertStoryRecord(runDir, header, record);
    } catch (err) {
      getLogger().debug("workflow", "Record close failed on the error path", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }
  };
  return { sc, env, closeOnError };
}

/** The resumed implementer and reviewers read brief.md / report.md from this run's story dir (spec §10). */
async function carryOverArtifacts(priorStoryDir: string, storyDir: string, storyId: string): Promise<void> {
  for (const name of ["brief.md", "report.md"]) {
    const src = Bun.file(join(priorStoryDir, name));
    try {
      if (await src.exists()) await Bun.write(join(storyDir, name), src);
    } catch (err) {
      getLogger().warn("workflow", `Could not carry ${name} over from the prior run`, {
        storyId,
        error: errorMessage(err),
      });
    }
  }
}
