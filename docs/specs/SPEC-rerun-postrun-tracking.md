# SPEC: Rerun Resume & Post-Run Status Tracking

## Summary

Persist acceptance and deferred regression outcomes in `status.json` so reruns skip already-passed phases and resume from the correct point. Un-gitignore `status.json` to make run state portable across machines.

## Motivation

When all stories are `"passed"` and you relaunch `nax run`, the runner re-runs acceptance validation and deferred regression from scratch — even if they already passed on the previous run. There is no persistent record of post-run phase outcomes between runs. This wastes time and cost on reruns, especially during self-dev where crashes/restarts are common.

## Design

### Un-gitignore `status.json`

Remove `.nax/features/*/status.json` from:
- `.gitignore` (project root)
- `checkGitignoreCoversNax()` required patterns in `src/precheck/checks-warnings.ts`

Keep `status.json` in `NAX_RUNTIME_PATTERNS` allowlist in `src/precheck/checks-git.ts` — it's written continuously during a run and will be dirty mid-run. `autoCommitIfDirty()` at run end handles committing it.

### `postRun` status shape

New types in `status-writer.ts`:

```typescript
interface PostRunPhaseStatus {
  status: "not-run" | "running" | "passed" | "failed";
  lastRunAt?: string;
  error?: string;
}

interface AcceptancePhaseStatus extends PostRunPhaseStatus {
  retries?: number;
  failedACs?: string[];
}

interface RegressionPhaseStatus extends PostRunPhaseStatus {
  failedTests?: number;
  affectedStories?: string[];
  rectificationAttempts?: number;
  skipped?: boolean;
}

interface PostRunStatus {
  acceptance: AcceptancePhaseStatus;
  regression: RegressionPhaseStatus;
}
```

`StatusWriter` gains three methods:
- `setPostRunPhase(phase, update)` — merges partial update into `postRun[phase]`, triggers write
- `getPostRunStatus()` — returns current `postRun` from in-memory state (defaults to both `"not-run"` if absent)
- `resetPostRunStatus()` — sets both phases to `{ status: "not-run" }`

### Phase boundary writes

Acceptance:
- Before `runAcceptanceLoop()` → `status = "running"`
- On success return → `status = "passed"`, `lastRunAt`
- On failure return → `status = "failed"`, `failedACs`, `retries`, `lastRunAt`

Regression:
- Before `runDeferredRegression()` → `status = "running"`
- On success → `status = "passed"`, `lastRunAt`
- On failure → `status = "failed"`, `failedTests`, `affectedStories`, `rectificationAttempts`, `lastRunAt`
- On smart-skip → `status = "passed"`, `skipped = true`, `lastRunAt`

### Rerun skip logic

In `runCompletionPhase()`, before running phases:

```typescript
const postRun = statusWriter.getPostRunStatus();

if (postRun.acceptance.status === "passed" && postRun.regression.status === "passed") {
  logger?.info("execution", "Post-run phases already passed — skipping");
  // skip both, proceed to metrics/summary
} else if (postRun.acceptance.status === "passed") {
  logger?.info("execution", "Acceptance already passed — skipping to regression");
  // skip acceptance, run regression only
} else {
  // run both (current behavior)
}
```

### Reset on story regression

When any story transitions from `"passed"` to a non-passed status (e.g. manual reset, re-execution), call `resetPostRunStatus()`. This prevents stale "passed" post-run state when implementation has changed. Only backward transitions trigger reset — `"pending"` → `"passed"` does not.

### Failure handling

- Missing `postRun` in existing `status.json` → treat as both `"not-run"` (backward compat, fail-open)
- Corrupt/unreadable `postRun` → treat as `"not-run"`, log warning
- `status = "running"` from a crashed previous run → treat as `"not-run"` (stale running state means it never completed)

## Stories

### US-001: `PostRunStatus` types and `StatusWriter` methods + un-gitignore

**Depends on:** none

Add `PostRunStatus` types and three methods to `StatusWriter`. Remove `status.json` from `.gitignore` and `checkGitignoreCoversNax()` required patterns.

