# Prompt-Audit Turn Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the prompt audit's `Turn:` an ordinal within one logical agent conversation on both transports, and give native records the session identity they already send to the provider.

**Architecture:** Native starts publishing `protocolIds` on its session handle, so `RecordId` exists on both transports. The round-trip count is then renamed end-to-end (`turn` → `roundTrips`) in a pure refactor that leaves the artifact byte-identical, and only after that does `PromptAuditor` begin assigning a per-`recordId` ordinal and rendering transport-specific round-trip labels. Splitting the rename from the behaviour change keeps the risky task small.

**Tech Stack:** TypeScript, Bun (test runner), Biome (lint/format).

**Spec:** `docs/superpowers/specs/2026-09-04-audit-turn-ordinal-design.md`

## Global Constraints

- **Branch:** all work lands on `feat/audit-turn-ordinal`. Verify with `git branch --show-current` before the first commit of every task.
- **Full test suite is `bun run test`. NEVER bare `bun test` for the suite** — it bypasses `scripts/run-tests.ts` and invents failures. Single-file iteration with `bun test <path> --timeout=5000` is correct and is what the steps below use.
- **File-size gate (`bun run lint`), SRC 600 / TEST 800.** Current sizes, all with room: `prompt-auditor.ts` 276, `manager-dispatch.ts` 294, `dispatch-events.ts` 262, `middleware/audit.ts` 52, `native/session/session.ts` 87.
- **Biome re-wraps on format**, so always `bun x biome check --write <files>` **then** `grep -c '' <file>`.
- **`check:alias-internals`** bans value-level `@/<dir>/<internal>` imports where `src/<dir>/index.ts` exists. Static `import type` is exempt; inline `import("@/dir/internal").X` type expressions are NOT. Use a relative path or a barrel for value imports.
- Before committing: biome format, `bun run typecheck`, `bun run lint`, `bun run test`.
- **Conventional commits.** No emojis in code, comments, or commit messages.
- TypeScript strict; no `any` without justification. Never mutate an input object — build a new one.
- **A regression test must be verified by REINTRODUCING the bug** and confirming failure. A test that passes under both the old and new behaviour proves nothing.

---

## File Structure

**Modified:**
- `src/agents/native/session/session.ts` (87) — `openNativeSession` publishes `protocolIds`.
- `src/runtime/prompt-auditor.ts` (276) — entry contract, the per-`recordId` ordinal counter, both render sites, the filename suffix.
- `src/runtime/dispatch-events.ts` (262) — `SessionTurnDispatchEvent.turn` renamed, `roundTripUnit` added.
- `src/agents/manager-dispatch.ts` (294) — populates the renamed fields and gains the explanatory remark.
- `src/runtime/middleware/audit.ts` (52) — forwards the renamed fields.

**Tests modified:**
- `test/unit/agents/native/session-lifecycle.test.ts`
- `test/unit/runtime/prompt-auditor.test.ts`
- `test/unit/runtime/middleware/audit.test.ts`
- `test/unit/runtime/dispatch-events.test.ts`
- `test/unit/runtime/middleware/{cost,logging,review-audit}.test.ts` — fixture field rename only
- `test/helpers/fake-agent-manager.ts` — fixture field rename only

No new files. The ordinal is a private field on the existing `PromptAuditor` class.

---

### Task 1: Native publishes a stable session identity

Implements spec story S1 and closes #1825 on its own. Independent of the other tasks — landable alone.

**Files:**
- Modify: `src/agents/native/session/session.ts`
- Modify: `src/runtime/prompt-auditor.ts` (one comment only)
- Test: `test/unit/agents/native/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `nativeSessionId(sessionKey: string): string` from `src/agents/native/session-affinity.ts` — a pure SHA-256 hash, first 32 hex chars, deliberately not memoised.
- Produces: a native `SessionHandle` whose `protocolIds` is `{ recordId: nativeSessionId(name), sessionId: nativeSessionId(name) }`. Task 3 keys its ordinal on `recordId`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/session-lifecycle.test.ts` inside the existing `describe("native session lifecycle", ...)` block:

