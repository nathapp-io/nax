# SPEC: Acceptance Test Scoping (BUG-083)

**Status:** Implemented  
**Priority:** High  
**Author:** Nax Dev  
**Date:** 2026-03-25  
**Depends on:** None (immediate fix) | QUALITY-002 Phase 3 (language-agnostic runner)

---

## Problem

The acceptance validation stage runs the project's full test suite (`quality.commands.test` / `bun test`) instead of only the acceptance test file. This means unrelated test failures cause the acceptance gate to fail with `"Tests errored with no AC failures parsed"`.

**Evidence (REVIEW-001 run, 2026-03-25):**
- 3/3 stories passed verification + review
- Acceptance ran `bun test` → 4517 tests → 14 failures (all in existing review runner tests, NOT acceptance tests)
- Exit code 1 → acceptance parser found no AC markers → `AC-ERROR`
- Acceptance retried twice, regenerated tests, same result
- The actual acceptance tests likely passed — but were drowned out by unrelated failures

## Root Cause

`src/acceptance/runner.ts` (or the acceptance stage) invokes the project-wide test command rather than targeting the acceptance test file at `.nax/features/<feature>/acceptance.test.ts`.

## Solution

### Phase 1: Immediate Fix (This Spec)

Run **only** the acceptance test file, not the full suite:

```
bun test .nax/features/<feature>/acceptance.test.ts --timeout=60000
```

The acceptance test is always a nax-generated `bun:test` TypeScript file, regardless of project language. It lives in the nax feature directory, not in the project's test tree. Therefore:

1. The acceptance runner should use `bun test <acceptance-file-path>` directly
2. This is independent of the project's `quality.commands.test` setting
3. The full suite is already covered by the regression gate — acceptance is a separate concern

#### Acceptance Runner Command Resolution

```
1. If acceptance.command is set in config → use it
2. Else → bun test <acceptance-file-path> --timeout=60000
```

The `acceptance.command` field does not exist today — add it as an optional escape hatch:

```typescript
// In AcceptanceConfig (src/config/runtime-types.ts)
export interface AcceptanceConfig {
  enabled: boolean;
  retries: number;
  // ... existing fields ...
  
  /** Override command to run acceptance tests. 
   *  Use {{FILE}} placeholder for the acceptance test file path.
   *  Default: "bun test {{FILE}} --timeout=60000" */
  command?: string;
}
```

#### Separation of Concerns

| Gate | What it runs | Purpose |
|:-----|:-------------|:--------|
| **Verification** (per-story) | Scoped tests matching story | Did the agent's code work? |
| **Regression** (deferred) | Full project test suite | Did we break anything? |
| **Acceptance** (post-run) | Only `acceptance.test.ts` | Did we build what was asked? |

These three gates answer different questions and must run different test sets.

### Phase 2: Language-Agnostic Runner (QUALITY-002)

When QUALITY-002 Phase 3 lands, acceptance tests may be generated in the project's language (Go, Rust, Python, etc.). At that point, the acceptance runner needs language-aware command resolution:

| Language | Test file | Command |
|:---------|:----------|:--------|
| TypeScript/JavaScript | `acceptance.test.ts` | `bun test {{FILE}} --timeout=60000` |
| Go | `acceptance_test.go` | `go test -v -run TestAcceptance -timeout 120s ./...` |
| Rust | `tests/acceptance.rs` | `cargo test --test acceptance -- --nocapture` |
| Python | `test_acceptance.py` | `pytest {{FILE}} -v --timeout=120` |

Resolution order:
1. `acceptance.command` explicit config → use verbatim (with `{{FILE}}` substitution)
2. Detected language from `ProjectProfile` → language-specific command table
3. Fallback → `bun test {{FILE}} --timeout=60000` (current behavior, made explicit)

#### Convention-Based Detection

The acceptance file extension determines the runner when no explicit config is set:

```typescript
function resolveAcceptanceCommand(filePath: string, profile?: ProjectProfile): string {
  // 1. Explicit config
  if (config.acceptance?.command) {
    return config.acceptance.command.replace("{{FILE}}", filePath);
  }
  
  // 2. Language-aware (Phase 2)
  if (profile?.language) {
    const cmd = ACCEPTANCE_RUNNERS[profile.language];
    if (cmd) return cmd.replace("{{FILE}}", filePath);
  }
  
  // 3. Extension-based fallback
  const ext = path.extname(filePath);
  switch (ext) {
    case ".ts":
    case ".js":
      return `bun test ${filePath} --timeout=60000`;
    case ".go":
      return `go test -v -run TestAcceptance -timeout 120s ${path.dirname(filePath)}/...`;
    case ".py":
      return `pytest ${filePath} -v --timeout=120`;
    case ".rs":
      return `cargo test --test ${path.basename(filePath, ".rs")} -- --nocapture`;
    default:
      return `bun test ${filePath} --timeout=60000`;
  }
}
```

This Phase 2 work is already tracked in QUALITY-002 (US-008: Language-appropriate acceptance tests). The spec here documents the design decision for when that story is implemented.

---

## User Stories

### US-001: Scope acceptance to feature test file only

**Complexity:** simple  
**Test strategy:** tdd-simple  
**Dependencies:** none  
**Context files:** `src/acceptance/runner.ts`, `src/pipeline/stages/acceptance.ts`, `src/config/runtime-types.ts`, `src/config/schemas.ts`, `src/config/defaults.ts`

**Acceptance Criteria:**

1. When acceptance tests run after all stories complete, the command executed is `bun test <path-to-acceptance.test.ts> --timeout=60000` where the path is the absolute path to `.nax/features/<feature>/acceptance.test.ts`
2. When the acceptance test file does not exist at the expected path, acceptance stage logs a warning and returns success with output containing 'no acceptance test file found'
3. When `acceptance.command` is set in config to a string containing `{{FILE}}`, the acceptance runner replaces `{{FILE}}` with the absolute acceptance test file path and executes the resulting command
4. When `acceptance.command` is set to a string without `{{FILE}}`, the acceptance runner executes the command verbatim (no substitution)
5. When the acceptance test file has 0 test cases (empty describe block), acceptance stage returns success with output containing 'no acceptance tests to run'
6. The project's `quality.commands.test` setting has no effect on which command the acceptance stage runs — acceptance always uses its own command resolution

---

## Out of Scope

- Language-aware acceptance test generation (QUALITY-002 US-008)
- Language-aware acceptance command resolution (QUALITY-002 US-008, Phase 2)
- Acceptance test quality improvements (separate concern)
- RED gate validation (already exists)

## Risk

**Low.** This is a scoping fix — the acceptance stage already runs and parses results. We're only changing WHICH tests it runs, not HOW it processes results.
