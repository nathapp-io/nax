/** Repo shape: single root package vs. multi-package monorepo */
export type RepoShape = "single" | "mono";

/** Detected monorepo orchestrator tool */
export type Orchestrator = "turbo" | "nx" | "none";

/** Per-package facts collected during deterministic analysis */
export interface PackageFacts {
  /** Relative path from repo root, e.g. "packages/foo". Empty string for the root package. */
  relativeDir: string;
  /** Detected test framework (e.g. "jest", "vitest", "go-test"). Undefined when unknown. */
  testFramework: string | undefined;
  /** Test file patterns from detectTestFilePatternsForWorkspace for this package. */
  testFilePatterns: readonly string[];
  /** Canonical scripts absent from this package's package.json */
  missingScripts: string[];
}

/** Full deterministic analysis of the repository, consumed by the LLM-driven config proposal step */
export interface RepoAnalysis {
  /** Whether this is a single-package or multi-package repo */
  shape: RepoShape;
  /** Per-package facts (length 1 for single, N for mono) */
  packages: PackageFacts[];
  /** Package manager run prefix, e.g. "bun run" or "npm run" */
  pmRunPrefix: string;
  /** Package manager dlx command, e.g. "bunx" or "npx" */
  pmDlx: string;
  /** Detected monorepo orchestrator */
  orchestrator: Orchestrator;
}
