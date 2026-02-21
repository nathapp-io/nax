/**
 * Post-Agent Verification (ADR-003)
 *
 * Extracted from runner.ts to keep the main loop focused on orchestration.
 * Runs verification after the agent completes, reverts story state on failure.
 */

import type { NaxConfig } from "../config";
import type { PRD, UserStory } from "../prd";
import { savePRD, getExpectedFiles } from "../prd";
import { runVerification, parseTestOutput, getEnvironmentalEscalationThreshold } from "./verification";
import { getTierConfig } from "./escalation";
import { appendProgress } from "./progress";
import type { StoryMetrics } from "../metrics";
import { getLogger } from "../logger";

/**
 * Safely get logger instance, returns null if not initialized
 */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

export interface PostVerifyOptions {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  story: UserStory;
  storiesToExecute: UserStory[];
  allStoryMetrics: StoryMetrics[];
  timeoutRetryCountMap: Map<string, number>;
}

export interface PostVerifyResult {
  passed: boolean;
  prd: PRD;
}

/**
 * Run post-agent verification and handle failure state.
 *
 * When verification fails:
 * - Reverts all batch stories from passed → pending
 * - Removes stale story metrics added by completionStage
 * - Tracks timeout retries for --detectOpenHandles escalation
 * - Appends diagnostic context to story.priorErrors
 * - Increments attempts (if countsTowardEscalation)
 *
 * @design Shell command in config.quality.commands.test is operator-controlled,
 * not user/PRD input. No shell injection risk from untrusted sources.
 */
export async function runPostAgentVerification(opts: PostVerifyOptions): Promise<PostVerifyResult> {
  const { config, prd, prdPath, workdir, featureDir, story, storiesToExecute, allStoryMetrics, timeoutRetryCountMap } = opts;
  const logger = getSafeLogger();

  if (!config.quality.commands.test) {
    return { passed: true, prd };
  }

  logger?.debug("verification", "Running verification", {
    command: config.quality.commands.test,
  });

  const timeoutRetryCount = timeoutRetryCountMap.get(story.id) || 0;
  const verificationResult = await runVerification({
    workingDirectory: workdir,
    expectedFiles: getExpectedFiles(story),
    command: config.quality.commands.test,
    timeoutSeconds: config.execution.verificationTimeoutSeconds,
    forceExit: config.quality.forceExit,
    detectOpenHandles: config.quality.detectOpenHandles,
    detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
    timeoutRetryCount,
    gracePeriodMs: config.quality.gracePeriodMs,
    drainTimeoutMs: config.quality.drainTimeoutMs,
    shell: config.quality.shell,
    stripEnvVars: config.quality.stripEnvVars,
  });

  if (verificationResult.success) {
    logger?.info("verification", "Verification passed");
    if (verificationResult.output) {
      const analysis = parseTestOutput(verificationResult.output, 0);
      if (analysis.passCount > 0) {
        logger?.debug("verification", "Test results", {
          passCount: analysis.passCount,
          failCount: analysis.failCount,
        });
      }
    }
    return { passed: true, prd };
  }

  // --- Verification failed ---

  // Undo story metrics added by completionStage (BUG-1 fix)
  const storyIds = new Set(storiesToExecute.map(s => s.id));
  for (let i = allStoryMetrics.length - 1; i >= 0; i--) {
    if (storyIds.has(allStoryMetrics[i].storyId)) {
      allStoryMetrics.splice(i, 1);
    }
  }

  // Track timeout retries for --detectOpenHandles escalation
  if (verificationResult.status === "TIMEOUT") {
    timeoutRetryCountMap.set(story.id, timeoutRetryCount + 1);
  }

  // Revert ALL stories in this batch back to pending
  const diagnosticContext = verificationResult.error || `Verification failed: ${verificationResult.status}`;
  prd.userStories = prd.userStories.map(s =>
    storyIds.has(s.id)
      ? { ...s, priorErrors: [...(s.priorErrors || []), diagnosticContext], status: "pending" as const, passes: false }
      : s
  );

  logger?.warn("verification", `Verification ${verificationResult.status}`, {
    status: verificationResult.status,
    error: verificationResult.error?.split("\n")[0],
  });

  if (verificationResult.output && verificationResult.passCount !== undefined) {
    logger?.debug("verification", "Test results", {
      passCount: verificationResult.passCount,
      failCount: verificationResult.failCount,
    });
  }

  // Don't count toward escalation for timeouts (environmental issue)
  if (verificationResult.countsTowardEscalation) {
    // Increment attempts — this drives tier escalation
    prd.userStories = prd.userStories.map(s =>
      s.id === story.id ? { ...s, attempts: s.attempts + 1 } : s
    );

    // Environmental failures escalate faster (ceil(tierAttempts / divisor))
    if (verificationResult.status === "ENVIRONMENTAL_FAILURE") {
      const currentTier = story.routing?.modelTier || config.autoMode.escalation.tierOrder[0]?.tier;
      const tierCfg = currentTier ? getTierConfig(currentTier, config.autoMode.escalation.tierOrder) : undefined;
      if (tierCfg) {
        const threshold = getEnvironmentalEscalationThreshold(tierCfg.attempts, config.quality.environmentalEscalationDivisor);
        const currentAttempts = (prd.userStories.find(s => s.id === story.id)?.attempts ?? 0);
        if (currentAttempts >= threshold) {
          logger?.warn("verification", "Environmental failure hit early escalation threshold", {
            currentAttempts,
            threshold,
          });
        }
      }
    }
  }

  await savePRD(prd, prdPath);

  if (featureDir) {
    await appendProgress(featureDir, story.id, "failed",
      `${story.title} — ${verificationResult.status}: ${verificationResult.error?.split("\n")[0]}`);
  }

  return { passed: false, prd };
}
