/**
 * Prompts CLI Command
 *
 * Assembles prompts for all stories in a feature without executing agents.
 * Used for debugging prompt isolation and context leakage.
 *
 * Executes: routing → constitution → context → prompt stages only.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { loadPRD } from "../prd";
import { getLogger } from "../logger";
import { runPipeline } from "../pipeline";
import type { PipelineContext } from "../pipeline";
import {
  routingStage,
  constitutionStage,
  contextStage,
  promptStage,
} from "../pipeline/stages";

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
export async function promptsCommand(
  options: PromptsCommandOptions,
): Promise<string[]> {
  const logger = getLogger();
  const { feature, workdir, config, storyId, outputDir } = options;

  // Find nax directory
  const naxDir = join(workdir, "nax");
  if (!existsSync(naxDir)) {
    throw new Error(
      `nax directory not found. Run 'nax init' first in ${workdir}`,
    );
  }

  // Load PRD
  const featureDir = join(naxDir, "features", feature);
  const prdPath = join(featureDir, "prd.json");

  if (!existsSync(prdPath)) {
    throw new Error(`Feature "${feature}" not found or missing prd.json`);
  }

  const prd = await loadPRD(prdPath);

  // Filter stories
  const stories = storyId
    ? prd.userStories.filter((s) => s.id === storyId)
    : prd.userStories;

  if (stories.length === 0) {
    throw new Error(
      storyId
        ? `Story "${storyId}" not found in feature "${feature}"`
        : `No stories found in feature "${feature}"`,
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
  const promptPipeline = [
    routingStage,
    constitutionStage,
    contextStage,
    promptStage,
  ];

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
 * @param story - User story
 * @param ctx - Pipeline context after running prompt assembly
 * @param role - Optional role for three-session TDD (test-writer, implementer, verifier)
 * @returns YAML frontmatter string (without delimiters)
 */
function buildFrontmatter(story: any, ctx: PipelineContext, role?: string): string {
  const lines: string[] = [];

  lines.push(`storyId: ${story.id}`);
  lines.push(`title: "${story.title}"`);
  lines.push(`testStrategy: ${ctx.routing.testStrategy}`);
  lines.push(`modelTier: ${ctx.routing.modelTier}`);

  if (role) {
    lines.push(`role: ${role}`);
  }

  // Estimate token counts (rough approximation: 1 token ≈ 4 chars)
  const contextTokens = ctx.contextMarkdown
    ? Math.ceil(ctx.contextMarkdown.length / 4)
    : 0;
  const promptTokens = ctx.prompt ? Math.ceil(ctx.prompt.length / 4) : 0;

  lines.push(`contextTokens: ${contextTokens}`);
  lines.push(`promptTokens: ${promptTokens}`);

  // Dependencies
  if (story.dependencies && story.dependencies.length > 0) {
    lines.push(`dependencies: [${story.dependencies.join(", ")}]`);
  }

  // Context elements breakdown with detailed tracking
  lines.push("contextElements:");

  // Story element (base story description)
  const storyText = `${story.title}\n${story.description}\n${story.acceptanceCriteria.join("\n")}`;
  const storyTokens = Math.ceil(storyText.length / 4);
  lines.push("  - type: story");
  lines.push(`    storyId: ${story.id}`);
  lines.push(`    tokens: ${storyTokens}`);

  // Dependency elements
  if (story.dependencies && story.dependencies.length > 0) {
    for (const depId of story.dependencies) {
      const depStory = ctx.prd.userStories.find((s) => s.id === depId);
      if (depStory) {
        const depText = `${depStory.title}\n${depStory.description}\n${depStory.acceptanceCriteria.join("\n")}`;
        const depTokens = Math.ceil(depText.length / 4);
        lines.push("  - type: dependency");
        lines.push(`    storyId: ${depId}`);
        lines.push(`    tokens: ${depTokens}`);
      }
    }
  }

  // Progress summary (aggregate counts only, no story details)
  const progressTokens = Math.ceil("Progress: X/Y stories completed".length / 4);
  lines.push("  - type: progress");
  lines.push(`    tokens: ${progressTokens}`);

  // Test coverage (to be scoped in US-003)
  if (contextTokens > storyTokens + progressTokens) {
    const coverageTokens = contextTokens - storyTokens - progressTokens;
    lines.push("  - type: test-coverage");
    lines.push(`    tokens: ${coverageTokens}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Handle three-session TDD prompts by building separate prompts for each role.
 *
 * @param story - User story
 * @param ctx - Pipeline context
 * @param outputDir - Output directory (undefined for stdout)
 * @param logger - Logger instance
 */
async function handleThreeSessionTddPrompts(
  story: any,
  ctx: PipelineContext,
  outputDir: string | undefined,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  // Import TDD prompt builders
  const { buildTestWriterPrompt, buildImplementerPrompt, buildVerifierPrompt } = await import("../tdd/prompts");

  // Build prompts for each session
  const sessions = [
    { role: "test-writer", prompt: buildTestWriterPrompt(story, ctx.contextMarkdown) },
    { role: "implementer", prompt: buildImplementerPrompt(story, ctx.contextMarkdown) },
    { role: "verifier", prompt: buildVerifierPrompt(story) },
  ];

  for (const session of sessions) {
    const frontmatter = buildFrontmatter(story, ctx, session.role);
    const fullOutput = `---\n${frontmatter}---\n\n${session.prompt}`;

    if (outputDir) {
      const promptFile = join(outputDir, `${story.id}.${session.role}.md`);
      await Bun.write(promptFile, fullOutput);

      logger.info("cli", "Written TDD prompt file", {
        storyId: story.id,
        role: session.role,
        promptFile,
      });
    } else {
      // Stdout mode: print separator + story ID + role + prompt
      console.log(`\n${"=".repeat(80)}`);
      console.log(`Story: ${story.id} — ${story.title} [${session.role}]`);
      console.log("=".repeat(80));
      console.log(fullOutput);
    }
  }

  // Also write context-only file for isolation audit
  if (outputDir && ctx.contextMarkdown) {
    const contextFile = join(outputDir, `${story.id}.context.md`);
    const frontmatter = buildFrontmatter(story, ctx);
    const contextOutput = `---\n${frontmatter}---\n\n${ctx.contextMarkdown}`;
    await Bun.write(contextFile, contextOutput);
  }
}
