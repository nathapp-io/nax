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
import { discoverPackages, generateAll, generateFor, generateForPackage } from "../context/generator";
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
  /**
   * Generate for a specific package directory (relative to repo root).
   * Reads .nax/mono/{package}/context.md, writes {package}/CLAUDE.md.
   * @example "packages/api"
   */
  package?: string;
  /**
   * Generate for all discovered packages.
   * Auto-discovers packages under .nax/mono/ with context.md up to 2 levels deep.
   */
  allPackages?: boolean;
}

const VALID_AGENTS: AgentType[] = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"];

/**
 * `nax generate` command handler.
 */
export async function generateCommand(options: GenerateCommandOptions): Promise<void> {
  const workdir = process.cwd();
  const dryRun = options.dryRun ?? false;

  // Load config early — needed for all paths
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(workdir);
  } catch {
    config = {} as Awaited<ReturnType<typeof loadConfig>>;
  }

  // --all-packages: discover and generate for all packages
  if (options.allPackages) {
    if (dryRun) {
      console.log(chalk.yellow("⚠ Dry run — no files will be written"));
    }
    console.log(chalk.blue("→ Discovering packages with .nax/mono/*/context.md..."));
    const packages = await discoverPackages(workdir);

    if (packages.length === 0) {
      console.log(chalk.yellow("  No packages found (no .nax/mono/*/context.md or .nax/mono/*/*/context.md)"));
      return;
    }

    console.log(chalk.blue(`→ Generating agent files for ${packages.length} package(s)...`));
    let errorCount = 0;

    for (const pkgDir of packages) {
      const results = await generateForPackage(pkgDir, config, dryRun, workdir);
      for (const result of results) {
        if (result.error) {
          console.error(chalk.red(`✗ ${pkgDir}: ${result.error}`));
          errorCount++;
        } else {
          const suffix = dryRun ? " (dry run)" : "";
          console.log(chalk.green(`✓ ${pkgDir}/${result.outputFile} (${result.content.length} bytes${suffix})`));
        }
      }
    }

    if (errorCount > 0) {
      console.error(chalk.red(`\n✗ ${errorCount} generation(s) failed`));
      process.exit(1);
    }
    return;
  }

  // --package: generate for a specific package
  if (options.package) {
    const packageDir = join(workdir, options.package);
    if (dryRun) {
      console.log(chalk.yellow("⚠ Dry run — no files will be written"));
    }
    console.log(chalk.blue(`→ Generating agent files for package: ${options.package}`));
    const pkgResults = await generateForPackage(packageDir, config, dryRun, workdir);
    let pkgHasError = false;
    for (const result of pkgResults) {
      if (result.error) {
        console.error(chalk.red(`✗ ${result.error}`));
        pkgHasError = true;
      } else {
        const suffix = dryRun ? " (dry run)" : "";
        console.log(chalk.green(`✓ ${options.package}/${result.outputFile} (${result.content.length} bytes${suffix})`));
      }
    }
    if (pkgHasError) process.exit(1);
    return;
  }

  const contextPath = options.context ? join(workdir, options.context) : join(workdir, ".nax/context.md");
  const outputDir = options.output ? join(workdir, options.output) : workdir;
  const autoInject = !options.noAutoInject;

  // Validate context file
  if (!existsSync(contextPath)) {
    console.error(chalk.red(`✗ Context file not found: ${contextPath}`));
    console.error(chalk.yellow("  Create .nax/context.md first, or run `nax init` to scaffold it."));
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

  const genOptions = {
    contextPath,
    outputDir,
    workdir,
    dryRun,
    autoInject,
  };

  try {
    if (options.agent) {
      // CLI --agent flag: single specific agent (overrides config)
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
      // No --agent flag: use config.generate.agents filter, or generate all
      let configAgents = config?.generate?.agents;

      // Detect misplaced generate config (autoMode.generate.agents) and warn
      const misplacedAgents = (config?.autoMode as unknown as Record<string, unknown> | undefined)?.generate as
        | { agents?: string[] }
        | undefined;
      if (!configAgents && misplacedAgents?.agents && misplacedAgents.agents.length > 0) {
        console.warn(
          chalk.yellow(
            '⚠ Warning: "generate.agents" is nested under "autoMode" in your config — it should be at the top level.',
          ),
        );
        console.warn(chalk.yellow('  Move it to: { "generate": { "agents": [...] } }'));
        configAgents = misplacedAgents.agents as Array<
          "claude" | "codex" | "opencode" | "cursor" | "windsurf" | "aider" | "gemini"
        >;
      }

      const agentFilter = configAgents && configAgents.length > 0 ? configAgents : null;

      if (agentFilter) {
        console.log(chalk.blue(`→ Generating configs for: ${agentFilter.join(", ")} (from config)...`));
      } else {
        console.log(chalk.blue("→ Generating configs for all agents..."));
      }

      // Pass agentFilter to generateAll so only matching agents are written to disk
      const results = await generateAll(genOptions, config, agentFilter ?? undefined);

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

      // Auto-generate per-package agent files when packages with .nax/mono/*/context.md are discovered
      const packages = await discoverPackages(workdir);
      if (packages.length > 0) {
        console.log(
          chalk.blue(`\n→ Discovered ${packages.length} package(s) with context.md — generating agent files...`),
        );
        let pkgErrorCount = 0;
        for (const pkgDir of packages) {
          const pkgResults = await generateForPackage(pkgDir, config, dryRun);
          for (const result of pkgResults) {
            if (result.error) {
              console.error(chalk.red(`✗ ${pkgDir}: ${result.error}`));
              pkgErrorCount++;
            } else {
              const suffix = dryRun ? " (dry run)" : "";
              const rel = pkgDir.startsWith(workdir) ? pkgDir.slice(workdir.length + 1) : pkgDir;
              console.log(chalk.green(`✓ ${rel}/${result.outputFile} (${result.content.length} bytes${suffix})`));
            }
          }
        }
        if (pkgErrorCount > 0) {
          console.error(chalk.red(`\n✗ ${pkgErrorCount} package generation(s) failed`));
          process.exit(1);
        }
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