**Acceptance Criteria:**
1. `setPostRunPhase("acceptance", { status: "passed", lastRunAt: "..." })` merges into `postRun.acceptance` in the written status file
2. `setPostRunPhase("regression", { status: "failed", failedTests: 3 })` merges into `postRun.regression` in the written status file
3. `getPostRunStatus()` returns `{ acceptance: { status: "not-run" }, regression: { status: "not-run" } }` when `postRun` is absent from status file
4. `getPostRunStatus()` returns `{ acceptance: { status: "not-run" }, regression: { status: "not-run" } }` when `postRun.acceptance.status` is `"running"` (stale crash recovery)
5. `resetPostRunStatus()` sets both phases to `{ status: "not-run" }` and clears all other fields
6. `.gitignore` does not contain `.nax/features/*/status.json` after this change
7. `checkGitignoreCoversNax()` does not list `status.json` in its required patterns array
8. `checkWorkingTreeClean()` still allows dirty `.nax/features/*/status.json` (remains in `NAX_RUNTIME_PATTERNS`)

### US-002: Write acceptance and regression phase status at boundaries

**Depends on:** US-001

Instrument `runner-completion.ts`, `acceptance-loop.ts`, and `run-completion.ts` to call `setPostRunPhase()` at each phase entry/exit.

**Acceptance Criteria:**
1. `runCompletionPhase()` calls `setPostRunPhase("acceptance", { status: "running" })` before entering `runAcceptanceLoop()`
2. `runAcceptanceLoop()` returns with `postRun.acceptance.status === "passed"` and `lastRunAt` set when acceptance passes
3. `runAcceptanceLoop()` returns with `postRun.acceptance.status === "failed"`, `failedACs` populated, and `retries` matching actual retry count when acceptance fails
4. `handleRunCompletion()` calls `setPostRunPhase("regression", { status: "running" })` before entering `runDeferredRegression()`
5. After `runDeferredRegression()` succeeds, `postRun.regression.status === "passed"` with `lastRunAt` set
6. After `runDeferredRegression()` fails, `postRun.regression.status === "failed"` with `failedTests` and `affectedStories` populated
7. After smart-skip in `handleRunCompletion()`, `postRun.regression.status === "passed"` and `skipped === true`

### US-003: Rerun skip logic and story regression reset

**Depends on:** US-002

Update `runCompletionPhase()` to check `postRun` status before running phases. Add `resetPostRunStatus()` call when a story transitions from `"passed"` to a non-passed status.

**Acceptance Criteria:**
1. `runCompletionPhase()` skips both acceptance and regression when `postRun.acceptance.status === "passed"` and `postRun.regression.status === "passed"`, emitting an info log
2. `runCompletionPhase()` skips acceptance but runs regression when `postRun.acceptance.status === "passed"` and `postRun.regression.status !== "passed"`
3. `runCompletionPhase()` runs both phases when `postRun.acceptance.status` is `"not-run"` or `"failed"`
4. When a story status changes from `"passed"` to `"pending"`, `resetPostRunStatus()` is called
5. When a story status changes from `"passed"` to `"failed"`, `resetPostRunStatus()` is called
6. When a story status changes from `"pending"` to `"passed"`, `resetPostRunStatus()` is NOT called

### US-004: Display `postRun` in `nax status` CLI

**Depends on:** US-001

Update `nax status` output to include acceptance and regression phase status when `postRun` is present.

**Acceptance Criteria:**
1. `nax status` output includes `Acceptance: passed` with timestamp when `postRun.acceptance.status === "passed"`
2. `nax status` output includes `Regression: failed` with `failedTests` count when `postRun.regression.status === "failed"`
3. `nax status` output omits post-run section entirely when `postRun` is absent (backward compat for old projects)
4. `nax status` output shows `Regression: skipped (smart-skip)` when `postRun.regression.skipped === true`

### Context Files
- `src/execution/status-writer.ts` — StatusWriter class, status file shape
- `src/execution/runner-completion.ts` — Completion phase orchestrator
- `src/execution/lifecycle/acceptance-loop.ts` — Acceptance retry loop
- `src/execution/lifecycle/run-completion.ts` — Deferred regression gate + metrics
- `src/precheck/checks-warnings.ts` — Gitignore validation (`checkGitignoreCoversNax`)
- `src/precheck/checks-git.ts` — Working tree clean check + `NAX_RUNTIME_PATTERNS`
- `.gitignore` — Project gitignore
