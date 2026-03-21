/**
 * Init Command
 *
 * Initializes nax configuration directories and files.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir, projectConfigDir } from "../config/paths";
import { getLogger } from "../logger";
import { initContext, initPackage } from "./init-context";
import { buildInitConfig, detectStack } from "./init-detect";
import type { ProjectStack } from "./init-detect";
import { promptsInitCommand } from "./prompts";

/** Init command options */
export interface InitOptions {
  /** Initialize global config (~/.nax) */
  global?: boolean;
  /** Project root (default: cwd) */
  projectRoot?: string;
  /**
   * Initialize a per-package nax/context.md scaffold.
   * Relative path from repo root, e.g. "packages/api".
   */
  package?: string;
}

/** Options for initProject */
export interface InitProjectOptions {
  /** Use LLM to generate context.md (--ai flag) */
  ai?: boolean;
  /** Force overwrite of existing files */
  force?: boolean;
}

/**
 * Gitignore entries added by nax init
 */
const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  ".nax/**/runs/",
  ".nax/metrics.json",
  ".nax/features/*/status.json",
  ".nax/features/*/plan/",
  ".nax/features/*/acp-sessions.json",
  ".nax/features/*/interactions/",
  ".nax/features/*/progress.txt",
  ".nax/features/*/acceptance-refined.json",
  ".nax-pids",
  ".nax-wt/",
];

/**
 * Add nax-specific entries to .gitignore if not already present.
 *
 * Appends a clearly marked nax section to the project .gitignore.
 */
async function updateGitignore(projectRoot: string): Promise<void> {
  const logger = getLogger();
  const gitignorePath = join(projectRoot, ".gitignore");

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = await Bun.file(gitignorePath).text();
  }

  const missingEntries = NAX_GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));

  if (missingEntries.length === 0) {
    logger.info("init", ".gitignore already has nax entries", { path: gitignorePath });
    return;
  }

  const naxSection = `\n# nax — generated files\n${missingEntries.join("\n")}\n`;
  await Bun.write(gitignorePath, existing + naxSection);
  logger.info("init", "Updated .gitignore with nax entries", {
    path: gitignorePath,
    added: missingEntries,
  });
}

/**
 * Build a stack-aware constitution.md from the detected project stack.
 */
function buildConstitution(stack: ProjectStack): string {
  const sections: string[] = [];

  sections.push("# Project Constitution\n");

  sections.push("## Goals");
  sections.push("- Deliver high-quality, maintainable code");
  sections.push("- Follow project conventions and best practices");
  sections.push("- Maintain comprehensive test coverage\n");

  sections.push("## Constraints");
  sections.push("- Follow functional style for pure logic");
  sections.push("- Keep files focused and under 400 lines\n");

  if (stack.runtime === "bun") {
    sections.push("## Bun-Native APIs");
    sections.push("- Use `Bun.file()` for file reads, `Bun.write()` for file writes");
    sections.push("- Use `Bun.spawn()` for subprocesses (never `child_process`)");
    sections.push("- Use `Bun.sleep()` for delays");
    sections.push("- Use `bun test` for running tests\n");
  }

  if (stack.language === "typescript") {
    sections.push("## strict TypeScript");
    sections.push("- Enable strict mode in tsconfig.json");
    sections.push("- No `any` in public APIs — use `unknown` + type guards");
    sections.push("- Explicit return types on all exported functions\n");
  }

  if (stack.language === "python") {
    sections.push("## Python Standards");
    sections.push("- Follow PEP 8 style guide for formatting and naming");
    sections.push("- Add type hints to all function signatures");
    sections.push("- Use type annotations for variables where non-obvious\n");
  }

  if (stack.monorepo !== "none") {
    sections.push("## Monorepo Conventions");
    sections.push("- Respect package boundaries — do not import across packages without explicit dependency");
    sections.push("- Each package should be independently buildable and testable");
    sections.push("- Shared utilities go in a dedicated `packages/shared` (or equivalent) package");
    if (stack.monorepo === "turborepo") {
      sections.push("- Use `turbo run <task> --filter=<package>` to run tasks scoped to a single package");
    } else if (stack.monorepo === "nx") {
      sections.push("- Use `nx run <package>:<task>` to run tasks scoped to a single package");
    } else if (stack.monorepo === "pnpm-workspaces") {
      sections.push("- Use `pnpm --filter <package> run <task>` to run tasks scoped to a single package");
    } else if (stack.monorepo === "bun-workspaces") {
      sections.push("- Use `bun run --filter <package> <task>` to run tasks scoped to a single package");
    }
    sections.push("");
  }

  sections.push("## Preferences");
  sections.push("- Prefer immutability over mutation");
  sections.push("- Write tests first (TDD approach)");
  sections.push("- Clear, descriptive naming");

  return `${sections.join("\n")}\n`;
}

const MINIMAL_GLOBAL_CONFIG = {
  version: 1,
  // Add global preferences here (e.g., model tiers, execution limits)
};

/**
 * Initialize global nax config directory (~/.nax)
 */
