# SPEC: Bugfix Batch — BUG-085 through BUG-089

## Summary

Five bugs discovered from analysing the koda vcs-integration nax run (v0.54.1). Grouped by component:

| Bug | Component | Severity | Issue |
|:----|:----------|:---------|:------|
| BUG-085 | review/semantic | High | `complete()` passes no options (timeout, sessionName, workdir) |
| BUG-086 | review/semantic | Low | No info-level logging for start/pass/fail |
| BUG-087 | acceptance/setup | High | All refined ACs assigned to first story's storyId |
| BUG-088 | acceptance/generator | High | Acceptance tests fail with `Cannot find package` in monorepos — **descoped, separate spec needed** |
| BUG-089 | agents/acp | Medium | `complete()` timeout leaves stale ACP server in "agent needs reconnect" |

## Stories

---

### US-001: Semantic review complete() options + configurable timeout

**BUG-085 + BUG-086**

#### Problem

`src/review/semantic.ts` line 244 calls `agent.complete(prompt)` with zero options:
- No `sessionName` → timestamp-based ephemeral name, hard to trace
- No `workdir` → acpx has no cwd context
- No `timeoutMs` → falls back to 2-min global default, too short for large diffs
- No logging → no info-level log for start/pass/fail (typecheck and lint both log)

Observed: VCS-002 (medium complexity, NestJS monorepo, 8 ACs) timed out at exactly 120s. The prompt process was killed (SIGTERM, code 143), semantic review fail-opened silently. The biggest story — the one most likely to benefit from semantic review — got no review.

#### Changes

**1. Add `timeoutMs` to `SemanticReviewConfig`**

`src/config/schemas.ts` — add to `SemanticReviewConfigSchema`:
```ts
const SemanticReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000), // 10 min
});
```

`src/review/types.ts` — add to interface:
```ts
export interface SemanticReviewConfig {
  modelTier: import("../config/schema-types").ModelTier;
  rules: string[];
  timeoutMs: number; // new
}
```

`src/config/defaults.ts` — update default:
```ts
semantic: {
  modelTier: "balanced" as const,
  rules: [] as string[],
  timeoutMs: 600_000, // 10 min
},
```

**2. Pass options in `runSemanticReview()`**

`src/review/semantic.ts` — update the `agent.complete()` call:
```ts
rawResponse = await agent.complete(prompt, {
  sessionName: `nax-semantic-${story.id}`,
  workdir,
  timeoutMs: semanticConfig.timeoutMs,
});
```

Note: `workdir` is already a parameter of `runSemanticReview()` — just needs to be forwarded.

**3. Add info-level logging**

`src/review/semantic.ts` — add at start and end of `runSemanticReview()`:
```ts
// At start (after storyGitRef check):
logger?.info("review", `Running semantic check`, { storyId: story.id, modelTier: semanticConfig.modelTier });

// On success:
logger?.info("review", "Semantic review passed", { storyId: story.id, durationMs: Date.now() - startTime });

// On failure (before returning failed result):
logger?.warn("review", `Semantic review failed: ${parsed.findings.length} findings`, {
  storyId: story.id,
  durationMs: Date.now() - startTime,
});
```

#### Acceptance Criteria

1. Given `review.semantic.timeoutMs` is set to 300000 in config, when `runSemanticReview()` calls `agent.complete()`, then the options object includes `timeoutMs: 300000`
2. Given `review.semantic.timeoutMs` is not set, when `runSemanticReview()` calls `agent.complete()`, then the options object includes `timeoutMs: 600000` (default)
3. When `runSemanticReview()` calls `agent.complete()`, then the options include `sessionName` matching pattern `nax-semantic-<storyId>` and `workdir` matching the provided workdir
4. When semantic review starts (after the storyGitRef guard), then an info log `"Running semantic check"` is emitted with `storyId` and `modelTier`
5. When semantic review passes, then an info log `"Semantic review passed"` is emitted with `storyId` and `durationMs`
6. When semantic review fails with findings, then a warn log `"Semantic review failed: N findings"` is emitted with `storyId` and `durationMs`

#### Files

- `src/review/semantic.ts` — complete() options + logging
- `src/review/types.ts` — add `timeoutMs` to `SemanticReviewConfig`
- `src/config/schemas.ts` — add `timeoutMs` to schema
- `src/config/defaults.ts` — add default value
- `test/unit/review/semantic.test.ts` — new/updated tests

---

### US-002: Acceptance refinement per-story storyId assignment

**BUG-087**

#### Problem

`src/pipeline/stages/acceptance-setup.ts` line 148 flattens all story criteria into one array:
```ts
const allCriteria = ctx.prd.userStories
  .filter(s => !s.id.startsWith("US-FIX-"))
  .flatMap(s => s.acceptanceCriteria);
```

Then line 178 refines them all with a single storyId:
```ts
refinedCriteria = await _acceptanceSetupDeps.refine(allCriteria, {
  storyId: ctx.prd.userStories[0]?.id ?? "US-001",  // ALWAYS first story
  ...
});
```

Result: all 24 ACs in `acceptance-refined.json` have `"storyId": "VCS-001"`.

#### Changes

Refine per-story instead of all-at-once:

```ts
// Replace the single refine() call with per-story refinement
let refinedCriteria: RefinedCriterion[] = [];
const storiesToRefine = ctx.prd.userStories.filter(s => !s.id.startsWith("US-FIX-"));

if (ctx.config.acceptance.refinement) {
  for (const story of storiesToRefine) {
    const storyRefined = await _acceptanceSetupDeps.refine(story.acceptanceCriteria, {
      storyId: story.id,
      codebaseContext: "",
      config: ctx.config,
      testStrategy: ctx.config.acceptance.testStrategy,
      testFramework: ctx.config.acceptance.testFramework,
    });
    refinedCriteria.push(...storyRefined);
  }
} else {
  for (const story of storiesToRefine) {
    refinedCriteria.push(...story.acceptanceCriteria.map(c => ({
      original: c,
      refined: c,
      testable: true,
      storyId: story.id,
    })));
  }
}
```

