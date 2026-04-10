/**
 * Constitution Generator Orchestrator
 *
 * Generates agent-specific config files from nax/constitution.md.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateFilePath } from "../config/path-security";
import { aiderGenerator } from "./generators/aider";
import { claudeGenerator } from "./generators/claude";
import { cursorGenerator } from "./generators/cursor";
import { opencodeGenerator } from "./generators/opencode";
import type { AgentType, ConstitutionContent, GeneratorMap } from "./generators/types";
import { windsurfGenerator } from "./generators/windsurf";

/** Generator registry */
const GENERATORS: GeneratorMap = {
  claude: claudeGenerator,
  opencode: opencodeGenerator,
  cursor: cursorGenerator,
  windsurf: windsurfGenerator,
  aider: aiderGenerator,
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
  /** Constitution file path (default: nax/constitution.md) */
  constitutionPath: string;
  /** Output directory (default: project root) */
  outputDir: string;
  /** Dry run mode (don't write files) */
  dryRun?: boolean;
  /** Specific agent to generate for (default: all) */
  agent?: AgentType;
}

/**
 * Load constitution content from file
 */
async function loadConstitutionContent(constitutionPath: string): Promise<ConstitutionContent> {
  if (!existsSync(constitutionPath)) {
    throw new Error(`Constitution file not found: ${constitutionPath}`);
  }

  const file = Bun.file(constitutionPath);
  const markdown = await file.text();

  return {
    markdown,
    sections: {}, // TODO: implement section parsing if needed
  };
}

/**
 * Generate config for a specific agent
 */
function generateForAgent(
  agent: AgentType,
  constitution: ConstitutionContent,
): { content: string; outputFile: string } {
  const generator = GENERATORS[agent];
  if (!generator) {
    throw new Error(`Unknown agent type: ${agent}`);
  }

  const content = generator.generate(constitution);
  return {
    content,
    outputFile: generator.outputFile,
  };
}

/**
 * Write generated content to file
 */
async function writeGeneratedFile(outputDir: string, filename: string, content: string): Promise<void> {
  const outputPath = join(outputDir, filename);

  // SEC-5: Validate path before writing
  const validatedPath = validateFilePath(outputPath, outputDir);

  await Bun.write(validatedPath, content);
}

/**
 * Generate config for a specific agent
 *
 * @param agent - Agent type to generate for
 * @param constitutionPath - Path to constitution file
 * @param outputDir - Directory to write output file
 * @param dryRun - If true, don't write files
 * @returns Generation result
 */
export async function generateFor(
  agent: AgentType,
  constitutionPath: string,
  outputDir: string,
  dryRun = false,
): Promise<GenerationResult> {
  try {
    const constitution = await loadConstitutionContent(constitutionPath);
    const { content, outputFile } = generateForAgent(agent, constitution);

    if (!dryRun) {
      await writeGeneratedFile(outputDir, outputFile, content);
    }

    return {
      agent,
      outputFile,
      content,
      written: !dryRun,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      agent,
      outputFile: GENERATORS[agent].outputFile,
      content: "",
      written: false,
      error,
    };
  }
}

/**
 * Generate config files for all agents
 *
 * @param constitutionPath - Path to constitution file
 * @param outputDir - Directory to write output files
 * @param dryRun - If true, don't write files
 * @returns Array of generation results
 */
export async function generateAll(
  constitutionPath: string,
  outputDir: string,
  dryRun = false,
): Promise<GenerationResult[]> {
  const agents: AgentType[] = ["claude", "opencode", "cursor", "windsurf", "aider"];
  const results: GenerationResult[] = [];

  for (const agent of agents) {
    const result = await generateFor(agent, constitutionPath, outputDir, dryRun);
    results.push(result);
  }

  return results;
}
