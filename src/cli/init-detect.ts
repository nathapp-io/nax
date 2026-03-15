/**
 * Project Stack Detection for nax init
 *
 * Scans the project root for stack indicators and builds quality.commands
 * for nax/config.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Detected project runtime */
export type Runtime = "bun" | "node" | "unknown";

/** Detected UI framework */
export type UIFramework = "ink" | "react" | "vue" | "svelte";

/** Full stack info including UI framework and bin detection */
export interface StackInfo extends ProjectStack {
  uiFramework?: UIFramework;
  hasBin?: boolean;
}

/** Shape of a parsed package.json for detection purposes */
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
  workspaces?: string[] | { packages: string[] };
}

function readPackageJson(projectRoot: string): PackageJson | undefined {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function allDeps(pkg: PackageJson): Record<string, string> {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
}

function detectUIFramework(pkg: PackageJson): UIFramework | undefined {
  const deps = allDeps(pkg);
  if ("ink" in deps) return "ink";
  if ("react" in deps || "next" in deps) return "react";
  if ("vue" in deps || "nuxt" in deps) return "vue";
  if ("svelte" in deps || "@sveltejs/kit" in deps) return "svelte";
  return undefined;
}

function detectHasBin(pkg: PackageJson): boolean {
  return pkg.bin !== undefined;
}

/**
 * Detect the project stack including UI framework from package.json.
 */
export function detectStack(projectRoot: string): StackInfo {
  const base = detectProjectStack(projectRoot);
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return base;
  return {
    ...base,
    uiFramework: detectUIFramework(pkg),
    hasBin: detectHasBin(pkg) || undefined,
  };
}

/** Detected project language */
export type Language = "typescript" | "python" | "rust" | "go" | "unknown";

/** Detected linter */
export type Linter = "biome" | "eslint" | "ruff" | "clippy" | "golangci-lint" | "unknown";

/** Detected monorepo tooling */
export type Monorepo = "turborepo" | "nx" | "pnpm-workspaces" | "bun-workspaces" | "none";

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
  if (existsSync(join(projectRoot, "nx.json"))) return "nx";
  if (existsSync(join(projectRoot, "pnpm-workspace.yaml"))) return "pnpm-workspaces";
  // Bun/npm/yarn workspaces: package.json with "workspaces" field
  const pkg = readPackageJson(projectRoot);
  if (pkg?.workspaces) return "bun-workspaces";
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
 * Build quality.commands for monorepo orchestrators.
 *
 * Turborepo and Nx support change-aware filtering natively — delegate
 * scoping to the tool rather than nax's smart test runner.
 * pnpm/bun workspaces have no built-in affected detection, so nax's
 * smart runner still applies; commands run across all packages.
 */
function buildMonorepoQualityCommands(stack: ProjectStack): QualityCommands | null {
  if (stack.monorepo === "turborepo") {
    return {
      typecheck: "turbo run typecheck --filter=...[HEAD~1]",
      lint: "turbo run lint --filter=...[HEAD~1]",
      test: "turbo run test --filter=...[HEAD~1]",
    };
  }
  if (stack.monorepo === "nx") {
    return {
      typecheck: "nx affected --target=typecheck",
      lint: "nx affected --target=lint",
      test: "nx affected --target=test",
    };
  }
  if (stack.monorepo === "pnpm-workspaces") {
    return {
      lint: resolveLintCommand(stack, "pnpm run --recursive lint"),
      test: "pnpm run --recursive test",
    };
  }
  if (stack.monorepo === "bun-workspaces") {
    return {
      lint: resolveLintCommand(stack, "bun run lint"),
      test: "bun run --filter '*' test",
    };
  }
  return null;
}

/**
 * Build quality.commands from a detected project stack.
 */
export function buildQualityCommands(stack: ProjectStack): QualityCommands {
  // Monorepo orchestrators: delegate to the tool's own scoping
  const monorepoCommands = buildMonorepoQualityCommands(stack);
  if (monorepoCommands) return monorepoCommands;

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

/** Build the acceptance config section from StackInfo, or undefined if not applicable. */
function buildAcceptanceConfig(stack: StackInfo): { testStrategy: string; testFramework?: string } | undefined {
  if (stack.uiFramework === "ink") {
    return { testStrategy: "component", testFramework: "ink-testing-library" };
  }
  if (stack.uiFramework === "react") {
    return { testStrategy: "component", testFramework: "@testing-library/react" };
  }
  if (stack.uiFramework === "vue") {
    return { testStrategy: "component", testFramework: "@testing-library/vue" };
  }
  if (stack.uiFramework === "svelte") {
    return { testStrategy: "component", testFramework: "@testing-library/svelte" };
  }
  if (stack.hasBin) {
    const testFramework = stack.runtime === "bun" ? "bun:test" : "jest";
    return { testStrategy: "cli", testFramework };
  }
  return undefined;
}

/**
 * Build the full init config object from a detected project stack.
 * Falls back to minimal config when stack is undetected.
 */
export function buildInitConfig(stack: ProjectStack | StackInfo): object {
  const stackInfo = stack as StackInfo;
  const acceptance = buildAcceptanceConfig(stackInfo);

  if (!isStackDetected(stack)) {
    return acceptance ? { version: 1, acceptance } : { version: 1 };
  }

  const commands = buildQualityCommands(stack);
  const hasCommands = Object.keys(commands).length > 0;

  if (!hasCommands && !acceptance) {
    return { version: 1 };
  }

  const config: Record<string, unknown> = { version: 1 };
  if (hasCommands) config.quality = { commands };
  if (acceptance) config.acceptance = acceptance;
  return config;
}
