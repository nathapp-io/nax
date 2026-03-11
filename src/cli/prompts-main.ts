/**
 * Prompts Main Command
 *
 * Assembles prompts for all stories in a feature without executing agents.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import { runPipeline } from "../pipeline";
import type { PipelineContext } from "../pipeline";
import { constitutionStage, contextStage, promptStage, routingStage } from "../pipeline/stages";
import type { UserStory } from "../prd";
import { loadPRD } from "../prd";
import { handleThreeSessionTddPrompts } from "./prompts-tdd";

export interface PromptsCommandOptions {
  /** Feature name */
  feature: string;
  /** Working directory (project root) */
  workdir: string;
  /** Ngent configuration */
  config: NaxConfig;
  /** Optional: filter to single story ID */
  storyId?: string;
  /** Optional: output directory (stdout if not provided) */
  outputDir?: string;
}

/**
 * Execute the `nax prompts` command.
 *
 * Runs the pipeline through routing → constitution → context → prompt stages
 * for each story, then outputs the assembled prompts to stdout or files.
 *
 * @param options - Command options
 * @returns Array of story IDs that were processed
 *
 * @example
 * ```bash
 * # Dump all story prompts to stdout
 * nax prompts -f core
 *
 * # Write to directory
 * nax prompts -f core --out ./prompt-dump/
 *
 * # Single story
 * nax prompts -f core --story US-003
 * ```
 */
export async function promptsCommand(options: PromptsCommandOptions): Promise<string[]> {
  const logger = getLogger();
  const { feature, workdir, config, storyId, outputDir } = options;

  // Find nax directory
  const naxDir = join(workdir, "nax");
  if (!existsSync(naxDir)) {
    throw new Error(`nax directory not found. Run 'nax init' first in ${workdir}`);
  }

  // Load PRD
  const featureDir = join(naxDir, "features", feature);
  const prdPath = join(featureDir, "prd.json");

  if (!existsSync(prdPath)) {
    throw new Error(`Feature "${feature}" not found or missing prd.json`);
  }

  const prd = await loadPRD(prdPath);

  // Filter stories
  const stories = storyId ? prd.userStories.filter((s) => s.id === storyId) : prd.userStories;

  if (stories.length === 0) {
    throw new Error(
      storyId ? `Story "${storyId}" not found in feature "${feature}"` : `No stories found in feature "${feature}"`,
    );
  }

  // Create output directory if specified
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
  }

  logger.info("cli", "Assembling prompts", {
    feature,
    storyCount: stories.length,
    outputMode: outputDir ? "files" : "stdout",
  });

  // Process each story through the pipeline (routing → constitution → context → prompt)
  const processedStories: string[] = [];
  const promptPipeline = [routingStage, constitutionStage, contextStage, promptStage];

  for (const story of stories) {
    // Build initial pipeline context
    const ctx: PipelineContext = {
      config,
      prd,
      story,
      stories: [story], // Single story, not batch
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Placeholder routing",
      }, // Will be set by routingStage
      workdir,
      featureDir,
      hooks: { hooks: {} }, // Empty hooks config
    };

    // Run the prompt assembly pipeline
    const result = await runPipeline(promptPipeline, ctx);

    if (!result.success) {
      logger.warn("cli", "Failed to assemble prompt for story", {
        storyId: story.id,
        reason: result.reason,
      });
      continue;
    }

    // Handle three-session TDD stories separately
    if (ctx.routing.testStrategy === "three-session-tdd") {
      await handleThreeSessionTddPrompts(story, ctx, outputDir, logger);
      processedStories.push(story.id);
      continue;
    }

    // For non-TDD stories, ensure prompt was built
    if (!ctx.prompt) {
      logger.warn("cli", "No prompt generated for story", {
        storyId: story.id,
      });
      continue;
    }

    // Build YAML frontmatter
    const frontmatter = buildFrontmatter(story, ctx);

    // Full output: frontmatter + prompt
    const fullOutput = `---\n${frontmatter}---\n\n${ctx.prompt}`;

    // Write to file or stdout
    if (outputDir) {
      const promptFile = join(outputDir, `${story.id}.prompt.md`);
      await Bun.write(promptFile, fullOutput);

      // Also write context-only file for isolation audit
      if (ctx.contextMarkdown) {
        const contextFile = join(outputDir, `${story.id}.context.md`);
        const contextOutput = `---\n${frontmatter}---\n\n${ctx.contextMarkdown}`;
        await Bun.write(contextFile, contextOutput);
      }

      logger.info("cli", "Written prompt files", {
        storyId: story.id,
        promptFile,
      });
    } else {
      // Stdout mode: print separator + story ID + prompt
      console.log(`\n${"=".repeat(80)}`);
      console.log(`Story: ${story.id} — ${story.title}`);
      console.log("=".repeat(80));
      console.log(fullOutput);
    }

    processedStories.push(story.id);
  }

  logger.info("cli", "Prompt assembly complete", {
    processedCount: processedStories.length,
  });

  return processedStories;
}

/**
 * Build YAML frontmatter for a story prompt.
 *
 * Uses actual token counts from BuiltContext elements (computed by context builder
 * using CHARS_PER_TOKEN=3) rather than re-estimating independently.
 *
 * @param story - User story
 * @param ctx - Pipeline context after running prompt assembly
 * @param role - Optional role for three-session TDD (test-writer, implementer, verifier)
 * @returns YAML frontmatter string (without delimiters)
 */
export function buildFrontmatter(story: UserStory, ctx: PipelineContext, role?: string): string {
  const lines: string[] = [];

  lines.push(`storyId: ${story.id}`);
  lines.push(`title: "${story.title}"`);
  lines.push(`testStrategy: ${ctx.routing.testStrategy}`);
  lines.push(`modelTier: ${ctx.routing.modelTier}`);

  if (role) {
    lines.push(`role: ${role}`);
  }

  // Use actual token counts from BuiltContext if available
  const builtContext = ctx.builtContext;
  const contextTokens = builtContext?.totalTokens ?? 0;
  const promptTokens = ctx.prompt ? Math.ceil(ctx.prompt.length / 3) : 0;

  lines.push(`contextTokens: ${contextTokens}`);
  lines.push(`promptTokens: ${promptTokens}`);

  // Dependencies
  if (story.dependencies && story.dependencies.length > 0) {
    lines.push(`dependencies: [${story.dependencies.join(", ")}]`);
  }

  // Context elements breakdown from actual BuiltContext
  lines.push("contextElements:");

  if (builtContext) {
    for (const element of builtContext.elements) {
      lines.push(`  - type: ${element.type}`);
      if (element.storyId) {
        lines.push(`    storyId: ${element.storyId}`);
      }
      if (element.filePath) {
        lines.push(`    filePath: ${element.filePath}`);
      }
      lines.push(`    tokens: ${element.tokens}`);
    }
  }

  if (builtContext?.truncated) {
    lines.push("truncated: true");
  }

  return `${lines.join("\n")}\n`;
}
