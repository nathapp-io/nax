# Bugs Found: Dogfood Run C (2026-02-19, plan→analyze→run pipeline)

## BUG-16: maxIterations is global, not per-story (CODE)

**Severity:** High — causes infinite loops on stuck stories

**Evidence:** Config had `maxIterations: 5` but nax ran **20 iterations**.
The main loop at `runner.ts:140` checks `iterations < config.execution.maxIterations`,
but the config value was overridden. Investigation shows the dogfood config had `maxIterations: 5`
but per the summary the run did 20 iterations.

**Root Cause:** `maxIterations` is a **global** cap across ALL stories, not per-story.
But the real issue is that the per-story attempt counter (`story.attempts`) doesn't cap the
story — only the escalation logic reads it. If escalation doesn't trigger (see BUG-17),
the story retries indefinitely until the global iteration limit.

**Expected Behavior:** Each story should respect the tier budget:
- Per-story max attempts = sum of `tierOrder` attempts (default: 5+3+2=10)
- After exhausting all tiers, mark story as FAILED and move to next story
- `maxIterations` should be an override safety cap, not the primary limit

**Fix Location:** `src/execution/runner.ts` — add per-story attempt check before retrying

---

## BUG-17: ASSET_CHECK_FAILED doesn't trigger escalation (CODE)

**Severity:** High — story loops at same tier forever

**Evidence:** US-004 failed ASSET_CHECK 16 times, always at `balanced` tier.
Never escalated to `powerful` despite `countsTowardEscalation: true`.

**Root Cause:** The escalation logic lives in the `case "escalate"` handler
(`runner.ts:367`), but ASSET_CHECK failures flow through `post-verify.ts`
which only increments `story.attempts` and reverts to `pending`. It never
returns an `"escalate"` action to the runner — it just reverts the story.

The escalation check happens in runner.ts case "escalate" but the pipeline
never returns "escalate" for verification failures. The verify stage returns
"continue" (tests passed), then post-verify reverts on ASSET_CHECK but the
result is already "continue".

**Flow:**
```
1. Pipeline runs → verify stage → tests pass → "continue"
2. completion stage → marks story as passed
3. post-verify → ASSET_CHECK fails → reverts to pending, increments attempts
4. Runner sees "continue" from pipeline, never hits "escalate" case
5. Next iteration picks up story at SAME tier (no escalation)
```

**Expected Behavior:** When `story.attempts` exceeds the current tier's budget,
the runner should check tier escalation BEFORE starting the next iteration,
not only in the `"escalate"` case handler.

**Fix Location:** 
- `src/execution/runner.ts` — add tier check at start of iteration (before agent spawn)
- OR `src/execution/post-verify.ts` — escalate the story's `routing.modelTier` when attempts exceed tier budget

---

## BUG-18: ASSET_CHECK error not fed back to agent prompt (CODE)

**Severity:** Medium — agent repeats same mistake endlessly

**Evidence:** All 17 retries of US-004 show the exact same warnings:
```
⚠️  Relevant file not found: src/finder.ts (story: US-004)
⚠️  Relevant file not found: test/finder.test.ts (story: US-004)
```
The agent kept writing to `src/discovery.ts` instead of `src/finder.ts`.
The ASSET_CHECK error is stored in `story.priorErrors` (post-verify.ts line 102),
but the "Prior Errors" section in the prompt only showed the initial ASSET_CHECK
message, not a clear instruction like "You MUST create src/finder.ts".

**Expected Behavior:** The ASSET_CHECK error should be prominent in the prompt,
ideally as a mandatory instruction: "REQUIRED: Create these files: src/finder.ts, test/finder.test.ts"

**Fix Location:** `src/pipeline/stages/prompt.ts` — format ASSET_CHECK errors as mandatory file creation instructions

---

## BUG-19: Simple complexity routes to balanced tier, not fast (CODE)

**Severity:** Medium — wastes budget on wrong tier

