/**
 * Constitution CLI Command
 *
 * Generates agent-specific config files from nax/constitution.md.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { generateAll, generateFor } from "../constitution/generator";
import type { AgentType } from "../constitution/generators/types";

/** Constitution generate options */
export interface ConstitutionGenerateOptions {
  /** Path to constitution file (default: nax/constitution.md) */
  constitution?: string;
  /** Output directory (default: project root) */
  output?: string;
  /** Specific agent to generate for (default: all) */
  agent?: string;
  /** Dry run mode (don't write files) */
  dryRun?: boolean;
}

/**
 * Constitution generate command
 */
export async function constitutionGenerateCommand(options: ConstitutionGenerateOptions): Promise<void> {
  const workdir = process.cwd();
  const constitutionPath = options.constitution
    ? join(workdir, options.constitution)
    : join(workdir, "nax/constitution.md");
  const outputDir = options.output ? join(workdir, options.output) : workdir;

  // Validate constitution file exists
  if (!existsSync(constitutionPath)) {
    console.error(chalk.red(`[FAIL] Constitution file not found: ${constitutionPath}`));
    console.error(chalk.yellow(`Create ${constitutionPath} first or use --constitution to specify a different path.`));
    process.exit(1);
  }

  console.log(chalk.blue(`[OK] Loading constitution from ${constitutionPath}`));

  // Validate agent type if specified
  const validAgents: AgentType[] = ["claude", "opencode", "cursor", "windsurf", "aider"];
  if (options.agent && !validAgents.includes(options.agent as AgentType)) {
    console.error(chalk.red(`[FAIL] Unknown agent type: ${options.agent}`));
    console.error(chalk.yellow(`Valid agents: ${validAgents.join(", ")}`));
    process.exit(1);
  }

  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    console.log(chalk.yellow("[DRY RUN] No files will be written"));
  }

  try {
    // Generate for specific agent or all agents
    if (options.agent) {
      const agent = options.agent as AgentType;
      console.log(chalk.blue(`-> Generating config for ${agent}...`));

      const result = await generateFor(agent, constitutionPath, outputDir, dryRun);

      if (result.error) {
        console.error(chalk.red(`[FAIL] ${agent}: ${result.error}`));
        process.exit(1);
      }

      if (dryRun) {
        console.log(chalk.green(`[OK] ${agent} -> ${result.outputFile} (${result.content.length} bytes, dry run)`));
      } else {
        console.log(chalk.green(`[OK] ${agent} -> ${result.outputFile} (${result.content.length} bytes)`));
      }
    } else {
      console.log(chalk.blue("-> Generating configs for all agents..."));

      const results = await generateAll(constitutionPath, outputDir, dryRun);

      let errorCount = 0;
      for (const result of results) {
        if (result.error) {
          console.error(chalk.red(`[FAIL] ${result.agent}: ${result.error}`));
          errorCount++;
        } else if (dryRun) {
          console.log(
            chalk.green(`[OK] ${result.agent} -> ${result.outputFile} (${result.content.length} bytes, dry run)`),
          );
        } else {
          console.log(chalk.green(`[OK] ${result.agent} -> ${result.outputFile} (${result.content.length} bytes)`));
        }
      }

      if (errorCount > 0) {
        console.error(chalk.red(`[FAIL] ${errorCount} generation(s) failed`));
        process.exit(1);
      }
    }

    if (!dryRun) {
      console.log(chalk.green(`\n[OK] Constitution config(s) generated in ${outputDir}`));
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`[FAIL] Generation failed: ${error}`));
    process.exit(1);
  }
}