```ts
  test("opening publishes the session identity it will send to the provider", async () => {
    const handle = await openNativeSession("sess-ids", opts());
    // Same value the adapter derives per call, so the audit trail records what
    // actually went on the wire rather than a parallel id.
    expect(handle.protocolIds?.recordId).toBe(nativeSessionId("sess-ids"));
    expect(handle.protocolIds?.sessionId).toBe(nativeSessionId("sess-ids"));
    await closeNativeSession(handle, false);
  });

  test("two different session names get different identities", async () => {
    const a = await openNativeSession("sess-one", opts());
    const b = await openNativeSession("sess-two", opts());
    expect(a.protocolIds?.recordId).not.toBe(b.protocolIds?.recordId);
    await closeNativeSession(a, false);
    await closeNativeSession(b, false);
  });
```

Add to that file's imports:

```ts
import { nativeSessionId } from "@/agents/native/session-affinity";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/native/session-lifecycle.test.ts --timeout=5000`
Expected: FAIL — `handle.protocolIds` is `undefined`, so `.recordId` is undefined rather than the hash.

- [ ] **Step 3: Publish the identity**

In `src/agents/native/session/session.ts`, add to the imports:

```ts
import { nativeSessionId } from "../session-affinity";
```

In `openNativeSession`, add `protocolIds` to the returned handle, after the `agentName` line:

```ts
  return {
    id: name,
    agentName: NATIVE_AGENT,
    // Both fields carry the same value on purpose. On ACP they differ because a
    // physical session can be re-established under a stable logical record;
    // native has no reconnect, so its logical and physical identity genuinely
    // coincide. `nativeSessionId` is a pure hash of the name and deliberately
    // not memoised, so this is exactly the id `sendTurn` later puts on the wire.
    protocolIds: { recordId: nativeSessionId(name), sessionId: nativeSessionId(name) },
    ...(opts.modelDef !== undefined ? { modelDef: opts.modelDef } : {}),
    ...(opts.modelTier !== undefined ? { modelTier: opts.modelTier } : {}),
  };
```

- [ ] **Step 4: Correct the misleading field comment**

In `src/runtime/prompt-auditor.ts`, the `PromptAuditEntry` fields are currently introduced as:

```ts
  /** ACP-specific session correlation fields. */
```

Replace that line with:

