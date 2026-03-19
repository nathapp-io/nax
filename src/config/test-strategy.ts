/**
 * Test Strategy — Single Source of Truth
 *
 * Defines all valid test strategies, the normalizer, and shared prompt
 * fragments used by plan.ts and claude-decompose.ts.
 */

import type { TestStrategy } from "./schema-types";

// ─── Re-export type ───────────────────────────────────────────────────────────

export type { TestStrategy };

// ─── Valid values ─────────────────────────────────────────────────────────────

export const VALID_TEST_STRATEGIES: readonly TestStrategy[] = [
  "test-after",
  "tdd-simple",
  "three-session-tdd",
  "three-session-tdd-lite",
];

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Validate and normalize a test strategy string.
 * Returns a valid TestStrategy or falls back to "test-after".
 */
export function resolveTestStrategy(raw: string | undefined): TestStrategy {
  if (!raw) return "test-after";
  if (VALID_TEST_STRATEGIES.includes(raw as TestStrategy)) return raw as TestStrategy;
  // Map legacy/typo values
  if (raw === "tdd") return "tdd-simple";
  if (raw === "three-session") return "three-session-tdd";
  if (raw === "tdd-lite") return "three-session-tdd-lite";
  return "test-after"; // safe fallback
}

// ─── Prompt fragments (shared by plan.ts and claude-decompose.ts) ────────────

export const COMPLEXITY_GUIDE = `## Complexity Classification Guide

- simple: ≤50 LOC, single-file change, purely additive, no new dependencies → tdd-simple
- medium: 50–200 LOC, 2–5 files, standard patterns, clear requirements → three-session-tdd-lite
- complex: 200–500 LOC, multiple modules, new abstractions or integrations → three-session-tdd
- expert: 500+ LOC, architectural changes, cross-cutting concerns, high risk → three-session-tdd

### Security Override

Security-critical functions (authentication, cryptography, tokens, sessions, credentials,
password hashing, access control) must use three-session-tdd regardless of complexity.`;

export const TEST_STRATEGY_GUIDE = `## Test Strategy Guide

- tdd-simple: Simple stories (≤50 LOC). Write failing tests first, then implement to pass them — all in one session.
- three-session-tdd-lite: Medium stories, or complex stories involving UI/CLI/integration. 3 sessions: (1) test-writer writes failing tests and may create minimal src/ stubs for imports, (2) implementer makes tests pass and may replace stubs, (3) verifier confirms correctness.
- three-session-tdd: Complex/expert stories or security-critical code. 3 sessions with strict isolation: (1) test-writer writes failing tests — no src/ changes allowed, (2) implementer makes them pass without modifying test files, (3) verifier confirms correctness.
- test-after: Only when explicitly configured (tddStrategy: "off"). Write tests after implementation. Not auto-assigned.`;

export const GROUPING_RULES = `## Story Rules

- Every story must produce code changes verifiable by tests or review.
- NEVER create stories for analysis, planning, documentation, or migration plans.
  Your analysis belongs in the "analysis" field, not in a story.
- NEVER create stories whose primary purpose is writing tests, achieving coverage
  targets, or running validation/regression suites. Each story's testStrategy
  handles test creation as part of implementation. Testing is a built-in pipeline
  stage, not a user story. No exceptions.
- Combine small, related tasks into a single "simple" or "medium" story.
  Do NOT create separate stories for every single file or function unless complex.
- Aim for coherent units of value. Maximum recommended stories: 10-15 per feature.`;
