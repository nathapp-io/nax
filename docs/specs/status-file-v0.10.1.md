# Spec: v0.10.1 — Status File + TDD Escalation Retry

**Version:** v0.10.1  
**Author:** Subrina  
**Date:** 2026-02-25  
**Status:** Draft

---

## Summary

Add a `--status-file <path>` flag to `nax run` that writes a machine-readable JSON status file, updated after each story completes. Enables external tools (CI/CD, orchestrators, dashboards) to monitor nax runs without parsing logs or aggregating hooks.

## Motivation

- **Log parsing is fragile** — format changes break consumers
- **Hook aggregation has gaps** — if a hook fails, events are lost; no single source of truth
- **nax already tracks this state** — `RunResult`, story counts, cost, PRD status are all in memory
- **General-purpose** — useful for any integration, not just our orchestrator skill

## Interface

### CLI Flag

```bash
nax run -f <feature> --headless --status-file ./nax-status.json
```

| Flag | Type | Default | Description |
|:-----|:-----|:--------|:------------|
| `--status-file` | `string` | `undefined` | Path to write JSON status file. If not set, no file is written. |

Relative paths resolved from `cwd` (same as `--headless` log behavior).

### Status File Schema

```typescript
interface NaxStatusFile {
  /** Schema version for forward compatibility */
  version: 1;
  
  /** Run metadata */
  run: {
    id: string;              // Run ID (e.g. "run-2026-02-25T10-00-00-000Z")
    feature: string;         // Feature name
    startedAt: string;       // ISO 8601
    status: "running" | "completed" | "failed" | "stalled";
    dryRun: boolean;
  };

  /** Aggregate progress */
  progress: {
    total: number;           // Total stories in PRD
    passed: number;
    failed: number;
    paused: number;
    blocked: number;
    pending: number;         // total - passed - failed - paused - blocked
  };

  /** Cost tracking */
  cost: {
    spent: number;           // USD accumulated
    limit: number | null;    // From config.execution.costLimit
  };

  /** Current story being processed (null if between stories) */
  current: {
    storyId: string;
    title: string;
    complexity: string;      // simple | medium | complex
    tddStrategy: string;     // test-after | tdd-lite | three-session-tdd
    model: string;           // Resolved model name
    attempt: number;         // Current attempt (1-based)
    phase: string;           // routing | test-write | implement | verify | review
  } | null;

  /** Iteration count */
  iterations: number;

  /** Last updated timestamp */
  updatedAt: string;         // ISO 8601
  
  /** Duration so far in ms */
  durationMs: number;
}
```

### Example Output

```json
{
  "version": 1,
  "run": {
    "id": "run-2026-02-25T10-00-00-000Z",
    "feature": "auth-refactor",
    "startedAt": "2026-02-25T10:00:00Z",
    "status": "running",
    "dryRun": false
  },
  "progress": {
    "total": 12,
    "passed": 7,
    "failed": 1,
    "paused": 0,
    "blocked": 1,
    "pending": 3
  },
  "cost": {
    "spent": 1.23,
    "limit": 5.00
  },
  "current": {
    "storyId": "US-008",
    "title": "Add retry logic to queue handler",
    "complexity": "medium",
    "tddStrategy": "tdd-lite",
    "model": "claude-sonnet-4-5-20250514",
    "attempt": 1,
    "phase": "implement"
  },
  "iterations": 8,
  "updatedAt": "2026-02-25T10:15:32Z",
  "durationMs": 932000
}
```

## Implementation

### Files to Change

| File | Change |
|:-----|:-------|
| `src/execution/runner.ts` | Add `statusFile?: string` to `RunOptions`. Call `writeStatusFile()` at key points. |
| `src/execution/status-file.ts` | **New file.** `writeStatusFile()` function — builds `NaxStatusFile` from run state, writes atomically. |
| `src/main.ts` (or wherever CLI args are parsed) | Add `--status-file` option, pass to `RunOptions`. |

### Write Points

Status file is updated at these moments:

1. **Run start** — initial state (all stories pending)
2. **Story start** — update `current` with story info
3. **Story complete/fail/pause** — update `progress` counts, clear `current`
4. **Run end** — final state (`status: "completed"` or `"failed"`)

### Atomic Writes

