#!/usr/bin/env bun
/**
 * nax — AI Coding Agent Orchestrator
 *
 * CLI entry point for the nax orchestration system.
 *
 * Features:
 * - `init`: Initialize nax in a project directory
 * - `run`: Execute the orchestration loop for a feature
 * - `features create/list`: Manage feature definitions
 * - `analyze`: Parse spec.md + tasks.md into prd.json
 * - `agents`: Check available coding agent installations
 * - `status`: Show current feature progress
 *
 * Architecture:
 * - Complexity-based routing to model tiers (fast/balanced/powerful)
 * - Three-session TDD for security-critical and complex stories
 * - Story batching for simple stories to reduce overhead
 * - Lifecycle hooks for custom automation (on-start, on-complete, etc.)
 *
 * @example
 * ```bash
 * # Initialize in project
 * nax init
 *
 * # Create feature
 * nax features create auth-system
 *
 * # Analyze spec/tasks into PRD
 * nax analyze --feature auth-system
 *
 * # Run orchestration
 * nax run --feature auth-system
 *
 * # Check status
 * nax status --feature auth-system
 * ```
 */

import { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { loadConfig, DEFAULT_CONFIG, findProjectDir, validateDirectory } from "../src/config";
import { checkAgentHealth, getAllAgentNames } from "../src/agents";
import { loadPRD, countStories } from "../src/prd";
import { loadHooksConfig } from "../src/hooks";
import { run } from "../src/execution";
import {
  analyzeFeature,
  planCommand,
  acceptCommand,
  displayCostMetrics,
  displayLastRunMetrics,
  displayModelEfficiency,
  runsListCommand,
  runsShowCommand,
} from "../src/cli";
import { renderTui, PipelineEventEmitter, type StoryDisplayState } from "../src/tui";
import { initLogger, type LogLevel } from "../src/logger";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

const program = new Command();

program
  .name("nax")
  .description("AI Coding Agent Orchestrator — loops until done")
  .version(pkg.version);

// ── init ─────────────────────────────────────────────
program
  .command("init")
  .description("Initialize nax in the current project")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-f, --force", "Force overwrite existing files", false)
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = join(workdir, "nax");

    if (existsSync(naxDir) && !options.force) {
      console.log(chalk.yellow("nax already initialized. Use --force to overwrite."));
      return;
    }

    // Create directory structure
    mkdirSync(join(naxDir, "features"), { recursive: true });
    mkdirSync(join(naxDir, "hooks"), { recursive: true });

    // Write default config
    await Bun.write(
      join(naxDir, "config.json"),
      JSON.stringify(DEFAULT_CONFIG, null, 2),
    );

    // Write default hooks.json
    await Bun.write(
      join(naxDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "on-start": { command: "echo \"nax started: $NAX_FEATURE\"", enabled: false },
          "on-complete": { command: "echo \"nax complete: $NAX_FEATURE\"", enabled: false },
          "on-pause": { command: "echo \"nax paused: $NAX_REASON\"", enabled: false },
          "on-error": { command: "echo \"nax error: $NAX_REASON\"", enabled: false },
        },
      }, null, 2),
    );

    // Write .gitignore
    await Bun.write(
      join(naxDir, ".gitignore"),
      "# nax temp files\n*.tmp\n.paused.json\n",
    );

    // Write starter constitution.md
    await Bun.write(
      join(naxDir, "constitution.md"),
      `# Project Constitution

This document defines the coding standards, architectural rules, testing requirements, and forbidden patterns for this project. All AI agents must follow these rules strictly.

## Coding Standards

- Follow the project's existing code style and conventions
- Write clear, self-documenting code with meaningful names
- Keep functions small and focused (single responsibility)
- Prefer immutability over mutation
- Use consistent formatting throughout the codebase

## Testing Requirements

- All new code must include tests
- Tests should cover happy paths, edge cases, and error conditions
- Aim for high test coverage (80%+ recommended)
- Tests must pass before marking a story as complete
- **Before writing tests, read existing test files** to understand what is already covered
- Do not duplicate test coverage that prior stories already wrote
- Focus on testing NEW behavior introduced by this story
- 2-3 tests per validation rule is sufficient (e.g., missing, empty, wrong type) — do not exhaustively test every falsy value

## Architecture Rules

- Follow the project's existing architecture patterns
- Each module should have a clear, single purpose
- Avoid tight coupling between modules
- Use dependency injection where appropriate
- Document architectural decisions in comments or docs

## Forbidden Patterns

- No hardcoded secrets, API keys, or credentials
- No console.log in production code (use proper logging)
- No \`any\` types in TypeScript (use proper typing)
- No commented-out code (use version control instead)
- No large files (split into smaller, focused modules)

## Commit Standards

- Write clear, descriptive commit messages
- Follow conventional commits format (feat:, fix:, refactor:, etc.)
- Commit early and often with atomic changes
- Reference story IDs in commit messages

## Documentation

- Add JSDoc comments for public APIs
- Update README when adding new features
- Document complex algorithms or business logic
- Keep documentation up-to-date with code changes

---

**Note:** Customize this constitution to match your project's specific needs. The AI agents will reference this document when implementing stories.
`,
    );

    console.log(chalk.green("✅ Initialized nax"));
    console.log(chalk.dim(`   ${naxDir}/`));
    console.log(chalk.dim("   ├── config.json"));
    console.log(chalk.dim("   ├── constitution.md"));
    console.log(chalk.dim("   ├── hooks.json"));
    console.log(chalk.dim("   ├── features/"));
    console.log(chalk.dim("   └── hooks/"));
    console.log(chalk.dim("\nNext: nax features create <name>"));
  });