```ts
  /**
   * Session correlation fields, populated by any transport that has a session
   * identity. `recordId` is the stable logical record; `sessionId` is the
   * physical one, which can change on reconnect. They were assumed ACP-only,
   * which is why native records carried neither (#1825).
   */
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/agents/native/session-lifecycle.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Verify the gate by reintroducing the bug**

Temporarily delete the `protocolIds:` line from the returned handle and re-run.
Expected: FAIL on both new tests. Restore it and confirm PASS.

- [ ] **Step 7: Format, lint, typecheck, full suite**

```bash
bun x biome check --write src/agents/native/session/session.ts src/runtime/prompt-auditor.ts test/unit/agents/native/session-lifecycle.test.ts
grep -c '' src/agents/native/session/session.ts src/runtime/prompt-auditor.ts
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must be feat/audit-turn-ordinal
git add src/agents/native/session/session.ts src/runtime/prompt-auditor.ts test/unit/agents/native/session-lifecycle.test.ts
git commit -m "feat(native): publish session identity on the handle so audits record it (#1825)"
```

---

### Task 2: Rename the round-trip field end to end

A pure refactor. The rendered artifact must be **byte-identical** after this task — `Turn:` still shows the round-trip count and the suffix is unchanged. This exists so Task 3's behaviour change lands on a small, already-correct diff.

**Files:**
- Modify: `src/runtime/dispatch-events.ts`
- Modify: `src/agents/manager-dispatch.ts:91`
- Modify: `src/runtime/middleware/audit.ts:24`
- Modify: `src/runtime/prompt-auditor.ts`
- Test: `test/unit/runtime/prompt-auditor.test.ts`, `test/unit/runtime/middleware/audit.test.ts`, `test/unit/runtime/dispatch-events.test.ts`, `test/unit/runtime/middleware/{cost,logging,review-audit}.test.ts`, `test/helpers/fake-agent-manager.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `SessionTurnDispatchEvent.roundTrips: number` (was `turn`) and `SessionTurnDispatchEvent.roundTripUnit: "model-call" | "agent-run"`
  - `PromptAuditEntry.roundTrips?: number` (was `turn`) and `PromptAuditEntry.roundTripUnit?: "model-call" | "agent-run"`
  - Task 3 consumes both and adds the auditor-assigned ordinal.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/runtime/middleware/audit.test.ts`, inside its existing top-level `describe`:

```ts
  test("forwards the round-trip count and its unit onto the audit entry", () => {
    const bus = new DispatchEventBus();
    const recorded: PromptAuditEntry[] = [];
    const off = attachAuditSubscriber(
      bus,
      { record: (e) => recorded.push(e), recordError: () => {}, flush: async () => {} },
      "r-001",
    );
    bus.emitDispatch(makeSessionTurnEvent({ roundTrips: 4, roundTripUnit: "model-call" }));
    off();
    expect(recorded[0]?.roundTrips).toBe(4);
    expect(recorded[0]?.roundTripUnit).toBe("model-call");
  });
```

That file already has a `makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent>)` helper at the top — use it, do not add another. Because it is typed against the real event type, making `roundTripUnit` required in Step 3 will force you to add a default there (`roundTripUnit: "agent-run"`), and `turn: 1` in its defaults becomes `roundTrips: 1`. That compile error is expected and is the helper telling you where the contract moved.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/runtime/middleware/audit.test.ts --timeout=5000`
Expected: FAIL — `roundTrips` is not a known property; `recorded[0].roundTrips` is undefined.

- [ ] **Step 3: Rename on the dispatch event**

In `src/runtime/dispatch-events.ts`, in `SessionTurnDispatchEvent`, replace:

```ts
  readonly turn: number;
```

with:

```ts
  /**
   * Round-trips inside this turn. The UNIT differs by transport, which is why
   * `roundTripUnit` travels with it: on ACP each round-trip is a complete
   * delegated agent run, on native each is a single model call.
   */
  readonly roundTrips: number;
  readonly roundTripUnit: "model-call" | "agent-run";
```

- [ ] **Step 4: Populate them at the producer**

In `src/agents/manager-dispatch.ts`, replace:

```ts
    turn: result.internalRoundTrips ?? 1,
```

with:

```ts
    // `internalRoundTrips` counts a complete delegated agent run on ACP and a
    // single model call on native — nax owns the conversation loop there. The
    // unit travels with the number so nothing downstream has to infer it from
    // the agent name, and so the two are never compared as if they were alike.
    roundTrips: result.internalRoundTrips ?? 1,
    roundTripUnit: input.agentName === NATIVE_AGENT ? "model-call" : "agent-run",
```

`input.agentName` is the same expression the surrounding object already uses for its own `agentName` field, so no new plumbing is needed. Add the import if absent:

```ts
import { NATIVE_AGENT } from "./native/models";
```

- [ ] **Step 5: Forward them in the middleware**

In `src/runtime/middleware/audit.ts`, replace:

```ts
        turn: event.turn,
```

with:

```ts
        roundTrips: event.roundTrips,
        roundTripUnit: event.roundTripUnit,
```

- [ ] **Step 6: Rename on the audit entry, keeping output identical**

In `src/runtime/prompt-auditor.ts`, in `PromptAuditEntry`, replace:

```ts
  readonly turn?: number;
```

with:

