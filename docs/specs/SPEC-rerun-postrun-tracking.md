# SPEC: Rerun Resume & Post-Run Status Tracking

## Summary

Persist acceptance and deferred regression outcomes in `status.json` so reruns can skip already-passed phases and resume from the correct point. Also un-gitignore `status.json` to make run state portable across machines.

## Motivation

Currently, when all stories are `"passed"` and you relaunch `nax run`:

1. The runner skips story execution (correct).
2. It re-runs acceptance validation from scratch (wasteful if it already passed).
3. It re-runs the deferred regression gate from scratch (wasteful if it already passed).
4. If acceptance previously failed and was then fixed manually, nax has no memory of that — it starts the full acceptance retry loop again.

There is no persistent record of post-run phase outcomes between runs. The only tracked state is per-story status in `prd.json` and run-level metadata in `status.json` (which is currently gitignored).

### Related Issues

- **#249** — fix(rerun): resume from first failed story on rerun
- **#250** — feat(status): persist acceptance/deferred regression state across reruns

## Design

### 1. Un-gitignore `status.json`

Remove `.nax/features/*/status.json` from:
- `.gitignore` (project root)
- `nax init` generated gitignore template
- `checkGitignoreCoversNax()` required patterns list in `src/precheck/checks-warnings.ts`

**Keep** `status.json` in `NAX_RUNTIME_PATTERNS` allowlist in `src/precheck/checks-git.ts` — it's written continuously during a run, so it will be dirty mid-run. The `autoCommitIfDirty()` at run end handles committing it.

### 2. Extend `status.json` with `postRun` section

Add a `postRun` field to the status file shape:

```typescript
// status-writer.ts — new types
interface PostRunPhaseStatus {
  status: "not-run" | "running" | "passed" | "failed";
  lastRunAt?: string;          // ISO timestamp of last attempt
  error?: string;              // Short summary if failed/crashed
}

interface AcceptancePhaseStatus extends PostRunPhaseStatus {
  retries?: number;            // How many retry iterations were used
  failedACs?: string[];        // e.g. ["AC-3", "AC-7"] — last known failures
}

interface RegressionPhaseStatus extends PostRunPhaseStatus {
  failedTests?: number;        // Count of failing tests
  affectedStories?: string[];  // Story IDs mapped to failures
  rectificationAttempts?: number;
  skipped?: boolean;           // True when smart-skip applied
}

interface PostRunStatus {
  acceptance: AcceptancePhaseStatus;
  regression: RegressionPhaseStatus;
}
```

Example `status.json` after a run where acceptance passed but regression failed:

```json
{
  "version": 1,
  "run": {
    "id": "run-2026-04-04T08-42-38-886Z",
    "feature": "debate-session-mode",
    "startedAt": "2026-04-04T08:42:38.886Z",
    "status": "failed",
    "pid": 30247
  },
  "progress": {
    "total": 9,
    "passed": 9,
    "failed": 0,
    "pending": 0
  },
  "cost": { "spent": 8.12, "limit": 30 },
  "postRun": {
    "acceptance": {
      "status": "passed",
      "lastRunAt": "2026-04-04T08:43:00.000Z"
    },
    "regression": {
      "status": "failed",
      "lastRunAt": "2026-04-04T08:43:37.000Z",
      "failedTests": 3,
      "affectedStories": ["US-002"],
      "rectificationAttempts": 2,
      "error": "3 tests still failing after 2 rectification attempts"
    }
  }
}
```

### 3. Write `postRun` status at phase boundaries

| Code location | Action |
|:---|:---|
| `runner-completion.ts` — before `runAcceptanceLoop()` | Write `postRun.acceptance.status = "running"` |
| `acceptance-loop.ts` — on success return | Write `postRun.acceptance.status = "passed"` |
| `acceptance-loop.ts` — on failure return | Write `postRun.acceptance.status = "failed"` + `failedACs` + `retries` |
| `runner-completion.ts` — before `handleRunCompletion()` | Write `postRun.regression.status = "running"` |
| `run-completion.ts` — after regression passes | Write `postRun.regression.status = "passed"` |
| `run-completion.ts` — after regression fails | Write `postRun.regression.status = "failed"` + details |
| `run-completion.ts` — after smart-skip | Write `postRun.regression.status = "passed"`, `skipped = true` |

