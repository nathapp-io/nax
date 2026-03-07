# Trigger Completion — Spec

**Version:** v0.25.0
**Status:** Planned

---

## Problem

8 of 9 interaction trigger helpers (`checkCostExceeded`, `checkCostWarning`, `checkMaxRetries`, `checkSecurityReview`, `checkMergeConflict`, `checkPreMerge`, `checkStoryAmbiguity`, `checkReviewGate`) are implemented in `src/interaction/triggers.ts` and exported but **never called** from the pipeline.

Only `human-review` is wired (via `wireInteraction` subscriber on `human-review:requested` event).

Additionally, 3 hook events (`on-resume`, `on-session-end`, `on-error`) are defined in `HookEvent` but not wired to any pipeline event.

---

## Goal

Wire all 8 remaining triggers to the correct pipeline decision points. Add 3 missing hook events. Add E2E/integration test coverage for the Telegram and auto plugins.

---

## Stories

### TC-001: Wire `cost-exceeded` and `cost-warning` triggers

**Location:** `src/execution/sequential-executor.ts`

Currently at line 93, when `totalCost >= config.execution.costLimit`, the run exits with `"cost-limit"` — no interaction trigger is fired.

**Fix:**
- Before exiting on cost limit: call `checkCostExceeded({featureName, cost, limit}, config, interactionChain)`. If trigger returns `abort` or chain not available → exit as today. Pass `interactionChain` into `executeSequential` ctx (already present in `SequentialExecutionContext`).
- Add a `cost-warning` threshold check: when `totalCost >= costLimit * 0.8` (configurable via `interaction.triggers.cost-warning.threshold`, default 0.8), fire `checkCostWarning`. Fire only once per run (track with a boolean flag). Fallback: `continue`.
- Emit new `run:paused` event if trigger response is `escalate` (pause for human decision).
- Add `CostExceededEvent` and `CostWarningEvent` to `PipelineEventBus` (or reuse `run:paused` with a `reason` field — preferred, avoids new event types).

**Acceptance criteria:**
- When cost hits 80% of limit, `cost-warning` trigger fires once and run continues (default fallback)
- When cost hits 100% of limit, `cost-exceeded` trigger fires; abort kills the run, skip/continue allows proceeding past limit
- When no interaction plugin is configured, behavior is identical to today (no-op)
- Tests: unit test both thresholds with mock chain

---

### TC-002: Wire `max-retries` trigger

**Location:** `src/execution/sequential-executor.ts` or `src/pipeline/pipeline-result-handler.ts`

Currently when a story exhausts all tier escalations and is marked failed permanently (`markStoryFailed`), no trigger fires (except `human-review` which fires on `human-review:requested` event for a different condition).