Write to `<path>.tmp` then rename to `<path>` to prevent readers from seeing partial JSON:

```typescript
import { rename } from "node:fs/promises";

async function writeStatusFile(path: string, status: NaxStatusFile): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(status, null, 2));
  await rename(tmpPath, path);
}
```

### Integration with RunOptions

```typescript
// src/execution/runner.ts
export interface RunOptions {
  // ... existing fields
  /** Path to write JSON status file (optional) */
  statusFile?: string;
}
```

### Progress Counting

Derive from PRD state (already loaded):

```typescript
function countProgress(prd: PRD): NaxStatusFile["progress"] {
  const stories = prd.stories;
  const passed = stories.filter(s => s.status === "passed").length;
  const failed = stories.filter(s => s.status === "failed").length;
  const paused = stories.filter(s => s.status === "paused").length;
  const blocked = stories.filter(s => s.status === "blocked").length;
  const total = stories.length;
  return { total, passed, failed, paused, blocked, pending: total - passed - failed - paused - blocked };
}
```

### Cleanup

The status file is **not** deleted on run end — it persists as a record of the last run. Consumers can check `run.status` to determine if the run is still active.

## Testing

| Test | Description |
|:-----|:------------|
| `status-file.test.ts` | Unit: `writeStatusFile()` produces valid JSON, atomic write works |
| `status-file.test.ts` | Unit: `countProgress()` correctly counts all states |
| `runner.test.ts` | Integration: `--status-file` option flows through to `RunOptions` |
| `runner.test.ts` | Integration: status file updates at each write point |
| Manual | `--status-file` + `--dry-run` produces correct output |

## Non-Goals

- **Real-time streaming** — this is a polled file, not a websocket/SSE stream
- **Historical run data** — status file represents current/last run only (hooks + events.jsonl cover history)
- **`nax status --json` command** — future work, can read this file

## Migration

None. New optional flag, no breaking changes. If `--status-file` is not passed, behavior is identical to v0.10.0.

---

# Feature 2: TDD Escalation Retry

## Summary

Three-session TDD currently hard-codes `pause` for all failures — isolation violations, session crashes, and test failures all result in the story being paused with no retry. This means TDD stories never benefit from the escalation system that test-after stories use.

Change: TDD failures should follow the same escalation retry pattern as test-after. Only pause when all retry paths are exhausted.

## Problem

Current flow (all TDD failures):
```
TDD failure → needsHumanReview=true → execution stage returns "pause" → story paused → NO RETRY
```

test-after flow (for comparison):
```
Agent failure → execution stage returns "escalate" → runner bumps tier → retries → only fails after max attempts
```

## Proposed Retry Strategy

TDD failures are classified into three categories with different retry paths:

### Category 1: Isolation Violation (test-writer touches source)

**Current:** Pause immediately.  
**Proposed:** Auto-downgrade to tdd-lite, then escalate.

```
three-session-tdd fails (isolation violation)
  → Retry 1: three-session-tdd-lite (same tier, skip isolation for writer/implementer)
    → Success? Done ✅
    → Fail? Escalate to next tier
      → Retry 2: tdd-lite + stronger model
        → Success? Done ✅
        → Fail? Continue escalation through tier chain
          → All tiers exhausted → pause (needs human review) ⏸
```

**Note:** The zero-file fallback already does this for one specific case (test-writer creates no test files → auto-retry as lite). This generalizes that pattern to all isolation violations.

### Category 2: Session Failure (agent crash, timeout, non-zero exit)

**Current:** Pause immediately.  
**Proposed:** Escalate model tier (same as test-after).

```
TDD session fails (crash/timeout)
  → Escalate to next model tier
    → Retry with stronger model (same TDD strategy)
      → Success? Done ✅
      → Fail? Continue escalation
        → All tiers exhausted → mark failed ❌
```

### Category 3: Tests Still Failing After All Sessions

**Current:** Post-TDD verification runs. If tests fail → pause.  
**Proposed:** Escalate model tier.

```
All 3 sessions complete but tests still fail
  → Escalate to next model tier
    → Retry full TDD with stronger model
      → Success? Done ✅
      → Fail? Continue escalation
        → All tiers exhausted → mark failed ❌
```

### Summary Table

