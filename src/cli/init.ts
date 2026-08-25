/**
 * Init Command
 *
 * Initializes nax configuration directories and files.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { featuresDir, globalConfigDir, PROJECT_FEATURES_DIR, projectConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { readProjectIdentity } from "../runtime";
import {
  NAX_GITIGNORE_ENTRIES,
  NAX_NAXIGNORE_ENTRIES,
  NAX_NAXIGNORE_HEADER,
  NAX_NAXIGNORE_SUGGESTIONS,
  patchIgnoreFile,
} from "../utils/gitignore";
import { initContext, initPackage } from "./init-context";
import type { ProjectStack } from "./init-detect";
import { buildInitConfig, detectStack } from "./init-detect";

export const _initDeps = {
  log: console.log.bind(console) as (...args: unknown[]) => void,
};

/** Result of project name validation */
export interface ProjectNameValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a project name.
 * Must be lowercase alphanumeric with hyphens/underscores, 1–64 chars,
 * must not start with '.' or '_', and must not be a reserved name.
 */
export function validateProjectName(name: string): ProjectNameValidationResult {
  if (!name) return { valid: false, error: "name must be non-empty" };
  if (name.length > 64) return { valid: false, error: "name must be at most 64 characters" };
  if (!/^[a-z0-9_-]+$/.test(name))
    return {
      valid: false,
      error: "name must contain only lowercase letters, digits, hyphens, and underscores",
    };
  if (["global", "_archive"].includes(name)) return { valid: false, error: `name '${name}' is reserved` };
  if (name.startsWith(".") || name.startsWith("_"))
    return { valid: false, error: "name must not start with '.' or '_'" };
  return { valid: true };
}

/** Result of collision check against the global identity registry */
export interface InitCollisionResult {
  collision: boolean;
  existing?: {
    workdir: string;
    remoteUrl: string | null;
    lastSeen: string;
  };
}

/**
 * Check whether a project name is already claimed by a different project.
 * Returns `{ collision: false }` if the name is unclaimed or claimed by the
 * same project (matched by remote URL or workdir when no remote exists).
 */
export async function checkInitCollision(
  name: string,
  currentWorkdir: string,
  currentRemote: string | null,
): Promise<InitCollisionResult> {
  const identity = await readProjectIdentity(name);
  if (!identity) return { collision: false };

  const sameRemote = currentRemote !== null && identity.remoteUrl !== null && currentRemote === identity.remoteUrl;
  const sameWorkdir = !currentRemote && !identity.remoteUrl && currentWorkdir === identity.workdir;
  if (sameRemote || sameWorkdir) return { collision: false };

  return {
    collision: true,
    existing: {
      workdir: identity.workdir,
      remoteUrl: identity.remoteUrl,
      lastSeen: identity.lastSeen,
    },
  };
}

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
  /** Project name for the global identity registry */
  name?: string;
  /** Skip re-init collision guard */
  force?: boolean;
}

/** Options for initProject */
export interface InitProjectOptions {
  /** Force overwrite of existing files */
  force?: boolean;
  /** Project name for validation and identity registry */
  name?: string;
}

/**
 * Add nax-specific entries to .gitignore if not already present.
 *
 * Additive and idempotent — see `patchIgnoreFile`.
 */
async function updateGitignore(projectRoot: string): Promise<void> {
  const logger = getLogger();
  const gitignorePath = join(projectRoot, ".gitignore");

  const result = await patchIgnoreFile(gitignorePath, NAX_GITIGNORE_ENTRIES);

  if (result.added.length === 0) {
    logger.info("init", ".gitignore already has nax entries", { path: gitignorePath });
    return;
  }

  logger.info("init", "Updated .gitignore with nax entries", {
    path: gitignorePath,
    created: result.created,
    added: result.added,
  });
}

/**
 * Create or reconcile .naxignore — the paths nax's own context, review and
 * verification passes skip.
 *
 * The explanatory header and commented suggestions are written only when the
 * file is created, so a re-run never resurrects a suggestion the user removed.
 */