**Fix:**
- In the story failure path (after all escalations exhausted), call `checkMaxRetries({featureName, storyId, iteration}, config, interactionChain)`.
- Response `skip` = proceed (today's behavior), `abort` = halt entire run, `escalate` = retry story from scratch at top tier.
- Wire via `story:failed` event in `wireInteraction` subscriber (add alongside `human-review:requested`).

**Acceptance criteria:**
- `max-retries` trigger fires when a story is permanently failed
- `abort` response halts the run with exit reason `"interaction-abort"`
- `skip` response is silent (today's behavior)
- Tests: unit test with mock chain for all three fallbacks

---

### TC-003: Wire `security-review`, `merge-conflict`, `pre-merge` triggers

**Location:** `src/pipeline/stages/review.ts` and `src/pipeline/stages/completion.ts` (post-story)

- **`security-review`**: Fire after plugin reviewer (e.g. semgrep) rejects a story in `review.ts`. Currently returns `{ action: "fail" }`. Before failing permanently, call `checkSecurityReview`. Response `abort` = fail (today), `escalate` = retry with security context injected.
- **`merge-conflict`**: Fire when git operations detect a merge conflict during story commit. Currently no merge-conflict detection exists — add detection in `src/execution/git.ts` (catch `CONFLICT` in git merge/rebase output) and call `checkMergeConflict`.
- **`pre-merge`**: Fire after all stories pass but before the run is marked complete. Call `checkPreMerge({featureName, totalStories, cost}, config, interactionChain)` in `sequential-executor.ts` final block. Response `abort` = halt, `continue` = complete normally.

**Acceptance criteria:**
- `security-review` trigger fires when plugin reviewer rejects (not when lint/typecheck fails)
- `merge-conflict` trigger fires when git detects CONFLICT markers
- `pre-merge` trigger fires once after all stories pass, before run:completed
- Tests: unit tests for each trigger point with mock chain

---

### TC-004: Wire `story-ambiguity` and `review-gate` triggers

**Location:** `src/pipeline/stages/execution.ts`

- **`story-ambiguity`**: Fire when agent session returns ambiguous/clarification-needed signal. Currently the agent exit codes and output are parsed in `execution.ts` — add a detection heuristic (e.g. agent output contains "unclear" / "ambiguous" / "need clarification" keywords, or a new `needsClarification` flag in agent result). Call `checkStoryAmbiguity` before escalating.
- **`review-gate`**: Fire after `story:completed` as a human checkpoint gate (configurable, disabled by default). Wire via new `review-gate:requested` event emitted in completion stage when `interaction.triggers.review-gate.enabled = true`.

**Acceptance criteria:**
- `story-ambiguity` trigger fires when agent signals ambiguity (keyword detection)
- `review-gate` trigger fires after each story passes when enabled
- Both default to disabled in config (opt-in)
- Tests: unit tests for ambiguity detection heuristic + trigger dispatch

---

### TC-005: Wire missing hook events (`on-resume`, `on-session-end`, `on-error`)

**Location:** `src/pipeline/subscribers/hooks.ts`

Three hook events are defined in `HookEvent` but never wired to pipeline events:

- **`on-resume`**: Fire when a paused run resumes. Add `run:resumed` event to `PipelineEventBus`, emit it in `sequential-executor.ts` when resuming from pause state. Wire in `wireHooks`.
- **`on-session-end`**: Fire when an individual agent session ends (pass or fail). Map to `story:completed` + `story:failed`. Wire in `wireHooks` on both events.
- **`on-error`**: Fire on unhandled errors / crash. Emit in `crash-recovery.ts` crash handler. Wire in `wireHooks`.

**Acceptance criteria:**
- `on-resume` hook fires when a paused run is continued
- `on-session-end` hook fires after every agent session (pass or fail)
- `on-error` hook fires in crash handler before exit
- Tests: extend existing `hooks.test.ts` with the three new events

---

### TC-006: Auto plugin integration tests

**Location:** `test/integration/interaction/`

The `AutoInteractionPlugin` (LLM-based) has zero test coverage. The Telegram and Webhook plugins have init/config tests but no send/receive flow tests.

**Fix:**
- `auto.test.ts` — mock the LLM call (`_deps` pattern), test: approve decision, reject decision, confidence below threshold falls back, `security-review` is never auto-approved.
- Extend `interaction-plugins.test.ts` with Telegram send flow (mock `fetch`, verify message format + inline keyboard structure).
- Extend with Webhook send flow (mock HTTP server, verify HMAC signature validation).

**Acceptance criteria:**
- Auto plugin: LLM approve/reject/confidence-fallback/security-review-block all covered
- Telegram: message send format and inline keyboard structure verified
- Webhook: HMAC verification tested (valid + tampered signatures)
- All tests are unit/mock — no real network calls

---

## Out of Scope

- Full E2E test with real Telegram bot (requires live credentials)
- New trigger types beyond the 9 already defined
- Interaction state persistence (pause/resume full flow) — separate feature

---

## Notes

- All trigger calls must be best-effort guarded: if `interactionChain` is null/undefined, skip silently (today's behavior)
- `interactionChain` is already threaded through `SequentialExecutionContext` — no new context changes needed for most stories
- Config `interaction.triggers.<name>.enabled` must be `true` for any trigger to fire (`isTriggerEnabled` handles this)