| Failure Type | Current Action | New Action | Final Fallback |
|:-------------|:--------------|:-----------|:--------------|
| Isolation violation | pause | Downgrade to lite → escalate | pause (human review) |
| Zero test files created | lite retry (exists) | Keep existing + escalate | pause (human review) |
| Session crash/timeout | pause | Escalate tier | fail |
| Tests fail post-TDD | pause | Escalate tier | fail |
| Verifier flags bad code | pause | Escalate tier | pause (human review) |

**Why "pause" for isolation/verifier but "fail" for crashes?**
- Isolation violations and verifier concerns suggest the code needs *human judgment* — the AI may be fundamentally misunderstanding the task.
- Crashes and test failures are mechanical — a stronger model usually fixes them.

## Implementation

### Changes to `ThreeSessionTddResult`

Add a `failureCategory` field so the execution stage can differentiate:

```typescript
export interface ThreeSessionTddResult {
  success: boolean;
  sessions: TddSessionResult[];
  needsHumanReview: boolean;
  reviewReason?: string;
  totalCost: number;
  lite: boolean;
  
  /** NEW: Categorize failure for retry routing */
  failureCategory?: "isolation-violation" | "session-failure" | "tests-failing" | "verifier-rejected";
}
```

### Changes to `execution.ts` (pipeline stage)

Replace the blanket `pause` with category-based routing:

```typescript
// Current:
if (tddResult.needsHumanReview) {
  return { action: "pause", reason: tddResult.reviewReason };
}

// Proposed:
if (!tddResult.success) {
  switch (tddResult.failureCategory) {
    case "isolation-violation":
      // If already lite → escalate. If strict → retry as lite (same tier).
      if (tddResult.lite) {
        return { action: "escalate", reason: tddResult.reviewReason };
      }
      // Store flag in context so runner knows to downgrade strategy
      ctx.retryAsLite = true;
      return { action: "escalate", reason: `Isolation violation — downgrading to lite` };
    
    case "session-failure":
    case "tests-failing":
      return { action: "escalate", reason: tddResult.reviewReason };
    
    case "verifier-rejected":
      // Escalate first, pause only after all tiers exhausted
      return { action: "escalate", reason: tddResult.reviewReason };
    
    default:
      return { action: "pause", reason: tddResult.reviewReason };
  }
}
```

### Changes to `runner.ts` (escalation handler)

When escalating a TDD story with `retryAsLite`, update the story's routing to use `three-session-tdd-lite`:

```typescript
case "escalate": {
  // ... existing escalation logic ...
  
  // NEW: If retryAsLite flag set, downgrade TDD strategy
  if (pipelineResult.context?.retryAsLite && story.routing) {
    story.routing.testStrategy = "three-session-tdd-lite";
  }
  
  // ... rest of escalation ...
}
```

### Changes to `tdd/orchestrator.ts`

Set `failureCategory` based on what went wrong:

```typescript
// After session 1 (test-writer) isolation failure:
return {
  success: false,
  ...
  failureCategory: "isolation-violation",
};

// After session crash/timeout:
return {
  success: false,
  ...
  failureCategory: "session-failure",
};

// After post-TDD verification fails:
return {
  success: false,
  ...
  failureCategory: "tests-failing",
};
```

### Files to Change

| File | Change |
|:-----|:-------|
| `src/tdd/types.ts` | Add `failureCategory` to `ThreeSessionTddResult` |
| `src/tdd/orchestrator.ts` | Set `failureCategory` at each failure point |
| `src/pipeline/stages/execution.ts` | Route by `failureCategory` instead of blanket `pause` |
| `src/pipeline/types.ts` | Add `retryAsLite?: boolean` to `PipelineContext` |
| `src/execution/runner.ts` | Handle `retryAsLite` flag in escalation case |

### Testing

| Test | Description |
|:-----|:------------|
| `tdd/orchestrator.test.ts` | Unit: each failure path sets correct `failureCategory` |
| `pipeline/execution.test.ts` | Unit: isolation violation returns `escalate` (not `pause`) |
| `pipeline/execution.test.ts` | Unit: lite isolation violation returns `escalate` |
| `pipeline/execution.test.ts` | Unit: session failure returns `escalate` |
| `execution/runner.test.ts` | Integration: TDD story escalates through tiers before failing |
| `execution/runner.test.ts` | Integration: `retryAsLite` downgrades strategy on next attempt |
| Manual | Run with intentionally strict project, verify lite downgrade + tier escalation |

