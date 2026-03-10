/**
 * Init Command
 *
 * Initializes nax configuration directories and files.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir, projectConfigDir } from "../config/paths";
import { DEFAULT_CONFIG } from "../config/schema";
import { getLogger } from "../logger";
import { promptsInitCommand } from "./prompts";

/** Init command options */
export interface InitOptions {
  /** Initialize global config (~/.nax) */
  global?: boolean;
  /** Project root (default: cwd) */
  projectRoot?: string;
}

/**
 * Gitignore entries added by nax init
 */
const NAX_GITIGNORE_ENTRIES = [".nax-verifier-verdict.json"];

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
 * Template for default constitution.md
 */
const DEFAULT_CONSTITUTION = `# Project Constitution

## Goals
- Deliver high-quality, maintainable code
- Follow project conventions and best practices
- Maintain comprehensive test coverage

## Constraints
- Use Bun-native APIs only
- Follow functional style for pure logic
- Keep files focused and under 400 lines

## Preferences
- Prefer immutability over mutation
- Write tests first (TDD approach)
- Clear, descriptive naming
`;

/**
 * Template for minimal config.json (references defaults, only overrides)
 */
const MINIMAL_PROJECT_CONFIG = {
  version: 1,
  // Add project-specific overrides here
};

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
    await Bun.write(constitutionPath, DEFAULT_CONSTITUTION);
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
export async function initProject(projectRoot: string): Promise<void> {
  const logger = getLogger();
  const projectDir = projectConfigDir(projectRoot);

  // Create nax/ directory if it doesn't exist
  if (!existsSync(projectDir)) {
    await mkdir(projectDir, { recursive: true });
    logger.info("init", "Created project config directory", { path: projectDir });
  }

  // Create nax/config.json if it doesn't exist
  const configPath = join(projectDir, "config.json");
  if (!existsSync(configPath)) {
    await Bun.write(configPath, `${JSON.stringify(MINIMAL_PROJECT_CONFIG, null, 2)}\n`);
    logger.info("init", "Created project config", { path: configPath });
  } else {
    logger.info("init", "Project config already exists", { path: configPath });
  }

  // Create nax/constitution.md if it doesn't exist
  const constitutionPath = join(projectDir, "constitution.md");
  if (!existsSync(constitutionPath)) {
    await Bun.write(constitutionPath, DEFAULT_CONSTITUTION);
    logger.info("init", "Created project constitution", { path: constitutionPath });
  } else {
    logger.info("init", "Project constitution already exists", { path: constitutionPath });
  }

  // Create nax/hooks/ directory if it doesn't exist
  const hooksDir = join(projectDir, "hooks");
  if (!existsSync(hooksDir)) {
    await mkdir(hooksDir, { recursive: true });
    logger.info("init", "Created project hooks directory", { path: hooksDir });
  } else {
    logger.info("init", "Project hooks directory already exists", { path: hooksDir });
  }

  // Update .gitignore to include nax-specific entries
  await updateGitignore(projectRoot);

  // Create prompt templates (final step)
  // Pass autoWireConfig: false to prevent auto-wiring prompts.overrides
  // Templates are created but not activated until user explicitly configures them
  await promptsInitCommand({ workdir: projectRoot, force: false, autoWireConfig: false });

  logger.info("init", "Project config initialized successfully", { path: projectDir });
}

/**
 * Run init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  if (options.global) {
    await initGlobal();
  } else {
    const projectRoot = options.projectRoot ?? process.cwd();
    await initProject(projectRoot);
  }
}
