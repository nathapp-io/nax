/**
 * Project Stack Detection for nax init
 *
 * Scans the project root for stack indicators and builds quality.commands
 * for nax/config.json. Implementation stub — not yet implemented.
 */

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

/**
 * Detect the project stack by scanning for indicator files.
 * Not yet implemented.
 */
export function detectProjectStack(_projectRoot: string): ProjectStack {
  throw new Error("Not implemented");
}

/**
 * Build quality.commands from a detected project stack.
 * Not yet implemented.
 */
export function buildQualityCommands(_stack: ProjectStack): QualityCommands {
  throw new Error("Not implemented");
}

/**
 * Build the full init config object from a detected project stack.
 * Falls back to minimal config when stack is undetected.
 * Not yet implemented.
 */
export function buildInitConfig(_stack: ProjectStack): object {
  throw new Error("Not implemented");
}
