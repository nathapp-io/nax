/** Builds the StepContext and wires the real steps, sink and advisor into a StoryLoopEnv (Task 10's contract). */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveWorkflowConfig } from "@/config";
import { _workflowResumeDeps, headsUpChannel } from "@/execution";
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
import { storyWorkEvidence } from "./no-work";
import { workflowFeatureDir, workflowRunDir, workflowStoryDir } from "./paths";
import { runReReview } from "./re-review";
import { loadPriorStory, newStoryRecord, upsertStoryRecord } from "./result";
import { _workflowDeps, type StepContext } from "./step-context";
import { storyModelFor } from "./step-model";
import { type StoryLoopEnv, type StoryLoopSteps, turnLabel } from "./story-loop";
import { runStoryReview } from "./story-review";
import { addRoleTokens } from "./tokens";
import { withToolErrorOutcome } from "./tool-error-outcome";
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
  const runDir = workflowRunDir(ctx.projectDir, feature, runId);
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
  const priorStory = await loadPriorStory(workflowFeatureDir(ctx.projectDir, feature), runId, ctx.story.id);
  const prior = priorStory?.record ?? null;
  const resume = resumablePrior(prior, ctx.story.id);
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
  // nax#2491 P8: after an agent step, say what became of any session's repeated tool errors.
  const toolErrors = <T>(label: string, run: () => Promise<T>): Promise<T> =>
    withToolErrorOutcome(
      { outputDir, feature, runId, storyId: ctx.story.id, now: () => _workflowDeps.now() },
      `${ctx.story.id} ${label}`,
      run,
    );
  const steps: StoryLoopSteps = {
    implement: timed("implement", addTiming, (turn) => toolErrors(turnLabel(turn), () => runImplementerTurn(sc, turn))),
    gates: timed("gates", addTiming, () => runStoryGates(sc)),
    fullSuite: timed("full-suite", addTiming, () => runWorkflowSuiteGate(sc)),
    storyReview: timed("story-review", addTiming, (concerns) =>
      toolErrors("story-review", () => runStoryReview(sc, concerns)),
    ),
    reReview: timed("re-review", addTiming, (round, findings, fixBase) =>
      toolErrors(`re-review r${round}`, () => runReReview(sc, round, findings, fixBase)),
    ),
    head: () => readHead(sc.projectDir),
    uncommitted: () => listUncommitted(sc.projectDir),
    workProduced: () => storyWorkEvidence(sc),
    modelFor: storyModelFor(sc),
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
        // Per-role tokens add to a resumed record's prior totals instead of replacing them.
        const tokens = patch.tokensByRole
          ? { tokensByRole: addRoleTokens(record.tokensByRole ?? {}, patch.tokensByRole) }
          : {};
        record = { ...record, ...patch, ...tokens };
        await upsertStoryRecord(runDir, header, record);
      },
      ledger: (text, options) => appendLedger(runDir, ctx.story.id, text, options),
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

/**
 * US-003 (nax#2511) — which prior workflow record this run resumes into.
 *
 * A crash during the first implement turn leaves nothing to resume into: start the
 * story over (a new session sees the uncommitted edits in the tree). Mid-loop records
 * resume (spec §10) — but only in the default `"auto"` mode: `--fresh` /
 * `--no-resume` restart the story from the top, which is the only signal that tells a
 * deliberate restart apart from a crash (workflow mode leaves the PRD story's `status`
 * and `attempts` untouched). The ignored record is logged and left on disk; this run
 * simply starts a fresh one and never reads the old one.
 *
 * Its own function so the resume decision does not grow `buildStoryEnv`, which is
 * close to its complexity budget, and so the phase rule reads in one place.
 */
function resumablePrior(prior: WorkflowStoryRecord | null, storyId: string): WorkflowStoryRecord | null {
  if (prior === null || prior.phase === "implement") return null;
  const mode = _workflowResumeDeps.mode;
  if (mode === "auto") return prior;
  getLogger().info("workflow", `Ignoring a prior run's workflow record (resume mode ${mode})`, {
    storyId,
    round: prior.round,
    phase: prior.phase,
  });
  return null;
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
