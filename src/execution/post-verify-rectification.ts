/**
 * Post-Verify Rectification Loop
 *
 * Extracted from post-verify.ts: rectification retry loop and
 * failure reversion logic shared by both scoped and regression paths.
 */

import { getAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PRD, UserStory } from "../prd";
import { getExpectedFiles, savePRD } from "../prd";
import { appendProgress } from "./progress";
import { type RectificationState, createRectificationPrompt, shouldRetryRectification } from "./rectification";
import { parseBunTestOutput } from "./test-output-parser";
import { runVerification } from "./verification";

export interface RectificationLoopOptions {
  config: NaxConfig;
  workdir: string;
  story: UserStory;
  testCommand: string;
  timeoutSeconds: number;
  testOutput: string;
  promptPrefix?: string;
}

/**
 * Run the rectification retry loop. Returns true if rectification fixed all failures.
 */
export async function runRectificationLoop(opts: RectificationLoopOptions): Promise<boolean> {
  const { config, workdir, story, testCommand, timeoutSeconds, testOutput, promptPrefix } = opts;
  const logger = getSafeLogger();

  const rectificationConfig = config.execution.rectification;
  const testSummary = parseBunTestOutput(testOutput);

  const rectificationState: RectificationState = {
    attempt: 0,
    initialFailures: testSummary.failed,
    currentFailures: testSummary.failed,
  };

  const label = promptPrefix ? "regression rectification" : "rectification";
  logger?.info("rectification", `Starting ${label} loop`, {
    storyId: story.id,
    initialFailures: rectificationState.initialFailures,
    maxRetries: rectificationConfig.maxRetries,
  });

  while (shouldRetryRectification(rectificationState, rectificationConfig)) {
    rectificationState.attempt++;

    logger?.info(
      "rectification",
      `${label} attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`,
      { storyId: story.id, currentFailures: rectificationState.currentFailures },
    );

    let rectificationPrompt = createRectificationPrompt(testSummary.failures, story, rectificationConfig);
    if (promptPrefix) {
      rectificationPrompt = `${promptPrefix}\n\n${rectificationPrompt}`;
    }

    const agent = getAgent(config.autoMode.defaultAgent);
    if (!agent) {
      logger?.error("rectification", "Agent not found, cannot retry");
      break;
    }

    const modelTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
    const modelDef = resolveModel(config.models[modelTier]);

    const agentResult = await agent.run({
      prompt: rectificationPrompt,
      workdir,
      modelTier,
      modelDef,
      timeoutSeconds: config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: config.execution.dangerouslySkipPermissions,
    });

    if (!agentResult.success) {
      logger?.warn("rectification", `Agent ${label} session failed`, {
        storyId: story.id,
        attempt: rectificationState.attempt,
      });
    }

    const retryVerification = await runVerification({
      workingDirectory: workdir,
      expectedFiles: getExpectedFiles(story),
      command: testCommand,
      timeoutSeconds,
      forceExit: config.quality.forceExit,
      detectOpenHandles: config.quality.detectOpenHandles,
      detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
      timeoutRetryCount: 0,
      gracePeriodMs: config.quality.gracePeriodMs,
      drainTimeoutMs: config.quality.drainTimeoutMs,
      shell: config.quality.shell,
      stripEnvVars: config.quality.stripEnvVars,
    });

    if (retryVerification.success) {
      logger?.info("rectification", `[OK] ${label} succeeded!`, {
        storyId: story.id,
        attempt: rectificationState.attempt,
        initialFailures: rectificationState.initialFailures,
      });
      return true;
    }

    if (retryVerification.output) {
      const newTestSummary = parseBunTestOutput(retryVerification.output);
      rectificationState.currentFailures = newTestSummary.failed;
      testSummary.failures = newTestSummary.failures;
      testSummary.failed = newTestSummary.failed;
      testSummary.passed = newTestSummary.passed;
    }
  }

  if (rectificationState.attempt >= rectificationConfig.maxRetries) {
    logger?.warn("rectification", `${label} exhausted max retries`, {
      storyId: story.id,
      attempts: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
  } else if (rectificationState.currentFailures > rectificationState.initialFailures) {
    logger?.warn("rectification", `${label} aborted due to further regression`, {
      storyId: story.id,
      initialFailures: rectificationState.initialFailures,
      currentFailures: rectificationState.currentFailures,
    });
  }

  return false;
}

export interface RevertStoriesOptions {
  prd: PRD;
  prdPath: string;
  story: UserStory;
  storiesToExecute: UserStory[];
  allStoryMetrics: StoryMetrics[];
  featureDir?: string;
  diagnosticContext: string;
  countsTowardEscalation: boolean;
}

/** Revert stories to pending on verification failure and save PRD. */
export async function revertStoriesOnFailure(opts: RevertStoriesOptions): Promise<PRD> {
  const storyIds = new Set(opts.storiesToExecute.map((s) => s.id));

  // Remove stale metrics
  for (let i = opts.allStoryMetrics.length - 1; i >= 0; i--) {
    if (storyIds.has(opts.allStoryMetrics[i].storyId)) {
      opts.allStoryMetrics.splice(i, 1);
    }
  }

  // Revert stories to pending with diagnostic context
  opts.prd.userStories = opts.prd.userStories.map((s) =>
    storyIds.has(s.id)
      ? { ...s, priorErrors: [...(s.priorErrors || []), opts.diagnosticContext], status: "pending" as const, passes: false }
      : s,
  );

  if (opts.countsTowardEscalation) {
    opts.prd.userStories = opts.prd.userStories.map((s) =>
      s.id === opts.story.id ? { ...s, attempts: s.attempts + 1 } : s,
    );
  }

  await savePRD(opts.prd, opts.prdPath);

  if (opts.featureDir) {
    await appendProgress(opts.featureDir, opts.story.id, "failed", `${opts.story.title} -- ${opts.diagnosticContext}`);
  }

  return opts.prd;
}
