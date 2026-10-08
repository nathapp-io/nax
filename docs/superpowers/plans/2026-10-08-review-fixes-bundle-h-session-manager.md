# Review Fixes Bundle H — Session-Manager Races

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** The RACE-37 single-flight guard is never released mid-open, and a session reopened after `closeStory` is never born cancelled.

**Architecture:** Two small edits to `SessionManager` (`packages/nax/src/session/manager.ts`). Task 1 lets `openSession`'s close-then-reopen path close the old session WITHOUT dropping the guard, instead of dropping and re-adding it across an `await`. Task 2 clears a stale cancel flag when `openSession` creates a brand-new descriptor.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #8, #24.

**Branch:** `git fetch origin && git checkout -b fix/review-h-session-manager origin/main`

## Global Constraints

See the master plan. **`manager.ts` is grandfathered at 664 lines and may NOT grow by one line.** The two tasks below are written to net −2 lines together (Task 1 is −3, Task 2 is +1). Run `wc -l src/session/manager.ts` after each task; it must print ≤ 664. Do not reformat unrelated code (biome may reflow a line you touch; if it adds lines, shorten your comment instead).

## Files

- Modify: `packages/nax/src/session/manager.ts:422-429` (Task 1), `:466-475` (Task 2), `:511, 532` (Task 1)
- Test: `packages/nax/test/unit/session/manager-phase-b-session.test.ts` (429 lines)

---

### Task 1: Close-then-reopen keeps the single-flight guard held (#8)

`openSession` adds `name` to `_busySessions` as its single-flight guard. On close-then-reopen, `openSessionImpl` awaits `closeSession(liveHandle)`, which deletes the marker at its end; `openSessionImpl` re-adds it only in the NEXT microtask after the await resumes. A second `openSession(name)` scheduled in between passes the guard and runs `adapter.openSession` concurrently; the loser's physical session is orphaned. Fix: `closeSession` takes an internal `keepOpenGuard` flag so the marker is never dropped.

**Files:**
- Modify: `packages/nax/src/session/manager.ts`
- Test: `packages/nax/test/unit/session/manager-phase-b-session.test.ts`

**Interfaces:**
- `closeSession(handle: SessionHandle, keepOpenGuard = false): Promise<void>`. The `ISessionManager` interface (`session/types.ts:322`) keeps `closeSession(handle)`; the extra optional parameter is implementation-only and only `openSessionImpl` passes `true`.

- [ ] **Step 1: Write the failing test**

Append a new describe at the end of `manager-phase-b-session.test.ts`:

```ts
describe("openSession() close-then-reopen — RACE-37 guard", () => {
  test("the single-flight marker is not released until the reopen has finished", async () => {
    const log: string[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        log.push(`adapter.open:${opts.agentName}`);
        const handle: SessionHandle = { id: name, agentName: opts.agentName };
        return handle;
      }),
      closeSession: mock(async () => {
        log.push("adapter.close");
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const name = "nax-race-guard";
    await sm.openSession(name, makeOpenRequest({ agentName: "claude" }));

    // Element access reaches the private guard set (see .claude/rules/test-ratchets.md).
    const busy = sm["_busySessions"];
    const realDelete = busy.delete.bind(busy);
    busy.delete = (value: string) => {
      log.push(`busy.delete:${value}`);
      return realDelete(value);
    };
    log.length = 0;

    // A different agent forces close-then-reopen (endpoint-identity.ts decideReuse).
    await sm.openSession(name, makeOpenRequest({ agentName: "codex" }));

    // The ONLY release is openSession's own finally, after the new adapter session exists.
    expect(log).toEqual(["adapter.close", "adapter.open:codex", `busy.delete:${name}`]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `timeout 30 bun test test/unit/session/manager-phase-b-session.test.ts --timeout=5000`
Expected: FAIL — the log has an extra `busy.delete:nax-race-guard` between `adapter.close` and `adapter.open:codex`.

- [ ] **Step 3: Implement**

In `manager.ts`:

1. Replace lines 424-429:

```ts
    if (liveHandle && reuse === "close-then-reopen") {
      // closeSession clears _busySessions for this name; openSession set that marker
      // as its single-flight guard and still needs it for the rest of this open.
      await this.closeSession(liveHandle);
      this._busySessions.add(name);
    } else if (liveHandle) this._liveHandles.delete(name);
