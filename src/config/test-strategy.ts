/**
 * Test Strategy — Single Source of Truth
 *
 * Defines all valid test strategies, the normalizer, and shared prompt
 * fragments used by plan.ts and claude-decompose.ts.
 */

import type { ProjectProfile } from "./runtime-types";
import type { TestStrategy } from "./schema-types";

// ─── Re-export type ───────────────────────────────────────────────────────────

export type { TestStrategy };

// ─── Valid values ─────────────────────────────────────────────────────────────

export const VALID_TEST_STRATEGIES: readonly TestStrategy[] = [
  "no-test",
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
  if (raw === "none") return "no-test";
  if (raw === "tdd") return "tdd-simple";
  if (raw === "three-session") return "three-session-tdd";
  if (raw === "tdd-lite") return "three-session-tdd-lite";
  return "test-after"; // safe fallback
}

// ─── Prompt fragments (shared by plan.ts and claude-decompose.ts) ────────────

export const COMPLEXITY_GUIDE = `## Complexity Classification Guide

Classify each story's complexity based on scope and risk — NOT acceptance criteria count.
A story with 10 simple "add field" ACs is simpler than one with 3 ACs involving concurrent
state management. Classify by content, not quantity.

- simple: Single-file change, purely additive, no new dependencies, standard patterns
- medium: 2–5 files, standard patterns, clear requirements, no new abstractions
- complex: Multiple modules, new abstractions or integrations, cross-module dependencies
- expert: Architectural changes, cross-cutting concerns, high risk, novel patterns

### Security Override

Security-critical functions (authentication, cryptography, tokens, sessions, credentials,
password hashing, access control) must use three-session-tdd regardless of complexity.`;

export const TEST_STRATEGY_GUIDE = `## Test Strategy Guide

Assign testStrategy based on complexity and content:

| Complexity | Default Strategy         | Override when                          |
|------------|--------------------------|----------------------------------------|
| simple     | tdd-simple               | —                                      |
| medium     | tdd-simple               | —                                      |
| complex    | three-session-tdd-lite   | three-session-tdd if security-critical |
| expert     | three-session-tdd        | —                                      |

### Strategy descriptions

- no-test: Zero behavioral change — config files, documentation, CI/build changes, dependency bumps,
  pure structural refactors. REQUIRES noTestJustification field. If ANY runtime behavior changes,
  use tdd-simple or higher. When in doubt, use tdd-simple.
- tdd-simple: Write failing tests first, then implement to pass them — all in one session.
  Use for simple and medium complexity stories.
- three-session-tdd-lite: 3 sessions: (1) test-writer writes failing tests and may create minimal
  src/ stubs for imports, (2) implementer makes tests pass and may replace stubs, (3) verifier
  confirms correctness. Use for complex stories.
- three-session-tdd: 3 sessions with strict isolation: (1) test-writer writes failing tests —
  no src/ changes allowed, (2) implementer makes them pass without modifying test files,
  (3) verifier confirms correctness. Use for expert stories and security-critical code.
- test-after: Write implementation first, then tests. Use only when the story is exploratory
  or prototyping and strict TDD would be counterproductive.`;

export const AC_QUALITY_RULES = `## Acceptance Criteria Rules

Each acceptance criterion must be **behavioral and independently testable**.

### Format

Use one of:
- "[function/method] returns/throws/emits [specific value] when [condition]"
- "When [action], then [expected outcome]"
- "Given [precondition], when [action], then [result]"

### Rules

1. Each AC = exactly one testable assertion.
2. Use concrete identifiers: function names, return types, error messages, log levels, field values.
3. Specify HOW things connect (e.g. "logger forwards to the run's logger"), not just that they exist.
4. NEVER list quality gates as ACs — typecheck, lint, and build are run automatically by the pipeline.
5. NEVER use vague verbs: "works correctly", "handles properly", "is valid", "functions as expected".
6. NEVER write ACs about test coverage, test counts, or test file existence — testing is a pipeline stage.

### Examples

BAD (do NOT write these):
- "TypeScript strict mode compiles with no errors" → quality gate, not behavior
- "PostRunContext interface defined with all required fields" → existence check, not behavior
- "Function handles edge cases correctly" → vague, untestable
- "Tests pass" → meta-criterion about the pipeline, not the feature
- "bun run typecheck and bun run lint pass" → quality gate

GOOD (write ACs like these):
- "buildPostRunContext() returns PostRunContext where logger.info('msg') forwards to the run's logger with stage='post-run'"
- "getPostRunActions() returns empty array when no plugins provide 'post-run-action'"
- "validatePostRunAction() returns false and logs warning when postRunAction.execute is not a function"
- "cleanupRun() calls action.execute() only when action.shouldRun() resolves to true"
- "When action.execute() throws, cleanupRun() logs at warn level and continues to the next action"
- "resolveRouting() short-circuits and returns story.routing values when both complexity and testStrategy are already set"`;

