# SPEC: Acceptance Retry Loop Restructure

## Summary

Restructure the acceptance fix flow so the outer retry loop owns all retry logic. Replace the monolithic `runFixRouting()` with a single-attempt `applyFix()`. Replace full test regeneration with surgical `executeTestFix()`. Remove nested retry counters.

## Motivation

Bench-04 v0.60.0 revealed structural issues in the acceptance retry loop (see ADR-006):

1. The outer loop exits immediately when `runFixRouting` returns `{ fixed: false }` — `maxRetries: 2` effectively gives 1 attempt
2. `test_bug` gets single-shot treatment (regen once, inline re-test, done) while `source_bug` gets an inner retry loop
3. Full regen on `test_bug` throws away passing tests and often reproduces the same bugs
4. Two nested retry counters (`acceptance.maxRetries` + `acceptance.fix.maxRetries`) create confusing behavior
5. `runFixRouting` is monolithic — diagnoses, fixes, re-tests, and retries all in one function

## Design

### Restructured Flow

```
runAcceptanceLoop()                              [maxRetries: 3]
│
│ let stubRegenCount = 0
│ let previousFailure = ""
│
└─ while (retries < maxRetries)
    │
    ├─ 1. Run acceptance tests
    │   └─ PASS → done (+ hardening pass)
    │   └─ FAIL → collect {failedACs, testOutput}
    │
    ├─ 2. retries++
    │   └─ >= maxRetries? → give up (on-pause hook)
    │
    ├─ 3. Guard: isStubTestFile()?
    │   ├─ stubRegenCount >= 2 → exit ("generator cannot produce tests")
    │   └─ stubRegenCount++ → full regen → continue (back to step 1)
    │
    ├─ 4. Diagnose (fresh each iteration)
    │   ├─ Fast path: all semantic verdicts passed → verdict="test_bug"
    │   ├─ Fast path: >80% ACs fail → verdict="test_bug" (skip LLM call)
    │   ├─ diagnose-first: diagnoseAcceptanceFailure(previousFailure)
    │   └─ implement-only: skip diagnosis, assume source_bug
    │
    ├─ 5. applyFix(verdict, previousFailure)
    │   ├─ source_bug → executeSourceFix() (single attempt)
    │   ├─ test_bug  → executeTestFix() (surgical, single attempt)
    │   └─ both      → executeSourceFix() + executeTestFix()
    │
    ├─ 6. previousFailure += "Attempt N: verdict — reasoning"
    │
    └─ 7. continue (always — back to step 1)
```

### Key Properties

- **Outer loop always continues** — the only exit conditions are: acceptance passes, or `maxRetries` exhausted
- **Fresh diagnosis each iteration** — verdict can change (e.g. `test_bug` → `source_bug` after a regen)
- **`previousFailure` accumulates** — each iteration appends diagnosis reasoning + test output
- **No inline acceptance re-test** — `applyFix` applies fixes only, the outer loop re-tests
- **No inner retry loops** — `applyFix` does exactly one fix attempt per verdict

### `applyFix()` — replaces `runFixRouting()`

```typescript
async function applyFix(opts: {
  ctx: AcceptanceLoopContext;
  failures: { failedACs: string[]; testOutput: string };
  acceptanceContext: PipelineContext;
  diagnosis: DiagnosisResult;
  previousFailure?: string;
}): Promise<{ cost: number }>
```

Differences from `runFixRouting`:
- No `{ fixed: boolean }` return — the outer loop re-tests regardless
- No inner retry loop
- No inline acceptance execution
- Receives `diagnosis` as input (diagnosed by caller, not internally)
- Returns only cost for tracking

### `executeTestFix()` — replaces `regenerateAcceptanceTest()` for `test_bug`

New function in `src/acceptance/fix-executor.ts` (alongside existing `executeSourceFix`).

```typescript
export async function executeTestFix(
  agent: AgentAdapter,
  opts: {
    testOutput: string;
    testFileContent: string;
    failedACs: string[];
    diagnosis: DiagnosisResult;
    config: NaxConfig;
    workdir: string;
    featureName: string;
    storyId: string;
    acceptanceTestPath: string;
    previousFailure?: string;
  },
): Promise<{ success: boolean; cost: number }>
```