// ── run ──────────────────────────────────────────────
program
  .command("run")
  .description("Run the orchestration loop for a feature")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-a, --agent <name>", "Force a specific agent")
  .option("-m, --max-iterations <n>", "Max iterations", "20")
  .option("--dry-run", "Show plan without executing", false)
  .option("--no-context", "Disable context builder (skip file context in prompts)")
  .option("--no-batch", "Disable story batching (execute all stories individually)")
  .option("--headless", "Force headless mode (disable TUI, use pipe mode)", false)
  .option("--verbose", "Enable verbose logging (debug level)", false)
  .option("--quiet", "Quiet mode (warnings and errors only)", false)
  .option("--silent", "Silent mode (errors only)", false)
  .option("-d, --dir <path>", "Working directory", process.cwd())
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    // Determine log level from flags or env var (env var takes precedence)
    let logLevel: LogLevel = "info"; // default
    const envLevel = process.env.NAX_LOG_LEVEL?.toLowerCase();
    if (envLevel && ["error", "warn", "info", "debug"].includes(envLevel)) {
      logLevel = envLevel as LogLevel;
    } else if (options.verbose) {
      logLevel = "debug";
    } else if (options.quiet) {
      logLevel = "warn";
    } else if (options.silent) {
      logLevel = "error";
    }

    const config = await loadConfig();
    const naxDir = findProjectDir(workdir);

    if (!naxDir) {
      console.error(chalk.red("nax not initialized. Run: nax init"));
      process.exit(1);
    }

    const featureDir = join(naxDir, "features", options.feature);
    const prdPath = join(featureDir, "prd.json");

    if (!existsSync(prdPath)) {
      console.error(chalk.red(`Feature "${options.feature}" not found or missing prd.json`));
      process.exit(1);
    }

    // Create run directory and JSONL log file path
    const runsDir = join(featureDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    // Generate run ID from ISO timestamp
    const runId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const logFilePath = join(runsDir, `${runId}.jsonl`);

    // Initialize logger with selected level and file path
    initLogger({
      level: logLevel,
      filePath: logFilePath,
      useChalk: true,
    });

    // Override config from CLI
    if (options.agent) {
      config.autoMode.defaultAgent = options.agent;
    }
    config.execution.maxIterations = Number.parseInt(options.maxIterations, 10);

    const hooks = await loadHooksConfig(naxDir);

    // Determine TUI vs headless mode
    // TUI activates when:
    // 1. stdout is a TTY, AND
    // 2. --headless flag is NOT passed, AND
    // 3. NAX_HEADLESS env var is NOT set
    const isTTY = process.stdout.isTTY ?? false;
    const headlessFlag = options.headless ?? false;
    const headlessEnv = process.env.NAX_HEADLESS === "1";
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    // Create event emitter for TUI integration
    const eventEmitter = new PipelineEventEmitter();

    // Render TUI if not in headless mode
    let tuiInstance: ReturnType<typeof renderTui> | undefined;
    if (!useHeadless) {
      // Load PRD to get initial story states
      const prd = await loadPRD(prdPath);
      const initialStories: StoryDisplayState[] = prd.userStories.map((story) => ({
        story,
        status: story.passes ? "passed" : "pending",
        routing: story.routing,
        cost: 0,
      }));

      tuiInstance = renderTui({
        feature: options.feature,
        stories: initialStories,
        totalCost: 0,
        elapsedMs: 0,
        events: eventEmitter,
        ptyOptions: null, // TODO: Pass actual PTY spawn options when runner supports it
      });
    } else {
      console.log(chalk.dim("   [Headless mode — pipe output]"));
    }

    const result = await run({
      prdPath,
      workdir,
      config,
      hooks,
      feature: options.feature,
      featureDir,
      dryRun: options.dryRun,
      useBatch: options.batch ?? true,
      eventEmitter,
    });

    // Create/update latest.jsonl symlink
    const latestSymlink = join(runsDir, "latest.jsonl");
    try {
      // Remove existing symlink if present
      if (existsSync(latestSymlink)) {
        Bun.spawnSync(["rm", latestSymlink]);
      }
      // Create new symlink pointing to current run log
      Bun.spawnSync(["ln", "-s", `${runId}.jsonl`, latestSymlink], {
        cwd: runsDir,
      });
    } catch (error) {
      console.error(chalk.yellow(`Warning: Failed to create latest.jsonl symlink: ${error}`));
    }

    // Cleanup TUI if it was rendered
    if (tuiInstance) {
      tuiInstance.unmount();
    }

    // Summary (only in headless mode; TUI shows summary itself)
    if (useHeadless) {
      console.log(chalk.dim("\n── Summary ──────────────────────────────────"));
      console.log(chalk.dim(`   Iterations:  ${result.iterations}`));
      console.log(chalk.dim(`   Completed:   ${result.storiesCompleted}`));
      console.log(chalk.dim(`   Cost:        $${result.totalCost.toFixed(4)}`));
      console.log(chalk.dim(`   Duration:    ${(result.durationMs / 1000 / 60).toFixed(1)} min`));
    }

    process.exit(result.success ? 0 : 1);
  });

