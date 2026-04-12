/**
 * Analyze Module Types
 *
 * Types for codebase scanning used by planning.
 */

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
