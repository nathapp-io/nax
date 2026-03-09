/**
 * Context Generator Orchestrator (v0.16.1)
 *
 * Generates agent-specific config files from nax/context.md + auto-injected metadata.
 * Replaces the old constitution generator.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { validateFilePath } from "../config/path-security";
import { aiderGenerator } from "./generators/aider";
import { claudeGenerator } from "./generators/claude";
import { codexGenerator } from "./generators/codex";
import { cursorGenerator } from "./generators/cursor";
import { geminiGenerator } from "./generators/gemini";
import { opencodeGenerator } from "./generators/opencode";
import { windsurfGenerator } from "./generators/windsurf";
import { buildProjectMetadata } from "./injector";
import type { AgentContextGenerator, AgentType, ContextContent, GeneratorMap } from "./types";

/** Generator registry */
const GENERATORS: GeneratorMap = {
  claude: claudeGenerator,
  codex: codexGenerator,
  opencode: opencodeGenerator,
  cursor: cursorGenerator,
  windsurf: windsurfGenerator,
  aider: aiderGenerator,
  gemini: geminiGenerator,
};

/** Generation result for a single agent */
export interface GenerationResult {
  agent: AgentType;
  outputFile: string;
  content: string;
  written: boolean;
  error?: string;
}

/** Generate options */
export interface GenerateOptions {
  /** Path to nax/context.md (default: <workdir>/nax/context.md) */
  contextPath: string;
  /** Output directory (default: project root) */
  outputDir: string;
  /** Working directory for metadata injection */
  workdir: string;
  /** Dry run mode */
  dryRun?: boolean;
  /** Specific agent (default: all) */
  agent?: AgentType;
  /** Auto-inject project metadata (default: true) */
  autoInject?: boolean;
}

/**
 * Load context content and optionally inject project metadata.
 */
async function loadContextContent(options: GenerateOptions, config: NaxConfig): Promise<ContextContent> {
  if (!existsSync(options.contextPath)) {
    throw new Error(`Context file not found: ${options.contextPath}`);
  }

  const file = Bun.file(options.contextPath);
  const markdown = await file.text();

  const autoInject = options.autoInject ?? true;
  const metadata = autoInject ? await buildProjectMetadata(options.workdir, config) : undefined;

  return { markdown, metadata };
}

/**
 * Generate config for a specific agent.
 */
async function generateFor(agent: AgentType, options: GenerateOptions, config: NaxConfig): Promise<GenerationResult> {
  const generator = GENERATORS[agent];
  if (!generator) {
    return { agent, outputFile: "", content: "", written: false, error: `Unknown agent: ${agent}` };
  }

  try {
    const context = await loadContextContent(options, config);
    const content = generator.generate(context);
    const outputPath = join(options.outputDir, generator.outputFile);

    validateFilePath(outputPath, options.outputDir);

    if (!options.dryRun) {
      await Bun.write(outputPath, content);
    }

    return { agent, outputFile: generator.outputFile, content, written: !options.dryRun };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { agent, outputFile: generator.outputFile, content: "", written: false, error };
  }
}

/**
 * Generate configs for all agents.
 */
async function generateAll(options: GenerateOptions, config: NaxConfig): Promise<GenerationResult[]> {
  // Load context once and share across generators
  const context = await loadContextContent(options, config);

  const results: GenerationResult[] = [];

  for (const [agentKey, generator] of Object.entries(GENERATORS) as [AgentType, AgentContextGenerator][]) {
    try {
      const content = generator.generate(context);
      const outputPath = join(options.outputDir, generator.outputFile);

      validateFilePath(outputPath, options.outputDir);

      if (!options.dryRun) {
        await Bun.write(outputPath, content);
      }

      results.push({ agent: agentKey, outputFile: generator.outputFile, content, written: !options.dryRun });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ agent: agentKey, outputFile: generator.outputFile, content: "", written: false, error });
    }
  }

  return results;
}

export { generateFor, generateAll };
export type { AgentType };