```ts
  readonly roundTrips?: number;
  readonly roundTripUnit?: "model-call" | "agent-run";
```

Then update the two consumers so the rendered bytes do not change yet. In `deriveAuditSuffix`:

```ts
  if (entry.callType === "run" && entry.roundTrips !== undefined) {
    const stage = entry.stage ?? "run";
    return `${stage}-t${String(entry.roundTrips).padStart(2, "0")}`;
  }
```

and in `buildTxtContent`:

```ts
    ...(entry.roundTrips !== undefined ? [`Turn:       ${entry.roundTrips}`] : []),
```

- [ ] **Step 7: Update the remaining fixtures**

Rename the field in every test fixture that constructs one of these objects. Find them with:

```bash
grep -rn "turn: [0-9]" test/
```

Expected: 8 occurrences across `test/unit/runtime/prompt-auditor.test.ts`, `test/unit/runtime/middleware/{audit,cost,logging,review-audit}.test.ts`, `test/unit/runtime/dispatch-events.test.ts`, and `test/helpers/fake-agent-manager.ts`. Each becomes `roundTrips: <n>`, and any that construct a `SessionTurnDispatchEvent` also need `roundTripUnit: "agent-run"` since the field is required on that type.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/ --timeout=5000`
Expected: PASS.

- [ ] **Step 9: Prove the artifact did not change**

This task must not alter output. Confirm by asserting the rendered header still says `Turn:` with the round-trip count. Append to `test/unit/runtime/prompt-auditor.test.ts`:

```ts
  test("renaming the field did not change the rendered header or suffix", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", roundTrips: 4 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txt = written.find((w) => w.path.endsWith(".txt"));
      expect(txt?.path).toContain("-run-t04.txt");
      expect(txt?.data).toContain("Turn:       4");
    });
  });
```

Run: `bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000`
Expected: PASS. Task 3 will change both assertions deliberately.

- [ ] **Step 10: Format, lint, typecheck, full suite**

```bash
bun x biome check --write src/runtime/dispatch-events.ts src/agents/manager-dispatch.ts src/runtime/middleware/audit.ts src/runtime/prompt-auditor.ts test/unit/runtime test/helpers/fake-agent-manager.ts
grep -c '' src/runtime/dispatch-events.ts src/agents/manager-dispatch.ts src/runtime/prompt-auditor.ts
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 11: Commit**

```bash
git add src/runtime/dispatch-events.ts src/agents/manager-dispatch.ts src/runtime/middleware/audit.ts src/runtime/prompt-auditor.ts test/ 
git commit -m "refactor(runtime): rename the audit turn field to roundTrips and carry its unit"
```

---

### Task 3: Assign the ordinal and render transport-specific labels

Implements spec stories S2 and S3, and closes #1824. This is the behaviour change.

**Files:**
- Modify: `src/runtime/prompt-auditor.ts`
- Test: `test/unit/runtime/prompt-auditor.test.ts`

