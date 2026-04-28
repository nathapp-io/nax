/**
 * Rectification Loop (ADR-005, Phase 4)
 *
 * Replaces src/execution/post-verify-rectification.ts.
 * Moved into the verification module where it belongs architecturally.
 *
 * Used by: src/pipeline/stages/rectify.ts, src/execution/lifecycle/run-regression.ts
 */

import type { IAgentManager } from "../agents";
import { estimateCostByDuration } from "../agents/cost";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import type { DebateStageConfig, Debater } from "../debate/types";
import { escalateTier as _escalateTier } from "../execution/escalation/escalation";
import { getSafeLogger } from "../logger";
import { buildHopCallback } from "../operations/build-hop-callback";
import type { PipelineContext } from "../pipeline/types";
import type { UserStory } from "../prd";
import { getExpectedFiles } from "../prd";
import { RectifierPromptBuilder } from "../prompts";
import type { FailureRecord } from "../prompts";
import { formatSessionName } from "../session/naming";
import { buildFailureRecords } from "./failure-records";
import { parseTestOutput } from "./parser";
import { formatFailureSummary } from "./parser";
import { type RectificationState, shouldRetryRectification } from "./rectification";
import { fullSuite as _fullSuite } from "./runners";
import { type RetryAttempt, type VerifyOutcome, runRetryLoop } from "./shared-rectification-loop";

/** Failure snapshot for the rectification retry loop. */
export interface RectificationFailure {
  testOutput: string;
  testSummary: ReturnType<typeof parseTestOutput>;
}

/** Result from one rectification attempt. */
export interface RectificationAttemptResult {
  /** Whether the agent run itself succeeded (exit 0). */
  agentSuccess: boolean;
  /** Estimated cost for this attempt. */
  cost: number;
  /** Protocol IDs for session manager binding. */
  protocolIds?: import("../runtime/protocol-types").ProtocolIds;
}

export interface RectificationLoopOptions {
  config: NaxConfig;
  workdir: string;
  story: UserStory;
  testCommand: string;
  timeoutSeconds: number;
  testOutput: string;
  promptPrefix?: string;
  featureName?: string;
  /** AgentManager — routes all agent calls through IAgentManager. */
  agentManager: IAgentManager;
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
  /**
   * NaxRuntime (ADR-019 Phase D). When present, each rectification attempt dispatches
   * via buildHopCallback → runWithFallback (fresh session per hop). keepOpen is only
   * used in the legacy path when runtime is absent.
   */
  runtime?: import("../runtime").NaxRuntime;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debate diagnosis helper
// ─────────────────────────────────────────────────────────────────────────────

async function _defaultRunDebate(
  storyId: string,
  stageConfig: DebateStageConfig,
  prompt: string,
  config: NaxConfig,
  agentManager: IAgentManager,
): Promise<{ output: string | null; totalCostUsd: number }> {
  const logger = getSafeLogger();
  const debaters: Debater[] = stageConfig.debaters ?? [];
  const manager = agentManager;
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
  agentManager: undefined as IAgentManager | undefined,
  runVerification: _fullSuite as typeof _fullSuite,
  escalateTier: _escalateTier,
  runDebate: _defaultRunDebate as typeof _defaultRunDebate,
};

/**
 * Run the rectification retry loop.
 * Returns whether all failures were fixed, the accumulated agent cost, and total wall-clock duration.
 */
export async function runRectificationLoop(
  opts: RectificationLoopOptions,
): Promise<{ succeeded: boolean; cost: number; durationMs: number }> {
  const loopStartMs = Date.now();
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
    runtime,
  } = opts;
  const logger = getSafeLogger();
  const agentManager = opts.agentManager ?? _rectificationDeps.agentManager;
  if (!agentManager) {
    logger?.warn("rectification", "No agentManager threaded — skipping rectification loop", {
      storyId: story.id,
    });
    return { succeeded: false, cost: 0, durationMs: 0 };
  }
  const rectificationConfig = config.execution.rectification;
  const testSummary = parseTestOutput(testOutput);
  const label = promptPrefix ? "regression rectification" : "rectification";

  const rectificationSessionName = formatSessionName({
    workdir,
    featureName,
    storyId: story.id,
    role: "implementer",
  });

  let costAccum = 0;
  let currentAttempt = 0;

  // Initial failure snapshot for the retry loop
  const initialFailure: RectificationFailure = {
    testOutput,
    testSummary,
  };

