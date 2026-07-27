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

// ─── Classification predicates (SSOT) ────────────────────────────────────────

/**
 * Strategies that use the three-session TDD orchestration: a separate
 * test-writer, implementer, and verifier session, with a full-suite gate
 * between implementer and verifier. These are the only strategies that assemble
 * the `autofix-test-writer` rectification strategy.
 */
export const THREE_SESSION_STRATEGIES: ReadonlySet<TestStrategy> = new Set([
  "three-session-tdd",
  "three-session-tdd-lite",
]);

/**
 * Single-session strategies in which ONE agent writes both the tests and the
 * implementation in the same session. The implementer authored its own tests
 * and therefore MAY edit them during rectification (permit-with-guard) — unlike
 * three-session TDD where the "do not modify test files" rule is absolute.
 *
 * `no-test` is excluded: it produces no tests, so there is nothing to own or edit.
 */
export const SINGLE_SESSION_TEST_OWNING_STRATEGIES: ReadonlySet<TestStrategy> = new Set(["tdd-simple", "test-after"]);

/** True for strategies that run the three-session TDD orchestration. */
export function isThreeSessionStrategy(strategy: TestStrategy | undefined): boolean {
  return strategy !== undefined && THREE_SESSION_STRATEGIES.has(strategy);
}

/**
 * True when the strategy makes the implementer the author of its own tests
 * (single-session, test-owning), so it may edit test files to resolve genuine
 * AC/spec contradictions during rectification. False for `no-test` and all
 * three-session strategies.
 */
export function isSingleSessionTestOwningStrategy(strategy: TestStrategy | undefined): boolean {
  return strategy !== undefined && SINGLE_SESSION_TEST_OWNING_STRATEGIES.has(strategy);
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

| Complexity | Default Strategy         | Override when                                        |
|------------|--------------------------|------------------------------------------------------|
| simple     | tdd-simple               | three-session-tdd if security-critical (see below)   |
| medium     | tdd-simple               | three-session-tdd if security-critical (see below)   |
| complex    | three-session-tdd-lite   | three-session-tdd if security-critical (see below)   |
| expert     | three-session-tdd        | —                                                    |

**Security override (applies to ALL complexity levels):** If a story involves authentication,
access control, role checks, credentials, tokens, sessions, cryptography, or password hashing,
set testStrategy to three-session-tdd regardless of the default strategy for that complexity level.
This ensures strict test-implementation isolation for security-critical code paths.

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
  **Examples:** ADMIN-guarded endpoints, JWT validation, RBAC enforcement, password reset flows.
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

1. **Preserve spec ACs.** Every acceptance criterion stated in the spec must appear in \`acceptanceCriteria\`. Never silently drop a spec AC. ACs may be lightly rephrased for testability, but must retain the same assertion and concrete identifiers. An AC carrying a deprecated \`[grep]\`/\`[file]\`/\`[verbatim]\` tag describes a file-content check rather than a runtime behaviour: rewrite it as the behaviour that check was meant to prove, and drop the tag.
2. **Do not invent spec ACs.** If you identify useful behavioral edge cases or negative paths that the spec did not explicitly list, place them in \`suggestedCriteria\` (a string array on the same story object) — never in \`acceptanceCriteria\`. These go through a separate hardening pass.
3. **Respect story scope.** Each story's criteria must only cover what the spec says for that story. Do not assign criteria that belong to a different story's scope (wrong feature area, wrong file, wrong dependency chain).
4. **\`suggestedCriteria\` format.** Each element must be a plain behavioral assertion — an observable output, return value, state change, or error condition that a test can assert. Never include implementation details (imports, internal structure), design suggestions, or vague descriptions.
5. **Enumerate failure-mode tables.** If the spec contains a "Failure handling", "Error handling", "Failure modes", or equivalent table/section enumerating error/exception scenarios, every row MUST produce at least one acceptance criterion in the matching story. Walk the table row by row; do not skip rows because they look minor. A failure-mode row without an AC is treated as a missing AC and will cause rejection.
6. **Preserve the spec's out-of-scope statements.** If the spec has an "Out of Scope", "Non-Goals", or "Not in scope" section — or an inline \`**Out of scope …:**\` lead-in — copy every item **verbatim** into the top-level \`outOfScope\` string array. This is what the feature deliberately does NOT do; it is the only channel by which a deferred arc reaches the implementer, which never sees the spec. Never drop an item, never merge two into one, and never turn one into an acceptance criterion. Echo an item into a story's \`**Scope** — Out:\` bullet as well whenever that story sits close enough to the boundary that an implementer might stray across it. Omit \`outOfScope\` only when the spec declares nothing.
7. **Resolve internal spec contradictions toward the AC.** If the spec's prose, design table, or interface block contradicts a stated acceptance criterion (e.g. design table says \`lookback or strategy_lookback\` but the AC says \`lookback=None\`), the AC is authoritative. Implement the AC; do NOT echo the contradicting prose into the description.`;

export const DESCRIPTION_QUALITY_RULES = `## Description Quality Rules

When a spec contains a design subsection for a story (e.g. \`### N. <Topic>\` under \`## Design\`), the story description MUST embed that subsection's interface declarations, algorithms, and design notes verbatim.

### Format

\`\`\`
**Goal** — 1 sentence: what this story changes
**Motivation** — 1 sentence from spec's Motivation section: why this matters
**Approach** — verbatim from spec's design subsection
**Scope** — In: ... Out: ...
**Interface** — verbatim TypeScript (or language-appropriate) signatures from the spec
\`\`\`

### Rules

1. Do NOT paraphrase spec design sections — embed them verbatim.
1a. \`**Scope** — Out:\` states *inter-story* boundaries — work that belongs to a different story in this PRD. Feature-level exclusions (what the whole feature defers) belong in the top-level \`outOfScope\` array, not here. List an item in both places when this story sits close enough to a feature-level boundary that an implementer might stray across it.
2. A one-sentence description is almost always too short for implementation stories that have spec design content.
3. The implementer receives only this description — no access to the spec. Design decisions lost here are permanently invisible to the implementer.
4. **Self-check before emitting.** After drafting each description, re-read it against the story's \`acceptanceCriteria\`. If any sentence in the description contradicts an AC (e.g. description says behaviour X, AC says behaviour not-X), the description is wrong — rewrite the offending sentence to match the AC, or delete it. The AC is authoritative. Embedding contradicting spec prose verbatim still counts as a contradiction; resolve it.

### Examples

BAD (do NOT write this):
\`\`\`json
"description": "Replace full re-import with incremental diff-and-apply against durable tables."
\`\`\`
(One sentence — all design content dropped.)

GOOD (write descriptions like this):
\`\`\`json
"description": "**Goal** — Replace O(n) full re-import with incremental diff-and-apply against durable graph tables.\\n\\n**Motivation** — importGraphify() deletes all nodes then re-indexes everything in memory, causing timeouts at 500+ nodes.\\n\\n**Interface**\\n\\\`\\\`\\\`typescript\\nclass IncrementalGraphDiffService {\\n  async diffAndApply(projectId: string, newNodes: NodeDto[], newLinks: LinkDto[]): Promise<DiffResult>\\n  async getStoredGraph(projectId: string): Promise<StoredGraph>\\n}\\n\\\`\\\`\\\`\\n\\n**Approach** — 5-step diff: (1) load stored graph, (2) compute added/updated/removed sets, (3) delete removed nodes, (4) upsert changed nodes, (5) re-index only changed content."
\`\`\``;

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
