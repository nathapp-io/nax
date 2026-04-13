/**
 * Pure classification functions — no agent registry or heavy deps.
 *
 * Extracted from router.ts so test files can import classifyComplexity /
 * determineTestStrategy without pulling in createAgentRegistry → AcpAgentAdapter,
 * which registers background handles and prevents Bun from exiting after tests.
 */

import type { Complexity, TddStrategy, TestStrategy } from "../config";

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

const COMPLEX_KEYWORDS = [
  "refactor",
  "redesign",
  "architecture",
  "migration",
  "breaking change",
  "public api",
  "security",
  "auth",
  "encryption",
  "permission",
  "rbac",
  "casl",
  "jwt",
  "grpc",
  "microservice",
  "event-driven",
  "saga",
];

const EXPERT_KEYWORDS = [
  "cryptograph",
  "zero-knowledge",
  "distributed consensus",
  "real-time",
  "websocket",
  "streaming",
  "performance critical",
];

const SECURITY_KEYWORDS = [
  "auth",
  "security",
  "permission",
  "jwt",
  "oauth",
  "token",
  "encryption",
  "secret",
  "credential",
  "password",
  "rbac",
  "casl",
];

const PUBLIC_API_KEYWORDS = [
  "public api",
  "breaking change",
  "external",
  "consumer",
  "sdk",
  "npm publish",
  "release",
  "endpoint",
];


// ---------------------------------------------------------------------------
// Core classification functions
// ---------------------------------------------------------------------------

/**
 * Classify a story's complexity based on keywords.
 *
 * AC count is intentionally excluded — quantity is a poor proxy for complexity.
 * A story with 10 simple "add field" ACs is simpler than one with 3 ACs involving
 * concurrent state management. Complexity is determined by content, not quantity.
 *
 * BUG-031: description excluded — it accumulates priorErrors across retries and
 * causes classification drift. Only stable, immutable fields are used.
 *
 * #408: AC-count thresholds removed — keyword-only classification.
 * "medium" is no longer produced by keyword fallback; it comes from the plan LLM only.
 */
export function classifyComplexity(
  title: string,
  _description: string,
  acceptanceCriteria: string[],
  tags: string[] = [],
): Complexity {
  const text = [title, ...(acceptanceCriteria ?? []), ...(tags ?? [])].join(" ").toLowerCase();

  if (EXPERT_KEYWORDS.some((kw) => text.includes(kw))) return "expert";
  if (COMPLEX_KEYWORDS.some((kw) => text.includes(kw))) return "complex";
  return "simple";
}

/**
 * Determine test strategy using decision tree logic.
 *
 * When tddStrategy is provided:
 * - 'strict' → always three-session-tdd
 * - 'lite'   → always three-session-tdd-lite
 * - 'simple' → always tdd-simple
 * - 'off'    → always test-after
 * - 'auto'   → heuristic logic (default)
 *
 * #408: Updated thresholds — medium now routes to tdd-simple (was three-session-tdd-lite);
 * complex now routes to three-session-tdd-lite (was three-session-tdd).
 * Security/public-api override still forces three-session-tdd on any complexity.
 */
export function determineTestStrategy(
  complexity: Complexity,
  title: string,
  _description: string,
  tags: string[] = [],
  tddStrategy: TddStrategy = "auto",
): TestStrategy {
  if (tddStrategy === "strict") return "three-session-tdd";
  if (tddStrategy === "lite") return "three-session-tdd-lite";
  if (tddStrategy === "simple") return "tdd-simple";
  if (tddStrategy === "off") return "test-after";

  // auto mode: apply heuristics
  // BUG-031: exclude description — only use stable, immutable story fields
  const text = [title, ...(tags ?? [])].join(" ").toLowerCase();

  const isSecurityCritical = SECURITY_KEYWORDS.some((kw) => text.includes(kw));
  const isPublicApi = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  if (isSecurityCritical || isPublicApi) return "three-session-tdd";

  if (complexity === "expert") return "three-session-tdd";
  if (complexity === "complex") return "three-session-tdd-lite";

  // simple + medium → single-session TDD
  return "tdd-simple";
}
