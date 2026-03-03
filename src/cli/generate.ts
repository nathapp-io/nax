/**
 * `nax generate` CLI Command (v0.16.1)
 *
 * Generates agent-specific config files from nax/context.md + auto-injected project metadata.
 * Replaces `nax constitution generate`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config/loader";
import { generateAll, generateFor } from "../context/generator";
import type { AgentType } from "../context/types";

/** Options for `nax generate` */
export interface GenerateCommandOptions {
  /** Path to context file (default: nax/context.md) */
  context?: string;
  /** Output directory (default: project root) */
  output?: string;
  /** Specific agent to generate for */
  agent?: string;
  /** Dry run — preview without writing */
  dryRun?: boolean;
  /** Disable auto-injection of project metadata */
  noAutoInject?: boolean;
}

const VALID_AGENTS: AgentType[] = ["claude", "opencode", "cursor", "windsurf", "aider"];

/**
 * `nax generate` command handler.
 */
export async function generateCommand(options: GenerateCommandOptions): Promise<void> {
  const workdir = process.cwd();
  const contextPath = options.context ? join(workdir, options.context) : join(workdir, "nax/context.md");
  const outputDir = options.output ? join(workdir, options.output) : workdir;
  const autoInject = !options.noAutoInject;
  const dryRun = options.dryRun ?? false;

  // Validate context file
  if (!existsSync(contextPath)) {
    console.error(chalk.red(`✗ Context file not found: ${contextPath}`));
    console.error(chalk.yellow("  Create nax/context.md first, or run `nax init` to scaffold it."));
    process.exit(1);
  }

  // Validate agent if specified
  if (options.agent && !VALID_AGENTS.includes(options.agent as AgentType)) {
    console.error(chalk.red(`✗ Unknown agent: ${options.agent}`));
    console.error(chalk.yellow(`  Valid agents: ${VALID_AGENTS.join(", ")}`));
    process.exit(1);
  }

  if (dryRun) {
    console.log(chalk.yellow("⚠ Dry run — no files will be written"));
  }

  console.log(chalk.blue(`→ Loading context from ${contextPath}`));
  if (autoInject) {
    console.log(chalk.dim("  Auto-injecting project metadata..."));
  }

  // Load config for metadata injection (best-effort, use defaults if not found)
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(workdir);
  } catch {
    // Config not required for generate — use empty defaults
    config = {} as Awaited<ReturnType<typeof loadConfig>>;
  }

  const genOptions = {
    contextPath,
    outputDir,
    workdir,
    dryRun,
    autoInject,
  };

  try {
    if (options.agent) {
      const agent = options.agent as AgentType;
      console.log(chalk.blue(`→ Generating config for ${agent}...`));

      const result = await generateFor(agent, genOptions, config);

      if (result.error) {
        console.error(chalk.red(`✗ ${agent}: ${result.error}`));
        process.exit(1);
      }

      const suffix = dryRun ? " (dry run)" : "";
      console.log(chalk.green(`✓ ${agent} → ${result.outputFile} (${result.content.length} bytes${suffix})`));
    } else {
      console.log(chalk.blue("→ Generating configs for all agents..."));

      const results = await generateAll(genOptions, config);
      let errorCount = 0;

      for (const result of results) {
        if (result.error) {
          console.error(chalk.red(`✗ ${result.agent}: ${result.error}`));
          errorCount++;
        } else {
          const suffix = dryRun ? " (dry run)" : "";
          console.log(
            chalk.green(`✓ ${result.agent} → ${result.outputFile} (${result.content.length} bytes${suffix})`),
          );
        }
      }

      if (errorCount > 0) {
        console.error(chalk.red(`\n✗ ${errorCount} generation(s) failed`));
        process.exit(1);
      }
    }

    if (!dryRun) {
      console.log(chalk.green(`\n✓ Agent configs written to ${outputDir}`));
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ Generation failed: ${error}`));
    process.exit(1);
  }
}
