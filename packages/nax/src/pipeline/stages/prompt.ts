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

import { resolveAcceptanceExecution } from "@/acceptance";
import { assembleForStage, executionContextStage } from "@/context/engine";
import { getLogger } from "@/logger";
import { PromptBuilder } from "@/prompts";
import { commandSpecIncludes, renderCommandSpec, resolveSelfVerificationPromptInput } from "@/quality";
import { resolveScopeFiles } from "../scope-files";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const _promptStageDeps = {
  async readFile(filePath: string, metadataOnly = false): Promise<{ exists: boolean; text: string }> {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    return { exists, text: exists && !metadataOnly ? await file.text() : "" };
  },
};

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) =>
    ctx.routing.testStrategy !== "three-session-tdd" && ctx.routing.testStrategy !== "three-session-tdd-lite",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;

    // AC6–AC8: load acceptance test file content from ctx.acceptanceTestPaths
    const acceptanceEntries = await resolveAcceptanceExecution(ctx, _promptStageDeps);
    const selfVerification = await resolveSelfVerificationPromptInput(ctx.config, ctx.workdir);

    // Assemble a stage-specific v2 bundle for the execution stage so the agent receives
    // the correct role/provider/budget context (Finding 1 fix).  Falls back to null when
    // v2 is disabled; getBundleMarkdown() then returns ctx.featureContextMarkdown.
    const execStage = executionContextStage({ isBatch, testStrategy: ctx.routing.testStrategy });
    const scopeFiles = ctx.scopeFiles ?? (await resolveScopeFiles(ctx));
    const execBundle = await assembleForStage(ctx, execStage, {
      ...(scopeFiles.length > 0 && { scopeFiles }),
    });
    if (execBundle) {
      ctx.contextBundle = execBundle;
    }

    let prompt: string;
    // US-004 — gate the `run-test` region on the SSOT for naming the
    // `testScoped` key (`RunCommand` resolves by exact placeholder match;
    // a template that takes `{{file}}` / `{{package}}` / no placeholder
    // would render a tool call the runtime rejects). The SSOT lives at
    // src/execution/lifecycle/acceptance-helpers.ts:89.
    const scopedTestCommand = commandSpecIncludes(ctx.config.quality?.commands?.testScoped, "{{files}}")
      ? "testScoped"
      : undefined;
    if (isBatch) {
      const builder = PromptBuilder.for("batch")
        .withLoader(ctx.workdir, ctx.config)
        .stories(ctx.stories)
        .context(ctx.contextMarkdown)
        .v2FeatureContext(execBundle?.pushMarkdown)
        .featureContext(execBundle ? undefined : (ctx.featureContextMarkdown ?? ""))
        .constitution(ctx.constitution?.content)
        .testCommand(renderCommandSpec(ctx.config.quality?.commands?.test))
        .scopedTestCommand(scopedTestCommand)
        .hermeticConfig(ctx.config.quality?.testing)
        .selfVerification(selfVerification);
      if (acceptanceEntries.length > 0) builder.acceptanceExecution(acceptanceEntries);
      prompt = await builder.build();
    } else {
      // no-test uses a dedicated role; all other single-session strategies use tdd-simple
      const role = ctx.routing.testStrategy === "no-test" ? ("no-test" as const) : ("tdd-simple" as const);
      const builder = PromptBuilder.for(role)
        .withLoader(ctx.workdir, ctx.config)
        .story(ctx.story)
        .context(ctx.contextMarkdown)
        .v2FeatureContext(execBundle?.pushMarkdown)
        .featureContext(execBundle ? undefined : (ctx.featureContextMarkdown ?? ""))
        .constitution(ctx.constitution?.content)
        .testCommand(renderCommandSpec(ctx.config.quality?.commands?.test))
        .scopedTestCommand(scopedTestCommand)
        .hermeticConfig(ctx.config.quality?.testing)
        .selfVerification(selfVerification)
        .noTestJustification(ctx.story.routing?.noTestJustification);
      if (acceptanceEntries.length > 0) builder.acceptanceExecution(acceptanceEntries);
      prompt = await builder.build();
    }

    ctx.prompt = prompt;

    if (isBatch) {
      logger.info("prompt", "Batch session prepared", {
        storyId: "batch",
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
