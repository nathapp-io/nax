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
import { findProjectDir } from "../config/paths";
import type { GenerateOptions, GenerationResult, PackageGenerationResult } from "../context/generator";
import { discoverPackages, generateAll, generateFor, generateForPackage } from "../context/generator";
import type { AgentType } from "../context/types";
import { NaxError } from "../errors";
import { isRelativeAndSafe } from "../utils/path-security";

/** Options for `nax generate` */
export interface GenerateCommandOptions {
  /** Project directory (default: process.cwd()) */
  dir?: string;
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

/** Resolved command context shared by every `nax generate` phase. */
interface GenerateFrame {
  /** Project directory the command runs against. */
  workdir: string;
  /** Loaded config; a failed load degrades to an empty object (never throws). */
  config: Awaited<ReturnType<typeof loadConfig>>;
  /** Dry run — preview without writing. */
  dryRun: boolean;
}

/** Load the effective config for the command; a failed load degrades to an empty object. */
async function loadCommandConfig(workdir: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  try {
    return await loadConfig(workdir);
  } catch {
    return {} as Awaited<ReturnType<typeof loadConfig>>;
  }
}

/** Print the dry-run notice (identical wording in all three generation paths). */
function printDryRunNotice(dryRun: boolean): void {
  if (dryRun) {
    console.log(chalk.yellow("⚠ Dry run — no files will be written"));
  }
}

/**
 * Print one package's generation results; returns the failure count.
 * Failure lines always name `pkgDir`; success lines use `displayDir`
 * (defaults to `pkgDir`; the discovered-packages path passes a workdir-relative label).
 */
function reportPackageResults(
  frame: GenerateFrame,
  results: PackageGenerationResult[],
  dirs: { pkgDir: string; displayDir?: string },
): number {
  const { pkgDir, displayDir = pkgDir } = dirs;
  let errorCount = 0;
  for (const result of results) {
    if (result.error) {
      console.error(chalk.red(`✗ ${pkgDir}: ${result.error}`));
      errorCount++;
    } else {
      const suffix = frame.dryRun ? " (dry run)" : "";
      console.log(chalk.green(`✓ ${displayDir}/${result.outputFile} (${result.content.length} bytes${suffix})`));
    }
  }
  return errorCount;
}

/** --all-packages: discover every package and generate for each. */
async function runAllPackages(frame: GenerateFrame): Promise<void> {
  printDryRunNotice(frame.dryRun);
  console.log(chalk.blue("→ Discovering packages with .nax/mono/*/context.md..."));
  const packages = await discoverPackages(frame.workdir);

  if (packages.length === 0) {
    console.log(chalk.yellow("  No packages found (no .nax/mono/*/context.md or .nax/mono/*/*/context.md)"));
    return;
  }

  console.log(chalk.blue(`→ Generating agent files for ${packages.length} package(s)...`));
  let errorCount = 0;

  for (const pkgDir of packages) {
    const results = await generateForPackage(pkgDir, frame.config, frame.dryRun, frame.workdir);
    errorCount += reportPackageResults(frame, results, { pkgDir });
  }

  if (errorCount > 0) {
    console.error(chalk.red(`\n✗ ${errorCount} generation(s) failed`));
    process.exit(1);
  }
}

/** --package <path>: generate for one explicit package, validated first. */
async function runSinglePackage(frame: GenerateFrame, pkg: string): Promise<void> {
  if (!isRelativeAndSafe(pkg)) {
    throw new NaxError(
      `generateCommand: package "${pkg}" is not a safe relative path (must be non-empty, relative, and free of ".." segments)`,
      "INVALID_PACKAGE_PATH",
      { stage: "generate", package: pkg },
    );
  }
  const packageDir = join(frame.workdir, pkg);
  printDryRunNotice(frame.dryRun);
  console.log(chalk.blue(`→ Generating agent files for package: ${pkg}`));
  const pkgResults = await generateForPackage(packageDir, frame.config, frame.dryRun, frame.workdir);
  let pkgHasError = false;
  for (const result of pkgResults) {
    if (result.error) {
      console.error(chalk.red(`✗ ${result.error}`));
      pkgHasError = true;
    } else {
      const suffix = frame.dryRun ? " (dry run)" : "";
      console.log(chalk.green(`✓ ${pkg}/${result.outputFile} (${result.content.length} bytes${suffix})`));
    }
  }
  if (pkgHasError) process.exit(1);
}

/** Validate the root-path inputs: the context file must exist and --agent must be known. */
function validateRootInputs(contextPath: string, agent: string | undefined): void {
  if (!existsSync(contextPath)) {
    console.error(chalk.red(`✗ Context file not found: ${contextPath}`));
    console.error(chalk.yellow("  Create .nax/context.md first, or run `nax init` to scaffold it."));
    process.exit(1);
  }

  if (agent && !VALID_AGENTS.includes(agent as AgentType)) {
    console.error(chalk.red(`✗ Unknown agent: ${agent}`));
    console.error(chalk.yellow(`  Valid agents: ${VALID_AGENTS.join(", ")}`));
    process.exit(1);
  }
}

/** --agent <name>: generate one specific agent, overriding any config filter. */
async function generateSingleAgent(frame: GenerateFrame, agent: AgentType, genOptions: GenerateOptions): Promise<void> {
  console.log(chalk.blue(`→ Generating config for ${agent}...`));

  const result = await generateFor(agent, genOptions, frame.config);

  if (result.error) {
    console.error(chalk.red(`✗ ${agent}: ${result.error}`));
    process.exit(1);
  }

  const suffix = frame.dryRun ? " (dry run)" : "";
  console.log(chalk.green(`✓ ${agent} → ${result.outputFile} (${result.content.length} bytes${suffix})`));
}

/**
 * Resolve the agent filter from config, or null for "generate all". Only a
 * project-level config's generate.agents filters — global config's should not
 * restrict generation in unconfigured projects.
 */
function resolveAgentFilter(workdir: string, config: Awaited<ReturnType<typeof loadConfig>>): AgentType[] | null {
  const projectNaxDir = findProjectDir(workdir);
  let configAgents = projectNaxDir ? config?.generate?.agents : null;

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

  return configAgents && configAgents.length > 0 ? configAgents : null;
}

/** Print root-level (per-agent) generation results; returns the failure count. */
function reportAgentResults(frame: GenerateFrame, results: GenerationResult[]): number {
  let errorCount = 0;

  for (const result of results) {
    if (result.error) {
      console.error(chalk.red(`✗ ${result.agent}: ${result.error}`));
      errorCount++;
    } else {
      const suffix = frame.dryRun ? " (dry run)" : "";
      console.log(chalk.green(`✓ ${result.agent} → ${result.outputFile} (${result.content.length} bytes${suffix})`));
    }
  }

  return errorCount;
}

/** Generate per-package agent files for packages discovered under .nax/mono/. */
async function generateDiscoveredPackages(frame: GenerateFrame): Promise<void> {
  const packages = await discoverPackages(frame.workdir);
  if (packages.length === 0) {
    return;
  }

  console.log(chalk.blue(`\n→ Discovered ${packages.length} package(s) with context.md — generating agent files...`));
  let pkgErrorCount = 0;
  for (const pkgDir of packages) {
    const pkgResults = await generateForPackage(pkgDir, frame.config, frame.dryRun, frame.workdir);
    const rel = pkgDir.startsWith(frame.workdir) ? pkgDir.slice(frame.workdir.length + 1) : pkgDir;
    pkgErrorCount += reportPackageResults(frame, pkgResults, { pkgDir, displayDir: rel });
  }
  if (pkgErrorCount > 0) {
    console.error(chalk.red(`\n✗ ${pkgErrorCount} package generation(s) failed`));
    process.exit(1);
  }
}

/** No --agent flag: honor the config's agent filter (or all agents), then the discovered packages. */
async function generateFromConfig(frame: GenerateFrame, genOptions: GenerateOptions): Promise<void> {
  const agentFilter = resolveAgentFilter(frame.workdir, frame.config);

  if (agentFilter) {
    console.log(chalk.blue(`→ Generating configs for: ${agentFilter.join(", ")} (from config)...`));
  } else {
    console.log(chalk.blue("→ Generating configs for all agents..."));
  }

  // Pass agentFilter to generateAll so only matching agents are written to disk
  const results = await generateAll(genOptions, frame.config, agentFilter ?? undefined);

  const errorCount = reportAgentResults(frame, results);
  if (errorCount > 0) {
    console.error(chalk.red(`\n✗ ${errorCount} generation(s) failed`));
    process.exit(1);
  }

  // Auto-generate per-package agent files when packages with .nax/mono/*/context.md are discovered
  await generateDiscoveredPackages(frame);
}

/** Default path: validate inputs, then generate for --agent or per the config filter. */
async function runRootGeneration(frame: GenerateFrame, options: GenerateCommandOptions): Promise<void> {
  const contextPath = options.context ? join(frame.workdir, options.context) : join(frame.workdir, ".nax/context.md");
  const outputDir = options.output ? join(frame.workdir, options.output) : frame.workdir;
  const autoInject = !options.noAutoInject;

  validateRootInputs(contextPath, options.agent);

  printDryRunNotice(frame.dryRun);

  console.log(chalk.blue(`→ Loading context from ${contextPath}`));
  if (autoInject) {
    console.log(chalk.dim("  Auto-injecting project metadata..."));
  }

  const genOptions: GenerateOptions = {
    contextPath,
    outputDir,
    workdir: frame.workdir,
    dryRun: frame.dryRun,
    autoInject,
  };

  try {
    if (options.agent) {
      // CLI --agent flag: single specific agent (overrides config)
      await generateSingleAgent(frame, options.agent as AgentType, genOptions);
    } else {
      // No --agent flag: use config.generate.agents filter, or generate all.
      await generateFromConfig(frame, genOptions);
    }

    if (!frame.dryRun) {
      console.log(chalk.green(`\n✓ Agent configs written to ${outputDir}`));
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`✗ Generation failed: ${error}`));
    process.exit(1);
  }
}

/**
 * `nax generate` command handler.
 */
export async function generateCommand(options: GenerateCommandOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const frame: GenerateFrame = {
    workdir,
    config: await loadCommandConfig(workdir),
    dryRun: options.dryRun ?? false,
  };

  // --all-packages: discover and generate for all packages
  if (options.allPackages) {
    await runAllPackages(frame);
    return;
  }

  // --package: generate for a specific package. Guard on `!== undefined` rather
  // than truthiness so an explicit "--package \"\"" flows into validation
  // instead of silently falling through to root-package generation.
  if (options.package !== undefined) {
    await runSinglePackage(frame, options.package);
    return;
  }

  await runRootGeneration(frame, options);
}
