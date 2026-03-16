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

- simple: ≤50 LOC, single-file change, purely additive, no new dependencies → test-after
- medium: 50–200 LOC, 2–5 files, standard patterns, clear requirements → tdd-simple
- complex: 200–500 LOC, multiple modules, new abstractions or integrations → three-session-tdd
- expert: 500+ LOC, architectural changes, cross-cutting concerns, high risk → three-session-tdd-lite

### Security Override

Security-critical functions (authentication, cryptography, tokens, sessions, credentials,
password hashing, access control) must be classified at MINIMUM "medium" complexity
regardless of LOC count. These require at minimum "tdd-simple" test strategy.`;

export const TEST_STRATEGY_GUIDE = `## Test Strategy Guide

- test-after: Simple changes with well-understood behavior. Write tests after implementation.
- tdd-simple: Medium complexity. Write key tests first, implement, then fill coverage.
- three-session-tdd: Complex stories. Full TDD cycle with separate test-writer and implementer sessions.
- three-session-tdd-lite: Expert/high-risk stories. Full TDD with additional verifier session.`;

export const GROUPING_RULES = `## Grouping Rules

- Combine small, related tasks into a single "simple" or "medium" story.
- Do NOT create separate stories for every single file or function unless complex.
- Do NOT create standalone stories purely for test coverage or testing.
  Each story's testStrategy already handles testing (tdd-simple writes tests first,
  three-session-tdd uses separate test-writer session, test-after writes tests after).
  Only create a dedicated test story for unique integration/E2E test logic that spans
  multiple stories and cannot be covered by individual story test strategies.
- Aim for coherent units of value. Maximum recommended stories: 10-15 per feature.`;
