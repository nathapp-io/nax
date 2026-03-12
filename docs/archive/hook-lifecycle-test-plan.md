# Hook Lifecycle Integration Test Plan

## Audit Summary (2026-02-19)

### Wiring Status

| Hook Event | Wired | Fire Points |
|:---|:---|:---|
| `on-start` | ✅ | Run begins (runner.ts:97) |
| `on-story-start` | ✅ | Before each story (runner.ts:252, 602) |
| `on-story-complete` | ✅ | After story passes (completion.ts:71) |
| `on-story-fail` | ✅ | After story fails/exhausts retries (runner.ts:358, 413, 434) |
| `on-pause` | ✅ | Cost limit, max iterations, user pause (runner.ts:236, 327, 455, 511, 526) |
| `on-resume` | ❌ | **Not wired** — no resume flow exists yet |
| `on-session-end` | ❌ | **Not wired** — no agent session lifecycle tracking |
| `on-complete` | ✅ | All stories done (runner.ts:167) |
| `on-error` | ❌ | **Not wired** — no global error handler fires it |

### Bugs / Issues Found

1. **BUG-13: `on-resume` never fires** — no resume mechanism exists in headless mode
2. **BUG-14: `on-session-end` never fires** — agent session completion not tracked at hook level
3. **BUG-15: `on-error` never fires** — unhandled errors crash without hook notification
4. **ISSUE: `on-pause` fires for 5 different reasons** — should context distinguish pause types?

---

## Integration Test Plan

### Test File: `test/hooks-integration.test.ts`

### Setup
- Create a mock hook script that logs events to a temp file
- Use minimal PRD with 2 stories (1 pass, 1 fail)
- Mock Claude agent to return controlled output
- Verify hook fire order and context by reading the log file

### Test Cases

#### 1. Happy Path — Full Lifecycle
```
Expected hook order:
  on-start (feature=test-feature)
  on-story-start (storyId=US-001)
  on-story-complete (storyId=US-001, status=pass)
  on-story-start (storyId=US-002)
  on-story-complete (storyId=US-002, status=pass)
  on-complete (status=complete, cost>0)
```

#### 2. Story Failure — Escalation Path
```
Expected hook order:
  on-start
  on-story-start (storyId=US-001)
  on-story-fail (storyId=US-001, status=fail, reason=tests_failed)
  on-story-start (storyId=US-001)  // retry
  on-story-fail (storyId=US-001)   // exhausted
  on-complete (status=complete)
```

#### 3. Cost Limit Pause
```
Expected hook order:
  on-start
  on-story-start
  on-story-complete
  on-pause (status=paused, reason=cost_limit)
```

#### 4. Max Iterations Pause
```
Expected:
  on-start
  on-story-start (repeated)
  on-pause (reason=max_iterations)
```

#### 5. Hook Failure Doesn’t Block Pipeline
```
Given: on-story-start hook exits with code 1
Expected: Pipeline continues, warning logged, story still executes
```

#### 6. Hook Timeout Doesn’t Block Pipeline
```
Given: on-story-start hook hangs for >5s
Expected: Hook killed after timeout, pipeline continues
```

#### 7. Context Data Accuracy
```
Verify for each hook:
  - feature name matches
  - storyId matches current story
  - cost is accumulated (not per-story)
  - model matches current tier
  - iteration number is correct
```

#### 8. Disabled Hook Skipped
```
Given: on-story-start.enabled = false in hooks.json
Expected: Hook not executed, no log entry
```

#### 9. Missing Hooks Graceful
```
Given: hooks.json has only on-start defined
Expected: All other events silently skipped
```

### Missing Hook Implementation (v0.8)

#### `on-error` — Wire into global error handler
```typescript
// In runner.ts, wrap main loop in try/catch:
try {
  // ... pipeline loop
} catch (err) {
  await fireHook(hooks, "on-error", hookCtx(feature, {
    status: "error",
    reason: err.message,
  }), workdir);
  throw err;
}
```

#### `on-session-end` — Wire after agent process exits
```typescript
// In pipeline after agent spawn completes:
await fireHook(hooks, "on-session-end", hookCtx(feature, {
  storyId: story.id,
  status: exitCode === 0 ? "success" : "failed",
  model: currentModel,
}), workdir);
```

#### `on-resume` — Wire when interactive resume happens
```typescript
// In TUI resume handler (not applicable in headless):
await fireHook(hooks, "on-resume", hookCtx(feature, {
  status: "resumed",
}), workdir);
```

---

*Plan created 2026-02-19*
