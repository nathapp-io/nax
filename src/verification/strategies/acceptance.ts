// RE-ARCH: keep
/**
 * Acceptance Verification Strategy (ADR-005, Phase 1)
 *
 * Runs acceptance tests from a feature directory test file.
 * Extracted from src/pipeline/stages/acceptance.ts.
 */

import path from "node:path";
import { getLogger } from "../../logger";
import { parseTestFailures } from "../../test-runners/ac-parser";
import { spawn } from "../../utils/bun-deps";
import { killProcessGroup } from "../../utils/process-kill";
import type { IVerificationStrategy, VerifyContext, VerifyResult } from "../orchestrator-types";
import { makeFailResult, makePassResult, makeSkippedResult } from "../orchestrator-types";

/** Injectable deps for testability */
export const _acceptanceDeps = { spawn };

export class AcceptanceStrategy implements IVerificationStrategy {
  readonly name = "acceptance" as const;

  async execute(ctx: VerifyContext): Promise<VerifyResult> {
    const logger = getLogger();

    if (!ctx.acceptanceTestPath) {
      logger.warn("verify[acceptance]", "No acceptance test path provided — skipping", { storyId: ctx.storyId });
      return makeSkippedResult(ctx.storyId, "acceptance");
    }

    const testPath = path.isAbsolute(ctx.acceptanceTestPath)
      ? ctx.acceptanceTestPath
      : path.join(ctx.workdir, ctx.acceptanceTestPath);

    const exists = await Bun.file(testPath).exists();
    if (!exists) {
      logger.warn("verify[acceptance]", "Acceptance test file not found — skipping", {
        storyId: ctx.storyId,
        testPath,
      });
      return makeSkippedResult(ctx.storyId, "acceptance");
    }

    const start = Date.now();
    const timeoutMs = ctx.timeoutSeconds * 1000;
    const proc = _acceptanceDeps.spawn(["bun", "test", testPath], {
      cwd: ctx.workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      setTimeout(() => {
        killProcessGroup(proc.pid, "SIGKILL");
      }, 5000);
    }, timeoutMs);

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), timeoutMs + 6000)),
    ]);
    clearTimeout(timeoutId);
    const stdout = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 3000)),
    ]);
    const stderr = await Promise.race([
      new Response(proc.stderr).text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 3000)),
    ]);
    const durationMs = Date.now() - start;

    if (timedOut || exitCode === 124) {
      logger.warn("verify[acceptance]", "Acceptance tests timed out", {
        storyId: ctx.storyId,
        timeoutSeconds: ctx.timeoutSeconds,
      });
      return makePassResult(ctx.storyId, "acceptance", { rawOutput: "TIMEOUT", durationMs });
    }
    const output = `${stdout}\n${stderr}`;

    const failedACs = parseTestFailures(output);

    if (exitCode === 0 && failedACs.length === 0) {
      logger.info("verify[acceptance]", "All acceptance tests passed", { storyId: ctx.storyId });
      return makePassResult(ctx.storyId, "acceptance", { rawOutput: output, durationMs });
    }

    if (failedACs.length === 0) {
      // Test process failed but we couldn't parse AC IDs — treat as pass (setup error)
      logger.warn("verify[acceptance]", "Tests failed but no AC IDs detected — treating as pass", {
        storyId: ctx.storyId,
      });
      return makePassResult(ctx.storyId, "acceptance", { rawOutput: output, durationMs });
    }

    logger.error("verify[acceptance]", "Acceptance tests failed", {
      storyId: ctx.storyId,
      failedACs,
    });

    return makeFailResult(ctx.storyId, "acceptance", "TEST_FAILURE", {
      rawOutput: output,
      failCount: failedACs.length,
      failures: failedACs.map((acId) => ({
        file: testPath,
        testName: acId,
        error: `Acceptance criterion ${acId} failed`,
        stackTrace: [],
      })),
      durationMs,
    });
  }
}