// ── features ─────────────────────────────────────────
const features = program.command("features").description("Manage features");

features
  .command("create <name>")
  .description("Create a new feature")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (name, options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      console.error(chalk.red("nax not initialized. Run: nax init"));
      process.exit(1);
    }

    const featureDir = join(naxDir, "features", name);
    mkdirSync(featureDir, { recursive: true });

    // Create empty templates
    await Bun.write(join(featureDir, "spec.md"), `# Feature: ${name}\n\n## Overview\n\n## Requirements\n\n## Acceptance Criteria\n`);
    await Bun.write(join(featureDir, "plan.md"), `# Plan: ${name}\n\n## Architecture\n\n## Phases\n\n## Dependencies\n`);
    await Bun.write(join(featureDir, "tasks.md"), `# Tasks: ${name}\n\n## US-001: [Title]\n\n### Description\n\n### Acceptance Criteria\n- [ ] Criterion 1\n`);
    await Bun.write(join(featureDir, "progress.txt"), `# Progress: ${name}\n\nCreated: ${new Date().toISOString()}\n\n---\n`);

    console.log(chalk.green(`✅ Created feature: ${name}`));
    console.log(chalk.dim(`   ${featureDir}/`));
    console.log(chalk.dim("   ├── spec.md"));
    console.log(chalk.dim("   ├── plan.md"));
    console.log(chalk.dim("   ├── tasks.md"));
    console.log(chalk.dim("   └── progress.txt"));
    console.log(chalk.dim("\nNext: Edit spec.md and tasks.md, then: nax analyze --feature " + name));
  });

features
  .command("list")
  .description("List all features")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      console.error(chalk.red("nax not initialized."));
      process.exit(1);
    }

    const featuresDir = join(naxDir, "features");
    if (!existsSync(featuresDir)) {
      console.log(chalk.dim("No features yet."));
      return;
    }

    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(featuresDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    if (entries.length === 0) {
      console.log(chalk.dim("No features yet."));
      return;
    }

    console.log(chalk.bold("\nFeatures:\n"));
    for (const name of entries) {
      const prdPath = join(featuresDir, name, "prd.json");
      if (existsSync(prdPath)) {
        const prd = await loadPRD(prdPath);
        const c = countStories(prd);
        console.log(`  ${name} — ${c.passed}/${c.total} stories done`);
      } else {
        console.log(`  ${name} (no prd.json yet)`);
      }
    }
    console.log();
  });