**Evidence:** US-001 (simple) and US-004 (simple) both show:
```
Complexity: simple | Model: balanced | TDD: test-after
Routing: test-after: simple task (medium)
```
Should start at `fast` (Haiku) per `complexityRouting.simple: "fast"`.

**Root Cause:** The routing display shows `(medium)` suggesting the actual
routed tier is `medium`/`balanced`, not the expected `fast`. Likely the
routing stage is using test strategy routing instead of complexity routing,
or there's a fallback that overrides the tier.

**Fix Location:** `src/pipeline/stages/routing.ts` or equivalent — check why
simple stories get routed to balanced instead of fast.

---

## Test Coverage Gaps

### Existing (35 tests in runner.test.ts)
- ✅ Batch prompt building (3 tests)
- ✅ Batch grouping (8 tests)
- ✅ Batch precompute (5 tests)
- ✅ Batch failure escalation (3 tests)
- ✅ Queue commands (6 tests)
- ✅ Escalation chain (7 tests)
- ✅ Hook security/loading/env (19 tests in hooks.test.ts)

### Missing (needed to prevent BUG-16–19)
- ❌ **Per-story iteration capping** — story should fail after tier budget exhausted
- ❌ **ASSET_CHECK → escalation trigger** — post-verify failure should escalate tier
- ❌ **ASSET_CHECK error in prompt** — verify mandatory files appear in next prompt
- ❌ **Complexity → tier routing accuracy** — simple=fast, medium=balanced, complex=powerful
- ❌ **Post-verify revert + re-queue** — story reverted correctly after ASSET_CHECK
- ❌ **End-to-end: story passes on retry after escalation** — integration test
- ❌ **End-to-end: story fails permanently after all tiers exhausted** — integration test
- ❌ **Verification unit tests** — no `test/verification.test.ts` exists
- ❌ **Post-verify unit tests** — no `test/post-verify.test.ts` exists

---

*Filed 2026-02-19 from dogfood run C (plan→analyze→run pipeline test)*

## BUG-21: No model name validation before run (CONFIG)

**Severity:** Medium — causes silent failures, wasted retries

**Evidence:** Dogfood Run D — `claude-opus-4` not recognized by Claude Code CLI.
Agent exited with error message but exit code 0 on some attempts, exit code 1 on others.
TDD test-writer session ran 3 times producing nothing. Wasted ~$0.13 and 3 minutes.

**Root Cause:** No validation of model names in config against the agent's accepted models.
`claude-opus-4` is not a valid Claude Code model name (`claude-opus-4-5` or `opus` alias is).

**Expected Behavior:** Before starting a run, validate that all configured model names
are accepted by the target agent. Fail fast with a clear error message.

**Future Design:** When supporting multiple code agents (Claude, Cursor, Copilot, etc.),
each agent adapter should expose a `validateModel(name: string)` method or provide
a model registry. Worst case: maintain a `models.json` per provider.

**Workaround:** Use CLI aliases (`haiku`, `sonnet`, `opus`) which always resolve to latest.

**Fix Location:** `src/config/validate.ts` — add model validation step.
Agent adapter interface: add optional `getSupportedModels()` or `validateModel()`.

**Priority:** Low — workaround available (use aliases)

---

## BUG-21: Claude Code child processes orphaned after TDD session failure

**Found:** Run D, US-007 TDD test-writer failure (2026-02-19 20:11)
**Severity:** Medium (resource leak, CPU waste)
**Component:** `src/tdd/orchestrator.ts` / `src/agents/claude-adapter.ts`

### Symptoms
- `bun test` (PID 76312) running at 99.9% CPU for 2+ hours after Run D completed
- Process orphaned (PPID=1), original parent (PGID leader 76309) dead
- Sibling `tail -5` (PID 76313) also orphaned, plus a zombie child (PID 76555)
- Pipeline: `bun test 2>&1 | tail -5` — spawned by Claude Code internally during TDD test-writer session