**Interfaces:**
- Consumes: `PromptAuditEntry.roundTrips` / `roundTripUnit` (Task 2), and `recordId` populated on native by Task 1.
- Produces: audit records whose `Turn:` and `-tNN` suffix are a per-`recordId` ordinal, and whose round-trip count renders as `ModelCalls:` or `AgentRuns:`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/runtime/prompt-auditor.test.ts`:

```ts
  test("numbers turns sequentially within one recordId, across differing session names", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      // Same logical conversation, different display names and stages — this is
      // the run -> rectification case. Keying on sessionName would restart at 1.
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", recordId: "rec-1", roundTrips: 4 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", stage: "run", recordId: "rec-1", roundTrips: 1 }));
      aud.record(
        makeEntry({ callType: "run", sessionName: "sess-b", stage: "rectification", recordId: "rec-1", roundTrips: 1 }),
      );
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.path).toContain("-run-t01.txt");
      expect(txts[1]?.path).toContain("-run-t02.txt");
      expect(txts[2]?.path).toContain("-rectification-t03.txt");
      expect(txts[0]?.data).toContain("Turn:       1");
      expect(txts[2]?.data).toContain("Turn:       3");
    });
  });

  test("a different recordId restarts the numbering", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", recordId: "rec-1", roundTrips: 1 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", recordId: "rec-2", roundTrips: 1 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.data).toContain("Turn:       1");
      expect(txts[1]?.data).toContain("Turn:       1");
    });
  });

  test("falls back to sessionName when no recordId is present", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", roundTrips: 1 }));
      aud.record(makeEntry({ callType: "run", sessionName: "sess-a", roundTrips: 1 }));
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[1]?.data).toContain("Turn:       2");
    });
  });

  test("renders the round-trip count under a label naming its unit", async () => {
    await withTempDir(async (dir) => {
      const written: Array<{ path: string; data: string }> = [];
      const orig = _promptAuditorDeps.write;
      _promptAuditorDeps.write = async (path: string, data: string) => {
        written.push({ path, data });
        return 0;
      };
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(
        makeEntry({ callType: "run", sessionName: "n", recordId: "r-n", roundTrips: 8, roundTripUnit: "model-call" }),
      );
      aud.record(
        makeEntry({ callType: "run", sessionName: "a", recordId: "r-a", roundTrips: 2, roundTripUnit: "agent-run" }),
      );
      await aud.flush();
      _promptAuditorDeps.write = orig;
      const txts = written.filter((w) => w.path.endsWith(".txt"));
      expect(txts[0]?.data).toContain("ModelCalls: 8");
      expect(txts[0]?.data).not.toContain("AgentRuns:");
      expect(txts[1]?.data).toContain("AgentRuns:  2");
      expect(txts[1]?.data).not.toContain("ModelCalls:");
    });
  });
```

Also update the Task 2 assertion that pinned the old output. Change the test `"renaming the field did not change the rendered header or suffix"` to expect the new behaviour, and rename it to `"a first turn renders as t01 regardless of its round-trip count"`:

```ts
      expect(txt?.path).toContain("-run-t01.txt");
      expect(txt?.data).toContain("Turn:       1");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000`
Expected: FAIL — suffixes read `-t04`/`-t01`/`-t01`, `Turn:` echoes the round-trip count, and no `ModelCalls:` or `AgentRuns:` line exists.

- [ ] **Step 3: Add the ordinal counter**

In `src/runtime/prompt-auditor.ts`, add a private field to the `PromptAuditor` class alongside the existing ones:

```ts
  /**
   * recordId (or sessionName when absent) -> turns seen so far.
   *
   * Keyed on the protocol's own identity rather than the display name: one
   * recordId spans separate sendTurn calls and stage changes, so it is what
   * says "still the same conversation". The map is per-auditor, and an auditor
   * is per-run, so the numbering's scope matches the audit directory's.
   */
  private readonly _turnOrdinals = new Map<string, number>();
```

Replace `record` so it assigns the ordinal without mutating the caller's entry:

```ts
  record(entry: PromptAuditEntry): void {
    this._enqueue(entry.callType === "run" ? { ...entry, turn: this._nextTurn(entry) } : entry);
  }

  private _nextTurn(entry: PromptAuditEntry): number {
    const key = entry.recordId ?? entry.sessionName ?? "";
    const next = (this._turnOrdinals.get(key) ?? 0) + 1;
    this._turnOrdinals.set(key, next);
    return next;
  }
```

Add the assigned field to `PromptAuditEntry`, marked as auditor-owned:

```ts
  /**
   * Position of this turn within its logical conversation, assigned by
   * PromptAuditor — callers do not set it. Distinct from `roundTrips`, which
   * counts iterations INSIDE one turn.
   */
  readonly turn?: number;