The agent session:
- Receives: test file content + failing AC output + diagnosis reasoning + previousFailure
- Instructions: "Fix ONLY the failing test assertions (AC-6, AC-7, AC-9). Do NOT modify passing tests. Do NOT modify source code."
- `sessionRole: "test-fix"`
- Model tier: `acceptance.fix.fixModel` (same as source fix)
- Verifies by running `bun test <acceptance-test-path>` after modifications
- Returns `{ success, cost }`

### Diagnosis Step (moved out of `applyFix`)

Diagnosis is now the caller's responsibility, not `applyFix`'s. This keeps `applyFix` as a pure "apply one fix" function.

```typescript
// In runAcceptanceLoop, before applyFix:
let diagnosis: DiagnosisResult;

if (semanticVerdicts.length > 0 && semanticVerdicts.every(v => v.passed)) {
  // Fast path: semantic review confirmed all ACs implemented
  diagnosis = { verdict: "test_bug", reasoning: "all semantic verdicts passed", confidence: 1.0 };
} else if (isTestLevelFailure(failures.failedACs, totalACs)) {
  // Fast path: >80% ACs fail — likely test-level issue
  diagnosis = { verdict: "test_bug", reasoning: `${failures.failedACs.length}/${totalACs} ACs failed`, confidence: 0.9 };
} else if (strategy === "implement-only") {
  diagnosis = { verdict: "source_bug", reasoning: "implement-only strategy", confidence: 1.0 };
} else {
  diagnosis = await diagnoseAcceptanceFailure(agent, { ...opts, previousFailure });
}
```

### Stub Guard

```typescript
let stubRegenCount = 0;
const MAX_STUB_REGENS = 2;

// Inside loop, before diagnosis:
if (isStubTestFile(testContent)) {
  if (stubRegenCount >= MAX_STUB_REGENS) {
    logger.error("acceptance", "Generator cannot produce real tests — giving up");
    return buildResult(false, ...);
  }
  stubRegenCount++;
  await regenerateAcceptanceTest(testPath, ctx);
  continue; // back to acceptance test
}
```

Full regen is used ONLY for stubs — there's no test code to fix surgically.

### Config Changes

```typescript
interface AcceptanceConfig {
  maxRetries: number;  // default: 3 (was 2)
  fix: {
    diagnoseModel: string;   // default: "fast"
    fixModel: string;        // default: "balanced"
    strategy: "diagnose-first" | "implement-only";
    /** @deprecated Ignored — outer loop controls retries via maxRetries */
    maxRetries?: number;
  };
}
```

- `acceptance.maxRetries` default increases from 2 → 3 (each iteration does one fix, not a nested retry)
- `acceptance.fix.maxRetries` deprecated — silently ignored

### `previousFailure` Accumulation

```typescript
let previousFailure = "";

// After each applyFix:
previousFailure += `\n---\nAttempt ${retries}/${maxRetries}: verdict=${diagnosis.verdict}, confidence=${diagnosis.confidence}\nReasoning: ${diagnosis.reasoning}\nFailed ACs: ${failures.failedACs.join(", ")}\n`;
```

Passed to:
- `diagnoseAcceptanceFailure()` — diagnosis sees what was tried before
- `executeSourceFix()` — source fixer knows what was already attempted
- `executeTestFix()` — test fixer knows which assertion patterns already failed

## Files to Change

| File | Change |
|------|--------|
| `src/execution/lifecycle/acceptance-loop.ts` | Restructure `runAcceptanceLoop`: stub guard with counter, diagnosis moved to loop body, `applyFix` replaces `runFixRouting`, always continue, previousFailure accumulation |
| `src/execution/lifecycle/acceptance-loop.ts` | `applyFix()` replaces `runFixRouting()`: single-attempt, no inner retry, no inline acceptance, receives diagnosis as input |
| `src/acceptance/fix-executor.ts` | Add `executeTestFix()` — surgical test fix via `agent.run()` with `sessionRole: "test-fix"` |
| `src/config/schemas.ts` | Change `acceptance.maxRetries` default from 2 → 3 |
| `test/unit/execution/lifecycle/acceptance-loop.test.ts` | Update tests for restructured loop + applyFix |
| `test/unit/acceptance/fix-executor.test.ts` | Add tests for `executeTestFix()` |