**Note:** This changes refinement from 1 LLM call (all ACs) to N calls (one per story). For typical PRDs (3-5 stories), this adds ~10-15s but produces correct storyId attribution. The refinement prompt is short and fast-tier, so cost impact is minimal.

#### Acceptance Criteria

1. Given a PRD with stories VCS-001 (7 ACs), VCS-002 (8 ACs), VCS-003 (3 ACs), VCS-004 (6 ACs), when acceptance refinement runs, then `acceptance-refined.json` entries for VCS-001's ACs have `storyId: "VCS-001"`, VCS-002's have `storyId: "VCS-002"`, etc.
2. Given a PRD with a fix story `US-FIX-001`, when acceptance refinement runs, then the fix story's criteria are excluded from refinement (existing behavior preserved)
3. Given `acceptance.refinement: false` in config, when acceptance setup runs, then the non-LLM fallback also assigns per-story storyIds correctly

#### Files

- `src/pipeline/stages/acceptance-setup.ts` — per-story refinement loop
- `test/unit/pipeline/stages/acceptance-setup.test.ts` — updated tests

---

### ~~US-003: Acceptance test monorepo module resolution~~ — DESCOPED

**BUG-088 — tracked separately.** Requires architectural decision on per-package vs root-level acceptance tests in monorepos. See GitHub issue #49.

---

### US-003: Complete() timeout kills ACP server process tree

**BUG-089**

#### Problem

When `complete()` times out, the prompt process is killed (SIGTERM), and `acpx sessions close` runs. But the ACP server process tree (`npm exec claude-agent-acp → node → claude`) enters "agent needs reconnect" state and never exits.

This only happens on the **timeout path** — normal `complete()` calls clean up fine. The ACP server is started by `acpx sessions ensure` during `createSession()` and expects to serve future prompts. On timeout, the session is closed but the server remains waiting for a reconnect that never comes.

#### Changes

**In `SpawnAcpSession.close()`, after closing the session, terminate the ACP server if the session was force-closed (timeout/error path).**

`src/agents/acp/spawn-client.ts` — update `SpawnAcpSession.close()`:

```ts
async close(options?: { forceTerminate?: boolean }): Promise<void> {
  // Kill in-flight prompt process first (if any)
  if (this.activeProc) {
    try {
      this.activeProc.kill(15); // SIGTERM
      getSafeLogger()?.debug("acp-adapter", `Killed active prompt process PID ${this.activeProc.pid}`);
    } catch {
      // Process may have already exited
    }
    this.activeProc = null;
  }

  // Close the logical session
  const closeCmd = ["acpx", "--cwd", this.cwd, this.agentName, "sessions", "close", this.sessionName];
  getSafeLogger()?.debug("acp-adapter", `Closing session: ${this.sessionName}`);
  const closeProc = _spawnClientDeps.spawn(closeCmd, { stdout: "pipe", stderr: "pipe" });
  await closeProc.exited;

  // On timeout/error path: also stop the ACP server to prevent stale processes.
  // Normal complete() calls don't need this — the server exits on idle.
  if (options?.forceTerminate) {
    const stopCmd = ["acpx", "--cwd", this.cwd, this.agentName, "stop"];
    getSafeLogger()?.debug("acp-adapter", `Force-terminating ACP server for session: ${this.sessionName}`);
    const stopProc = _spawnClientDeps.spawn(stopCmd, { stdout: "pipe", stderr: "pipe" });
    await stopProc.exited;
  }
}
```

**In `complete()` finally block, call `session.close({ forceTerminate: true })` when an error occurred (timeout or other):**

`src/agents/acp/adapter.ts` — update `complete()` finally block:

```ts
} catch (err) {
  // ... existing error handling ...
  hadError = true;  // track that we're on the error path
  // ...
} finally {
  if (session) {
    await session.close({ forceTerminate: hadError }).catch(() => {});
  }
  await client.close().catch(() => {});
}
```

**Update `AcpSession` interface** to accept the optional parameter:

`src/agents/acp/adapter.ts`:
```ts
export interface AcpSession {
  close(options?: { forceTerminate?: boolean }): Promise<void>;
  // ...
}
```

#### Acceptance Criteria

1. When `complete()` times out and the prompt process is killed, then `session.close()` is called with `{ forceTerminate: true }` and `acpx <agent> stop` is executed
2. When `complete()` succeeds normally, then `session.close()` is called without `forceTerminate` (existing behavior preserved — server may exit on idle)
3. Given a timed-out `complete()` call, when the finally block executes, then no stale ACP server processes remain (verify via `pgrep -f claude-agent-acp` in test)
4. When `acpx <agent> stop` fails (e.g., server already exited), then the error is swallowed and logged at debug level

#### Files

- `src/agents/acp/spawn-client.ts` — `close()` with forceTerminate option
- `src/agents/acp/adapter.ts` — `AcpSession` interface + `complete()` error tracking
- `test/unit/agents/acp/spawn-client.test.ts` — new/updated tests

---

## Implementation Order

```
US-001 (semantic options + logging) → independent
US-002 (per-story storyId)         → independent  
US-003 (stale ACP cleanup)         → independent
```

All four are independent — can be done in any order or in parallel.

## Status

- **Spec:** Draft
- **GitHub Issues:** #46, #47, #48, #49, #50