```

- [ ] **Step 4: Render the ordinal and the unit label**

In `deriveAuditSuffix`, switch from `roundTrips` to the ordinal:

```ts
  if (entry.callType === "run" && entry.turn !== undefined) {
    const stage = entry.stage ?? "run";
    return `${stage}-t${String(entry.turn).padStart(2, "0")}`;
  }
```

In `buildTxtContent`, replace the single `Turn:` line with the ordinal plus a unit-named count:

```ts
    ...(entry.turn !== undefined ? [`Turn:       ${entry.turn}`] : []),
    ...(entry.roundTrips !== undefined
      ? [
          entry.roundTripUnit === "agent-run"
            ? `AgentRuns:  ${entry.roundTrips}`
            : `ModelCalls: ${entry.roundTrips}`,
        ]
      : []),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Verify the key by reintroducing the bug**

Temporarily change `_nextTurn`'s key to ignore `recordId`:

```ts
    const key = entry.sessionName ?? "";
```

Run: `bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000`
Expected: FAIL on `"numbers turns sequentially within one recordId, across differing session names"` — the third record restarts at `t01` because its `sessionName` differs. That failure is the whole point of the test: a version using one session name throughout would pass under both keys and prove nothing. Restore `entry.recordId ?? entry.sessionName ?? ""`.

- [ ] **Step 7: Format, lint, typecheck, full suite**

```bash
bun x biome check --write src/runtime/prompt-auditor.ts test/unit/runtime/prompt-auditor.test.ts
grep -c '' src/runtime/prompt-auditor.ts test/unit/runtime/prompt-auditor.test.ts
bun run typecheck && bun run lint && bun run test
```

Expected: `prompt-auditor.ts` under 600, the test file under 800, suite green. Other suites may reference the old `Turn:` output — if any fail, update the assertion to the new format rather than reverting the renderer.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/prompt-auditor.ts test/unit/runtime/prompt-auditor.test.ts
git commit -m "feat(runtime): number audit turns per conversation and name the round-trip unit (#1824)"
```

---

## Live Verification

Run after all three tasks are green. Both issues are about a real artifact, so the unit tests are necessary but not sufficient.

- [ ] **Step 1: Build and run a native fixture from a copy**

```bash
bun run build   # embeds the commit; verify by naxCommit, never by --version
```

Run any native fixture from a **copy** — a nax run auto-commits onto the current branch.

- [ ] **Step 2: Confirm no suffix collisions within a session**

```bash
ls ~/.nax/<project>/prompt-audit/<feature>/ | sed -E 's/^[0-9]+-//' | sort | uniq -d
```

Expected: empty. Before this plan, a session with several retried turns produced repeated `-t01` names.

- [ ] **Step 3: Confirm native records carry their session identity**

```bash
grep -l "^SessionId:" ~/.nax/<project>/prompt-audit/<feature>/*.txt | wc -l
```

Expected: greater than zero, and the value should match `RecordId:` on native records.

- [ ] **Step 4: Confirm the unit label**

```bash
grep -h "^ModelCalls:\|^AgentRuns:" ~/.nax/<project>/prompt-audit/<feature>/*.txt | sort | uniq -c
```

Expected: `ModelCalls:` on a native run, `AgentRuns:` on an ACP run, never both in one record.

---

## Risks

1. **The filename suffix changes meaning on both transports.** `-tNN` becomes an ordinal. Anything grepping `-t10` to find round-trip-capped calls breaks — that grep is already obsolete since the cap was removed, and no other consumer of the suffix is known.
2. **`Turn:` changes meaning on ACP**, the incumbent transport, so old and new ACP records are not comparable. Accepted in the spec: leaving ACP alone would keep one field carrying two meanings, which is the defect itself.
3. **The ordinal is per `PromptAuditor` instance**, so a resumed run restarts numbering. That matches the audit directory's per-run scope.
4. **Task 2 must not change output.** If its Step 9 assertion fails, the refactor has leaked a behaviour change and should be corrected before Task 3 builds on it.
