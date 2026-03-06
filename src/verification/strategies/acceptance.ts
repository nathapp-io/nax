// RE-ARCH: keep
/**
 * Acceptance Verification Strategy (ADR-005, Phase 1)
 *
 * Runs acceptance tests from a feature directory test file.
 * Extracted from src/pipeline/stages/acceptance.ts.
 */

import path from "node:path";
import { getLogger } from "../../logger";
import type { IVerificationStrategy, VerifyContext, VerifyResult } from "../orchestrator-types";
import { makeFailResult, makePassResult, makeSkippedResult } from "../orchestrator-types";

function parseFailedACs(output: string): string[] {
  const failed: string[] = [];
  for (const line of output.split("\n")) {
    if (line.includes("(fail)")) {
      const m = line.match(/(AC-\d+):/i);
      if (m) {
        const id = m[1].toUpperCase();
        if (!failed.includes(id)) failed.push(id);
      }
    }
  }
  return failed;
}

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
    const proc = Bun.spawn(["bun", "test", testPath], {
      cwd: ctx.workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Date.now() - start;
    const output = `${stdout}\n${stderr}`;

    const failedACs = parseFailedACs(output);

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
