/**
 * Analyze Module Types
 *
 * Types for codebase scanning used by planning.
 */

/** A discovered source root within a workspace or single-package project. */
export interface SourceRoot {
  /** Relative path from workdir (e.g. "packages/api", "cmd/worker", "."). */
  path: string;
  /** Detected language; undefined when no language markers are present. */
  language: "typescript" | "javascript" | "go" | "rust" | "python" | undefined;
  /** Detected framework label (e.g. "NestJS", "Next.js"); empty string when unknown. */
  framework: string;
  /** Detected test runner label (e.g. "jest", "vitest", "go-test", "pytest"); empty string when unknown. */
  testRunner: string;
}

/** Codebase scan result */
export interface CodebaseScan {
  /** File tree (src/ directory, max depth 3) */
  fileTree: string;
  /** Package dependencies */
  dependencies: Record<string, string>;
  /** Dev dependencies */
  devDependencies: Record<string, string>;
  /** Detected test patterns */
  testPatterns: string[];
}