The `StatusWriter` gains a new method:

```typescript
setPostRunPhase(
  phase: "acceptance" | "regression",
  update: Partial<AcceptancePhaseStatus> | Partial<RegressionPhaseStatus>
): void
```

This merges the update into the existing `postRun[phase]` state and triggers a write.

### 4. Rerun decision logic

In `runCompletionPhase()`, before running acceptance/regression, read the existing `postRun` state:

```typescript
const postRun = statusWriter.getPostRunStatus();

// Case 1: Both already passed — skip entirely
if (postRun?.acceptance.status === "passed" && postRun?.regression.status === "passed") {
  logger?.info("execution", "Post-run phases already passed on previous run — skipping");
  return earlyCompletionResult();
}

// Case 2: Acceptance passed, regression not yet — skip acceptance, run regression
if (postRun?.acceptance.status === "passed") {
  logger?.info("execution", "Acceptance already passed — skipping to regression gate");
  // Skip acceptance loop, proceed to handleRunCompletion() which runs regression
}

// Case 3: Acceptance failed or not-run — run acceptance
// (current behavior, no change)
```

### 5. Reset `postRun` on story status change

When any story transitions from `"passed"` to another status (e.g. manual reset, re-execution), reset `postRun` to `not-run` for both phases. This prevents stale "passed" acceptance/regression status when the implementation has changed.

```typescript
// In StatusWriter or wherever story status transitions are handled
if (previousStatus === "passed" && newStatus !== "passed") {
  this.resetPostRunStatus();  // Sets both phases to "not-run"
}
```

### 6. `nax status` CLI output

The existing `nax status` command should display `postRun` state when present:

```
Feature: debate-session-mode
Stories: 9/9 passed
Acceptance: ✓ passed (2026-04-04 16:43)
Regression: ✗ failed — 3 tests, 2 rectification attempts
```

## Files to Modify

| File | Change |
|:---|:---|
| `.gitignore` | Remove `.nax/features/*/status.json` line |
| `src/precheck/checks-warnings.ts` | Remove `status.json` from `checkGitignoreCoversNax` patterns |
| `src/execution/status-writer.ts` | Add `PostRunStatus` types, `setPostRunPhase()`, `getPostRunStatus()`, `resetPostRunStatus()` |
| `src/execution/runner-completion.ts` | Read `postRun` before deciding phases; write status at boundaries |
| `src/execution/lifecycle/acceptance-loop.ts` | Write acceptance phase status on entry/exit |
| `src/execution/lifecycle/run-completion.ts` | Write regression phase status on entry/exit |
| `src/commands/status.ts` (or equivalent) | Display `postRun` in CLI output |
| `nax init` template (if exists) | Remove `status.json` from generated gitignore |

## Stories

### US-000: Un-gitignore `status.json`

**Depends on:** none

Remove `.nax/features/*/status.json` from `.gitignore`, `checkGitignoreCoversNax()` required patterns, and `nax init` template (if applicable). Keep `status.json` in `NAX_RUNTIME_PATTERNS` allowlist so dirty `status.json` doesn't block precheck.

**Acceptance Criteria:**
1. `.gitignore` does not contain `.nax/features/*/status.json`
2. `checkGitignoreCoversNax()` does not require `status.json` pattern
3. `checkWorkingTreeClean()` still allows dirty `status.json` (remains in `NAX_RUNTIME_PATTERNS`)
4. Existing tests pass

### US-001: Add `postRun` to `StatusWriter`

**Depends on:** US-000

Add `PostRunStatus` types and methods to `StatusWriter`:
- `setPostRunPhase(phase, update)` — merge partial update into `postRun[phase]`
- `getPostRunStatus()` — read current `postRun` from status file
- `resetPostRunStatus()` — set both phases to `"not-run"`

