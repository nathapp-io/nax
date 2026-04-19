/**
 * Acceptance Test Generation Types
 *
 * Types for generating acceptance tests from spec.md acceptance criteria.
 */

import type { IAgentManager } from "../agents/manager-types";
import type { AgentAdapter } from "../agents/types";
import type { AcceptanceTestStrategy, ModelDef, ModelTier, NaxConfig } from "../config/schema";

/**
 * Return value of refineAcceptanceCriteria — criteria plus cost metadata.
 */
export interface RefineResult {
  criteria: RefinedCriterion[];
  costUsd: number;
}

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
  /** Story title — anchors the refiner to the correct subject function/entity */
  storyTitle?: string;
  /** Story description — additional context so the refiner avoids guessing function names */
  storyDescription?: string;
  /** AgentManager for completeWithFallback — when provided, replaces direct adapter.complete() */
  agentManager?: IAgentManager;
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
  /** AgentManager for completeWithFallback — when provided, replaces direct adapter.complete() */
  agentManager?: IAgentManager;
  /** Target language for test generation (e.g. 'go', 'python', 'rust') — defaults to TypeScript */
  language?: string;
  /** Implementation context — files to include in the prompt so the generator writes tests against the real API */
  implementationContext?: Array<{ path: string; content: string }>;
  /** Previous failure message — included in prompt to help generator avoid the same mistake */
  previousFailure?: string;
  /** Override the target test file path in the generator prompt — used by hardening pass for suggested test files */
  targetTestFile?: string;
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
  /** LLM cost for this generation call in USD (0 when not available) */
  costUsd?: number;
}

/**
 * Persisted semantic review verdict for a story.
 * Written to <featureDir>/semantic-verdicts/<storyId>.json by completion.ts
 * and loaded by the acceptance loop.
 */
export interface SemanticVerdict {
  /** Story ID this verdict belongs to */
  storyId: string;
  /** Whether the semantic review passed */
  passed: boolean;
  /** ISO timestamp when the verdict was recorded */
  timestamp: string;
  /** Number of acceptance criteria in scope at review time */
  acCount: number;
  /** Structured findings from the semantic check (empty when passed) */
  findings: import("../plugins/types").ReviewFinding[];
}

/** Diagnosis result from acceptance test failure analysis (US-001) */
export interface DiagnosisResult {
  /** Verdict of the diagnosis */
  verdict: "source_bug" | "test_bug" | "both";
  /** Reasoning behind the verdict */
  reasoning: string;
  /** Confidence score between 0 and 1 */
  confidence: number;
  /** Issues found in the test (optional) */
  testIssues?: string[];
  /** Issues found in the source code (optional) */
  sourceIssues?: string[];
  /** LLM cost incurred for the diagnosis agent session */
  cost?: number;
}
