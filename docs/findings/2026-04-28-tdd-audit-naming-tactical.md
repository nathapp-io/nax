# Tactical Fix — TDD Audit Naming (sessionHint via tracked-session boundary)

**Date:** 2026-04-28
**Status:** Stopgap — superseded by ADR-020 D1 (third boundary) + D6 (typed `SessionRole`) when those land
**Discovered via:** `nax-dogfood/fixtures/tdd-calc/.nax/prompt-audit/tdd-calc/1777371175083-run-run-US-001.txt` (and two siblings) post-PR #783

## Problem

After PR #783 threaded `ctx.agentManager` through the TDD dispatch path, audit middleware fires for TDD sessions — but the resulting files are named `1777371175083-run-run-US-001.txt` instead of `*-test-writer.txt` / `*-implementer.txt` / `*-verifier.txt`.

The session **does** exist with the correct name (`nax-51a4d03c-tdd-calc-us-001-implementer`); the descriptor in `SessionManager.state.sessions` has the right role. The audit middleware never sees it.

## Root cause

Three dispatch paths, only two propagate session metadata into middleware ctx:

| Path | How session metadata reaches middleware |
|:---|:---|
| Single-session (`callOp` → `executeHop` → `runAsSession(agent, handle, ...)`) | `handle` is set on `ctx.sessionHandle` directly ✓ |
| One-shot (`completeAs(agent, prompt, opts)`) | `opts` is set on `ctx.completeOptions`; audit reads `sessionRole` ✓ |
| **Tracked-session (`runInSession(id, manager, req)` → `runTrackedSession` → `manager.run(req)`)** | **Nothing — descriptor info dropped on the floor ✗** |

`runTrackedSession` (`src/session/manager-run.ts:36`) calls `runner.run(injectedRequest)` blindly. The descriptor's role and computed sessionName never make it into `injectedRequest`, so the `runAs` envelope middleware sees `ctx.sessionHandle === undefined` and falls back to `sessionNameFromCompleteOptions`, which only reads `completeOptions` (also undefined for run-kind). Filename derives from `${ts}-${callType}-${stage}-${storyId}` — `1777371175083-run-run-US-001`.

## Fix

Inject a typed `sessionHint` from descriptor metadata into `runOptions` at the tracked-session boundary; teach audit middleware to read it as a third fallback.

This is symptom-suppression — it adds a third scrape source, not a structural emit-from-boundary fix. ADR-020 D1 replaces all three scrape sources with `DispatchEvent` emission from the three concrete boundaries; this patch ships that fix's outcome for TDD without waiting for the full ADR.

## Changes

### `src/agents/types.ts` (or wherever `AgentRunOptions` is declared)

Add a typed optional `sessionHint` field:

```typescript
export interface AgentRunOptions {
  // ... existing fields
  /**
   * Tracked-session boundary hint — populated by SessionManager.runTrackedSession
   * from the session descriptor before invoking runner.run(). Audit/cost middleware
   * read this when ctx.sessionHandle is unset (the runAs envelope path) so files
   * are named by role instead of falling back to "run-run-<storyId>".
   *
   * Set ONLY by SessionManager.runTrackedSession. Do not set at any other call site.
   * Superseded by ADR-020 D1 (DispatchEvent emission from tracked-session boundary).
   */
  sessionHint?: { sessionName: string; role: string };
}
```

### `src/session/manager-run.ts` — populate from descriptor

In `runTrackedSession`, between the descriptor lookup and `runner.run()`:

```typescript
const descriptor = state.sessions.get(id)!;            // already exists at line 42
const sessionName = state.nameFor({                    // NEW
  workdir: descriptor.workdir,
  featureName: descriptor.featureName,
  storyId: descriptor.storyId,
  role: descriptor.role,
});

const injectedRequest: SessionManagedRunRequest = {
  ...request,
  runOptions: {
    ...request.runOptions,
    sessionHint: { sessionName, role: descriptor.role },   // NEW
    onSessionEstablished: (protocolIds, name) => { /* unchanged */ },
  },
};
```

`SessionManager` already exposes `nameFor` (used at `tdd/session-runner.ts:271`). If `state.nameFor` isn't directly accessible from inside `runTrackedSession`, pass it in via the `state` bag (one extra field).

### `src/runtime/middleware/audit.ts` — read as third fallback

Update the `sessionName` resolution at line 38:

```typescript
const sessionName =
  ctx.sessionHandle?.id ??
  ctx.request?.runOptions?.sessionHint?.sessionName ??   // NEW: tracked-session path
  sessionNameFromCompleteOptions(ctx);
```

Skip-guard at line 30 stays as-is for now (still needed until D1's structural fix lands).

### `src/runtime/middleware/cost.ts` — same

Mirror the same one-line addition for cost attribution.

## Test

`test/integration/tdd/audit-naming.test.ts` (new):

```typescript
test("TDD three-session run produces per-role audit files", async () => {
  await runTddDogfood({ feature: "tdd-calc", story: "US-001" });

  const files = await listAuditFiles("tdd-calc");
  const roles = files.map(extractRoleFromFilename);

  expect(roles).toContain("test-writer");
  expect(roles).toContain("implementer");
  expect(roles).toContain("verifier");
  expect(roles).not.toContain("run");   // no run-run-US-001 files
});
```

## Total

| File | LOC |
|:---|:---|
| `src/agents/types.ts` | +12 (typed field + comment) |
| `src/session/manager-run.ts` | +8 (descriptor → sessionHint) |
| `src/runtime/middleware/audit.ts` | +1 (third fallback) |
| `src/runtime/middleware/cost.ts` | +1 (third fallback) |
| `test/integration/tdd/audit-naming.test.ts` | +50 (new test) |
| **Source total** | **~22 LOC** |

## Validation

- Re-run `tdd-calc` dogfood. Expected files:
  - `<ts>-nax-51a4d03c-tdd-calc-us-001-test-writer.txt`
  - `<ts>-nax-51a4d03c-tdd-calc-us-001-implementer.txt`
  - `<ts>-nax-51a4d03c-tdd-calc-us-001-verifier.txt`
- Existing single-session and complete-call audit files unchanged (untouched code paths).

## Out of scope

- The acceptance role drift (`-acceptance` vs `-acceptance-gen` in filenames) is a separate bug — `sessionRole` is free-form string and some path passes the truncated value. Fix lands with ADR-020 D6 (typed `SessionRole` SSOT). This patch does not address it.
- Restructuring audit/cost as `DispatchEvent` subscribers — ADR-020 Wave 1.
- Removing `wrapAdapterAsManager` from public exports — ADR-020 Wave 2.

## Replacement timeline

This patch should be deleted in the PR that lands ADR-020 Wave 1:

- `AgentRunOptions.sessionHint` removed (no caller after `runTrackedSession` emits `DispatchEvent` directly)
- Audit/cost middleware rewritten as event subscribers, all three scrape paths deleted

The `sessionHint` field name is intentionally distinct from `sessionHandle` and `completeOptions` so the deprecation grep is unambiguous.