## Retry Budget

Uses the existing escalation config (`autoMode.escalation.tierOrder`). Example:

```json
{
  "autoMode": {
    "escalation": {
      "enabled": true,
      "tierOrder": [
        { "tier": "fast", "attempts": 2 },
        { "tier": "balanced", "attempts": 2 },
        { "tier": "powerful", "attempts": 1 }
      ]
    }
  }
}
```

For a strict TDD story with isolation violation:
```
Attempt 1: three-session-tdd @ fast      → isolation violation
Attempt 2: three-session-tdd-lite @ fast  → tests fail
Attempt 3: tdd-lite @ balanced            → tests fail  
Attempt 4: tdd-lite @ balanced            → tests fail
Attempt 5: tdd-lite @ powerful            → success ✅ (or fail → pause)
```

Max cost is bounded by the existing tier budget. No new config needed.

---

# Feature 3: Structured Verifier Verdicts

## Summary

The verifier (session 3) is designed to judge whether the implementer's changes are legitimate — especially when the implementer modified test files. Currently, this judgment is implicit: the verifier runs as a regular agent, and the only signal is "did tests pass after verifier ran?" There's no structured verdict flowing back to the pipeline.

Add structured output parsing to the verifier session so its judgment feeds into `failureCategory` and the escalation system.

## Problem

Current verifier prompt asks it to:
1. Run tests and verify they pass
2. Review implementation quality
3. Check acceptance criteria
4. **Check if implementer modified test files and judge legitimacy**
5. Fix issues minimally

But the result is just `{ success: boolean, estimatedCost: number }` — same as any agent session. The verifier's judgment about test modifications, code quality, and acceptance criteria is lost.

**Consequences:**
- If verifier finds illegitimate test modifications, it tries to fix them but we don't know *what* it found
- If verifier can't fix the issue, it exits non-zero → treated same as a crash
- No signal to differentiate "tests pass but code is bad" from "tests fail"
- The `VerifierDecision` type exists in `types.ts` but is **never populated**

## Proposed Solution

### Structured Verdict File

Instead of parsing agent stdout (fragile), the verifier writes a structured verdict file that the orchestrator reads after the session:

```
<workdir>/.nax-verifier-verdict.json
```

**Why a file?** Claude Code (the agent) can easily write files. Parsing structured output from stdout is unreliable with Claude Code since it mixes tool calls, thinking, and output.

### Verdict Schema

```typescript
interface VerifierVerdict {
  /** Schema version */
  version: 1;
  
  /** Overall approval */
  approved: boolean;
  
  /** Test results */
  tests: {
    /** Did all tests pass? */
    allPassing: boolean;
    /** Number of tests passing */
    passCount: number;
    /** Number of tests failing */
    failCount: number;
  };
  
  /** Implementer test modification review */
  testModifications: {
    /** Were test files modified by implementer? */
    detected: boolean;
    /** List of modified test files */
    files: string[];
    /** Are the modifications legitimate? */
    legitimate: boolean;
    /** Reasoning for legitimacy judgment */
    reasoning: string;
  };
  
  /** Acceptance criteria check */
  acceptanceCriteria: {
    /** All criteria met? */
    allMet: boolean;
    /** Per-criterion status */
    criteria: Array<{
      criterion: string;
      met: boolean;
      note?: string;
    }>;
  };
  
  /** Code quality assessment */
  quality: {
    /** Overall quality: good | acceptable | poor */
    rating: "good" | "acceptable" | "poor";
    /** Issues found */
    issues: string[];
  };
  
  /** Fixes applied by verifier */
  fixes: string[];
  
  /** Overall reasoning */
  reasoning: string;
}
```

### Updated Verifier Prompt

```typescript
export function buildVerifierPrompt(story: UserStory): string {
  return `# Test-Driven Development — Session 3: Verify

You are in the third session of a three-session TDD workflow. Tests and implementation are complete.

**Story:** ${story.title}