**Acceptance Criteria:**
1. `StatusWriter` exposes `setPostRunPhase("acceptance", { status: "passed" })`
2. `StatusWriter` exposes `getPostRunStatus()` returning current state
3. `resetPostRunStatus()` sets both phases to `{ status: "not-run" }`
4. `postRun` section appears in written `status.json`
5. Missing `postRun` in existing `status.json` is treated as both phases `"not-run"` (backward compat)
6. Unit tests cover all methods

### US-002: Write acceptance phase status

**Depends on:** US-001

Instrument `runner-completion.ts` and `acceptance-loop.ts` to write acceptance phase status at boundaries:
- `"running"` before entering acceptance loop
- `"passed"` on success with `lastRunAt`
- `"failed"` on failure with `failedACs`, `retries`, `lastRunAt`

**Acceptance Criteria:**
1. After successful acceptance, `postRun.acceptance.status === "passed"`
2. After failed acceptance, `postRun.acceptance.status === "failed"` with `failedACs` populated
3. `lastRunAt` is set on every acceptance attempt
4. `retries` reflects actual retry count
5. Unit tests verify status transitions

### US-003: Write regression phase status

**Depends on:** US-001

Instrument `run-completion.ts` to write regression phase status at boundaries:
- `"running"` before entering regression gate
- `"passed"` on success
- `"failed"` on failure with `failedTests`, `affectedStories`, `rectificationAttempts`
- `"passed"` with `skipped: true` on smart-skip

**Acceptance Criteria:**
1. After successful regression, `postRun.regression.status === "passed"`
2. After failed regression, `postRun.regression.status === "failed"` with details
3. After smart-skip, `postRun.regression.status === "passed"` and `skipped === true`
4. `lastRunAt` is set on every regression attempt
5. Unit tests verify status transitions

### US-004: Rerun skip logic

**Depends on:** US-002, US-003

Update `runCompletionPhase()` to check existing `postRun` status before running phases:
- Both passed → skip both, emit log, return early
- Acceptance passed, regression not → skip acceptance, run regression only
- Otherwise → run both (current behavior)

**Acceptance Criteria:**
1. Rerun with `postRun.acceptance.status === "passed"` and `postRun.regression.status === "passed"` skips both phases
2. Rerun with `postRun.acceptance.status === "passed"` and `postRun.regression.status === "failed"` skips acceptance, runs regression
3. Rerun with `postRun.acceptance.status === "failed"` runs acceptance from scratch
4. Missing `postRun` (old status.json) runs both phases (backward compat)
5. Log messages indicate which phases are skipped and why
6. Integration test: simulate rerun with pre-populated `status.json`

### US-005: Reset `postRun` on story status change

**Depends on:** US-001

When any story transitions away from `"passed"`, reset `postRun` to `"not-run"` for both phases to prevent stale post-run results.

**Acceptance Criteria:**
1. Story `"passed"` → `"pending"` triggers `resetPostRunStatus()`
2. Story `"passed"` → `"failed"` triggers `resetPostRunStatus()`
3. Story `"pending"` → `"passed"` does NOT reset (only backward transitions)
4. After reset, both `postRun.acceptance` and `postRun.regression` have `status: "not-run"`
5. Unit test covers all transition cases

### US-006: Display `postRun` in `nax status`

**Depends on:** US-001

Update `nax status` CLI output to show acceptance and regression phase status when `postRun` is present.

**Acceptance Criteria:**
1. `nax status` shows acceptance status with timestamp when present
2. `nax status` shows regression status with failure details when present
3. Missing `postRun` shows nothing extra (clean output for old projects)
4. Failed phases show reason/details (failedACs, failedTests count)

### Context Files

- `src/execution/status-writer.ts` — StatusWriter class, status file shape
- `src/execution/runner-completion.ts` — Completion phase orchestrator
- `src/execution/lifecycle/acceptance-loop.ts` — Acceptance retry loop
- `src/execution/lifecycle/run-completion.ts` — Deferred regression gate + metrics
- `src/execution/lifecycle/run-regression.ts` — Regression implementation
- `src/precheck/checks-warnings.ts` — Gitignore validation
- `src/precheck/checks-git.ts` — Working tree clean check + NAX_RUNTIME_PATTERNS
- `.gitignore` — Project gitignore
- `src/commands/status.ts` — CLI status command (if exists)