  const outcome = await runRetryLoop<RectificationFailure, RectificationAttemptResult>({
    stage: "rectification",
    storyId: story.id,
    packageDir: workdir,
    maxAttempts: rectificationConfig.maxRetries,
    failure: initialFailure,
    previousAttempts: [],
    buildPrompt: (failure) => {
      currentAttempt++;
      const diagnosisPrefix: string | null = null;
      const debateStageConfig = config.debate?.stages?.rectification;
      let debatePromise: Promise<string | null> = Promise.resolve(null);

      if (debateStageConfig?.enabled) {
        const failureSummary = formatFailureSummary(failure.testSummary.failures);
        const diagnosisPrompt = `Analyze the following test failures and identify the root cause:\n\n${failureSummary}`;
        debatePromise = (async () => {
          try {
            const debateResult = await _rectificationDeps.runDebate(
              story.id,
              debateStageConfig,
              diagnosisPrompt,
              config,
              agentManager,
            );
            if (debateResult.totalCostUsd > 0 && story.routing) {
              story.routing.estimatedCostUsd = (story.routing.estimatedCostUsd ?? 0) + debateResult.totalCostUsd;
            }
            if (debateResult.output !== null) {
              return `## Root Cause Analysis\n\n${debateResult.output}`;
            }
            logger?.info("rectification", "debate diagnosis fallback — all debaters failed", {
              storyId: story.id,
              event: "fallback",
            });
            return null;
          } catch (_error) {
            logger?.info("rectification", "debate diagnosis fallback — debate threw error", {
              storyId: story.id,
              event: "fallback",
            });
            return null;
          }
        })();
      }

      const failureRecords: FailureRecord[] = buildFailureRecords(failure.testSummary, failure.testOutput);
      const rectPrompt = RectifierPromptBuilder.regressionFailure({
        story,
        failures: failureRecords,
        testCommand,
        conventions: true,
      });
      const rectPromise = Promise.resolve(rectPrompt);

      return (async () => {
        const [diagnosis, rectificationPrompt] = await Promise.all([debatePromise, rectPromise]);
        let finalPrompt = rectificationPrompt;
        if (diagnosis) {
          finalPrompt = `${diagnosis}\n\n${finalPrompt}`;
        }
        if (promptPrefix) {
          finalPrompt = `${promptPrefix}\n\n${finalPrompt}`;
        }
        return finalPrompt;
      })();
    },
    execute: async (prompt) => {
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

      const isLastAttempt = currentAttempt >= rectificationConfig.maxRetries;

      const runOptions = {
        prompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds: config.execution.sessionTimeoutSeconds,
        pipelineStage: "rectification" as const,
        config,
        projectDir,
        maxInteractionTurns: config.agent?.maxInteractionTurns,
        featureName,
        storyId: story.id,
        sessionRole: "implementer" as const,
      };

      let agentResult: import("../agents").AgentResult;
      if (runtime) {
        // ADR-019 Pattern A: dispatch via buildHopCallback → runWithFallback.
        // Each attempt opens a fresh session; keepOpen is not used in the runtime path.
        const executeHop = buildHopCallback(
          {
            sessionManager: runtime.sessionManager,
            agentManager: runtime.agentManager,
            story,
            config,
            projectDir,
            featureName: featureName ?? "",
            workdir,
            effectiveTier: modelTier,
            defaultAgent,
            pipelineStage: "rectification",
          },
          sessionId,
          runOptions,
        );
        const outcome = await agentManager.runWithFallback(
          { runOptions, signal: runtime.signal, executeHop },
          defaultAgent,
        );
        agentResult = outcome.result;
      } else {
        // Legacy keepOpen path — used when no runtime is available (standalone callers).
        agentResult = await agentManager.run({
          runOptions: { ...runOptions, keepOpen: !isLastAttempt },
        });
      }

      costAccum += agentResult.estimatedCostUsd ?? 0;

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
          cost: agentResult.estimatedCostUsd,
        });
      } else {
        logger?.warn("rectification", `Agent ${label} session failed`, {
          storyId: story.id,
          exitCode: agentResult.exitCode,
        });
      }

