#!/usr/bin/env bun
/**
 * ngent — AI Coding Agent Orchestrator
 *
 * Loops until done. Three-session TDD for quality.
 * Smart routing for cost. Hooks for everything.
 */

import { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { loadConfig, DEFAULT_CONFIG, findProjectDir } from "../src/config";
import { checkAgentHealth, getAllAgentNames } from "../src/agents";
import { loadPRD, countStories } from "../src/prd";
import { loadHooksConfig } from "../src/hooks";
import { run } from "../src/execution";
import { analyzeFeature } from "../src/cli";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

const program = new Command();

program
  .name("ngent")
  .description("AI Coding Agent Orchestrator — loops until done")
  .version(pkg.version);

// ── init ─────────────────────────────────────────────
program
  .command("init")
  .description("Initialize ngent in the current project")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-f, --force", "Force overwrite existing files", false)
  .action(async (options) => {
    const ngentDir = join(options.dir, "ngent");

    if (existsSync(ngentDir) && !options.force) {
      console.log(chalk.yellow("ngent already initialized. Use --force to overwrite."));
      return;
    }

    // Create directory structure
    mkdirSync(join(ngentDir, "features"), { recursive: true });
    mkdirSync(join(ngentDir, "hooks"), { recursive: true });

    // Write default config
    await Bun.write(
      join(ngentDir, "config.json"),
      JSON.stringify(DEFAULT_CONFIG, null, 2),
    );

    // Write default hooks.json
    await Bun.write(
      join(ngentDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          "on-start": { command: "echo \"ngent started: $NGENT_FEATURE\"", enabled: false },
          "on-complete": { command: "echo \"ngent complete: $NGENT_FEATURE\"", enabled: false },
          "on-pause": { command: "echo \"ngent paused: $NGENT_REASON\"", enabled: false },
          "on-error": { command: "echo \"ngent error: $NGENT_REASON\"", enabled: false },
        },
      }, null, 2),
    );

    // Write .gitignore
    await Bun.write(
      join(ngentDir, ".gitignore"),
      "# ngent temp files\n*.tmp\n.paused.json\n",
    );

    console.log(chalk.green("✅ Initialized ngent"));
    console.log(chalk.dim(`   ${ngentDir}/`));
    console.log(chalk.dim("   ├── config.json"));
    console.log(chalk.dim("   ├── hooks.json"));
    console.log(chalk.dim("   ├── features/"));
    console.log(chalk.dim("   └── hooks/"));
    console.log(chalk.dim("\nNext: ngent features create <name>"));
  });

// ── run ──────────────────────────────────────────────
program
  .command("run")
  .description("Run the orchestration loop for a feature")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-a, --agent <name>", "Force a specific agent")
  .option("-m, --max-iterations <n>", "Max iterations", "20")
  .option("--dry-run", "Show plan without executing", false)
  .option("-d, --dir <path>", "Working directory", process.cwd())
  .action(async (options) => {
    const config = await loadConfig();
    const ngentDir = findProjectDir(options.dir);

    if (!ngentDir) {
      console.error(chalk.red("ngent not initialized. Run: ngent init"));
      process.exit(1);
    }

    const featureDir = join(ngentDir, "features", options.feature);
    const prdPath = join(featureDir, "prd.json");

    if (!existsSync(prdPath)) {
      console.error(chalk.red(`Feature "${options.feature}" not found or missing prd.json`));
      process.exit(1);
    }

    // Override config from CLI
    if (options.agent) {
      config.autoMode.defaultAgent = options.agent;
    }
    config.execution.maxIterations = Number.parseInt(options.maxIterations, 10);

    const hooks = await loadHooksConfig(ngentDir);

    const result = await run({
      prdPath,
      workdir: options.dir,
      config,
      hooks,
      feature: options.feature,
      dryRun: options.dryRun,
    });

    // Summary
    console.log(chalk.dim("\n── Summary ──────────────────────────────────"));
    console.log(chalk.dim(`   Iterations:  ${result.iterations}`));
    console.log(chalk.dim(`   Completed:   ${result.storiesCompleted}`));
    console.log(chalk.dim(`   Cost:        $${result.totalCost.toFixed(4)}`));
    console.log(chalk.dim(`   Duration:    ${(result.durationMs / 1000 / 60).toFixed(1)} min`));

    process.exit(result.success ? 0 : 1);
  });

// ── features ─────────────────────────────────────────
const features = program.command("features").description("Manage features");

features
  .command("create <name>")
  .description("Create a new feature")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (name, options) => {
    const ngentDir = findProjectDir(options.dir);
    if (!ngentDir) {
      console.error(chalk.red("ngent not initialized. Run: ngent init"));
      process.exit(1);
    }

    const featureDir = join(ngentDir, "features", name);
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
    console.log(chalk.dim("\nNext: Edit spec.md and tasks.md, then: ngent analyze --feature " + name));
  });

features
  .command("list")
  .description("List all features")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    const ngentDir = findProjectDir(options.dir);
    if (!ngentDir) {
      console.error(chalk.red("ngent not initialized."));
      process.exit(1);
    }

    const featuresDir = join(ngentDir, "features");
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

// ── analyze ──────────────────────────────────────────
program
  .command("analyze")
  .description("Parse spec.md + tasks.md into prd.json")
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-b, --branch <name>", "Branch name", "feat/<feature>")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    const ngentDir = findProjectDir(options.dir);
    if (!ngentDir) {
      console.error(chalk.red("ngent not initialized. Run: ngent init"));
      process.exit(1);
    }

    const featureDir = join(ngentDir, "features", options.feature);
    if (!existsSync(featureDir)) {
      console.error(chalk.red(`Feature "${options.feature}" not found.`));
      process.exit(1);
    }

    const branchName = options.branch.replace("<feature>", options.feature);

    try {
      const prd = await analyzeFeature(featureDir, options.feature, branchName);
      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const c = countStories(prd);
      console.log(chalk.green(`\n✅ Generated prd.json for ${options.feature}`));
      console.log(chalk.dim(`   Stories: ${c.total}`));
      console.log(chalk.dim(`   Path: ${prdPath}`));

      for (const story of prd.userStories) {
        console.log(chalk.dim(`   ${story.id}: ${story.title} (${story.acceptanceCriteria.length} criteria)`));
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
  .requiredOption("-f, --feature <name>", "Feature name")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    const ngentDir = findProjectDir(options.dir);
    if (!ngentDir) {
      console.error(chalk.red("ngent not initialized."));
      process.exit(1);
    }

    const prdPath = join(ngentDir, "features", options.feature, "prd.json");
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

program.parse();