**Your tasks:**
1. Run all tests and verify they pass
2. Review the implementation for quality and correctness
3. Check that the implementation meets all acceptance criteria
4. Check if test files were modified by the implementer. If yes, verify the changes are legitimate fixes (e.g. fixing incorrect expectations) and NOT just loosening assertions to mask bugs.
5. If any issues exist, fix them minimally

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**IMPORTANT — Write Verdict File:**
After completing your review, write a JSON verdict file to \`.nax-verifier-verdict.json\` in the project root.

\`\`\`json
{
  "version": 1,
  "approved": true,
  "tests": {
    "allPassing": true,
    "passCount": 15,
    "failCount": 0
  },
  "testModifications": {
    "detected": false,
    "files": [],
    "legitimate": true,
    "reasoning": "No test files were modified by implementer"
  },
  "acceptanceCriteria": {
    "allMet": true,
    "criteria": [
      { "criterion": "Criterion text", "met": true }
    ]
  },
  "quality": {
    "rating": "good",
    "issues": []
  },
  "fixes": [],
  "reasoning": "All tests pass, implementation is clean, all criteria met."
}
\`\`\`

Set \`approved: false\` if:
- Tests are failing and you cannot fix them
- Implementer loosened test assertions to mask bugs (testModifications.legitimate = false)
- Critical acceptance criteria are not met
- Code quality is poor with security or correctness issues

Set \`approved: true\` if:
- All tests pass (or pass after your minimal fixes)
- Implementation is clean and follows conventions
- All acceptance criteria met
- Any test modifications by implementer are legitimate fixes

When done, commit any fixes with message: "fix: verify and adjust ${story.title}"`;
}
```

### Orchestrator Changes

After verifier session completes, read and parse the verdict file:

```typescript
// In tdd/orchestrator.ts, after session 3 completes:

// Read verdict file
const verdictPath = path.join(workdir, ".nax-verifier-verdict.json");
let verdict: VerifierVerdict | null = null;

try {
  const file = Bun.file(verdictPath);
  if (await file.exists()) {
    verdict = await file.json() as VerifierVerdict;
    logger.info("tdd", "Verifier verdict loaded", {
      storyId: story.id,
      approved: verdict.approved,
      testsAllPassing: verdict.tests.allPassing,
      testModsDetected: verdict.testModifications.detected,
      testModsLegitimate: verdict.testModifications.legitimate,
      qualityRating: verdict.quality.rating,
      allCriteriaMet: verdict.acceptanceCriteria.allMet,
    });
  } else {
    logger.warn("tdd", "No verifier verdict file found — falling back to test-only check", {
      storyId: story.id,
    });
  }
} catch (err) {
  logger.warn("tdd", "Failed to parse verifier verdict", {
    storyId: story.id,
    error: String(err),
  });
}