async function initGlobal(): Promise<void> {
  const logger = getLogger();
  const globalDir = globalConfigDir();

  // Create ~/.nax if it doesn't exist
  if (!existsSync(globalDir)) {
    await mkdir(globalDir, { recursive: true });
    logger.info("init", "Created global config directory", { path: globalDir });
  }

  // Create ~/.nax/config.json if it doesn't exist
  const configPath = join(globalDir, "config.json");
  if (!existsSync(configPath)) {
    await Bun.write(configPath, `${JSON.stringify(MINIMAL_GLOBAL_CONFIG, null, 2)}\n`);
    logger.info("init", "Created global config", { path: configPath });
  } else {
    logger.info("init", "Global config already exists", { path: configPath });
  }

  // Create ~/.nax/constitution.md if it doesn't exist
  const constitutionPath = join(globalDir, "constitution.md");
  if (!existsSync(constitutionPath)) {
    await Bun.write(
      constitutionPath,
      buildConstitution({ runtime: "unknown", language: "unknown", linter: "unknown", monorepo: "none" }),
    );
    logger.info("init", "Created global constitution", { path: constitutionPath });
  } else {
    logger.info("init", "Global constitution already exists", { path: constitutionPath });
  }

  // Create ~/.nax/hooks/ directory if it doesn't exist
  const hooksDir = join(globalDir, "hooks");
  if (!existsSync(hooksDir)) {
    await mkdir(hooksDir, { recursive: true });
    logger.info("init", "Created global hooks directory", { path: hooksDir });
  } else {
    logger.info("init", "Global hooks directory already exists", { path: hooksDir });
  }

  logger.info("init", "Global config initialized successfully", { path: globalDir });
}

/**
 * Initialize project nax directory (nax/)
 */
export async function initProject(projectRoot: string, options?: InitProjectOptions): Promise<void> {
  const logger = getLogger();
  const projectDir = projectConfigDir(projectRoot);

  // Create .nax/ directory if it doesn't exist
  if (!existsSync(projectDir)) {
    await mkdir(projectDir, { recursive: true });
    logger.info("init", "Created project config directory", { path: projectDir });
  }

  // Detect project stack and build config
  const stack = detectStack(projectRoot);
  const projectConfig = buildInitConfig(stack);
  logger.info("init", "Detected project stack", {
    runtime: stack.runtime,
    language: stack.language,
    linter: stack.linter,
    monorepo: stack.monorepo,
  });

  // Create .nax/config.json if it doesn't exist
  const configPath = join(projectDir, "config.json");
  if (!existsSync(configPath)) {
    await Bun.write(configPath, `${JSON.stringify(projectConfig, null, 2)}\n`);
    logger.info("init", "Created project config", { path: configPath });
  } else {
    logger.info("init", "Project config already exists", { path: configPath });
  }

  // Generate context.md (template or LLM-enhanced with --ai flag)
  await initContext(projectRoot, { ai: options?.ai, force: options?.force });

  // Create .nax/constitution.md with stack-aware content
  const constitutionPath = join(projectDir, "constitution.md");
  if (!existsSync(constitutionPath) || options?.force) {
    await Bun.write(constitutionPath, buildConstitution(stack));
    logger.info("init", "Created project constitution", { path: constitutionPath });
  } else {
    logger.info("init", "Project constitution already exists", { path: constitutionPath });
  }

  // Create .nax/hooks/ directory if it doesn't exist
  const hooksDir = join(projectDir, "hooks");
  if (!existsSync(hooksDir)) {
    await mkdir(hooksDir, { recursive: true });
    logger.info("init", "Created project hooks directory", { path: hooksDir });
  } else {
    logger.info("init", "Project hooks directory already exists", { path: hooksDir });
  }

  // Update .gitignore to include nax-specific entries
  await updateGitignore(projectRoot);

  // Create prompt templates
  // Pass autoWireConfig: false to prevent auto-wiring prompts.overrides
  // Templates are created but not activated until user explicitly configures them
  await promptsInitCommand({ workdir: projectRoot, force: false, autoWireConfig: false });

  // Print summary
  console.log("\n[OK] nax init complete. Created files:");
  console.log("  - .nax/config.json");
  console.log("  - .nax/context.md");
  console.log("  - .nax/constitution.md");
  console.log("  - .nax/hooks/");
  console.log("  - .nax/templates/");
  console.log("\nNext steps:");
  console.log("  1. Review .nax/context.md and fill in TODOs");
  console.log("  2. Review .nax/config.json and adjust quality commands");
  console.log("  3. Run: nax generate");
  console.log("  4. Run: nax plan");
  console.log("  5. Run: nax run");

  logger.info("init", "Project config initialized successfully", { path: projectDir });
}

/**
 * Run init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  if (options.global) {
    await initGlobal();
  } else if (options.package) {
    const projectRoot = options.projectRoot ?? process.cwd();
    await initPackage(projectRoot, options.package);
    console.log("\n[OK] Package scaffold created.");
    console.log(`  Created: .nax/mono/${options.package}/context.md`);
    console.log("\nNext steps:");
    console.log(`  1. Review .nax/mono/${options.package}/context.md and fill in TODOs`);
    console.log(`  2. Run: nax generate --package ${options.package}`);
  } else {
    const projectRoot = options.projectRoot ?? process.cwd();
    await initProject(projectRoot);
  }
}
