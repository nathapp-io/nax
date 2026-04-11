// RE-ARCH: keep
/**
 * Rectify Stage (ADR-005, Phase 2)
 *
 * Runs after a failed verify stage. Attempts to fix test failures by
 * running a rectification loop (agent + re-verify cycle).
 *
 * Enabled only when ctx.verifyResult?.success === false.
 *
 * Returns:
 * - `retry` fromStage:"verify" — rectification fixed the failures
 * - `escalate`                 — max retries exhausted
 */

import { join } from "node:path";
import { getLogger } from "../../logger";
import { isMonorepoOrchestratorCommand } from "../../verification/strategies/scoped";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const rectifyStage: PipelineStage = {
  name: "rectify",

  enabled(ctx: PipelineContext): boolean {
    // Only run when verify failed
    if (!ctx.verifyResult) return false;
    if (ctx.verifyResult.success) return false;
    // Only run when rectification is enabled in config
    return ctx.config.execution.rectification?.enabled ?? false;
  },

  skipReason(ctx: PipelineContext): string {
    if (!ctx.verifyResult || ctx.verifyResult.success) return "not needed (verify passed)";
    return "disabled (rectification not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { verifyResult } = ctx;

    if (!verifyResult || verifyResult.success) {
      return { action: "continue" };
    }

    const testOutput = verifyResult.rawOutput ?? "";
    const maxRetries = ctx.config.execution.rectification?.maxRetries ?? 3;

    logger.info("rectify", "Starting rectification loop", {
      storyId: ctx.story.id,
      failCount: verifyResult.failCount,
      maxRetries,
    });

    ctx.rectifyAttempt = (ctx.rectifyAttempt ?? 0) + 1;
    const rectifyAttempt = ctx.rectifyAttempt;

    pipelineEventBus.emit({
      type: "rectify:started",
      storyId: ctx.story.id,
      attempt: rectifyAttempt,
      testOutput,
    });

    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test ?? "bun test";
    const rawScopedTemplate = ctx.config.quality.commands.testScoped;

    // Resolve {{package}} in testScoped template for monorepo stories (mirrors verify.ts).
    // ctx.workdir is already the resolved package directory (MW-006).
    let resolvedScopedTemplate = rawScopedTemplate;
    if (rawScopedTemplate?.includes("{{package}}") && ctx.story.workdir) {
      const pkgName = await _rectifyDeps.readPackageName(ctx.workdir);
      resolvedScopedTemplate = pkgName !== null ? rawScopedTemplate.replaceAll("{{package}}", pkgName) : undefined;
    }

    // Monorepo orchestrators (turbo/nx) handle scoping natively via --filter.
    // The resolved scoped template IS the run command; per-file expansion would break their syntax.
    let effectiveTestCommand = testCommand;
    let testScopedTemplate = resolvedScopedTemplate;
    if (isMonorepoOrchestratorCommand(testCommand)) {
      if (resolvedScopedTemplate && ctx.story.workdir) {
        effectiveTestCommand = resolvedScopedTemplate;
      }
      testScopedTemplate = undefined; // no per-file expansion for orchestrators
    }

    const { succeeded, cost } = await _rectifyDeps.runRectificationLoop(ctx, {
      testCommand: effectiveTestCommand,
      testOutput,
      testScopedTemplate,
    });

    pipelineEventBus.emit({
      type: "rectify:completed",
      storyId: ctx.story.id,
      attempt: rectifyAttempt,
      fixed: succeeded,
    });

    if (succeeded) {
      logger.info("rectify", "Rectification succeeded — retrying verify", { storyId: ctx.story.id });
      // Clear verifyResult so verify stage re-runs fresh
      ctx.verifyResult = undefined;
      return { action: "retry", fromStage: "verify", cost };
    }

    logger.warn("rectify", "Rectification exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: `Rectification exhausted after ${maxRetries} attempts (${verifyResult.failCount} test failures)`,
      cost,
    };
  },
};

/**
 * Read the npm package name from <dir>/package.json.
 * Returns null if not found or file has no name field.
 */
async function readPackageName(dir: string): Promise<string | null> {
  try {
    const content = await Bun.file(join(dir, "package.json")).json();
    return typeof content.name === "string" ? content.name : null;
  } catch {
    return null;
  }
}

/**
 * Injectable deps for testing.
 */
import { runRectificationLoopFromCtx } from "../../verification/rectification-loop";
export const _rectifyDeps = {
  runRectificationLoop: runRectificationLoopFromCtx,
  readPackageName,
};