## Stories

### US-001: `executeTestFix()` — surgical test fix

Implement `executeTestFix()` in `src/acceptance/fix-executor.ts`. Runs an agent session that patches only failing test assertions in-place.

**Acceptance Criteria:**
- `executeTestFix()` calls `agent.run()` with `sessionRole: "test-fix"`
- Prompt includes: test file content, failing ACs list, test output, diagnosis reasoning, previousFailure
- Prompt instructs: "Fix ONLY the failing test assertions. Do NOT modify passing tests. Do NOT modify source code."
- Returns `{ success: boolean, cost: number }`
- Resolves model via `resolveModelForAgent()` with `fixModel` tier
- Uses `ctx.agentGetFn` for agent resolution (never bare `getAgent()`)

### US-002: Restructure `runAcceptanceLoop()`

Rewrite the outer loop to own all retry logic. Remove inner retry loops. Always continue after fix attempt.

**Acceptance Criteria:**
- Outer loop always continues after `applyFix()` — never exits early on fix failure
- `maxRetries` is the single retry budget (default: 3)
- `stubRegenCount` caps full regen at 2 attempts for stub tests
- Diagnosis runs fresh each iteration (not reused)
- `previousFailure` accumulates across iterations
- `test_bug` verdict can be retried on next iteration with fresh diagnosis
- `source_bug` verdict can be retried on next iteration with fresh diagnosis (verdict may change)

### US-003: `applyFix()` — replaces `runFixRouting()`

Single-attempt fix function that receives diagnosis and applies one fix.

**Acceptance Criteria:**
- `applyFix()` applies exactly one fix — no inner retry loop
- `applyFix()` does not run acceptance tests — returns after applying fix
- `source_bug` → calls `executeSourceFix()` once
- `test_bug` → calls `executeTestFix()` once
- `both` → calls `executeSourceFix()` then `executeTestFix()`
- Returns `{ cost: number }` (no `fixed` boolean — outer loop re-tests)
- `acceptance.fix.maxRetries` is ignored

### US-004: Absorb >80% heuristic into diagnosis step

Move `isTestLevelFailure()` check from a separate guard into the diagnosis step as a fast-path.

**Acceptance Criteria:**
- When >80% ACs fail, diagnosis returns `{ verdict: "test_bug" }` without an LLM call
- When all semantic verdicts passed, diagnosis returns `{ verdict: "test_bug" }` without an LLM call
- When `strategy: "implement-only"`, diagnosis returns `{ verdict: "source_bug" }` without an LLM call
- All three fast-paths skip the LLM diagnosis call and log the reason

### US-005: Config — maxRetries default change

**Acceptance Criteria:**
- `acceptance.maxRetries` default changes from 2 to 3
- `acceptance.fix.maxRetries` is accepted but ignored (backward compat, no validation error)
- Log a deprecation warning when `acceptance.fix.maxRetries` is explicitly set

### US-006: Remove dead code from acceptance-loop.ts

Clean up code made dead by the refactor.

**Acceptance Criteria:**
- `runFixRouting()` is deleted (replaced by `applyFix()`)
- `_acceptanceLoopDeps.executeTestRegen` is deleted (replaced by `executeTestFix()`)
- `isTestLevelFailure()` guard block removed from outer loop (logic moved to diagnosis fast-path)
- `isTestLevelFailure()` function kept (used by diagnosis fast-path)
- `grep -r "runFixRouting" src/` returns 0 matches
- `grep -r "executeTestRegen" src/` returns 0 matches
- No unused imports remain in `acceptance-loop.ts`
- All existing tests updated or removed to match
