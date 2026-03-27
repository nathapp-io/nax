/**
 * Acceptance Test Generation Types
 *
 * Types for generating acceptance tests from spec.md acceptance criteria.
 */

import type { AgentAdapter } from "../agents/types";
import type { AcceptanceTestStrategy, ModelDef, ModelTier, NaxConfig } from "../config/schema";

/**
 * A single refined acceptance criterion produced by the refinement module.
 */
export interface RefinedCriterion {
  /** The original criterion text from the PRD */
  original: string;
  /** Concrete, machine-verifiable description produced by LLM */
  refined: string;
  /** False if the LLM determines the criterion cannot be automatically tested */
  testable: boolean;
  /** The story ID this criterion belongs to */
  storyId: string;
}

/**
 * Context passed to refineAcceptanceCriteria.
 */
export interface RefinementContext {
  /** Story ID for attribution on each RefinedCriterion */
  storyId: string;
  /** Feature name for ACP session naming */
  featureName?: string;
  /** Working directory for ACP session naming */
  workdir?: string;
  /** Codebase context string (file tree, dependencies, etc.) */
  codebaseContext: string;
  /** Global config — model tier resolved from config.acceptance.model */
  config: NaxConfig;
  /** Test strategy — controls strategy-specific prompt instructions */
  testStrategy?: AcceptanceTestStrategy;
  /** Test framework — informs LLM which testing library syntax to use */
  testFramework?: string;
}

/**
 * A single acceptance criterion extracted from spec.md.
 *
 * @example
 * ```ts
 * const ac: AcceptanceCriterion = {
 *   id: "AC-2",
 *   text: "set(key, value, ttl) expires after ttl milliseconds",
 *   lineNumber: 42,
 * };
 * ```
 */
export interface AcceptanceCriterion {
  /** AC identifier (e.g., "AC-1", "AC-2") */
  id: string;
  /** Full criterion text */
  text: string;
  /** Line number in spec.md for reference */
  lineNumber: number;
}

/**
 * Options for generating acceptance tests.
 *
 * @example
 * ```ts
 * const options: GenerateAcceptanceTestsOptions = {
 *   specContent: "# Feature\n\n## Acceptance Criteria\n- AC-1: ...",
 *   featureName: "url-shortener",
 *   workdir: "/home/user/project",
 *   codebaseContext: "File tree:\nsrc/\n  index.ts\n",
 *   modelTier: "balanced",
 *   modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
 * };
 * ```
 */
/**
 * Options for generating acceptance tests from PRD stories and refined criteria.
 */
export interface GenerateFromPRDOptions {
  /** Feature name for context */
  featureName: string;
  /** Working directory for context scanning */
  workdir: string;
  /** Feature directory where acceptance-refined.json is written */
  featureDir: string;
  /** Codebase context (file tree, dependencies, test patterns) */
  codebaseContext: string;
  /** Model tier to use for test generation */
  modelTier: ModelTier;
  /** Resolved model definition */
  modelDef: ModelDef;
  /** Global config for quality settings */
  config: NaxConfig;
  /** Test strategy to use for template selection (default: 'unit') */
  testStrategy?: AcceptanceTestStrategy;
  /** Test framework for component/snapshot strategies (e.g. 'ink-testing-library', 'react') */
  testFramework?: string;
  /** Agent adapter to use for test generation — overrides _generatorPRDDeps.adapter */
  adapter?: AgentAdapter;
  /** Target language for test generation (e.g. 'go', 'python', 'rust') — defaults to TypeScript */
  language?: string;
}

export interface GenerateAcceptanceTestsOptions {
  /** Full spec.md content */
  specContent: string;
  /** Feature name for context */
  featureName: string;
  /** Working directory for context scanning */
  workdir: string;
  /** Codebase context (file tree, dependencies, test patterns) */
  codebaseContext: string;
  /** Model tier to use for test generation */
  modelTier: ModelTier;
  /** Resolved model definition */
  modelDef: ModelDef;
  /** Global config for quality settings */
  config: NaxConfig;
  /** Test framework for skeleton generation (e.g. "jest", "vitest") */
  testFramework?: string;
}

/**
 * Result from acceptance test generation.
 *
 * @example
 * ```ts
 * const result: AcceptanceTestResult = {
 *   testCode: 'import { describe, test, expect } from "bun:test";\n\n...',
 *   criteria: [
 *     { id: "AC-1", text: "TTL expires", lineNumber: 12 },
 *     { id: "AC-2", text: "set(key, value, ttl) expires after ttl", lineNumber: 13 },
 *   ],
 * };
 * ```
 */
export interface AcceptanceTestResult {
  /** Generated test code */
  testCode: string;
  /** Acceptance criteria that were processed */
  criteria: AcceptanceCriterion[];
}