// Clean up verdict file (don't leave it in the repo)
try {
  await unlink(verdictPath);
} catch { /* ignore */ }
```

### Verdict → failureCategory Mapping

```typescript
function categorizeVerdict(
  verdict: VerifierVerdict | null,
  session3Success: boolean,
  testsPass: boolean,
): { success: boolean; failureCategory?: FailureCategory; reviewReason?: string } {
  
  // No verdict file → fall back to existing behavior (test-only check)
  if (!verdict) {
    if (testsPass) return { success: true };
    return { 
      success: false, 
      failureCategory: "tests-failing",
      reviewReason: "Tests failing after all sessions (no verdict file)",
    };
  }

  // Verdict: approved
  if (verdict.approved) {
    return { success: true };
  }

  // Verdict: not approved — classify why
  
  // Illegitimate test modifications (implementer cheated)
  if (verdict.testModifications.detected && !verdict.testModifications.legitimate) {
    return {
      success: false,
      failureCategory: "verifier-rejected",
      reviewReason: `Verifier rejected: illegitimate test modifications in ${verdict.testModifications.files.join(", ")}. ${verdict.testModifications.reasoning}`,
    };
  }

  // Tests failing
  if (!verdict.tests.allPassing) {
    return {
      success: false,
      failureCategory: "tests-failing",
      reviewReason: `Tests failing: ${verdict.tests.failCount} failures. ${verdict.reasoning}`,
    };
  }

  // Acceptance criteria not met
  if (!verdict.acceptanceCriteria.allMet) {
    const unmet = verdict.acceptanceCriteria.criteria
      .filter(c => !c.met)
      .map(c => c.criterion);
    return {
      success: false,
      failureCategory: "verifier-rejected",
      reviewReason: `Acceptance criteria not met: ${unmet.join("; ")}`,
    };
  }

  // Poor quality
  if (verdict.quality.rating === "poor") {
    return {
      success: false,
      failureCategory: "verifier-rejected",
      reviewReason: `Poor code quality: ${verdict.quality.issues.join("; ")}`,
    };
  }

  // Catch-all: verdict says not approved but no clear reason
  return {
    success: false,
    failureCategory: "verifier-rejected",
    reviewReason: verdict.reasoning || "Verifier rejected without specific reason",
  };
}
```

### Escalation Behavior per Verdict

| Verdict Reason | failureCategory | Escalation Path |
|:---------------|:---------------|:---------------|
| Illegitimate test mods | `verifier-rejected` | Escalate tier → pause after all tiers |
| Tests failing | `tests-failing` | Escalate tier → fail after all tiers |
| Criteria not met | `verifier-rejected` | Escalate tier → pause after all tiers |
| Poor quality | `verifier-rejected` | Escalate tier → pause after all tiers |
| Approved | — | Success ✅ |
| No verdict file | Falls back to test check | Same as before |

### Verdict File Lifecycle

1. **Created by:** Verifier agent (session 3) writes `.nax-verifier-verdict.json`
2. **Read by:** TDD orchestrator after session 3 completes
3. **Deleted by:** TDD orchestrator after reading (not committed to git)
4. **Fallback:** If file missing or unparseable, fall back to existing behavior (post-TDD test verification)

### `.gitignore`

Add to project `.gitignore` (or nax init template):
```
.nax-verifier-verdict.json
```

### Files to Change

| File | Change |
|:-----|:-------|
| `src/tdd/types.ts` | Add `VerifierVerdict` interface |
| `src/tdd/prompts.ts` | Update `buildVerifierPrompt()` with verdict file instructions |
| `src/tdd/orchestrator.ts` | Read verdict file after session 3, map to `failureCategory` |
| `src/tdd/verdict.ts` | **New file.** `readVerdict()`, `categorizeVerdict()`, `cleanupVerdict()` |

### Testing

| Test | Description |
|:-----|:------------|
| `tdd/verdict.test.ts` | Unit: `categorizeVerdict()` for all verdict combinations |
| `tdd/verdict.test.ts` | Unit: missing verdict file falls back gracefully |
| `tdd/verdict.test.ts` | Unit: malformed JSON falls back gracefully |
| `tdd/orchestrator.test.ts` | Integration: verdict file read + cleanup after session 3 |
| `tdd/orchestrator.test.ts` | Integration: illegitimate test mods → `verifier-rejected` |
| Manual | Run TDD on a story, verify verdict file is written and consumed |

### Robustness

**What if the agent doesn't write the verdict file?**  
Fall back to existing behavior: run tests independently, check pass/fail. This is the same as v0.10.0. The verdict file is an enhancement, not a requirement.

**What if the JSON is malformed?**  
Log warning, fall back to test-only check. Never crash.

**What if the agent writes wrong data?**  
Validate required fields (`version`, `approved`, `tests`). Missing fields → fall back. The verdict is advisory — the independent test run is the ground truth for "tests pass."

---

# v0.10.1 Summary

Three features, cohesive release:

| Feature | Files Changed | Effort | Dependency |
|:--------|:-------------|:-------|:-----------|
| 1. `--status-file` | 3 (new `status-file.ts`, modify `runner.ts`, CLI) | Medium | None |
| 2. TDD Escalation Retry | 5 (types, orchestrator, execution stage, pipeline types, runner) | Medium | None |
| 3. Structured Verifier Verdicts | 4 (types, prompts, orchestrator, new `verdict.ts`) | Medium | Feature 2 (feeds `failureCategory`) |

**Total files:** 10 changed/new (some overlap — `types.ts` and `orchestrator.ts` touched by features 2+3).

**Breaking changes:** None. All features are additive/optional.

**Config changes:** None. Uses existing escalation config.

### Implementation Order

1. Feature 1 (`--status-file`) — independent, can ship alone
2. Feature 2 (TDD escalation) — core retry logic
3. Feature 3 (verifier verdicts) — builds on feature 2's `failureCategory`
