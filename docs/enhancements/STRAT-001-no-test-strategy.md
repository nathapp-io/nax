# STRAT-001: Add `no-test` Strategy

**Status:** Draft  
**Component:** `src/config/test-strategy.ts`, `src/config/schema-types.ts`, `src/pipeline/stages/prompt.ts`, `src/pipeline/stages/execution.ts`, `src/pipeline/stages/verify.ts`, `src/pipeline/stages/routing.ts`, plan prompt, batch routing  
**Priority:** Medium

---

## Problem

Stories that don't require test changes (config updates, documentation, refactors with no behavioral change, CI/build config, dependency bumps) are forced through test-writing sessions. This wastes time and produces trivial or no-op tests.

Currently the closest option is `test-after` with `single-session` role, but it still prompts the agent to write tests. There's no way to say "this story genuinely needs no tests."

## Goal

Add a `no-test` strategy that:
1. Skips test-writing entirely (no RED/GREEN/REFACTOR cycle)
2. Still runs review and acceptance (quality isn't skipped, just test writing)
3. Requires justification at every decision point

---

## Design

### Strategy definition

```typescript
// src/config/schema-types.ts
export type TestStrategy = "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
```

`no-test` is intentionally listed first — it's the lightest strategy, not the default.

### Justification requirement

Every point that assigns or routes to `no-test` **must** include a justification explaining why tests aren't needed. This prevents lazy "skip tests" behavior.

#### a. Plan prompt (`test-strategy.ts`)

The plan LLM classifies stories. The prompt must teach it when `no-test` is valid:

```
COMPLEXITY_GUIDE addition:
- no-test: Config-only changes, documentation, CI/build files, dependency bumps, 
  pure refactors with NO behavioral change. MUST include noTestJustification explaining 
  why tests are unnecessary. If any user-facing behavior changes, use tdd-simple or higher.
```

The plan output schema adds:
```typescript
// In PRD story routing
{
  testStrategy: "no-test",
  noTestJustification: "Config-only change — updates tsconfig.json compiler options, no runtime behavior affected"
}
```

#### b. Batch routing (`src/execution/batching.ts`)

When grouping stories into batches, `no-test` stories should be batched separately from tested stories (they use a different prompt role):

```typescript
// batching.ts — isSimple check
const isNoTest = story.routing?.testStrategy === "no-test";
const isSimple = story.routing?.complexity === "simple" && story.routing?.testStrategy === "test-after";
// no-test stories can batch together but NOT with test-after/tdd stories
```

#### c. LLM routing (`src/decompose/`, `src/pipeline/stages/routing.ts`)

The LLM strategy layer (`determineTestStrategy()`) must include `no-test` in its classification options with the justification requirement:

```
TEST_STRATEGY_GUIDE addition:
- no-test: Stories with zero behavioral change — config files, documentation, CI/build 
  changes, dependency bumps, pure structural refactors. REQUIRES noTestJustification 
  field. If any runtime behavior changes, use tdd-simple or higher. When in doubt, 
  use tdd-simple.
```

### Pipeline behavior for `no-test`

| Stage | Behavior |
|:------|:---------|
| **routing** | Classifies as `no-test` + stores justification |
| **prompt** | Uses `single-session` role WITHOUT test instructions — implement only |
| **execution** | Single session, no TDD cycle |
| **verify** | Skips test execution (already handles `no test command` case) |
| **review** | Runs normally — code quality still matters |
| **rectify** | Runs if review finds issues |
| **acceptance** | Runs normally — end-to-end validation still applies |

### Prompt role for `no-test`

New prompt variant: `"no-test"` role in `PromptBuilder`:

```markdown
## Your Role
You are implementing a change that does NOT require test modifications.

## Task
{story.title}: {story.description}

## Acceptance Criteria
{story.acceptanceCriteria}

## Rules
- Implement the change as described
- Do NOT create or modify test files
- Justification for no tests: {noTestJustification}
- Commit with a descriptive message
```

### Greenfield override interaction

BUG-010 greenfield detection forces `test-after` when no test files exist. `no-test` should be **exempt** from this override — if a story genuinely needs no tests, lack of test files is irrelevant:

```typescript
// routing.ts greenfield check
if (greenfieldDetectionEnabled && routing.testStrategy.startsWith("three-session-tdd")) {
  // ... force test-after
}
// no-test is NOT overridden by greenfield detection
```

### Escalation interaction

Tier escalation (S5) currently switches to `test-after` on failure. `no-test` stories should NOT be escalated to a test strategy — if the story was correctly classified as no-test, adding tests won't help:

```typescript
// tier-escalation.ts
if (currentTestStrategy === "no-test") {
  // Skip test-after escalation — no-test means no tests needed
}
```

---

## Implementation Plan

### Phase 1: Core (all changes needed)

1. **`src/config/schema-types.ts`** — add `"no-test"` to `TestStrategy` union
2. **`src/config/test-strategy.ts`** — add to `VALID_TEST_STRATEGIES`, add to `COMPLEXITY_GUIDE` and `TEST_STRATEGY_GUIDE`, handle in resolver (aliases: `"none"` → `"no-test"`)
3. **`src/pipeline/types.ts`** — update `testStrategy` union
4. **`src/prd/types.ts`** — add optional `noTestJustification?: string` to story routing
5. **`src/prompts/types.ts`** — add `"no-test"` to `PromptRole`
6. **`src/prompts/sections/role-task.ts`** — add `no-test` role text
7. **`src/prompts/sections/isolation.ts`** — add `no-test` isolation rules (no test files)
8. **`src/prompts/sections/hermetic.ts`** — exclude `no-test` from hermetic rules
9. **`src/pipeline/stages/prompt.ts`** — handle `no-test` → use `no-test` role
10. **`src/pipeline/stages/execution.ts`** — handle `no-test` like `test-after` (single session)
11. **`src/pipeline/stages/routing.ts`** — exempt `no-test` from greenfield override
12. **`src/execution/escalation/tier-escalation.ts`** — exempt `no-test` from test-after escalation
13. **`src/execution/batching.ts`** — separate `no-test` stories from tested stories

### Phase 2: Validation

14. **Plan output validation** — reject `no-test` without `noTestJustification`
15. **Unit tests** for all new behavior

---

## Acceptance Criteria

- [ ] **AC-1:** `no-test` is a valid `TestStrategy` value
- [ ] **AC-2:** Plan prompt includes `no-test` in complexity/strategy guide with justification requirement
- [ ] **AC-3:** LLM routing includes `no-test` with justification requirement
- [ ] **AC-4:** Batch routing separates `no-test` stories from tested stories
- [ ] **AC-5:** `no-test` stories use a prompt that does NOT instruct test writing
- [ ] **AC-6:** `no-test` stories skip verify stage (no test execution)
- [ ] **AC-7:** `no-test` stories still run review and acceptance stages
- [ ] **AC-8:** `no-test` is exempt from greenfield override (BUG-010)
- [ ] **AC-9:** `no-test` is exempt from test-after escalation (S5)
- [ ] **AC-10:** Plan output rejects `no-test` without `noTestJustification` field
- [ ] **AC-11:** `noTestJustification` is stored in `story.routing` and visible in logs
- [ ] **AC-12:** All existing tests pass (no regressions)

---

## Examples

### Config-only story (valid `no-test`)
```json
{
  "id": "US-003",
  "title": "Update TypeScript strict mode settings",
  "description": "Enable strictNullChecks in tsconfig.json",
  "acceptanceCriteria": ["tsconfig.json has strictNullChecks: true"],
  "routing": {
    "complexity": "simple",
    "testStrategy": "no-test",
    "noTestJustification": "Config-only change — modifies tsconfig.json compiler options, no runtime code affected"
  }
}
```

### Documentation story (valid `no-test`)
```json
{
  "id": "US-007",
  "title": "Add API documentation for auth module",
  "description": "Write JSDoc comments for all exported functions in src/auth/",
  "acceptanceCriteria": ["All exported functions have JSDoc"],
  "routing": {
    "complexity": "simple",
    "testStrategy": "no-test",
    "noTestJustification": "Documentation-only change — adds JSDoc comments, no behavioral changes"
  }
}
```

### Invalid `no-test` (should be rejected)
```json
{
  "id": "US-005",
  "title": "Add password validation",
  "description": "Validate passwords are 8+ chars with special characters",
  "routing": {
    "testStrategy": "no-test"
    // REJECTED: missing noTestJustification, and this has behavioral changes
  }
}
```

---

*Created 2026-03-21.*
