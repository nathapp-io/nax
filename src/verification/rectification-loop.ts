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
import type { DebateStageConfig, Debater } from "../debate/types";
import { escalateTier as _escalateTier } from "../execution/escalation/escalation";
import { parseBunTestOutput } from "../execution/test-output-parser";
import { getSafeLogger } from "../logger";
import type { AgentGetFn } from "../pipeline/types";
import type { UserStory } from "../prd";
import { getExpectedFiles } from "../prd";
import { formatFailureSummary } from "./parser";
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
// Debate diagnosis helper
// ─────────────────────────────────────────────────────────────────────────────

async function _defaultRunDebate(
  storyId: string,
  stageConfig: DebateStageConfig,
  prompt: string,
): Promise<{ output: string | null; totalCostUsd: number }> {
  const debaters: Debater[] = stageConfig.debaters ?? [];
  const resolved: Array<{ debater: Debater; adapter: import("../agents/types").AgentAdapter }> = [];

  for (const debater of debaters) {
    const adapter = _rectificationDeps.getAgent(debater.agent);
    if (adapter) {
      resolved.push({ debater, adapter });
    }
  }

  if (resolved.length === 0) {
    return { output: null, totalCostUsd: 0 };
  }

  const proposalSettled = await Promise.allSettled(
    resolved.map(({ debater, adapter }) =>
      adapter.complete(prompt, { model: debater.model }).then((out: string) => out),
    ),
  );

  const successful = proposalSettled
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successful.length === 0) {
    return { output: null, totalCostUsd: 0 };
  }

  const output = successful.join("\n\n");
  return { output, totalCostUsd: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _rectificationDeps = {
  getAgent: _getAgent as (name: string) => import("../agents/types").AgentAdapter | undefined,
  runVerification: _fullSuite as typeof _fullSuite,
  escalateTier: _escalateTier,
  runDebate: _defaultRunDebate as typeof _defaultRunDebate,
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
    lastExitCode: 1, // Assume failure since we entered the loop
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

    // Debate-based root cause diagnosis (when enabled)
    let diagnosisPrefix: string | null = null;
    const debateStageConfig = config.debate?.stages?.rectification;
    if (debateStageConfig?.enabled) {
      const failureSummary = formatFailureSummary(testSummary.failures);
      const diagnosisPrompt = `Analyze the following test failures and identify the root cause:\n\n${failureSummary}`;
      try {
        const debateResult = await _rectificationDeps.runDebate(story.id, debateStageConfig, diagnosisPrompt);
        if (debateResult.totalCostUsd > 0 && story.routing) {
          story.routing.estimatedCost = (story.routing.estimatedCost ?? 0) + debateResult.totalCostUsd;
        }
        if (debateResult.output !== null) {
          diagnosisPrefix = `## Root Cause Analysis\n\n${debateResult.output}`;
        } else {
          logger?.info("rectification", "debate diagnosis fallback — all debaters failed", {
            storyId: story.id,
            attempt: rectificationState.attempt,
            event: "fallback",
          });
        }
      } catch (err) {
        logger?.info("rectification", "debate diagnosis fallback — debate threw error", {
          storyId: story.id,
          attempt: rectificationState.attempt,
          event: "fallback",
        });
      }
    }

    let rectificationPrompt = createRectificationPrompt(
      testSummary.failures,
      story,
      rectificationConfig,
      rectificationState.attempt,
    );
    if (diagnosisPrefix) rectificationPrompt = `${diagnosisPrefix}\n\n${rectificationPrompt}`;
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
      rectificationState.lastExitCode = retryVerification.status === "SUCCESS" ? 0 : 1; // Basic mapping
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

      const escalationResult = await agent.run({
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

      logger?.info("rectification", "escalated rectification attempt cost", {
        storyId: story.id,
        escalatedTier,
        cost: escalationResult.estimatedCost,
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