const LANGUAGE_PATTERNS: Partial<Record<string, string>> = {
  go: `### Go-Specific AC Patterns

- "[function] returns (value, error) where error is [specific error type]"
- "[function] returns (nil, [ErrorType]) when [condition]"`,
  python: `### Python-Specific AC Patterns

- "[function] raises [ExceptionType] with message containing [text] when [condition]"
- "[function] returns [value] when [condition]"`,
  rust: `### Rust-Specific AC Patterns

- "[function] returns Result<[Ok type], [Err type]> where Err is [specific variant] when [condition]"
- "[function] returns Ok([value]) when [condition]"`,
};

const TYPE_PATTERNS: Partial<Record<string, string>> = {
  web: `### Web AC Patterns

- "When user clicks [element], component renders [expected output]"
- "When [event] occurs, component renders [expected state]"`,
  api: `### API AC Patterns

- "POST /[endpoint] with [body] returns [status code] and [response body]"
- "GET /[endpoint] with [params] returns [status code] and [response body]"`,
  cli: `### CLI AC Patterns

- "exit code is [0/1] and stdout contains [expected text] when [condition]"
- "[command] with [args] exits with code [0/1] and stderr contains [text]"`,
  tui: `### TUI AC Patterns

- "pressing [key] transitions state from [before] to [after]"
- "when [key] is pressed, screen renders [expected output]"`,
};

/**
 * Returns language- and project-type-aware AC quality rules.
 * When language or type are known, appends specific pattern examples.
 * Falls back to the default TypeScript rules for unknown/undefined inputs.
 */
export function getAcQualityRules(profile?: ProjectProfile): string {
  const langSection = profile?.language ? LANGUAGE_PATTERNS[profile.language] : undefined;
  const typeSection = profile?.type ? TYPE_PATTERNS[profile.type] : undefined;

  if (!langSection && !typeSection) return AC_QUALITY_RULES;

  const extras = [langSection, typeSection].filter(Boolean).join("\n\n");
  return `${AC_QUALITY_RULES}\n\n${extras}`;
}

/**
 * Spec fidelity rules — injected into buildPlanningPrompt() when a spec is provided.
 * Mirrors the synthesis anchor in session-plan.ts (debate mode) but for non-debate plan runs.
 */
export const SPEC_ANCHOR_RULES = `## Spec Fidelity Rules

When a spec is provided, these rules govern acceptance criteria generation:

1. **Preserve spec ACs.** Every acceptance criterion stated in the spec must appear in \`acceptanceCriteria\`, verbatim or lightly rephrased for testability. Never silently drop a spec AC.
2. **Do not invent spec ACs.** If you identify useful behavioral edge cases or negative paths that the spec did not explicitly list, place them in \`suggestedCriteria\` (a string array on the same story object) — never in \`acceptanceCriteria\`. These go through a separate hardening pass.
3. **Respect story scope.** Each story's criteria must only cover what the spec says for that story. Do not assign criteria that belong to a different story's scope (wrong feature area, wrong file, wrong dependency chain).
4. **\`suggestedCriteria\` format.** Each element must be a plain behavioral assertion — an observable output, return value, state change, or error condition that a test can assert. Never include implementation details (imports, internal structure), design suggestions, or vague descriptions.`;

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