```

with:

```ts
    // RACE-37: keep openSession's single-flight marker held across the close's await.
    if (liveHandle && reuse === "close-then-reopen") await this.closeSession(liveHandle, true);
    else if (liveHandle) this._liveHandles.delete(name);
```

2. Change the `closeSession` signature line (~511):

```ts
  async closeSession(handle: SessionHandle): Promise<void> {
```

to:

```ts
  async closeSession(handle: SessionHandle, keepOpenGuard = false): Promise<void> {
```

3. Change the busy-marker line near the end of `closeSession` (~532):

```ts
    this._busySessions.delete(handle.id);
```

to:

```ts
    if (!keepOpenGuard) this._busySessions.delete(handle.id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/session/ --timeout=5000`
Expected: PASS. Run `wc -l src/session/manager.ts` — expect 661.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/session/manager.ts packages/nax/test/unit/session/manager-phase-b-session.test.ts
git commit -m "fix(session): hold the RACE-37 guard across close-then-reopen (review #8)"
```

---

### Task 2: A brand-new session never inherits a stale cancel flag (#24)

`closeStory` deletes a still-RUNNING descriptor during teardown. If that session's in-flight turn then ends abort-shaped, `sendPrompt`'s catch adds the name to `_cancelledSessions` with no descriptor left to transition. A later `openSession` of the same name takes the create branch, which never clears the flag, so the new session's first `sendPrompt` throws `SESSION_CANCELLED` forever. The terminal→RUNNING reopen branch already clears it; the create branch must too.

**Files:**
- Modify: `packages/nax/src/session/manager.ts:466-475`
- Test: `packages/nax/test/unit/session/manager-phase-b-session.test.ts`

- [ ] **Step 1: Write the failing test**

Add `makeTurnResult` to the `@test/helpers` import, then append inside the describe added in Task 1 (or a new describe right after it):

```ts
  test("a session reopened after closeStory is not born cancelled by its predecessor's abort", async () => {
    const controller = new AbortController();
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turns = 0;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => {
        const handle: SessionHandle = { id: name, agentName: "claude" };
        return handle;
      }),
      sendTurn: mock(async () => {
        turns += 1;
        if (turns === 1) {
          await turnGate;
          controller.abort();
          throw new Error("aborted");
        }
        return makeTurnResult({ output: "ok" });
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const request = makeOpenRequest({ storyId: "US-1" });
    const first = await sm.openSession("nax-stale-cancel", request);

    const inFlight = sm.sendPrompt(first, "work", { signal: controller.signal });
    sm.closeStory("US-1"); // run teardown removes the descriptor while the turn is in flight
    releaseTurn();
    await expect(inFlight).rejects.toThrow("aborted");

    const reopened = await sm.openSession("nax-stale-cancel", request);
    await expect(sm.sendPrompt(reopened, "next")).resolves.toMatchObject({ output: "ok" });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/session/manager-phase-b-session.test.ts --timeout=5000`
Expected: FAIL — the second `sendPrompt` rejects with `SESSION_CANCELLED`.

- [ ] **Step 3: Implement**

In `openSessionImpl`, the create branch:

```ts
    if (!existingDescriptor) {
      const created = this.create({
```

becomes:

```ts
    if (!existingDescriptor) {
      this._cancelledSessions.delete(name); // a predecessor deleted by closeStory may have left it (#24)
      const created = this.create({
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/session/ --timeout=5000`
Expected: PASS, including `"throws SESSION_CANCELLED after signal abort during turn"` in `manager-phase-b-prompt.test.ts` (that session keeps its descriptor, so it never reaches the create branch). `wc -l src/session/manager.ts` — expect 662.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/session/manager.ts packages/nax/test/unit/session/manager-phase-b-session.test.ts
git commit -m "fix(session): a newly created session clears a stale cancel flag (review #24)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `session`. `manager.ts` shrank (664 → 662), so lower its grandfathered baseline in the same PR, and only after `bun run check:all` is green: from `packages/nax`, `bun run check:file-sizes:update`, then confirm `git diff scripts/baselines/file-sizes-baseline.json` changes ONLY the `src/session/manager.ts` entry (664 → 662). Commit it as `chore(session): lower manager.ts size baseline`.
