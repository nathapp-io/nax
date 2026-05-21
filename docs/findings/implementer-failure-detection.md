# Bug: `implementerOp` doesn't detect failure when using `fakeAgentManager`

## Failing Test

```
test/integration/tdd/story-orchestrator-core.test.ts
  → "failure when implementer session fails" (line 121)
  Expected: false
  Received: true
```

## What the Test Does

```typescript
const agent = createMockAgent([
  { success: true,  estimatedCostUsd: 0.01 },  // call 0: test-writer → succeeds
  { success: false, exitCode: 1, estimatedCostUsd: 0.02 },  // call 1: implementer → should fail
]);
const plan = buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", ...);
const result = await plan.run();
expect(result.success).toBe(false);  // FAILS — gets true
```

## Root Cause

**`fakeAgentManager.runWithFallback` ignores `req.executeHop` and calls `adapter.sendTurn` directly.** This creates a mismatch in error output format between test and production.

### Production flow (real `AgentManager`)

```
callOp
  → agentManager.runWithFallback({ ..., executeHop: buildHopCallback(...), ... })
    → real AgentManager CALLS executeHop
      → buildHopCallback
        → adapter.sendTurn()  [THROWS "Agent failed"]
        → catch block: output = `Agent "mock" failed: Agent failed`
  → rawOutput = 'Agent "mock" failed: Agent failed'
  → implementerOp.parse('Agent "mock" failed: ...') → startsWith('Agent "') → success: false ✓
```

### Test flow (`fakeAgentManager`)

```
callOp
  → fakeAgentManager.runWithFallback({ ..., executeHop: buildHopCallback(...), ... })
    → fakeAgentManager IGNORES executeHop, calls adapter.sendTurn DIRECTLY
      → adapter.sendTurn()  [THROWS "Agent failed"]
      → catch block: output = err.message = "Agent failed"  ← NO prefix
  → rawOutput = "Agent failed"
  → implementerOp.parse("Agent failed")
    → NOT empty
    → "Agent failed".startsWith('Agent "') = FALSE  ← no quote after "Agent "
    → parseSessionJsonOutput("Agent failed") = { success: false, filesChanged: [] }
    → BUT implementerOp.parse returns { success: true, ... }  ← hardcoded!
```

### Key files

| File | Relevant section |
|---|---|
| `test/helpers/fake-agent-manager.ts:63` | `runWithFallback` — ignores `req.executeHop`, calls `adapter.sendTurn` directly |
| `src/operations/build-hop-callback.ts:256-283` | catch block — prefixes output with `Agent "${agentName}" failed: ${errMessage}` |
| `src/operations/implement.ts:39-50` | `implementerOp.parse` — `startsWith('Agent "')` heuristic only catches the prefixed format |
| `test/integration/tdd/_tdd-test-helpers.ts:82-83` | `createMockAgent.sendTurn` — throws `new Error(r.output ?? "Agent failed")` on failure |

## The Tension

`implementerOp` is used in BOTH:
1. **Single-session (no-test) strategy** — agent outputs plain prose; must return `success: true`
2. **TDD three-session strategy** — agent failure injects an error string; must return `success: false`

`testWriterOp` avoids this problem because TDD agents always emit structured JSON  
(`{ "success": bool, "filesChanged": [...] }`), so `parseSessionJsonOutput` works perfectly.

For `implementerOp`, plain prose → `parseSessionJsonOutput` returns `{ success: false }`, which  
would break single-session strategies if used naively.

## Attempted Fixes (and Why They Failed)

### Attempt 1: `!outcome.result.success` check in `callOp` (before `!rawOutput` guard)
- Broke `call.test.ts` — test had `{ success: false, output: "" }` expecting `CALL_OP_NO_OUTPUT` throw

