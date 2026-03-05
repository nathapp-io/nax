/**
 * Acceptance Test Generation Types
 *
 * Types for generating acceptance tests from spec.md acceptance criteria.
 */

import type { ModelDef, ModelTier, NaxConfig } from "../config/schema";

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
