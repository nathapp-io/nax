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
import type { BuiltContext } from "../context/types";
import { getLogger } from "../logger";
import { runPipeline } from "../pipeline";
import type { PipelineContext } from "../pipeline";
import { constitutionStage, contextStage, promptStage, routingStage } from "../pipeline/stages";
import type { UserStory } from "../prd";
import { loadPRD } from "../prd";
import { PromptBuilder } from "../prompts";
import { buildRoleTaskSection } from "../prompts/sections/role-task";

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
function buildFrontmatter(story: UserStory, ctx: PipelineContext, role?: string): string {
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

export interface PromptsInitCommandOptions {
  /** Working directory (project root) */
  workdir: string;
  /** Overwrite existing files if true */
  force?: boolean;
}

const TEMPLATE_ROLES = [
  { file: "test-writer.md", role: "test-writer" as const },
  { file: "implementer.md", role: "implementer" as const, variant: "standard" as const },
  { file: "verifier.md", role: "verifier" as const },
  { file: "single-session.md", role: "single-session" as const },
  { file: "tdd-simple.md", role: "tdd-simple" as const },
] as const;

const TEMPLATE_HEADER = `<!--
  This file controls the role-body section of the nax prompt for this role.
  Edit the content below to customize the task instructions given to the agent.

  NON-OVERRIDABLE SECTIONS (always injected by nax, cannot be changed here):
    - Isolation rules (scope, file access boundaries)
    - Story context (acceptance criteria, description, dependencies)
    - Conventions (project coding standards)

  To activate overrides, add to your nax/config.json:
    { "prompts": { "overrides": { "<role>": "nax/templates/<role>.md" } } }
-->

`;

/**
 * Execute the `nax prompts --init` command.
 *
 * Creates nax/templates/ and writes 4 default role-body template files.
 * Auto-wires prompts.overrides in nax.config.json if the file exists and overrides are not already set.
 * Returns the list of file paths written. Returns empty array if files
 * already exist and force is not set.
 *
 * @param options - Command options
 * @returns Array of file paths written
 */
export async function promptsInitCommand(options: PromptsInitCommandOptions): Promise<string[]> {
  const { workdir, force = false } = options;
  const templatesDir = join(workdir, "nax", "templates");

  mkdirSync(templatesDir, { recursive: true });

  // Check for existing files
  const existingFiles = TEMPLATE_ROLES.map((t) => t.file).filter((f) => existsSync(join(templatesDir, f)));

  if (existingFiles.length > 0 && !force) {
    console.warn(
      `[WARN] nax/templates/ already contains files: ${existingFiles.join(", ")}. No files overwritten.\n       Pass --force to overwrite existing templates.`,
    );
    return [];
  }

  const written: string[] = [];

  for (const template of TEMPLATE_ROLES) {
    const filePath = join(templatesDir, template.file);
    const roleBody =
      template.role === "implementer"
        ? buildRoleTaskSection(template.role, template.variant)
        : buildRoleTaskSection(template.role);
    const content = TEMPLATE_HEADER + roleBody;
    await Bun.write(filePath, content);
    written.push(filePath);
  }

  console.log(`[OK] Written ${written.length} template files to nax/templates/:`);
  for (const filePath of written) {
    console.log(`  - ${filePath.replace(`${workdir}/`, "")}`);
  }

  // Auto-wire prompts.overrides in nax.config.json
  await autoWirePromptsConfig(workdir);

  return written;
}

/**
 * Auto-wire prompts.overrides in nax.config.json after template init.
 *
 * If nax.config.json exists and prompts.overrides is not already set,
 * add the override paths. If overrides are already set, print a note.
 * If nax.config.json doesn't exist, print manual instructions.
 *
 * @param workdir - Project working directory
 */
async function autoWirePromptsConfig(workdir: string): Promise<void> {
  const configPath = join(workdir, "nax.config.json");

  // If config file doesn't exist, print manual instructions
  if (!existsSync(configPath)) {
    const exampleConfig = JSON.stringify(
      {
        prompts: {
          overrides: {
            "test-writer": "nax/templates/test-writer.md",
            implementer: "nax/templates/implementer.md",
            verifier: "nax/templates/verifier.md",
            "single-session": "nax/templates/single-session.md",
            "tdd-simple": "nax/templates/tdd-simple.md",
          },
        },
      },
      null,
      2,
    );
    console.log(`\nNo nax.config.json found. To activate overrides, create nax/config.json with:\n${exampleConfig}`);
    return;
  }

  // Read existing config
  const configFile = Bun.file(configPath);
  const configContent = await configFile.text();
  const config = JSON.parse(configContent);

  // Check if prompts.overrides is already set
  if (config.prompts?.overrides && Object.keys(config.prompts.overrides).length > 0) {
    console.log(
      "[INFO] prompts.overrides already configured in nax.config.json. Skipping auto-wiring.\n" +
        "       To reset overrides, remove the prompts.overrides section and re-run this command.",
    );
    return;
  }

  // Build the override paths
  const overrides = {
    "test-writer": "nax/templates/test-writer.md",
    implementer: "nax/templates/implementer.md",
    verifier: "nax/templates/verifier.md",
    "single-session": "nax/templates/single-session.md",
    "tdd-simple": "nax/templates/tdd-simple.md",
  };

  // Add or update prompts section
  if (!config.prompts) {
    config.prompts = {};
  }
  config.prompts.overrides = overrides;

  // Write config with custom formatting that avoids 4-space indentation
  // by putting the overrides object on a single line
  const updatedConfig = formatConfigJson(config);
  await Bun.write(configPath, updatedConfig);

  console.log("[OK] Auto-wired prompts.overrides in nax.config.json");
}

/**
 * Format config JSON with 2-space indentation, keeping overrides object inline.
 *
 * This avoids 4-space indentation by putting the overrides object on the same line.
 *
 * @param config - Configuration object
 * @returns Formatted JSON string
 */
function formatConfigJson(config: Record<string, unknown>): string {
  const lines: string[] = ["{"];

  const keys = Object.keys(config);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = config[key];
    const isLast = i === keys.length - 1;

    if (key === "prompts" && typeof value === "object" && value !== null) {
      // Special handling for prompts object - keep overrides inline
      const promptsObj = value as Record<string, unknown>;
      if (promptsObj.overrides) {
        const overridesJson = JSON.stringify(promptsObj.overrides);
        lines.push(`  "${key}": { "overrides": ${overridesJson} }${isLast ? "" : ","}`);
      } else {
        lines.push(`  "${key}": ${JSON.stringify(value)}${isLast ? "" : ","}`);
      }
    } else {
      lines.push(`  "${key}": ${JSON.stringify(value)}${isLast ? "" : ","}`);
    }
  }

  lines.push("}");
  return lines.join("\n");
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
  story: UserStory,
  ctx: PipelineContext,
  outputDir: string | undefined,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  // Build prompts for each session using PromptBuilder
  const [testWriterPrompt, implementerPrompt, verifierPrompt] = await Promise.all([
    PromptBuilder.for("test-writer", { isolation: "strict" })
      .withLoader(ctx.workdir, ctx.config)
      .story(story)
      .context(ctx.contextMarkdown)
      .build(),
    PromptBuilder.for("implementer", { variant: "standard" })
      .withLoader(ctx.workdir, ctx.config)
      .story(story)
      .context(ctx.contextMarkdown)
      .build(),
    PromptBuilder.for("verifier").withLoader(ctx.workdir, ctx.config).story(story).context(ctx.contextMarkdown).build(),
  ]);

  const sessions = [
    { role: "test-writer", prompt: testWriterPrompt },
    { role: "implementer", prompt: implementerPrompt },
    { role: "verifier", prompt: verifierPrompt },
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
