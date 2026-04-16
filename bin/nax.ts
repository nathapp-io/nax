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
 * # Run orchestration
 * nax run --feature auth-system
 *
 * # Check status
 * nax status --feature auth-system
 * ```
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";

import {
  acceptCommand,
  agentsListCommand,
  contextInspectCommand,
  displayCostMetrics,
  displayFeatureStatus,
  displayLastRunMetrics,
  displayModelEfficiency,
  exportPromptCommand,
  planCommand,
  planDecomposeCommand,
  pluginsListCommand,
  promptsCommand,
  promptsInitCommand,
  runReplanLoop,
  runsListCommand,
  runsShowCommand,
} from "../src/cli";
import { configCommand } from "../src/cli/config";
import {
  profileCreateCommand,
  profileCurrentCommand,
  profileListCommand,
  profileShowCommand,
  profileUseCommand,
} from "../src/cli/config-profile";
import { generateCommand } from "../src/cli/generate";
import { detectCommand } from "../src/commands/detect";
import { diagnose } from "../src/commands/diagnose";
import { logsCommand } from "../src/commands/logs";
import { precheckCommand } from "../src/commands/precheck";
import { runsCommand } from "../src/commands/runs";
import { unlockCommand } from "../src/commands/unlock";
import { DEFAULT_CONFIG, findProjectDir, loadConfig, validateDirectory } from "../src/config";
import { run } from "../src/execution";
import { loadHooksConfig } from "../src/hooks";
import { type LogLevel, initLogger, resetLogger } from "../src/logger";
import { countStories, loadPRD } from "../src/prd";
import { PipelineEventEmitter, type StoryDisplayState, renderTui } from "../src/tui";
import { NAX_VERSION } from "../src/version";

const program = new Command();

program.name("nax").description("AI Coding Agent Orchestrator — loops until done").version(NAX_VERSION);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt user for a yes/no confirmation via stdin.
 * In tests or non-TTY environments, defaults to true.
 *
 * @param question - Confirmation question to display
 * @returns true if user answers Y/y, false if N/n, true by default for non-TTY
 */
async function promptForConfirmation(question: string): Promise<boolean> {
  // In non-TTY mode (tests, pipes), default to true
  if (!process.stdin.isTTY) {
    return true;
  }

  return new Promise((resolve) => {
    process.stdout.write(chalk.bold(`${question} [Y/n] `));

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const handler = (char: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", handler);

      const answer = char.toLowerCase();
      process.stdout.write("\n");

      if (answer === "n") {
        resolve(false);
      } else {
        // Default to yes for Y, Enter, or any other input
        resolve(true);
      }
    };

    process.stdin.on("data", handler);
  });
}

// ── init ─────────────────────────────────────────────
program
  .command("init")
  .description("Initialize nax in the current project")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-f, --force", "Force overwrite existing files", false)
  .option("--package <dir>", "Scaffold per-package nax/context.md (e.g. packages/api)")
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    // --package: scaffold per-package nax/context.md only
    if (options.package) {
      const { initPackage: initPkg } = await import("../src/cli/init-context");
      try {
        await initPkg(workdir, options.package, options.force);
        console.log(chalk.green("\n[OK] Package scaffold created."));
        console.log(chalk.dim(`  Created: ${options.package}/nax/context.md`));
        console.log(chalk.dim(`\nNext: nax generate --package ${options.package}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
      return;
    }

    const naxDir = join(workdir, ".nax");

    if (existsSync(naxDir) && !options.force) {
      console.log(chalk.yellow("nax already initialized. Use --force to overwrite."));
      return;
    }

    // Create directory structure
    mkdirSync(join(naxDir, "features"), { recursive: true });
    mkdirSync(join(naxDir, "hooks"), { recursive: true });

    // Write default config
    await Bun.write(join(naxDir, "config.json"), JSON.stringify(DEFAULT_CONFIG, null, 2));

    // Write default hooks.json
    await Bun.write(
      join(naxDir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            "on-start": { command: 'echo "nax started: $NAX_FEATURE"', enabled: false },
            "on-complete": { command: 'echo "nax complete: $NAX_FEATURE"', enabled: false },
            "on-pause": { command: 'echo "nax paused: $NAX_REASON"', enabled: false },
            "on-error": { command: 'echo "nax error: $NAX_REASON"', enabled: false },
          },
        },
        null,
        2,
      ),
    );

    // Write .gitignore
    await Bun.write(join(naxDir, ".gitignore"), "# nax temp files\n*.tmp\n.paused.json\n.nax-verifier-verdict.json\n");

    // Write starter context.md
    await Bun.write(
      join(naxDir, "context.md"),
      `# Project Context

This document defines coding standards, architectural decisions, and forbidden patterns for this project.
Run \`nax generate\` to regenerate agent config files (CLAUDE.md, AGENTS.md, .cursorrules, etc.) from this file.

> Project metadata (dependencies, commands) is auto-injected by \`nax generate\`.

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
- Before writing tests, read existing test files to understand what is already covered
- Do not duplicate test coverage that prior stories already wrote
- Focus on testing NEW behavior introduced by this story

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

**Note:** Customize this file to match your project's specific needs.
`,
    );

    // Initialize prompt templates (final step, don't auto-wire config)
    try {
      await promptsInitCommand({
        workdir,
        force: options.force,
        autoWireConfig: false,
      });
    } catch (err) {
      console.error(chalk.red(`Failed to initialize templates: ${(err as Error).message}`));
      process.exit(1);
    }

    console.log(chalk.green("✅ Initialized nax"));
    console.log(chalk.dim(`   ${naxDir}/`));
    console.log(chalk.dim("   ├── config.json"));
    console.log(chalk.dim("   ├── context.md"));
    console.log(chalk.dim("   ├── hooks.json"));
    console.log(chalk.dim("   ├── features/"));
    console.log(chalk.dim("   ├── hooks/"));
    console.log(chalk.dim("   └── templates/"));
    console.log(chalk.dim("       ├── test-writer.md"));
    console.log(chalk.dim("       ├── implementer.md"));
    console.log(chalk.dim("       ├── verifier.md"));
    console.log(chalk.dim("       ├── single-session.md"));
    console.log(chalk.dim("       └── tdd-simple.md"));
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
  .option("--parallel <n>", "Max parallel sessions (0=auto, omit=sequential)")
  .option("--plan", "Run plan phase first before execution", false)
  .option("--from <spec-path>", "Path to spec file (required when --plan is used)")
  .option("--one-shot", "Skip interactive planning Q&A, use single LLM call (ACP only)", false)
  .option("--force", "Force overwrite existing prd.json when using --plan", false)
  .option("--headless", "Force headless mode (disable TUI, use pipe mode)", false)
  .option("--verbose", "Enable verbose logging (debug level)", false)
  .option("--quiet", "Quiet mode (warnings and errors only)", false)
  .option("--silent", "Silent mode (errors only)", false)
  .option("--json", "JSON mode (raw JSONL output to stdout)", false)
  .option("-d, --dir <path>", "Working directory", process.cwd())
  .option("--skip-precheck", "Skip precheck validations (advanced users only)", false)
  .option("--profile <name>", "Profile to use (overrides config.json profile)")
  .action(async (options) => {
    // Validate directory path
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    // Validate --plan and --from flags (AC-8: --plan without --from is error)
    if (options.plan && !options.from) {
      console.error(chalk.red("Error: --plan requires --from <spec-path>"));
      process.exit(1);
    }

    // Validate --from path exists (AC-7: --from without existing file throws error)
    if (options.from && !existsSync(options.from)) {
      console.error(chalk.red(`Error: File not found: ${options.from} (required with --plan)`));
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

    // Determine formatter mode from flags
    let formatterMode: "quiet" | "normal" | "verbose" | "json" = "normal"; // default
    if (options.json) {
      formatterMode = "json";
    } else if (options.verbose) {
      formatterMode = "verbose";
    } else if (options.quiet || options.silent) {
      formatterMode = "quiet";
    }

    const naxDir = findProjectDir(workdir);
    const cliOverrides: Record<string, unknown> = {};
    if (options.profile) {
      cliOverrides.profile = options.profile;
    }
    const config = await loadConfig(naxDir ?? undefined, cliOverrides);

    if (!naxDir) {
      console.error(chalk.red("nax not initialized. Run: nax init"));
      process.exit(1);
    }

    const featureDir = join(naxDir, "features", options.feature);
    const prdPath = join(featureDir, "prd.json");

    // Run plan phase if --plan flag is set (AC-4: runs plan then execute)
    if (options.plan && options.from) {
      // Guard: block overwrite of existing prd.json unless --force
      if (existsSync(prdPath) && !options.force) {
        console.error(chalk.red(`Error: prd.json already exists for feature "${options.feature}".`));
        console.error(chalk.dim("   Use --force to overwrite, or run without --plan to use the existing PRD."));
        process.exit(1);
      }

      // Run environment precheck before plan — catch blockers early (before expensive LLM calls)
      if (!options.skipPrecheck) {
        const { runEnvironmentPrecheck } = await import("../src/precheck");
        console.log(chalk.dim("\n   [Pre-plan environment check]"));
        const envResult = await runEnvironmentPrecheck(config, workdir);
        if (!envResult.passed) {
          console.error(chalk.red("\n❌ Environment precheck failed — cannot proceed with planning."));
          for (const b of envResult.blockers) {
            console.error(chalk.red(`   ${b.name}: ${b.message}`));
          }
          process.exit(1);
        }
      }

      try {
        // Initialize plan logger before calling planCommand — writes to features/<feature>/plan/<ts>.jsonl
        const planLogDir = join(featureDir, "plan");
        mkdirSync(planLogDir, { recursive: true });
        const planLogId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
        const planLogPath = join(planLogDir, `${planLogId}.jsonl`);
        initLogger({ level: "info", filePath: planLogPath, useChalk: false, headless: true });
        console.log(chalk.dim(`   [Plan log: ${planLogPath}]`));

        console.log(chalk.dim("   [Planning phase: generating PRD from spec]"));
        const generatedPrdPath = await planCommand(workdir, config, {
          from: options.from,
          feature: options.feature,
          auto: options.oneShot ?? false, // interactive by default; --one-shot skips Q&A
          branch: undefined,
        });

        // Load the generated PRD to display confirmation gate
        const generatedPrd = await loadPRD(generatedPrdPath);

        // Run replan loop before confirmation gate (US-003: insert replan loop)
        await runReplanLoop(workdir, config, {
          feature: options.feature,
          prd: generatedPrd,
          prdPath: generatedPrdPath,
        });

        // Reload PRD after replan loop in case it was modified
        const finalPrd = await loadPRD(generatedPrdPath);

        // Display story breakdown (AC-5: confirmation gate displays story breakdown)
        console.log(chalk.bold("\n── Planning Summary ──────────────────────────────"));
        console.log(chalk.dim(`Feature: ${finalPrd.feature}`));
        console.log(chalk.dim(`Stories: ${finalPrd.userStories.length}`));
        console.log();

        for (const story of finalPrd.userStories) {
          const complexity = story.routing?.complexity || "unknown";
          console.log(chalk.dim(`  ${story.id}: ${story.title} [${complexity}]`));
        }
        console.log();

        // Show confirmation gate unless --headless (AC-5, AC-6)
        if (!options.headless) {
          // Prompt for user confirmation
          const confirmationResult = await promptForConfirmation("Proceed with execution?");
          if (!confirmationResult) {
            console.log(chalk.yellow("Execution cancelled."));
            process.exit(0);
          }
        }

        // Continue with normal run using the generated prd.json
        // (prdPath already points to the generated file)
      } catch (err) {
        console.error(chalk.red(`Error during planning: ${(err as Error).message}`));
        process.exit(1);
      }
    }

    // Check if prd.json exists (skip if --plan already generated it)
    if (!existsSync(prdPath)) {
      console.error(chalk.red(`Feature "${options.feature}" not found or missing prd.json`));
      process.exit(1);
    }

    // Reset plan logger (if plan phase ran) so the run logger can be initialized fresh
    resetLogger();

    // Create run directory and JSONL log file path
    const runsDir = join(featureDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    // Generate run ID from ISO timestamp
    const runId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const logFilePath = join(runsDir, `${runId}.jsonl`);

    // Determine TUI vs headless mode
    // TUI activates when:
    // 1. stdout is a TTY, AND
    // 2. --headless flag is NOT passed, AND
    // 3. NAX_HEADLESS env var is NOT set
    const isTTY = process.stdout.isTTY ?? false;
    const headlessFlag = options.headless ?? false;
    const headlessEnv = process.env.NAX_HEADLESS === "1";
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    // Initialize logger with selected level, file path, and formatter mode
    initLogger({
      level: logLevel,
      filePath: logFilePath,
      useChalk: true,
      formatterMode: useHeadless ? formatterMode : undefined,
      headless: useHeadless,
    });

    // Override config from CLI
    if (options.agent) {
      config.autoMode.defaultAgent = options.agent;
    }
    config.execution.maxIterations = Number.parseInt(options.maxIterations, 10);

    const globalNaxDir = join(homedir(), ".nax");
    const hooks = await loadHooksConfig(naxDir, globalNaxDir);

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

    // Compute status file path: <workdir>/.nax/status.json
    const statusFilePath = join(workdir, ".nax", "status.json");

    // Parse --parallel option
    let parallel: number | undefined;
    if (options.parallel !== undefined) {
      parallel = Number.parseInt(options.parallel, 10);
      if (Number.isNaN(parallel) || parallel < 0) {
        console.error(chalk.red("--parallel must be a non-negative integer"));
        process.exit(1);
      }
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
      parallel,
      eventEmitter,
      statusFile: statusFilePath,
      logFilePath,
      formatterMode: useHeadless ? formatterMode : undefined,
      headless: useHeadless,
      skipPrecheck: options.skipPrecheck ?? false,
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

    // Create spec.md template
    await Bun.write(
      join(featureDir, "spec.md"),
      `# Feature: ${name}

## Overview

<!-- One paragraph describing what this feature does and why it's needed. -->

## Background / Context

<!-- Optional: relevant background, existing behaviour, or constraints. -->

## User Stories

<!-- Describe what users need. Each story becomes a unit of work for nax.
     Be specific — the more detail here, the better the generated plan. -->

- As a [user], I want to [goal] so that [benefit].

## Technical Requirements

<!-- Optional: specific technical constraints, patterns to follow, APIs to use, etc. -->

## Acceptance Criteria

<!-- These are parsed by nax to generate acceptance tests.
     Use clear, testable statements. Each criterion = one AC test. -->

- [ ] [Describe observable outcome 1]
- [ ] [Describe observable outcome 2]

## Out of Scope

<!-- What this feature explicitly does NOT cover. -->
`,
    );
    await Bun.write(
      join(featureDir, "progress.txt"),
      `# Progress: ${name}\n\nCreated: ${new Date().toISOString()}\n\n---\n`,
    );

    console.log(chalk.green(`✅ Created feature: ${name}`));
    console.log(chalk.dim(`   ${featureDir}/`));
    console.log(chalk.dim("   ├── spec.md"));
    console.log(chalk.dim("   └── progress.txt"));
    console.log(chalk.dim(`\nNext: Edit spec.md, then: nax plan -f ${name} --from spec.md --auto`));
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
  .command("plan [description]")
  .description("Generate prd.json from a spec file via LLM one-shot call (replaces deprecated 'nax analyze')")
  .option("--from <spec-path>", "Path to spec file (required unless --decompose is used)")
  .requiredOption("-f, --feature <name>", "Feature name (required)")
  .option("--auto", "Run in one-shot LLM mode (alias: --one-shot)", false)
  .option("--one-shot", "Run in one-shot LLM mode (alias: --auto)", false)
  .option("-b, --branch <branch>", "Override default branch name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--decompose <storyId>", "Decompose an existing story into sub-stories")
  .option("--profile <name>", "Profile to use (overrides config.json profile)")
  .action(async (description, options) => {
    // AC-3: Detect and reject old positional argument form
    if (description) {
      console.error(
        chalk.red("Error: Positional args removed in plan v2.\n\nUse: nax plan -f <feature> --from <spec>"),
      );
      process.exit(1);
    }
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
    const cliOverrides: Record<string, unknown> = {};
    if (options.profile) {
      cliOverrides.profile = options.profile;
    }
    const config = await loadConfig(workdir, cliOverrides);

    // Initialize logger — writes to nax/features/<feature>/plan/<timestamp>.jsonl
    const featureLogDir = join(naxDir, "features", options.feature, "plan");
    mkdirSync(featureLogDir, { recursive: true });
    const planLogId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const planLogPath = join(featureLogDir, `${planLogId}.jsonl`);
    initLogger({ level: "info", filePath: planLogPath, useChalk: false, headless: true });
    console.log(chalk.dim(`   [Plan log: ${planLogPath}]`));

    try {
      if (options.decompose) {
        await planDecomposeCommand(workdir, config, {
          feature: options.feature,
          storyId: options.decompose,
        });
        console.log(chalk.green("\n[OK] Story decomposed"));
        console.log(chalk.dim(`   Log: ${planLogPath}`));
      } else {
        if (!options.from) {
          console.error(chalk.red("Error: --from <spec-path> is required unless --decompose is used"));
          process.exit(1);
        }
        const prdPath = await planCommand(workdir, config, {
          from: options.from,
          feature: options.feature,
          auto: options.auto || options.oneShot, // --auto and --one-shot are aliases
          branch: options.branch,
        });

        console.log(chalk.green("\n[OK] PRD generated"));
        console.log(chalk.dim(`   PRD: ${prdPath}`));
        console.log(chalk.dim(`   Log: ${planLogPath}`));
        console.log(chalk.dim(`\nNext: nax run -f ${options.feature}`));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── agents ───────────────────────────────────────────
program
  .command("agents")
  .description("List available coding agents with status and capabilities")
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

    try {
      const config = await loadConfig(workdir);
      await agentsListCommand(config, workdir);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── config ───────────────────────────────────────────
const configCmd = program
  .command("config")
  .description("Display effective merged configuration")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--explain", "Show detailed field descriptions", false)
  .option("--diff", "Show only fields where project overrides global", false)
  .action(async (options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
      return;
    }
    try {
      const config = await loadConfig(workdir);
      await configCommand(config, { explain: options.explain, diff: options.diff });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── config profile ────────────────────────────────────
const configProfileCmd = configCmd.command("profile").description("Manage config profiles");

configProfileCmd
  .command("list")
  .description("List all available profiles grouped by scope")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    try {
      const output = await profileListCommand(options.dir);
      console.log(output);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

configProfileCmd
  .command("show <name>")
  .description("Show resolved profile JSON")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--unmask", "Show raw values including secrets", false)
  .action(async (name, options) => {
    try {
      const output = await profileShowCommand(name, options.dir, { unmask: options.unmask });
      console.log(output);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

configProfileCmd
  .command("use <name>")
  .description("Set the active profile (use 'default' to clear)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (name, options) => {
    try {
      const msg = await profileUseCommand(name, options.dir);
      console.log(msg);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

configProfileCmd
  .command("current")
  .description("Show the currently active profile name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    try {
      const name = await profileCurrentCommand(options.dir);
      console.log(name);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

configProfileCmd
  .command("create <name>")
  .description("Create a new empty profile")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (name, options) => {
    try {
      const path = await profileCreateCommand(name, options.dir);
      console.log(`Created profile at: ${path}`);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
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

    // Default status: show feature progress (new implementation with active run detection)
    await displayFeatureStatus({
      feature: options.feature,
      dir: options.dir,
    });
  });

// ── logs ─────────────────────────────────────────────
program
  .command("logs")
  .description("Display run logs with filtering and follow mode")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-f, --follow", "Follow mode - stream new entries real-time", false)
  .option("-s, --story <id>", "Filter to specific story")
  .option("--level <level>", "Filter by log level (debug|info|warn|error)")
  .option("-l, --list", "List all runs in table format", false)
  .option("-r, --run <runId>", "Select run by run ID from central registry (global)")
  .option("-j, --json", "Output raw JSONL", false)
  .action(async (options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
    }

    try {
      await logsCommand({
        dir: workdir,
        follow: options.follow,
        story: options.story,
        level: options.level,
        list: options.list,
        run: options.run,
        json: options.json,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── diagnose ─────────────────────────────────────────
program
  .command("diagnose")
  .description("Diagnose run failures and generate recommendations")
  .option("-f, --feature <name>", "Feature name (defaults to current feature)")
  .option("-d, --dir <path>", "Working directory", process.cwd())
  .option("--json", "Output machine-readable JSON", false)
  .option("--verbose", "Verbose output with story breakdown", false)
  .action(async (options) => {
    try {
      await diagnose({
        feature: options.feature,
        workdir: options.dir,
        json: options.json,
        verbose: options.verbose,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── precheck ─────────────────────────────────────────
program
  .command("precheck")
  .description("Validate feature readiness before execution")
  .option("-f, --feature <name>", "Feature name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--json", "Output machine-readable JSON", false)
  .option("--light", "Environment-only check — skips PRD validation (use before nax plan)", false)
  .action(async (options) => {
    try {
      await precheckCommand({
        feature: options.feature,
        dir: options.dir,
        json: options.json,
        light: options.light,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── detect ───────────────────────────────────────────
program
  .command("detect")
  .description("Detect test-file patterns for the project and optionally persist them")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--apply", "Write detected patterns to .nax/ configs", false)
  .option("--json", "Machine-readable JSON output", false)
  .option("--package <dir>", "Restrict detection to a single package directory")
  .option("--force", "With --apply: overwrite even when testFilePatterns is already set", false)
  .action(async (options) => {
    try {
      await detectCommand({
        dir: options.dir,
        apply: options.apply,
        json: options.json,
        package: options.package,
        force: options.force,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── unlock ───────────────────────────────────────────
program
  .command("unlock")
  .description("Release stale lock from crashed nax process")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--force", "Skip liveness check and remove unconditionally", false)
  .action(async (options) => {
    try {
      await unlockCommand({
        dir: options.dir,
        force: options.force,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── runs ─────────────────────────────────────────────
const runs = program
  .command("runs")
  .description("Show all registered runs from the central registry (~/.nax/runs/)")
  .option("--project <name>", "Filter by project name")
  .option("--last <N>", "Limit to N most recent runs (default: 20)")
  .option("--status <status>", "Filter by status (running|completed|failed|crashed)")
  .action(async (options) => {
    try {
      await runsCommand({
        project: options.project,
        last: options.last !== undefined ? Number.parseInt(options.last, 10) : undefined,
        status: options.status,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

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

// ── prompts ──────────────────────────────────────────
program
  .command("prompts")
  .description("Assemble or initialize prompts")
  .option("-f, --feature <name>", "Feature name (required unless using --init or --export)")
  .option("--init", "Initialize default prompt templates", false)
  .option("--export <role>", "Export default prompt for a role to stdout or --out file")
  .option("--force", "Overwrite existing template files", false)
  .option("--story <id>", "Filter to a single story ID (e.g., US-003)")
  .option("--out <path>", "Output file path for --export, or directory for regular prompts (default: stdout)")
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

    // Handle --init command
    if (options.init) {
      try {
        await promptsInitCommand({
          workdir,
          force: options.force,
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
      return;
    }

    // Handle --export command
    if (options.export) {
      try {
        await exportPromptCommand({
          role: options.export,
          out: options.out,
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
      return;
    }

    // Handle regular prompts command (requires --feature)
    if (!options.feature) {
      console.error(chalk.red("Error: --feature is required (unless using --init or --export)"));
      process.exit(1);
    }

    // Load config
    const config = await loadConfig(workdir);

    try {
      const processedStories = await promptsCommand({
        feature: options.feature,
        workdir,
        config,
        storyId: options.story,
        outputDir: options.out,
      });

      if (options.out) {
        console.log(chalk.green(`\n✅ Prompts written to ${options.out}`));
        console.log(chalk.dim(`   Processed ${processedStories.length} stories`));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── generate ──────────────────────────────────────────
program
  .command("generate")
  .description("Generate agent config files (CLAUDE.md, AGENTS.md, etc.) from nax/context.md")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-c, --context <path>", "Context file path (default: nax/context.md)")
  .option("-o, --output <dir>", "Output directory (default: project root)")
  .option("-a, --agent <name>", "Specific agent (claude|opencode|cursor|windsurf|aider)")
  .option("--dry-run", "Preview without writing files", false)
  .option("--no-auto-inject", "Disable auto-injection of project metadata")
  .option("--package <dir>", "Generate CLAUDE.md for a specific package (e.g. packages/api)")
  .option("--all-packages", "Generate CLAUDE.md for all discovered packages", false)
  .action(async (options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
      return;
    }
    try {
      await generateCommand({
        dir: workdir,
        context: options.context,
        output: options.output,
        agent: options.agent,
        dryRun: options.dryRun,
        noAutoInject: !options.autoInject,
        package: options.package,
        allPackages: options.allPackages,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── context ──────────────────────────────────────────
const context = program.command("context").description("Inspect context-engine artifacts");

context
  .command("inspect <storyId>")
  .description("Inspect persisted context manifests for a story")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-f, --feature <id>", "Feature ID (otherwise scan all features)")
  .option("--json", "Print raw manifest JSON", false)
  .action(async (storyId, options) => {
    let workdir: string;
    try {
      workdir = validateDirectory(options.dir);
    } catch (err) {
      console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
      process.exit(1);
      return;
    }

    try {
      await contextInspectCommand({
        dir: workdir,
        feature: options.feature,
        json: options.json,
        storyId,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── plugins ──────────────────────────────────────────
const plugins = program.command("plugins").description("Manage plugins");

plugins
  .command("list")
  .description("List all installed plugins")
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

    // Load config (or use default if outside project)
    let config = DEFAULT_CONFIG;
    try {
      config = await loadConfig(workdir);
    } catch {
      // Outside project directory, use default config (global plugins only)
    }

    try {
      await pluginsListCommand(config, workdir);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse();
