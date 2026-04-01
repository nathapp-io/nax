# SPEC: Two-Phase Acceptance Fix Strategy

## Summary

Replace the current full-TDD-pipeline approach for acceptance fix stories with a two-phase diagnose-then-fix strategy. A cheap diagnosis LLM call determines whether the failure is a source bug, test bug, or both, then routes to the appropriate single-session fix strategy. Configurable model tiers for both phases.

## Motivation

When acceptance tests fail, nax currently generates fix stories (`US-FIX-*`) and routes them through the full pipeline (routing → test-writer → implementer → verifier). This has three problems:

1. **Overkill**: Fix stories already have failing tests as context. Running a test-writer session is redundant — the tests exist. bench-04 burned **$38.28** on a 3-session TDD fix when a single session would suffice.

2. **Assumes tests are always correct**: `convertFixStoryToUserStory()` hardcodes "Do NOT modify the test file." But generated acceptance tests can have bugs (bench-04: `makeTask` helper dropped `status` argument → all status-filter ACs failed).

3. **No diagnosis**: The pipeline blindly tries to fix source code without checking if the test itself is wrong. When the test IS wrong, the agent wastes budget trying to make correct code match broken assertions.

## Design

### Configuration

Add `fix` section to `acceptance` config in `src/config/schema.ts`:

```typescript
interface AcceptanceFixConfig {
  /** Model tier for diagnosis call. Resolved via resolveModelForAgent(). Default: "fast" */
  diagnoseModel: string;
  /** Model tier for fix implementation. Resolved via resolveModelForAgent(). Default: "balanced" */
  fixModel: string;
  /** Fix strategy. Default: "diagnose-first" */
  strategy: "diagnose-first" | "implement-only";
  /** Max retries for fix stories. Default: 2 */
  maxRetries: number;
}
```

Config JSON:
```json
{
  "acceptance": {
    "fix": {
      "diagnoseModel": "fast",
      "fixModel": "balanced",
      "strategy": "diagnose-first",
      "maxRetries": 2
    }
  }
}
```

Model resolution follows the same pattern as `debate.synthesisModel` — tier names resolved via `resolveModelForAgent()`.

### Phase 1: Diagnose (`src/acceptance/fix-diagnosis.ts`)

Full agent session using `diagnoseModel` tier via `adapter.run()` — NOT `complete()`. The diagnosis must run as a proper ACP session so it gets correct session naming, protocol handling, cost tracking, and fallback chain support.

Session naming: `nax-<hash>-<feature>-<storyId>-diagnose` (via `buildSessionName()` with `sessionRole: "diagnose"`).

Input (passed as prompt to the agent session):
- Failing test output (truncated to 2000 chars)
- Acceptance test file content
- Source files imported by the test (auto-detected from import statements)
- Instruction to output a JSON verdict

Output schema (parsed from agent session output):
```typescript
interface DiagnosisResult {
  verdict: "source_bug" | "test_bug" | "both";
  reasoning: string;
  confidence: number; // 0.0-1.0
  testIssues?: string[]; // specific test bugs found (when verdict is test_bug or both)
  sourceIssues?: string[]; // specific source bugs found (when verdict is source_bug or both)
}
```

Diagnosis prompt instructs the agent to:
1. Read the failing test assertions and understand what they expect
2. Read the source code being tested
3. Determine if the test setup/assertions are correct
4. Determine if the source implementation matches the acceptance criteria
5. Output a JSON object matching `DiagnosisResult`

When `strategy: "implement-only"`, Phase 1 is skipped entirely — goes straight to source fix.

### Phase 2: Fix (based on verdict)

**`source_bug`** — Fix source code:
- Full agent session using `fixModel` tier via `adapter.run()`
- Session naming: `nax-<hash>-<feature>-<storyId>-source-fix` (via `sessionRole: "source-fix"`)
- Session receives: failing test output + test file + diagnosis reasoning
- When ACP protocol: runs as ACP session with correct session name
- When CLI protocol: runs as CLI session (same `run()` path, adapter handles protocol)
- Verify by running acceptance tests
- Instructions: "Fix the source implementation to pass the acceptance tests. Do NOT modify the test file."

**`test_bug`** — Regenerate acceptance test:
- Call existing `regenerateAcceptanceTest()` (already in `acceptance-loop.ts`)
- If regeneration succeeds, re-run acceptance validation
- If regeneration fails, escalate to manual intervention

**`both`** — Fix source first, then re-evaluate:
- Run source fix session first
- Re-run acceptance tests
- If still failing, regenerate the test
- If still failing after regeneration, escalate

### Integration Point

Replace the current `generateAndAddFixStories()` → `executeFixStory()` flow in `acceptance-loop.ts` with:

```
// Current flow (replace):
generateAndAddFixStories() → routeTask() → runPipeline(defaultPipeline)

// New flow:
diagnoseAcceptanceFailure() → based on verdict:
  source_bug  → executeSourceFix() → verify
  test_bug    → regenerateAcceptanceTest() → verify
  both        → executeSourceFix() → verify → if still failing → regenerate → verify
```

The fix session bypasses routing entirely — no `routeTask()` call. Instead, it uses `adapter.run()` directly with the correct `sessionRole` and model tier. The adapter handles protocol selection (ACP vs CLI) internally.

### Session Protocol Handling

Both diagnosis and fix sessions go through `adapter.run()`, which:
1. Resolves the agent via `createAgentRegistry(config)` — respects ACP/CLI protocol setting
2. Creates/resumes ACP session with correct name via `buildSessionName(workdir, feature, storyId, sessionRole)`
3. Registers session in the sidecar file for cleanup
4. Handles fallback chain, rate limits, and session errors

