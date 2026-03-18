# Test Strategy Single Source of Truth — Spec

**Date:** 2026-03-16
**Branch:** `fix/test-strategy-ssot`
**Problem:** Plan prompt (`plan.ts`) and decompose prompt (`claude-decompose.ts`) define test strategies independently with different schemas — plan has 4 strategies, decompose has 2. No shared rules for security-complexity override or anti-test-story grouping.

---

## Goals

1. **Single source of truth** for test strategy definitions, complexity guides, and grouping rules
2. **Security-complexity override** — security-critical stories get minimum `medium` complexity
3. **Anti-standalone-test-story rule** — prevent LLM from creating dedicated test/coverage stories
4. **ARCHITECTURE.md §15** documenting the test strategy resolution pattern

---

## Design

### New file: `src/config/test-strategy.ts`

```typescript
// ─── Types ───────────────────────────────────────────────────────────────────

/** All valid test strategies. Single source of truth. */
export type TestStrategy = "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";

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
  return "test-after"; // safe fallback
}

// ─── Prompt fragments (shared by plan.ts and claude-decompose.ts) ────────

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

- test-after: Simple changes with well-understood behavior. Write tests after implementation in a single session.
- tdd-simple: Medium complexity. Write failing tests first, then implement to pass them — all in one session.
- three-session-tdd: Complex stories. 3 sessions: (1) test-writer writes failing tests — no src/ changes allowed, (2) implementer makes them pass without modifying test files, (3) verifier confirms correctness.
- three-session-tdd-lite: Expert/high-risk stories. 3 sessions: (1) test-writer writes failing tests and may create minimal src/ stubs for imports, (2) implementer makes tests pass and may add missing coverage or replace stubs, (3) verifier confirms correctness.`;

export const GROUPING_RULES = `## Grouping Rules

- Combine small, related tasks into a single "simple" or "medium" story.
- Do NOT create separate stories for every single file or function unless complex.
- Do NOT create standalone stories purely for test coverage or testing.
  Each story's testStrategy already handles testing (tdd-simple writes tests first,
  three-session-tdd uses separate test-writer session, test-after writes tests after).
  Only create a dedicated test story for unique integration/E2E test logic that spans
  multiple stories and cannot be covered by individual story test strategies.
- Aim for coherent units of value. Maximum recommended stories: 10-15 per feature.`;
```

### Changes to existing files

#### `src/cli/plan.ts` — `buildPlanningPrompt()`

Replace the inline complexity guide, test strategy guide, and grouping text with imports:

```typescript
import { COMPLEXITY_GUIDE, TEST_STRATEGY_GUIDE, GROUPING_RULES } from "../config/test-strategy";
```

In `buildPlanningPrompt()`, replace the three inline sections:
- Replace `## Complexity Classification Guide\n\n- simple: ...` block with `${COMPLEXITY_GUIDE}`
- Replace `## Test Strategy Guide\n\n- test-after: ...` block with `${TEST_STRATEGY_GUIDE}`
- Replace the grouping guidelines paragraph with `${GROUPING_RULES}`

The output schema's `testStrategy` field should reference the shared type:
```
"testStrategy": "test-after | tdd-simple | three-session-tdd | three-session-tdd-lite",
```
(This is already correct in the current plan prompt — just verify it matches.)

#### `src/agents/claude-decompose.ts` — `buildDecomposePrompt()`

Same treatment — replace inline strategy/complexity/grouping text with shared imports:

```typescript
import { COMPLEXITY_GUIDE, TEST_STRATEGY_GUIDE, GROUPING_RULES } from "../config/test-strategy";
```

Current decompose prompt only defines 2 strategies (`three-session-tdd`, `test-after`).
After this change it will have all 4, matching the plan prompt exactly.

Update the output schema in the prompt to include all 4 strategies:
```
12. testStrategy: "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite"
```

#### `src/pipeline/stages/routing.ts` (if applicable)

Check if routing.ts does its own test strategy validation. If so, replace with:
```typescript
import { resolveTestStrategy } from "../../config/test-strategy";
```

#### `src/prd/schema.ts` or `src/prd/index.ts` (PRD validation)

Check where `validatePlanOutput()` normalizes routing. If it validates testStrategy,
use `resolveTestStrategy()` to normalize unknown values instead of silently passing them through.

#### `docs/architecture/ARCHITECTURE.md` — Add §15

```markdown
## §15 Test Strategy Resolution

### Single Source of Truth

`src/config/test-strategy.ts` defines all valid test strategies, shared prompt fragments,
and the `resolveTestStrategy()` normalizer. This module is the ONLY place where test
strategy values, descriptions, and classification rules are defined.

### Available Strategies

| Strategy | Complexity | Description |
|:---------|:-----------|:------------|
| `test-after` | simple | Write tests after implementation |
| `tdd-simple` | medium | Write key tests first, then implement |
| `three-session-tdd` | complex | 3 sessions: test-writer (strict, no src/ changes) → implementer (no test changes) → verifier |
| `three-session-tdd-lite` | expert | 3 sessions: test-writer (lite, may add src/ stubs) → implementer (lite, may expand coverage) → verifier |

### Rules

1. **resolveTestStrategy()** normalizes unknown/legacy values to valid strategies
2. **Security override**: Security-critical stories → minimum "medium" / "tdd-simple"
3. **No standalone test stories**: Testing is handled per-story via testStrategy
4. Both `plan.ts` and `claude-decompose.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/cli/plan.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/agents/claude-decompose.ts` | Same prompt fragments |
| `src/pipeline/stages/routing.ts` | `resolveTestStrategy()` |
| `src/prd/schema.ts` | `resolveTestStrategy()` for PRD validation |
```

---

## Files Changed

| File | Change | Size |
|:-----|:-------|:-----|
| `src/config/test-strategy.ts` | **NEW** — types, resolver, prompt fragments | ~80 lines |
| `src/cli/plan.ts` | Import shared fragments, remove inline text | Small (replace ~30 lines) |
| `src/agents/claude-decompose.ts` | Import shared fragments, remove inline text, add 2 missing strategies | Small (replace ~20 lines) |
| `src/pipeline/stages/routing.ts` | Use `resolveTestStrategy()` if applicable | Small |
| `src/prd/schema.ts` | Use `resolveTestStrategy()` in validation | Small |
| `docs/architecture/ARCHITECTURE.md` | Add §15 | ~40 lines |

---

## Tests

- Unit test for `resolveTestStrategy()`: valid values, legacy mapping, unknown fallback
- Verify plan prompt contains all 4 strategies (snapshot or string match)
- Verify decompose prompt contains all 4 strategies
- Existing test suite must pass (no regressions)

---

## Rules

- Do NOT modify `docs/ROADMAP.md`
- Do NOT push to remote
- Commit each logical group with conventional commits
- Run `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail` for full suite
- Follow ARCHITECTURE.md patterns (`_deps` injection where needed)

---

*Author: nax-dev*
