/**
 * Prompt Stage
 *
 * Assembles the final prompt for the agent from:
 * - Story/stories (batch or single)
 * - Context markdown
 * - Constitution content
 *
 * @returns
 * - `continue`: Prompt built successfully
 *
 * @example
 * ```ts
 * // Single story with constitution
 * await promptStage.execute(ctx);
 * // ctx.prompt: "# CONSTITUTION\n...\n\n# Task: Add login button\n..."
 *
 * // Batch of stories without constitution
 * await promptStage.execute(ctx);
 * // ctx.prompt: "# Batch Task: 3 Stories\n## Story 1: US-001...\n"
 * ```
 */

import { getLogger } from "../../logger";
import { PromptBuilder } from "../../prompts";
import type { AcceptanceEntry } from "../../prompts/sections/acceptance";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const _promptStageDeps = {
  async readFile(filePath: string): Promise<{ exists: boolean; text: string }> {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    return { exists, text: exists ? await file.text() : "" };
  },
};

async function _loadAcceptanceEntries(
  ctx: PipelineContext,
  logger: ReturnType<typeof getLogger>,
): Promise<AcceptanceEntry[]> {
  if (!ctx.acceptanceTestPaths || ctx.acceptanceTestPaths.length === 0) {
    return [];
  }
  const entries: AcceptanceEntry[] = [];
  for (const item of ctx.acceptanceTestPaths) {
    const testPath = typeof item === "string" ? item : item.testPath;
    const { exists, text } = await _promptStageDeps.readFile(testPath);
    if (!exists) {
      logger.debug("prompt", "Acceptance test file not found, skipping", {
        storyId: ctx.story?.id ?? "batch",
        testPath,
      });
      continue;
    }
    entries.push({ testPath, content: text });
  }
  return entries;
}

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) =>
    ctx.routing.testStrategy !== "three-session-tdd" && ctx.routing.testStrategy !== "three-session-tdd-lite",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;

    // PKG-004: use centrally resolved effective config
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;

    // AC6–AC8: load acceptance test file content from ctx.acceptanceTestPaths
    const acceptanceEntries = await _loadAcceptanceEntries(ctx, logger);

    let prompt: string;
    if (isBatch) {
      const builder = PromptBuilder.for("batch")
        .withLoader(ctx.workdir, ctx.config)
        .stories(ctx.stories)
        .context(ctx.contextMarkdown)
        .constitution(ctx.constitution?.content)
        .testCommand(effectiveConfig.quality?.commands?.test)
        .hermeticConfig(effectiveConfig.quality?.testing);
      if (acceptanceEntries.length > 0) builder.acceptanceContext(acceptanceEntries);
      prompt = await builder.build();
    } else {
      // no-test uses a dedicated role; all other single-session strategies use tdd-simple
      const role = ctx.routing.testStrategy === "no-test" ? ("no-test" as const) : ("tdd-simple" as const);
      const builder = PromptBuilder.for(role)
        .withLoader(ctx.workdir, ctx.config)
        .story(ctx.story)
        .context(ctx.contextMarkdown)
        .constitution(ctx.constitution?.content)
        .testCommand(effectiveConfig.quality?.commands?.test)
        .hermeticConfig(effectiveConfig.quality?.testing)
        .noTestJustification(ctx.story.routing?.noTestJustification);
      if (acceptanceEntries.length > 0) builder.acceptanceContext(acceptanceEntries);
      prompt = await builder.build();
    }

    ctx.prompt = prompt;

    if (isBatch) {
      logger.info("prompt", "Batch session prepared", {
        storyCount: ctx.stories.length,
        testStrategy: ctx.routing.testStrategy,
      });
    } else {
      logger.info("prompt", "Single session prepared", {
        storyId: ctx.story.id,
        testStrategy: ctx.routing.testStrategy,
      });
    }

    return { action: "continue" };
  },
};