### Attempt 2: `!outcome.result.success` check in `callOp` (after `!rawOutput` guard)
- Fixed TDD tests ✓
- Broke 5 debate runner tests — `statefulDebaterOp.parse("")` was being invoked differently:
  debate runner uses `allSettledBounded` which handles thrown errors via `{ status: 'rejected' }`,
  but the `callOp` check was making non-empty debate outputs throw instead of returning `{ success: false }`

### Attempt 3 (current): `output.startsWith('Agent "')` in `implementerOp.parse()`
- Works for production flow (buildHopCallback prefix)
- FAILS for test flow (`fakeAgentManager` outputs bare `"Agent failed"` without prefix)

## Candidate Fixes

### Option A: Make `fakeAgentManager.runWithFallback` call `req.executeHop` when provided

**Concept**: When `callOp` passes `executeHop: buildHopCallback(...)`, `fakeAgentManager` should call it instead of going directly to `adapter.sendTurn`. This aligns test behavior with production and makes `buildHopCallback`'s error prefix appear in tests too.

```typescript
// test/helpers/fake-agent-manager.ts
runWithFallback: async (req) => {
  if (req.executeHop) {
    const hopResult = await req.executeHop({ kind: "initial" });
    return { result: hopResult.result, fallbacks: [] };
  }
  // existing direct-sendTurn path for tests that don't go through callOp
  ...
}
```

**Risk**: This changes behavior for ALL tests using `fakeAgentManager`. Need to verify that the `executeHop` path handles `openSession`/`closeSession` correctly in the `buildHopCallback` context.

**Benefit**: Tests match production semantics. The `startsWith('Agent "')` heuristic in `implementerOp.parse()` works correctly.

### Option B: Change `createMockAgent` to throw with the prefixed format

**Concept**: Make the mock throw `new Error('Agent "mock" failed: ...')` so the output has the expected prefix in both test and production paths.

```typescript
// test/integration/tdd/_tdd-test-helpers.ts
if (r.success === false) {
  throw new Error(`Agent "mock" failed: ${r.output ?? "Agent failed"}`);
}
```

In `fakeAgentManager`, the catch sets `output: err.message` = `'Agent "mock" failed: Agent failed'`,  
which `startsWith('Agent "')` correctly detects.

**Risk**: Changes the semantics of `createMockAgent` throw format. Double-prefix in production  
(`'Agent "mock" failed: Agent "mock" failed: ...'`) but still works since `startsWith` still matches.

**Benefit**: Minimal change, no impact on fakeAgentManager.

### Option C: Detect failure via `outcome.result.success` only for run-kind ops

**Concept**: Add `!outcome.result.success` check in `callOp` run-kind path only, converting  
to a throw. The debate runner tests that broke were using complete-kind ops (`statefulDebaterOp`  
actually uses run-kind too, so need to check what exactly broke).

**Risk**: Need to carefully re-audit the 5 debate tests that previously broke to understand  
if they fail due to genuine logic issue or test setup issue.

## Recommendation

**Option A** is the most principled fix — it closes the gap between test and production  
execution paths in `fakeAgentManager`. Option B is the minimal-impact path if Option A  
has hidden side effects.

Before implementing, verify:
1. Does `buildHopCallback` (the `executeHop`) need `sessionManager` to be present? In `fakeAgentManager`, `openSession`/`closeSession` are mocked.
2. Do any existing tests call `fakeAgentManager.runWithFallback` without `executeHop` and rely on the direct-sendTurn behavior?

## Files to Examine

- `src/agents/manager.ts` — real `runWithFallback` to understand the `executeHop` calling convention
- `test/helpers/fake-agent-manager.ts:63-158` — the `runWithFallback` that needs patching
- `src/operations/build-hop-callback.ts` — `executeHop` shape, what `{ kind: "initial" }` means
- `test/integration/tdd/_tdd-test-helpers.ts:61-98` — `createMockAgent` sendTurn behavior
- `test/integration/debate/` — the 5 tests that broke in Attempt 2, to understand if Option C is safe
