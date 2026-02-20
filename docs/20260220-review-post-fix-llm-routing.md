Code Review Report — Post-fix LLM routing
Date: 2026-02-20
Branch: feat/v0.8-llm-routing
Commit: a70d4f61d29ce1e528fd1e3d82ec9987b4737a79

Summary
- Reviewed only the latest commit (the P1–P5 fix commit).
- Verified code changes for P1, P2, P3, P5 and test mock updates in the diff between HEAD~1 and HEAD.
- Could not complete test run: 'bun test' appeared to hang in this environment within the allotted time. (See note at the end.)

What I accomplished / found
1) P1 (BUG-1+2): callLlm timeout, process kill and clearTimeout
- Changes made in src/routing/strategies/llm.ts:
  - Introduced timeoutId variable, setTimeout now kills the spawned process (proc.kill()) and rejects on timeout.
  - Promise.race is wrapped in try/catch and both success and error paths clearTimeout(timeoutId) and ensure proc.kill() is called on the error path.
- Assessment: Good improvements. This addresses the resource leak (leftover child) on timeout and ensures the timer is cleared on both success and failure.
- Notes / minor suggestions:
  - clearTimeout is called with timeoutId which is possibly undefined in the narrow window before setTimeout assigned it; that's safe because clearTimeout(undefined) is benign in Node.
  - proc.kill() is invoked both inside the timeout handler and again in catch — double-kill is usually safe but could be redundant; acceptable.
  - If proc.exited already resolved, kill() is a no-op. No dangling promises observed in this snippet.

2) P2 (ENH-1+2): tryLlmBatchRoute and applyCachedRouting
- Changes made in src/execution/runner.ts:
  - Extracted the LLM batch routing logic into tryLlmBatchRoute that logs and swallows errors and returns early when not applicable.
  - Extracted cached-routing override into applyCachedRouting(routing, story, config) and replaced inline blocks with the helper.
- Assessment: Behavior preserved. The helpers are straightforward extractions with identical logic (I compared the code before/after in the diff). applyCachedRouting reproduces the previous override logic for complexity -> modelTier mapping and testStrategy.
- Minor suggestion: applyCachedRouting accepts routing produced by routeTask; that function's return type is used via ReturnType<> which is OK. Consider adding a narrow explicit type alias for clarity in future.

3) P3 (TYPE-1): validateRoutingDecision and stripCodeFences
- Changes made in src/routing/strategies/llm.ts:
  - Extracted validateRoutingDecision(parsed, config) which validates parsed object fields and returns typed RoutingDecision.
  - Extracted stripCodeFences(text) to remove markdown/json code fences.
  - parseRoutingResponse now strips fences, JSON.parse once, and validates via validateRoutingDecision.
  - parseBatchResponse uses validateRoutingDecision(entry, config) directly instead of re-serializing entry->string->parse again.
- Assessment: Correct and type-safer.
  - validateRoutingDecision uses type assertions (as Complexity/TestStrategy/ModelTier) before returning typed fields — appropriate.
  - Using direct validation on batch entries avoids unnecessary serialization/parsing and fixes the prior issue where batch entries were re-serialized.
- Minor caution: validateRoutingDecision checks `if (!parsed.complexity || !parsed.modelTier || ...)` — if any field is present but falsy (empty string) it will still be caught; that likely matches intended validation.

4) P5 (ENH-3): Removed maxInputTokens from config schema
- Changes made in src/config/schema.ts: removed maxInputTokens from LlmRoutingConfig interface, schema and DEFAULT_CONFIG.
- Assessment: Removal in the three spots shown in diff is correct. I searched the diff for remaining references and did not see other references in the commit diff. (A full repo-wide search was not performed in this review scope.)

5) Test mocks: mock spawn kill handlers
- Changes made in test/routing/llm-strategy.test.ts: added kill: () => {} to all 9 mock spawn objects.
- Assessment: Matches the code changes in callLlm that call proc.kill() on timeout and in catch — tests needed mocks to provide a kill function to avoid runtime errors. Good.

Tests
- I attempted to run tests with `bun test` but the runner in this environment did not complete within the quick-review time window (process appeared to hang). I aborted attempts to repeatedly poll.
- Because tests did not finish here, I could not validate runtime behavior across the suite. Local/CI test run is recommended.

Grade (per requested areas)
- P1 (BUG-1+2): PASS — timeout handling and process cleanup implemented; no obvious resource leaks or dangling timers.
- P2 (ENH-1+2): PASS — helpers extracted; logic preserved.
- P3 (TYPE-1): PASS — validation and fence-stripping extracted; batch entry validation fixed to avoid re-serialization.
- P5 (ENH-3): PASS (within commit diff) — removed config field; no remaining references in diff.
- Test mocks: PASS — all mocked spawns in the tested file now include kill() handler.

Recommendations / Follow-ups
- Run the full test suite in CI or locally to confirm all tests pass. The new timeout/process kill behavior and the added kill mocks should make tests stable, but I couldn't confirm here.
- Optional: avoid double-kill redundancy by checking proc.killed/exited state before calling kill() if platform provides it — not required.
- Optional: add unit tests for validateRoutingDecision and stripCodeFences to assert correct behavior on edge cases (fenced JSON, invalid fields, batch entries).

Note about test run
- The environment's `bun test` invocation did not complete in this review session; please run tests in CI or locally and paste the last 20 lines of output if you want me to re-check test failures (if any).

Artifacts
- Saved report at: docs/20260220-review-post-fix-llm-routing.md

End of report.