### Root Cause
When Claude Code exits with code 1 (TDD session failure), it does NOT clean up shell commands it spawned internally. nax kills the Claude Code process via the agent adapter, but Claude Code's child processes (`bun test | tail -5`) are in a different process group (PGID 76309 vs Claude Code's own PID).

nax's `executeWithTimeout()` in `verification.ts` properly kills process groups for commands IT spawns, but TDD session child processes are spawned by Claude Code, not by nax.

### Process Tree at Failure
```
launchd (1)
├── bun test (76312) ← orphaned, 99.9% CPU, PGID 76309
├── tail -5 (76313) ← orphaned, sleeping, PGID 76309  
└── <defunct> (76555) ← zombie child of 76312
```
Original PGID leader (76309) is dead — likely the shell Claude Code spawned.

### Fix Options
1. **nax-side (recommended):** After agent adapter returns failure, run `pkill -P <agent_pid>` recursively or `kill -- -<pgid>` to clean up the entire process tree. Add a `cleanupProcessTree(pid)` utility.
2. **nax-side (belt+suspenders):** Track all child PIDs before/after TDD session via `pgrep -P`, kill any new orphans.
3. **Upstream (Claude Code):** File issue — Claude Code should clean up child processes on abnormal exit.

### Affected Code
- `src/tdd/orchestrator.ts` — `runTddSession()` calls agent adapter but doesn't clean up process tree on failure
- `src/agents/claude-adapter.ts` — `runSession()` kills Claude Code process but not its children

### Workaround
Manually kill orphaned processes: `kill -9 -76309` (kill entire PGID)

---

## BUG-22: TDD orchestrator treats verifier fix-and-commit as failure

**Found:** Run D2, US-009 (2026-02-19 22:23)
**Severity:** Medium (false positive pause, wastes human review time)
**Component:** `src/tdd/orchestrator.ts`

### Symptoms
- US-009 verifier session fixed flaky watcher tests (sleep timing) and added README.md
- All 355 tests pass, 98.7% coverage, clean commit `9f9b048`
- nax paused with "Verifier session identified issues" requiring human review
- No actual issues — the work is complete and correct

### Root Cause
`runThreeSessionTdd()` line 387:
```typescript
const allSuccessful = sessions.every((s) => s.success);
```

`session.success` is derived from the Claude Code agent's **exit code**, not the final test state. The verifier likely:
1. Ran `bun test` → some tests failed (flaky watcher timing)
2. Fixed the tests (increased sleep timers)
3. Ran `bun test` again → 355 pass
4. Committed the fix
5. But Claude Code exited with code 1 (possibly from the initial failed test run, or from an internal error during the long session)

The orchestrator checks `sessions.every(s => s.success)` which uses exit code, not actual test outcomes. A verifier that **finds and fixes issues is doing its job** — that's a success, not a failure.

### Fix Options
1. **Post-TDD verification (recommended):** After all 3 sessions complete, run `bun test` independently. If tests pass → mark success regardless of individual session exit codes.
2. **Verifier exit code tolerance:** If verifier session has commits AND tests pass (checked via isolation), treat as success even with non-zero exit.
3. **Two-phase verifier:** Split verifier into "check" (run tests, report) and "fix" (apply fixes). Only flag if "fix" also fails.

### Evidence
```
git log -1: "fix: verify and adjust Comprehensive integration tests and documentation"
  - 355 tests pass, 0 fail
  - 98.70% function coverage, 95.52% line coverage
  - Files changed: README.md (+261), test/integration.test.ts (+7/-7)

nax output: "⏸ Human review needed: Verifier session identified issues"
```

### Impact
- False pause blocks automated pipeline completion
- Human must manually verify and resume — defeats automation purpose
- Cost: $4.95 spent on US-009, then paused on a success
- Combined with misrouting (US-009 shouldn't have been TDD), this story cost ~$5 for ~$0.15 of actual work