async function updateNaxignore(projectRoot: string): Promise<void> {
  const logger = getLogger();
  const naxignorePath = join(projectRoot, ".naxignore");

  const result = await patchIgnoreFile(naxignorePath, NAX_NAXIGNORE_ENTRIES, {
    header: NAX_NAXIGNORE_HEADER,
    footer: NAX_NAXIGNORE_SUGGESTIONS,
    sectionComment: "# nax - scanning exclusions",
  });

  if (result.added.length === 0) {
    logger.info("init", ".naxignore already has nax entries", { path: naxignorePath });
    return;
  }

  logger.info("init", result.created ? "Created .naxignore" : "Updated .naxignore with nax entries", {
    path: naxignorePath,
    added: result.added,
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

  // Name validation and collision check — only for explicitly provided names.
  // When no name is given, config.name stays "" and the runtime derives the key
  // from basename(workdir) at run time, which need not pass schema validation.
  const detectedName = options?.name ?? "";
  if (detectedName) {
    const nameValidation = validateProjectName(detectedName);
    if (!nameValidation.valid) {
      logger.error("init", "Invalid project name", { name: detectedName, reason: nameValidation.error });
      throw new NaxError(`Invalid project name "${detectedName}": ${nameValidation.error}`, "INIT_INVALID_NAME", {
        stage: "init",
        name: detectedName,
      });
    }
  }

  // Detect current git remote (best-effort; non-git projects are fine)
  let currentRemote: string | null = null;
  try {
    const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: projectRoot });
    if (gitResult.exitCode === 0) {
      currentRemote = new TextDecoder().decode(gitResult.stdout).trim() || null;
    }
  } catch {
    /* non-git project — ok */
  }

  // Collision check — only when a name is explicitly provided
  if (detectedName && !options?.force) {
    const collision = await checkInitCollision(detectedName, projectRoot, currentRemote);
    if (collision.collision && collision.existing) {
      const configPath = join(projectDir, "config.json");
      throw new NaxError(
        [
          `Project name collision: "${detectedName}"`,
          `  This project:    ${projectRoot}`,
          `  Already in use:  ${collision.existing.workdir}  (last run: ${collision.existing.lastSeen})`,
          "  Resolve:",
          `    1. Rename: edit name in ${configPath}`,
          `    2. Reclaim: nax migrate --reclaim ${detectedName}`,
          `    3. Merge:   nax migrate --merge ${detectedName}`,
        ].join("\n"),
        "INIT_NAME_COLLISION",
        { stage: "init", name: detectedName },
      );
    }
  }

  // Create .nax/ directory if it doesn't exist
  if (!existsSync(projectDir)) {
    await mkdir(projectDir, { recursive: true });
    logger.info("init", "Created project config directory", { path: projectDir });
  }

  // Detect project stack and build config
  const stack = detectStack(projectRoot);
  const projectConfig = {
    ...buildInitConfig(stack),
    ...(detectedName ? { name: detectedName } : {}),
  };
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

  // Generate context.md from template
  await initContext(projectRoot, { force: options?.force });

  // Create .nax/constitution.md with stack-aware content
  const constitutionPath = join(projectDir, "constitution.md");
  if (!existsSync(constitutionPath) || options?.force) {
    await Bun.write(constitutionPath, buildConstitution(stack));
    logger.info("init", "Created project constitution", { path: constitutionPath });
  } else {
    logger.info("init", "Project constitution already exists", { path: constitutionPath });
  }

  // Create the hooks and features directories if they don't exist
  for (const [label, dir] of [
    ["hooks", join(projectDir, "hooks")],
    ["features", featuresDir(projectRoot)],
  ] as const) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      logger.info("init", `Created project ${label} directory`, { path: dir });
    } else {
      logger.info("init", `Project ${label} directory already exists`, { path: dir });
    }
  }

  // Reconcile the repo's ignore files. Both are additive and idempotent, so
  // they run on every init — including a re-init over an existing .nax/, which
  // is the case where a user's ignore file has drifted out of date.
  await updateGitignore(projectRoot);
  await updateNaxignore(projectRoot);

  // Print summary
  _initDeps.log("\n[OK] nax init complete. Created files:");
  _initDeps.log("  - .nax/config.json");
  _initDeps.log("  - .nax/context.md");
  _initDeps.log("  - .nax/constitution.md");
  _initDeps.log("  - .nax/hooks/");
  _initDeps.log(`  - ${PROJECT_FEATURES_DIR}/`);
  _initDeps.log("  - .gitignore  (nax entries)");
  _initDeps.log("  - .naxignore");
  _initDeps.log("\nNext steps:");
  _initDeps.log("  1. Review .nax/context.md and fill in TODOs");
  _initDeps.log("  2. Review .naxignore and add paths nax should not scan");
  _initDeps.log("  3. Review .nax/config.json and adjust quality commands");
  _initDeps.log("  4. Run: nax generate");
  _initDeps.log("  5. Run: nax plan");
  _initDeps.log("  6. Run: nax run");
  _initDeps.log("\nOptional: nax prompts --init  (scaffold overridable prompt templates)");

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
    await initPackage(projectRoot, options.package, options.force);
    _initDeps.log("\n[OK] Package scaffold created.");
    _initDeps.log(`  Created: .nax/mono/${options.package}/context.md`);
    _initDeps.log("\nNext steps:");
    _initDeps.log(`  1. Review .nax/mono/${options.package}/context.md and fill in TODOs`);
    _initDeps.log(`  2. Run: nax generate --package ${options.package}`);
  } else {
    const projectRoot = options.projectRoot ?? process.cwd();
    await initProject(projectRoot, { name: options.name, force: options.force });
  }
}
