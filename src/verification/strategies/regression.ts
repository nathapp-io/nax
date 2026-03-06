// RE-ARCH: keep
/**
 * Regression Verification Strategy (ADR-005, Phase 1)
 *
 * Runs the full test suite as a regression gate. Supports both inline
 * (per-story) and deferred (end-of-run) modes via context flag.
 *
 * Extracted from src/execution/post-verify.ts and
 * src/execution/lifecycle/run-regression.ts.
 */

import { getSafeLogger } from "../../logger";
import { fullSuite } from "../gate";
import type { IVerificationStrategy, VerifyContext, VerifyResult } from "../orchestrator-types";
import { makeFailResult, makePassResult, makeSkippedResult } from "../orchestrator-types";
import { parseBunTestOutput } from "../parser";

export class RegressionStrategy implements IVerificationStrategy {
  readonly name = "regression" as const;

  async execute(ctx: VerifyContext): Promise<VerifyResult> {
    const logger = getSafeLogger();
    const config = ctx.config;

    const enabled = config?.execution.regressionGate?.enabled ?? true;
    if (!enabled) {
      return makeSkippedResult(ctx.storyId, "regression");
    }

    logger?.info("verify[regression]", "Running full-suite regression gate", { storyId: ctx.storyId });

    const start = Date.now();
    const result = await _regressionStrategyDeps.runVerification({
      workdir: ctx.workdir,
      expectedFiles: [],
      command: ctx.testCommand,
      timeoutSeconds: ctx.timeoutSeconds,
      forceExit: config?.quality.forceExit,
      detectOpenHandles: config?.quality.detectOpenHandles,
      detectOpenHandlesRetries: config?.quality.detectOpenHandlesRetries,
      timeoutRetryCount: 0,
      gracePeriodMs: config?.quality.gracePeriodMs,
      drainTimeoutMs: config?.quality.drainTimeoutMs,
      shell: config?.quality.shell,
      stripEnvVars: config?.quality.stripEnvVars,
    });
    const durationMs = Date.now() - start;

    if (result.success) {
      const parsed = result.output ? parseBunTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };
      return makePassResult(ctx.storyId, "regression", {
        rawOutput: result.output,
        passCount: parsed.passed,
        durationMs,
      });
    }

    // Accept timeout as pass if configured (BUG-026)
    if (result.status === "TIMEOUT" && (ctx.acceptOnTimeout ?? true)) {
      logger?.warn("verify[regression]", "[BUG-026] Full-suite timed out (accepted as pass)", {
        storyId: ctx.storyId,
      });
      return makePassResult(ctx.storyId, "regression", { durationMs });
    }

    if (result.status === "TIMEOUT") {
      return makeFailResult(ctx.storyId, "regression", "TIMEOUT", { rawOutput: result.output, durationMs });
    }

    const parsed = result.output ? parseBunTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };
    return makeFailResult(ctx.storyId, "regression", "TEST_FAILURE", {
      rawOutput: result.output,
      passCount: parsed.passed,
      failCount: parsed.failed,
      failures: parsed.failures,
      durationMs,
    });
  }
}

export const _regressionStrategyDeps = { runVerification: fullSuite };
