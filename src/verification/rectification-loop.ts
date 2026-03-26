/**
 * Rectification Loop (ADR-005, Phase 4)
 *
 * Replaces src/execution/post-verify-rectification.ts.
 * Moved into the verification module where it belongs architecturally.
 *
 * Used by: src/pipeline/stages/rectify.ts, src/execution/lifecycle/run-regression.ts
 */

import { getAgent as _getAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config";
import { resolvePermissions } from "../config/permissions";
import { escalateTier as _escalateTier } from "../execution/escalation/escalation";
import { parseBunTestOutput } from "../execution/test-output-parser";
import { getSafeLogger } from "../logger";
import type { AgentGetFn } from "../pipeline/types";
import type { UserStory } from "../prd";
import { getExpectedFiles } from "../prd";
import {
  type RectificationState,
  createEscalatedRectificationPrompt,
  createRectificationPrompt,
  shouldRetryRectification,
} from "./rectification";
import { fullSuite as _fullSuite } from "./runners";

export interface RectificationLoopOptions {
  config: NaxConfig;
  workdir: string;
  story: UserStory;
  testCommand: string;
  timeoutSeconds: number;
  testOutput: string;
  promptPrefix?: string;
  featureName?: string;
  /** Protocol-aware agent resolver (ACP wiring). Falls back to static getAgent when absent. */
  agentGetFn?: AgentGetFn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _rectificationDeps = {
  getAgent: _getAgent as (name: string) => import("../agents/types").AgentAdapter | undefined,
  runVerification: _fullSuite as typeof _fullSuite,
  escalateTier: _escalateTier,
};

/** Run the rectification retry loop. Returns true if all failures were fixed. */
export async function runRectificationLoop(opts: RectificationLoopOptions): Promise<boolean> {
  const { config, workdir, story, testCommand, timeoutSeconds, testOutput, promptPrefix, featureName, agentGetFn } =
    opts;
  const logger = getSafeLogger();
  const rectificationConfig = config.execution.rectification;
  const testSummary = parseBunTestOutput(testOutput);
  const label = promptPrefix ? "regression rectification" : "rectification";

  const rectificationState: RectificationState = {
    attempt: 0,
    initialFailures: testSummary.failed,
    currentFailures: testSummary.failed,
  };

  logger?.info("rectification", `Starting ${label} loop`, {
    storyId: story.id,
    initialFailures: rectificationState.initialFailures,
    maxRetries: rectificationConfig.maxRetries,
  });

  while (shouldRetryRectification(rectificationState, rectificationConfig)) {
    rectificationState.attempt++;

    logger?.info("rectification", `${label} attempt ${rectificationState.attempt}/${rectificationConfig.maxRetries}`, {
      storyId: story.id,
      currentFailures: rectificationState.currentFailures,
    });

    let rectificationPrompt = createRectificationPrompt(testSummary.failures, story, rectificationConfig);
    if (promptPrefix) rectificationPrompt = `${promptPrefix}\n\n${rectificationPrompt}`;

    const agent = (agentGetFn ?? _rectificationDeps.getAgent)(config.autoMode.defaultAgent);
    if (!agent) {
      logger?.error("rectification", "Agent not found, cannot retry");
      break;
    }

    // story.routing.modelTier is not persisted (derived at runtime) — derive tier from
    // persisted complexity via complexityRouting instead of falling back to tierOrder[0] (fast/haiku).
    const complexity = story.routing?.complexity ?? "medium";
    const modelTier =
      config.autoMode.complexityRouting?.[complexity] || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
    const modelDef = resolveModel(config.models[modelTier]);

    const agentResult = await agent.run({
      prompt: rectificationPrompt,
      workdir,
      modelTier,
      modelDef,
      timeoutSeconds: config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(config, "rectification").skipPermissions,
      pipelineStage: "rectification",
      config,
      maxInteractionTurns: config.agent?.maxInteractionTurns,
      featureName,
      storyId: story.id,
      sessionRole: "implementer",
    });

    if (agentResult.success) {
      logger?.info("rectification", `Agent ${label} session complete`, {
        storyId: story.id,
        attempt: rectificationState.attempt,
        cost: agentResult.estimatedCost,
      });
    } else {
      logger?.warn("rectification", `Agent ${label} session failed`, {
        storyId: story.id,
        attempt: rectificationState.attempt,
        exitCode: agentResult.exitCode,
      });
    }

    const retryVerification = await _rectificationDeps.runVerification({
      workdir,
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

    const failingTests = testSummary.failures.slice(0, 10).map((f) => f.testName);
    const logData: Record<string, unknown> = {
      storyId: story.id,
      attempt: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
      failingTests,
    };

    // Include totalFailingTests if we have more than 10 structured failures
    // OR if no structured failures exist but there are still failures reported
    if (testSummary.failures.length > 10 || (testSummary.failures.length === 0 && testSummary.failed > 0)) {
      logData.totalFailingTests = testSummary.failed;
    }

    logger?.warn("rectification", `${label} still failing after attempt`, logData);
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

  const shouldEscalate =
    rectificationConfig.escalateOnExhaustion !== false &&
    config.autoMode?.escalation?.enabled === true &&
    rectificationState.attempt >= rectificationConfig.maxRetries &&
    rectificationState.currentFailures > 0;

  if (shouldEscalate) {
    const complexity = story.routing?.complexity ?? "medium";
    const currentTier =
      config.autoMode.complexityRouting?.[complexity] || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
    const tierOrder = config.autoMode.escalation.tierOrder;
    const escalatedTier = _rectificationDeps.escalateTier(currentTier, tierOrder);

    if (escalatedTier !== null) {
      const agent = (agentGetFn ?? _rectificationDeps.getAgent)(config.autoMode.defaultAgent);
      if (!agent) {
        return false;
      }

      const escalatedModelDef = resolveModel(config.models[escalatedTier]);
      let escalationPrompt = createEscalatedRectificationPrompt(
        testSummary.failures,
        story,
        rectificationState.attempt,
        currentTier,
        escalatedTier,
        rectificationConfig,
      );
      if (promptPrefix) escalationPrompt = `${promptPrefix}\n\n${escalationPrompt}`;

      await agent.run({
        prompt: escalationPrompt,
        workdir,
        modelTier: escalatedTier,
        modelDef: escalatedModelDef,
        timeoutSeconds: config.execution.sessionTimeoutSeconds,
        dangerouslySkipPermissions: resolvePermissions(config, "rectification").skipPermissions,
        pipelineStage: "rectification",
        config,
        maxInteractionTurns: config.agent?.maxInteractionTurns,
        featureName,
        storyId: story.id,
        sessionRole: "implementer",
      });

      const escalationVerification = await _rectificationDeps.runVerification({
        workdir,
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

      if (escalationVerification.success) {
        logger?.info("rectification", `${label} escalated from ${currentTier} to ${escalatedTier} and succeeded`, {
          storyId: story.id,
          currentTier,
          escalatedTier,
        });
        return true;
      }

      logger?.warn("rectification", "escalated rectification also failed", { storyId: story.id, escalatedTier });
    }
  }

  return false;
}
