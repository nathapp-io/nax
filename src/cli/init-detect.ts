/**
 * Project Stack Detection for nax init
 *
 * Scans the project root for stack indicators and builds quality.commands
 * for nax/config.json.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Detected project runtime */
export type Runtime = "bun" | "node" | "unknown";

/** Detected project language */
export type Language = "typescript" | "python" | "rust" | "go" | "unknown";

/** Detected linter */
export type Linter = "biome" | "eslint" | "ruff" | "clippy" | "golangci-lint" | "unknown";

/** Detected monorepo tooling */
export type Monorepo = "turborepo" | "none";

/** Full detected project stack */
export interface ProjectStack {
  runtime: Runtime;
  language: Language;
  linter: Linter;
  monorepo: Monorepo;
}

/** Quality commands derived from stack detection */
export interface QualityCommands {
  typecheck?: string;
  lint?: string;
  test?: string;
}

function detectRuntime(projectRoot: string): Runtime {
  if (existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bunfig.toml"))) {
    return "bun";
  }
  if (
    existsSync(join(projectRoot, "package-lock.json")) ||
    existsSync(join(projectRoot, "yarn.lock")) ||
    existsSync(join(projectRoot, "pnpm-lock.yaml"))
  ) {
    return "node";
  }
  return "unknown";
}

function detectLanguage(projectRoot: string): Language {
  if (existsSync(join(projectRoot, "tsconfig.json"))) return "typescript";
  if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "setup.py"))) {
    return "python";
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) return "rust";
  if (existsSync(join(projectRoot, "go.mod"))) return "go";
  return "unknown";
}

function detectLinter(projectRoot: string): Linter {
  if (existsSync(join(projectRoot, "biome.json")) || existsSync(join(projectRoot, "biome.jsonc"))) {
    return "biome";
  }
  if (
    existsSync(join(projectRoot, ".eslintrc.json")) ||
    existsSync(join(projectRoot, ".eslintrc.js")) ||
    existsSync(join(projectRoot, "eslint.config.js"))
  ) {
    return "eslint";
  }
  return "unknown";
}

function detectMonorepo(projectRoot: string): Monorepo {
  if (existsSync(join(projectRoot, "turbo.json"))) return "turborepo";
  return "none";
}

/**
 * Detect the project stack by scanning for indicator files.
 */
export function detectProjectStack(projectRoot: string): ProjectStack {
  return {
    runtime: detectRuntime(projectRoot),
    language: detectLanguage(projectRoot),
    linter: detectLinter(projectRoot),
    monorepo: detectMonorepo(projectRoot),
  };
}

function resolveLintCommand(stack: ProjectStack, fallback: string): string {
  if (stack.linter === "biome") return "biome check .";
  if (stack.linter === "eslint") return "eslint .";
  return fallback;
}

/**
 * Build quality.commands from a detected project stack.
 */
export function buildQualityCommands(stack: ProjectStack): QualityCommands {
  if (stack.runtime === "bun" && stack.language === "typescript") {
    return {
      typecheck: "bun run tsc --noEmit",
      lint: resolveLintCommand(stack, "bun run lint"),
      test: "bun test",
    };
  }

  if (stack.runtime === "node" && stack.language === "typescript") {
    return {
      typecheck: "npx tsc --noEmit",
      lint: resolveLintCommand(stack, "npm run lint"),
      test: "npm test",
    };
  }

  if (stack.language === "python") {
    return {
      lint: "ruff check .",
      test: "pytest",
    };
  }

  if (stack.language === "rust") {
    return {
      typecheck: "cargo check",
      lint: "cargo clippy",
      test: "cargo test",
    };
  }

  if (stack.language === "go") {
    return {
      typecheck: "go vet ./...",
      lint: "golangci-lint run",
      test: "go test ./...",
    };
  }

  return {};
}

function isStackDetected(stack: ProjectStack): boolean {
  return stack.runtime !== "unknown" || stack.language !== "unknown";
}

/**
 * Build the full init config object from a detected project stack.
 * Falls back to minimal config when stack is undetected.
 */
export function buildInitConfig(stack: ProjectStack): object {
  if (!isStackDetected(stack)) {
    return { version: 1 };
  }

  const commands = buildQualityCommands(stack);
  const hasCommands = Object.keys(commands).length > 0;

  if (!hasCommands) {
    return { version: 1 };
  }

  return {
    version: 1,
    quality: { commands },
  };
}