This ensures sessions appear correctly in `acpx list`, have proper cost attribution, and can be debugged.

### Fix Session Pipeline

The fix session uses `adapter.run()` directly — NOT the full pipeline. No test-writer, no review, no regression gate. The acceptance tests ARE the verification — run `bun test <acceptance-test-path>` after the fix session completes.

### Failure Handling

- Diagnosis session fails (timeout/error) → fall back to `"implement-only"` strategy (assume source bug)
- Low confidence diagnosis (<0.5) → log warning, proceed with verdict
- Fix session fails after `maxRetries` → escalate to manual intervention via `on-pause` hook
- `strategy: "implement-only"` → skip diagnosis entirely, always treat as source bug

## Stories

### US-001: Config schema and diagnosis types

Add `AcceptanceFixConfig` to config schema with defaults. Add `DiagnosisResult` interface. Wire into `NaxConfig.acceptance.fix`.

**Dependencies:** none

**Acceptance Criteria:**
- `NaxConfig.acceptance.fix` has type `AcceptanceFixConfig` with fields `diagnoseModel`, `fixModel`, `strategy`, `maxRetries`
- Default values: `diagnoseModel: "fast"`, `fixModel: "balanced"`, `strategy: "diagnose-first"`, `maxRetries: 2`
- `DiagnosisResult` interface exported from `src/acceptance/types.ts` with fields `verdict`, `reasoning`, `confidence`, `testIssues`, `sourceIssues`
- Config validation rejects unknown `strategy` values (only `"diagnose-first"` and `"implement-only"` allowed)

### US-002: Diagnosis session

Implement `diagnoseAcceptanceFailure()` in `src/acceptance/fix-diagnosis.ts`. Runs a full agent session via `adapter.run()` (not `complete()`) to diagnose whether the failure is a source bug, test bug, or both. Session runs under ACP protocol when configured, with correct session naming.

**Dependencies:** US-001

**Acceptance Criteria:**
- `diagnoseAcceptanceFailure()` calls `adapter.run()` (not `adapter.complete()`) with `sessionRole: "diagnose"`
- Session name follows pattern `nax-<hash>-<feature>-<storyId>-diagnose` via `buildSessionName()`
- `diagnoseAcceptanceFailure()` resolves `diagnoseModel` tier via `resolveModelForAgent()` — never passes raw tier name to adapter
- When agent output contains valid JSON matching `DiagnosisResult` schema, function returns parsed result
- When agent output is invalid/unparsable, function returns `{ verdict: "source_bug", reasoning: "diagnosis failed", confidence: 0 }`
- `diagnoseAcceptanceFailure()` auto-detects source file paths from test file `import` statements and reads their content (up to 5 files, 500 lines each)
- When `strategy` is `"implement-only"`, `diagnoseAcceptanceFailure()` is not called (caller skips it)
- When `config.agent.protocol` is `"acp"`, the session runs as a proper ACP session (visible in `acpx list`)

### US-003: Source fix session

Implement `executeSourceFix()` — full agent session via `adapter.run()` that fixes source code, verified against existing acceptance tests. Bypasses routing/pipeline — runs the agent directly.

**Dependencies:** US-001

**Acceptance Criteria:**
- `executeSourceFix()` calls `adapter.run()` (not `complete()`) with `sessionRole: "source-fix"`
- Session name follows pattern `nax-<hash>-<feature>-<storyId>-source-fix` via `buildSessionName()`
- `executeSourceFix()` resolves `fixModel` tier via `resolveModelForAgent()`
- Fix session prompt includes: failing test output, test file path, diagnosis reasoning (if available), and instruction to fix source only
- `executeSourceFix()` does NOT use the pipeline — calls `adapter.run()` directly, then verifies by running `bun test <acceptance-test-path>`
- Verification runs `bun test <acceptance-test-path>` — passes when all acceptance tests pass
- `executeSourceFix()` returns `{ success: boolean, cost: number }` with cost from `AgentResult`
- When `config.agent.protocol` is `"acp"`, the session runs as a proper ACP session with correct session name

### US-004: Wire into acceptance-loop

Replace current `generateAndAddFixStories()` + full pipeline flow with diagnosis → fix routing in `acceptance-loop.ts`.

**Dependencies:** US-002, US-003

**Acceptance Criteria:**
- When `strategy` is `"diagnose-first"` and verdict is `"source_bug"`, `acceptance-loop.ts` calls `executeSourceFix()` (not `generateAndAddFixStories`)
- When `strategy` is `"diagnose-first"` and verdict is `"test_bug"`, `acceptance-loop.ts` calls `regenerateAcceptanceTest()` then re-runs acceptance validation
- When `strategy` is `"diagnose-first"` and verdict is `"both"`, `acceptance-loop.ts` calls `executeSourceFix()` first, then if still failing calls `regenerateAcceptanceTest()`
- When `strategy` is `"implement-only"`, `acceptance-loop.ts` skips diagnosis and calls `executeSourceFix()` directly
- Fix retries respect `acceptance.fix.maxRetries` (not `acceptance.maxRetries`)
- JSONL events emitted: `acceptance.diagnosis` (with verdict, confidence), `acceptance.source-fix` (with cost), `acceptance.test-regen` (with outcome)
- Existing `generateAndAddFixStories()` codepath is preserved behind a feature flag or removed (if fully replaced)