      return {
        agentSuccess: agentResult.success,
        cost: agentResult.estimatedCostUsd ?? 0,
        protocolIds: agentResult.protocolIds,
      };
    },
    shouldAbort: (failure) => {
      if (rectificationConfig.abortOnIncreasingFailures) {
        return failure.testSummary.failed > initialFailure.testSummary.failed;
      }
      return false;
    },
    verify: async (result) => {
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
          attempt: currentAttempt,
          initialFailures: initialFailure.testSummary.failed,
        });
        return { passed: true };
      }

      if (retryVerification.output) {
        const newTestSummary = parseTestOutput(retryVerification.output);

        // Trust "0 failures" only when the parser found real evidence:
        // either the runner exited clean (status SUCCESS) or it saw passing
        // tests (passed > 0). If both are 0, the parser couldn't read the
        // output format — treat it as unresolved to avoid false-positives.
        if (newTestSummary.failed === 0 && (retryVerification.status === "SUCCESS" || newTestSummary.passed > 0)) {
          logger?.info("rectification", `[OK] ${label} succeeded after parsing retry output`, {
            storyId: story.id,
            attempt: currentAttempt,
            initialFailures: initialFailure.testSummary.failed,
          });
          return { passed: true };
        }

        const failingTests = newTestSummary.failures.slice(0, 10).map((failure) => failure.testName);
        const logData: Record<string, unknown> = {
          storyId: story.id,
          attempt: currentAttempt,
          remainingFailures: newTestSummary.failed,
          failingTests,
        };

        if (
          newTestSummary.failures.length > 10 ||
          (newTestSummary.failures.length === 0 && newTestSummary.failed > 0)
        ) {
          logData.totalFailingTests = newTestSummary.failed;
        }

        logger?.warn("rectification", `${label} still failing after attempt`, logData);

        return {
          passed: false,
          newFailure: {
            testOutput: retryVerification.output,
            testSummary: newTestSummary,
          },
        };
      }

      return {
        passed: false,
        newFailure: {
          testOutput: retryVerification.output ?? "",
          testSummary: initialFailure.testSummary,
        },
      };
    },
  });

  const succeeded = outcome.outcome === "fixed";

  // Escalation logic — runs only when exhausted and conditions permit
  if (outcome.outcome === "exhausted") {
    const finalFailure = outcome.finalFailure;
    const shouldEscalate =
      rectificationConfig.escalateOnExhaustion !== false &&
      config.autoMode?.escalation?.enabled === true &&
      finalFailure.testSummary.failed > 0;

    if (shouldEscalate) {
      const complexity = story.routing?.complexity ?? "medium";
      const currentTier =
        config.autoMode.complexityRouting?.[complexity] || config.autoMode.escalation.tierOrder[0]?.tier || "balanced";
      const tierOrder = config.autoMode.escalation.tierOrder;
      const escalationResult = _rectificationDeps.escalateTier(currentTier, tierOrder);
      const escalatedTier = escalationResult?.tier ?? null;
      const escalatedAgent = escalationResult?.agent;

      if (escalatedTier !== null) {
        const escalationManager = agentManager;
        const agentName = escalatedAgent ?? story.routing?.agent ?? escalationManager.getDefault();

        if (escalationManager.getAgent(agentName)) {
          const escalatedModelDef = resolveModelForAgent(
            config.models,
            agentName,
            escalatedTier,
            escalationManager.getDefault(),
          );
          let escalationPrompt = RectifierPromptBuilder.escalated(
            finalFailure.testSummary.failures,
            story,
            outcome.attempts,
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
              pipelineStage: "rectification",
              config,
              projectDir,
              maxInteractionTurns: config.agent?.maxInteractionTurns,
              featureName,
              storyId: story.id,
              sessionRole: "implementer",
            },
          });

          costAccum += escalationRunResult.estimatedCostUsd ?? 0;
          logger?.info("rectification", "escalated rectification attempt cost", {
            storyId: story.id,
            escalatedTier,
            cost: escalationRunResult.estimatedCostUsd,
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
            return { succeeded: true, cost: costAccum, durationMs: Date.now() - loopStartMs };
          }

          logger?.warn("rectification", "escalated rectification also failed", { storyId: story.id, escalatedTier });
        }
      }
    }

    logger?.warn("rectification", `${label} exhausted max retries`, {
      storyId: story.id,
      attempts: outcome.attempts,
      remainingFailures: initialFailure.testSummary.failed,
    });
  }

  return { succeeded, cost: costAccum, durationMs: Date.now() - loopStartMs };
}
