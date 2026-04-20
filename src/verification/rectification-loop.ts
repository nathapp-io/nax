/**
 * Rectification Loop (ADR-005, Phase 4)
 *
 * Replaces src/execution/post-verify-rectification.ts.
 * Moved into the verification module where it belongs architecturally.
 *
 * Used by: src/pipeline/stages/rectify.ts, src/execution/lifecycle/run-regression.ts
 */

import { AgentManager } from "../agents";
import type { IAgentManager } from "../agents";
import { computeAcpHandle } from "../agents/acp/adapter";
import { estimateCostByDuration } from "../agents/cost";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { resolvePermissions } from "../config/permissions";
import type { DebateStageConfig, Debater } from "../debate/types";
import { escalateTier as _escalateTier } from "../execution/escalation/escalation";
import { getSafeLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import type { UserStory } from "../prd";
import { getExpectedFiles } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { FailureRecord } from "../prompts";
import { parseTestOutput } from "./parser";
import { formatFailureSummary } from "./parser";
import { type RectificationState, shouldRetryRectification } from "./rectification";
import { fullSuite as _fullSuite } from "./runners";
import { runSharedRectificationLoop } from "./shared-rectification-loop";

export interface RectificationLoopOptions {
  config: NaxConfig;
  workdir: string;
  story: UserStory;
  testCommand: string;
  timeoutSeconds: number;
  testOutput: string;
  promptPrefix?: string;
  featureName?: string;
  /** AgentManager — routes all agent calls through IAgentManager. Falls back to createManager when absent. */
  agentManager?: IAgentManager;
  /** Absolute path to repo root — forwarded to agent.run() for prompt audit fast path */
  projectDir?: string;
  /**
   * Scoped test command template with {{files}} placeholder (quality.commands.testScoped).
   * Already resolved: {{package}} substituted by the caller (rectify stage).
   * Undefined for monorepo orchestrators (turbo/nx) — they do not support per-file expansion.
   */
  testScopedTemplate?: string;
  /**
   * In-process session registry (Phase 1+ plumbing). When provided, each rectification
   * attempt's protocolIds are bound to the descriptor so the audit trail stays current
   * across retries (G5: bindHandle after each agent.run() in the rectification loop).
   */
  sessionManager?: import("../session").ISessionManager;
  /**
   * nax session ID for the implementer session (sess-<uuid>).
   * Required alongside sessionManager for bindHandle to work.
   */
  sessionId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debate diagnosis helper
// ─────────────────────────────────────────────────────────────────────────────

async function _defaultRunDebate(
  storyId: string,
  stageConfig: DebateStageConfig,
  prompt: string,
  config: NaxConfig,
): Promise<{ output: string | null; totalCostUsd: number }> {
  const logger = getSafeLogger();
  const debaters: Debater[] = stageConfig.debaters ?? [];
  const manager = _rectificationDeps.createManager(config);
  const resolved: Array<{ debater: Debater; agentName: string }> = [];

  for (const debater of debaters) {
    if (manager.getAgent(debater.agent)) {
      resolved.push({ debater, agentName: debater.agent });
    }
  }

  if (resolved.length === 0) {
    return { output: null, totalCostUsd: 0 };
  }

  const timeoutMs = (config.execution?.sessionTimeoutSeconds ?? 600) * 1000;
  const startMs = Date.now();
  const proposalSettled = await Promise.allSettled(
    resolved.map(({ debater, agentName }) =>
      manager
        .completeAs(agentName, prompt, {
          model: debater.model,
          config,
          storyId,
          sessionRole: "debate-proposal",
          timeoutMs,
        })
        .then((out) => (typeof out === "string" ? out : out.output)),
    ),
  );
  const durationMs = Date.now() - startMs;

  const successful = proposalSettled
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);

  if (successful.length === 0) {
    return { output: null, totalCostUsd: 0 };
  }

  const successCount = successful.length;
  const costPerDebater = estimateCostByDuration("balanced", durationMs / successCount);
  const totalCostUsd = costPerDebater.cost * successCount;

  logger?.debug("rectification", "debate diagnosis complete", { storyId, successCount, totalCostUsd });

  const output = successful.join("\n\n");
  return { output, totalCostUsd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _rectificationDeps = {
  createManager: (config: NaxConfig): IAgentManager => new AgentManager(config),
  runVerification: _fullSuite as typeof _fullSuite,
  escalateTier: _escalateTier,
  runDebate: _defaultRunDebate as typeof _defaultRunDebate,
};

/** Run the rectification retry loop. Returns whether all failures were fixed and the accumulated agent cost. */
export async function runRectificationLoop(
  opts: RectificationLoopOptions,
): Promise<{ succeeded: boolean; cost: number }> {
  const {
    config,
    workdir,
    story,
    testCommand,
    timeoutSeconds,
    testOutput,
    promptPrefix,
    featureName,
    projectDir,
    testScopedTemplate,
    sessionManager,
    sessionId,
  } = opts;
  const logger = getSafeLogger();
  const rectificationConfig = config.execution.rectification;
  const testSummary = parseTestOutput(testOutput);
  const label = promptPrefix ? "regression rectification" : "rectification";

  const rectificationState: RectificationState = {
    attempt: 0,
    initialFailures: testSummary.failed,
    currentFailures: testSummary.failed,
    lastExitCode: 1, // Assume failure since we entered the loop
  };

  let costAccum = 0;
  const rectificationSessionName = computeAcpHandle(workdir, featureName, story.id, "implementer");

  const succeeded = await runSharedRectificationLoop({
    stage: "rectification",
    storyId: story.id,
    maxAttempts: rectificationConfig.maxRetries,
    state: rectificationState,
    logger,
    startMessage: `Starting ${label} loop`,
    startData: {
      storyId: story.id,
      initialFailures: rectificationState.initialFailures,
      maxRetries: rectificationConfig.maxRetries,
    },
    attemptMessage: (attempt) => `${label} attempt ${attempt}/${rectificationConfig.maxRetries}`,
    attemptData: () => ({
      storyId: story.id,
      currentFailures: rectificationState.currentFailures,
    }),
    canContinue: (state) => shouldRetryRectification(state, rectificationConfig),
    buildPrompt: async (attempt) => {
      let diagnosisPrefix: string | null = null;
      const debateStageConfig = config.debate?.stages?.rectification;
      if (debateStageConfig?.enabled) {
        const failureSummary = formatFailureSummary(testSummary.failures);
        const diagnosisPrompt = `Analyze the following test failures and identify the root cause:\n\n${failureSummary}`;
        try {
          const debateResult = await _rectificationDeps.runDebate(story.id, debateStageConfig, diagnosisPrompt, config);
          if (debateResult.totalCostUsd > 0 && story.routing) {
            story.routing.estimatedCost = (story.routing.estimatedCost ?? 0) + debateResult.totalCostUsd;
          }
          if (debateResult.output !== null) {
            diagnosisPrefix = `## Root Cause Analysis\n\n${debateResult.output}`;
          } else {
            logger?.info("rectification", "debate diagnosis fallback — all debaters failed", {
              storyId: story.id,
              attempt,
              event: "fallback",
            });
          }
        } catch (_error) {
          logger?.info("rectification", "debate diagnosis fallback — debate threw error", {
            storyId: story.id,
            attempt,
            event: "fallback",
          });
        }
      }

      const failureRecords: FailureRecord[] = testSummary.failures.map((f) => ({
        test: f.testName,
        file: f.file,
        message: f.error,
        output: f.stackTrace.length > 0 ? f.stackTrace.join("\n") : undefined,
      }));
      let rectificationPrompt = await RectifierPromptBuilder.for("verify-failure")
        .story(story)
        .priorFailures(failureRecords)
        .testCommand(testCommand)
        .conventions()
        .task()
        .build();
      if (diagnosisPrefix) {
        rectificationPrompt = `${diagnosisPrefix}\n\n${rectificationPrompt}`;
      }
      if (promptPrefix) {
        rectificationPrompt = `${promptPrefix}\n\n${rectificationPrompt}`;
      }
      return rectificationPrompt;
    },
    runAttempt: async (attempt, rectificationPrompt) => {
      const agentManager = opts.agentManager ?? _rectificationDeps.createManager(config);
      const defaultAgent = agentManager.getDefault();

      const complexity = story.routing?.complexity ?? "medium";
      const modelTier =
        config.autoMode.complexityRouting?.[complexity] || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
      const modelDef = resolveModelForAgent(
        config.models,
        story.routing?.agent ?? defaultAgent,
        modelTier,
        defaultAgent,
      );

      const isLastAttempt = attempt >= rectificationConfig.maxRetries;

      const agentResult = await agentManager.run({
        runOptions: {
          prompt: rectificationPrompt,
          workdir,
          modelTier,
          modelDef,
          timeoutSeconds: config.execution.sessionTimeoutSeconds,
          dangerouslySkipPermissions: resolvePermissions(config, "rectification").skipPermissions,
          pipelineStage: "rectification",
          config,
          projectDir,
          maxInteractionTurns: config.agent?.maxInteractionTurns,
          featureName,
          storyId: story.id,
          sessionRole: "implementer",
          keepOpen: !isLastAttempt,
        },
      });

      costAccum += agentResult.estimatedCost ?? 0;

      // G5: update session descriptor with latest protocolIds so the audit trail
      // reflects the session that actually ran (may differ after internal retries).
      if (sessionManager && sessionId && agentResult.protocolIds) {
        try {
          sessionManager.bindHandle(sessionId, rectificationSessionName, agentResult.protocolIds);
        } catch {
          // Session may not exist in manager (e.g. v2 context disabled) — ignore.
        }
      }

      if (agentResult.success) {
        logger?.info("rectification", `Agent ${label} session complete`, {
          storyId: story.id,
          attempt,
          cost: agentResult.estimatedCost,
        });
      } else {
        logger?.warn("rectification", `Agent ${label} session failed`, {
          storyId: story.id,
          attempt,
          exitCode: agentResult.exitCode,
        });
      }
    },
    checkResult: async (attempt, state) => {
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
          attempt,
          initialFailures: state.initialFailures,
        });
        return true;
      }

      if (retryVerification.output) {
        const newTestSummary = parseTestOutput(retryVerification.output);
        state.currentFailures = newTestSummary.failed;
        state.lastExitCode = retryVerification.status === "SUCCESS" ? 0 : 1;
        testSummary.failures = newTestSummary.failures;
        testSummary.failed = newTestSummary.failed;
        testSummary.passed = newTestSummary.passed;

        // Trust "0 failures" only when the parser found real evidence:
        // either the runner exited clean (status SUCCESS) or it saw passing
        // tests (passed > 0). If both are 0, the parser couldn't read the
        // output format — treat it as unresolved to avoid false-positives.
        if (newTestSummary.failed === 0 && (retryVerification.status === "SUCCESS" || newTestSummary.passed > 0)) {
          state.lastExitCode = 0;
          logger?.info("rectification", `[OK] ${label} succeeded after parsing retry output`, {
            storyId: story.id,
            attempt,
            initialFailures: state.initialFailures,
          });
          return true;
        }
      }

      return false;
    },
    onAttemptFailure: (attempt, state) => {
      const failingTests = testSummary.failures.slice(0, 10).map((failure) => failure.testName);
      const logData: Record<string, unknown> = {
        storyId: story.id,
        attempt,
        remainingFailures: state.currentFailures,
        failingTests,
      };

      if (testSummary.failures.length > 10 || (testSummary.failures.length === 0 && testSummary.failed > 0)) {
        logData.totalFailingTests = testSummary.failed;
      }

      logger?.warn("rectification", `${label} still failing after attempt`, logData);
    },
    onLoopEnd: (state) => {
      if (state.attempt >= rectificationConfig.maxRetries) {
        logger?.warn("rectification", `${label} exhausted max retries`, {
          storyId: story.id,
          attempts: state.attempt,
          remainingFailures: state.currentFailures,
        });
      } else if (state.currentFailures > state.initialFailures) {
        logger?.warn("rectification", `${label} aborted due to further regression`, {
          storyId: story.id,
          initialFailures: state.initialFailures,
          currentFailures: state.currentFailures,
        });
      }
    },
    onExhausted: async (state) => {
      const shouldEscalate =
        rectificationConfig.escalateOnExhaustion !== false &&
        config.autoMode?.escalation?.enabled === true &&
        state.currentFailures > 0;

      if (!shouldEscalate) {
        return false;
      }

      const complexity = story.routing?.complexity ?? "medium";
      const currentTier =
        config.autoMode.complexityRouting?.[complexity] || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
      const tierOrder = config.autoMode.escalation.tierOrder;
      const escalationResult = _rectificationDeps.escalateTier(currentTier, tierOrder);
      const escalatedTier = escalationResult?.tier ?? null;
      const escalatedAgent = escalationResult?.agent;

      if (escalatedTier === null) {
        return false;
      }

      const escalationManager = opts.agentManager ?? _rectificationDeps.createManager(config);
      const agentName = escalatedAgent ?? story.routing?.agent ?? escalationManager.getDefault();

      if (!escalationManager.getAgent(agentName)) {
        return false;
      }

      const escalatedModelDef = resolveModelForAgent(
        config.models,
        agentName,
        escalatedTier,
        escalationManager.getDefault(),
      );
      let escalationPrompt = RectifierPromptBuilder.escalated(
        testSummary.failures,
        story,
        state.attempt,
        currentTier,
        escalatedTier,
        rectificationConfig,
        testCommand,
        testScopedTemplate,
      );
      if (promptPrefix) {
        escalationPrompt = `${promptPrefix}\n\n${escalationPrompt}`;
      }

      const escalationRunResult = await escalationManager.runAs(agentName, {
        runOptions: {
          prompt: escalationPrompt,
          workdir,
          modelTier: escalatedTier,
          modelDef: escalatedModelDef,
          timeoutSeconds: config.execution.sessionTimeoutSeconds,
          dangerouslySkipPermissions: resolvePermissions(config, "rectification").skipPermissions,
          pipelineStage: "rectification",
          config,
          projectDir,
          maxInteractionTurns: config.agent?.maxInteractionTurns,
          featureName,
          storyId: story.id,
          sessionRole: "implementer",
        },
      });

      costAccum += escalationRunResult.estimatedCost ?? 0;
      logger?.info("rectification", "escalated rectification attempt cost", {
        storyId: story.id,
        escalatedTier,
        cost: escalationRunResult.estimatedCost,
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
      return false;
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "RECTIFICATION_AGENT_NOT_FOUND") {
      return false;
    }
    throw error;
  });

  return { succeeded, cost: costAccum };
}

/**
 * Run the rectification loop from a PipelineContext.
 * Stage-specific params (testCommand, testOutput, promptPrefix) must still be provided.
 */
export function runRectificationLoopFromCtx(
  ctx: PipelineContext,
  opts: { testCommand: string; testOutput: string; promptPrefix?: string; testScopedTemplate?: string },
): Promise<{ succeeded: boolean; cost: number }> {
  return runRectificationLoop({
    config: ctx.config,
    workdir: ctx.workdir,
    story: ctx.story,
    testCommand: opts.testCommand,
    timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
    testOutput: opts.testOutput,
    promptPrefix: opts.promptPrefix,
    featureName: ctx.prd.feature,
    agentManager: ctx.agentManager,
    projectDir: ctx.projectDir,
    testScopedTemplate: opts.testScopedTemplate,
    sessionManager: ctx.sessionManager,
    sessionId: ctx.sessionId,
  });
}