// ── plan ─────────────────────────────────────────────
program
  .command("plan <description>")
  .description("Interactive planning via agent plan mode")
  .option("--from <file>", "Non-interactive mode: read from input file")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (description: string, options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      console.error(chalk.red("nax not initialized. Run: nax init"));
      process.exit(1);
    }

    // Load config
    const config = await loadConfig(workdir);

    try {
      const specPath = await planCommand(description, workdir, config, {
        interactive: !options.from,
        from: options.from,
      });

      console.log(chalk.green(`\n✅ Planning complete`));
      console.log(chalk.dim(`   Spec: ${specPath}`));
      console.log(chalk.dim(`\nNext: nax analyze -f <feature-name>`));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── analyze ──────────────────────────────────────────
program
  .command("analyze")
  .description("Parse spec.md into prd.json via agent decompose")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-b, --branch <name>", "Branch name", "feat/<feature>")
  .option("--from <path>", "Explicit spec path (overrides default spec.md)")
  .option("--reclassify", "Re-classify existing prd.json without decompose", false)
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      console.error(chalk.red("nax not initialized. Run: nax init"));
      process.exit(1);
    }

    const featureDir = join(naxDir, "features", options.feature);
    if (!existsSync(featureDir)) {
      console.error(chalk.red(`Feature "${options.feature}" not found.`));
      process.exit(1);
    }

    const branchName = options.branch.replace("<feature>", options.feature);

    // Load config for validation
    const config = await loadConfig(workdir);

    try {
      const prd = await analyzeFeature({
        featureDir,
        featureName: options.feature,
        branchName,
        config,
        specPath: options.from,
        reclassify: options.reclassify,
      });

      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const c = countStories(prd);
      console.log(chalk.green(`\n✅ Generated prd.json for ${options.feature}`));
      console.log(chalk.dim(`   Stories: ${c.total}`));
      console.log(chalk.dim(`   Path: ${prdPath}`));

      for (const story of prd.userStories) {
        const routing = story.routing ? chalk.dim(` [${story.routing.complexity}]`) : "";
        console.log(chalk.dim(`   ${story.id}: ${story.title}${routing}`));
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── agents ───────────────────────────────────────────
program
  .command("agents")
  .description("Check available coding agents")
  .action(async () => {
    const health = await checkAgentHealth();

    console.log(chalk.bold("\nCoding Agents:\n"));
    for (const agent of health) {
      const status = agent.installed
        ? chalk.green("✅ installed")
        : chalk.red("❌ not found");
      console.log(`  ${agent.displayName.padEnd(15)} ${status}`);
    }
    console.log();
  });

// ── status ───────────────────────────────────────────
program
  .command("status")
  .description("Show current run status")
  .option("-f, --feature <name>", "Feature name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--cost", "Show cost metrics across all runs", false)
  .option("--last", "Show last run metrics (requires --cost)", false)
  .option("--model", "Show per-model efficiency (requires --cost)", false)
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    const naxDir = findProjectDir(workdir);
    if (!naxDir) {
      console.error(chalk.red("nax not initialized."));
      process.exit(1);
    }

    // Handle cost metrics flags
    if (options.cost) {
      if (options.last) {
        await displayLastRunMetrics(workdir);
      } else if (options.model) {
        await displayModelEfficiency(workdir);
      } else {
        await displayCostMetrics(workdir);
      }
      return;
    }

    // Default status: show feature progress
    if (!options.feature) {
      console.error(chalk.red("Feature name required (use -f, --feature <name>)"));
      console.error(chalk.dim("Or use --cost to show cost metrics"));
      process.exit(1);
    }

    const prdPath = join(naxDir, "features", options.feature, "prd.json");
    if (!existsSync(prdPath)) {
      console.error(chalk.red(`Feature "${options.feature}" not found.`));
      process.exit(1);
    }

    const prd = await loadPRD(prdPath);
    const c = countStories(prd);

    console.log(chalk.bold(`\n📊 ${prd.feature}`));
    console.log(chalk.dim(`   Branch: ${prd.branchName}`));
    console.log(chalk.dim(`   Updated: ${prd.updatedAt}`));
    console.log();
    console.log(`   Total:   ${c.total}`);
    console.log(chalk.green(`   Passed:  ${c.passed}`));
    console.log(chalk.red(`   Failed:  ${c.failed}`));
    console.log(chalk.dim(`   Pending: ${c.pending}`));
    console.log(chalk.yellow(`   Skipped: ${c.skipped}`));
    console.log();

    for (const story of prd.userStories) {
      const icon = story.passes ? "✅" : story.status === "failed" ? "❌" : "⬜";
      const routing = story.routing
        ? chalk.dim(` [${story.routing.complexity}/${story.routing.modelTier}/${story.routing.testStrategy}]`)
        : "";
      console.log(`   ${icon} ${story.id}: ${story.title}${routing}`);
    }
    console.log();
  });

// ── runs ─────────────────────────────────────────────
const runs = program
  .command("runs")
  .description("Manage and view run history");

runs
  .command("list")
  .description("List all runs for a feature")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    await runsListCommand({ feature: options.feature, workdir });
  });

runs
  .command("show <run-id>")
  .description("Show detailed information for a specific run")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (runId, options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    await runsShowCommand({ runId, feature: options.feature, workdir });
  });

// ── accept ───────────────────────────────────────────
program
  .command("accept")
  .description("Override failed acceptance criteria")
  .requiredOption("-f, --feature <name>", "Feature name")
  .requiredOption("--override <ac-id>", "AC ID to override (e.g., AC-2)")
  .requiredOption("-r, --reason <reason>", "Reason for accepting despite test failure")
  .action(async (options) => {
    try {
      await acceptCommand({
        feature: options.feature,
        override: options.override,
        reason: options.reason,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse();
