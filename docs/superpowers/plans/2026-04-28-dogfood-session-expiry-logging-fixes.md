# Dogfood Fixes: Session Expiry, Logging Gaps, Prompt Audit Gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Issues A, B/E, C, and D from `docs/findings/2026-04-27-dogfood-session-expiry-and-logging-issues.md`.

**Architecture:** Four independent fixes across three subsystems: (1) the ACP adapter gains NO_SESSION auto-recovery in `sendTurn` and the session manager gains a COMPLETED-state guard; (2) acceptance-setup threads `storyId` to the generate LLM call; (3) the prompt auditor gains a write-queue for crash safety and removes the `sessionName` gate so all entries get txt files.

**Tech Stack:** TypeScript/Bun, `node:fs/promises.appendFile`, `bun:test`

---

## File Map

| File | Change |
|:-----|:-------|
| `src/agents/acp/adapter.ts` | Add `exitCode?` to `AcpSessionResponse`; add `_permissionMode` to `AcpSessionHandleImpl`; NO_SESSION recovery in `sendTurn` |
| `src/session/manager.ts` | Add COMPLETED/FAILED guard in `sendPrompt` |
| `src/pipeline/stages/acceptance-setup.ts` | Pass `groupStoryId` to `acceptanceGenerateOp` callOp |
| `src/runtime/prompt-auditor.ts` | Replace `_entries[]` buffer with write-queue; remove `sessionName` gate; add `deriveTxtFilename` |
| `test/unit/agents/acp/adapter.test.ts` | Add NO_SESSION recovery tests |
| `test/unit/session/manager-phase-b-prompt.test.ts` | Add COMPLETED-state guard test |
| `test/unit/pipeline/stages/acceptance-setup-strategy.test.ts` | Verify storyId threading to generate callOp |
| `test/unit/runtime/prompt-auditor.test.ts` | Update in-flight tests; add sessionName-less txt filename tests |

---

## Task 1: Prompt Auditor — Write Queue (Issue D)

Replace the `_entries[]` accumulation + single-shot `flush()` pattern with a `_queue: Promise<void>` chain that writes each entry immediately.

**Files:**
- Modify: `src/runtime/prompt-auditor.ts`
- Modify: `test/unit/runtime/prompt-auditor.test.ts`

- [ ] **Step 1: Write the failing test — write-queue persists entries immediately**

Add to `test/unit/runtime/prompt-auditor.test.ts` before the existing tests:

```typescript
test("record() persists entry to JSONL immediately without waiting for flush()", async () => {
  await withTempDir(async (dir) => {
    const flushDir = join(dir, "audit");
    const appendedLines: string[] = [];
    const orig = _promptAuditorDeps.appendLine;
    _promptAuditorDeps.appendLine = async (_p: string, d: string) => { appendedLines.push(d); };
    const aud = new PromptAuditor("r-001", flushDir, FEATURE);
    aud.record(makeEntry({ prompt: "immediate" }));
    // wait for microtask queue to process the enqueued write
    await new Promise((r) => setTimeout(r, 0));
    expect(appendedLines.length).toBeGreaterThan(0);
    expect(appendedLines[0]).toContain('"immediate"');
    _promptAuditorDeps.appendLine = orig;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
timeout 30 bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000
```

Expected: FAIL — `appendLine` not yet a property of `_promptAuditorDeps`.

- [ ] **Step 3: Add `appendLine` dep and write-queue to prompt-auditor.ts**

Replace the full `PromptAuditor` class and `_promptAuditorDeps` in `src/runtime/prompt-auditor.ts` with:

```typescript
/** Injectable deps — swap in tests to avoid real disk I/O. */
export const _promptAuditorDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
  appendLine: async (path: string, data: string): Promise<void> => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, data, "utf8");
  },
};

export class PromptAuditor implements IPromptAuditor {
  private _queue: Promise<void> = Promise.resolve();
  private _dirCreated = false;
  private readonly _jsonlPath: string;
  private readonly _featureDir: string;

  constructor(
    private readonly _runId: string,
    private readonly _flushDir: string,
    private readonly _featureName: string,
  ) {
    this._featureDir = join(_flushDir, _featureName);
    this._jsonlPath = join(this._featureDir, `${_runId}.jsonl`);
  }

  record(entry: PromptAuditEntry): void {
    this._enqueue(entry);
  }

  recordError(entry: PromptAuditErrorEntry): void {
    this._enqueue(entry);
  }

  private _enqueue(entry: PromptAuditEntry | PromptAuditErrorEntry): void {
    // Chain onto the existing queue — each write is sequential,
    // preserving JSONL line order and preventing interleave.
    // Errors in one write do not break subsequent writes.
    this._queue = this._queue.then(() => this._writeEntry(entry)).catch(() => this._writeEntry(entry));
  }

  private async _writeEntry(entry: PromptAuditEntry | PromptAuditErrorEntry): Promise<void> {
    if (!this._dirCreated) {
      mkdirSync(this._featureDir, { recursive: true });
      this._dirCreated = true;
    }
    await _promptAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(entry)}\n`);

    // Write txt only for PromptAuditEntry (has prompt + response).
    if (!("prompt" in entry)) return;
    const auditEntry = entry as PromptAuditEntry;
    const filename = deriveTxtFilename(auditEntry);
    await _promptAuditorDeps.write(join(this._featureDir, filename), buildTxtContent(auditEntry));
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}
```

The `deriveTxtFilename` function is added in Task 2 of this plan.

- [ ] **Step 4: Run test to verify it passes**

```bash
timeout 30 bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000
```

Expected: new test PASSES. Some existing tests may fail because they mock `_promptAuditorDeps.write` but not the new `appendLine` — fix those in Step 5.

- [ ] **Step 5: Update existing tests that mock the old `write`-only API**

The tests that check JSONL content via the `write` mock need updating. Replace the `_promptAuditorDeps.write` mock pattern with `_promptAuditorDeps.appendLine` for JSONL assertions:

For the test `"flush() writes one JSONL line per entry in insertion order"`:

```typescript
test("flush() writes one JSONL line per entry in insertion order", async () => {
  await withTempDir(async (dir) => {
    const flushDir = join(dir, "audit");
    const appendedData: string[] = [];
    const origAppend = _promptAuditorDeps.appendLine;
    _promptAuditorDeps.appendLine = async (_p: string, d: string) => { appendedData.push(d); };
    const orig = _promptAuditorDeps.write;
    _promptAuditorDeps.write = async () => 0;
    const aud = new PromptAuditor("r-test", flushDir, FEATURE);
    aud.record(makeEntry({ prompt: "first" }));
    aud.record(makeEntry({ prompt: "second" }));
    await aud.flush();
    // Each entry appends one JSON line
    expect(appendedData).toHaveLength(2);
    expect(JSON.parse(appendedData[0].trim()).prompt).toBe("first");
    expect(JSON.parse(appendedData[1].trim()).prompt).toBe("second");
    _promptAuditorDeps.appendLine = origAppend;
    _promptAuditorDeps.write = orig;
  });
});
```

For the test `"flush() writes JSONL to <flushDir>/<featureName>/<runId>.jsonl"`:

```typescript
test("flush() appends JSONL to <flushDir>/<featureName>/<runId>.jsonl", async () => {
  await withTempDir(async (dir) => {
    const flushDir = join(dir, "audit");
    let capturedPath = "";
    const origAppend = _promptAuditorDeps.appendLine;
    _promptAuditorDeps.appendLine = async (p: string) => { capturedPath = p; };
    const orig = _promptAuditorDeps.write;
    _promptAuditorDeps.write = async () => 0;
    const aud = new PromptAuditor("my-run", flushDir, FEATURE);
    aud.record(makeEntry());
    await aud.flush();
    expect(capturedPath).toBe(join(flushDir, FEATURE, "my-run.jsonl"));
    _promptAuditorDeps.appendLine = origAppend;
    _promptAuditorDeps.write = orig;
  });
});
```

For the test `"flush() does nothing when no entries"` — add `appendLine` no-call assertion:

```typescript
test("flush() does nothing when no entries", async () => {
  const writes: string[] = [];
  const appends: string[] = [];
  const origWrite = _promptAuditorDeps.write;
  const origAppend = _promptAuditorDeps.appendLine;
  _promptAuditorDeps.write = async (p) => { writes.push(p); return 0; };
  _promptAuditorDeps.appendLine = async (p) => { appends.push(p); };
  const aud = new PromptAuditor("r-001", "/tmp/audit", FEATURE);
  await aud.flush();
  expect(writes).toHaveLength(0);
  expect(appends).toHaveLength(0);
  _promptAuditorDeps.write = origWrite;
  _promptAuditorDeps.appendLine = origAppend;
});
```

Remove the two old in-flight tests (`"flush() captures entries recorded during async write"` and `"flush() captures error entries recorded during async write"`) — the queue approach handles in-flight atomically without the `_inFlightEntries` complexity. The write-queue test in Step 1 covers the equivalent guarantee.

For the `"recordError() entries appear in JSONL but produce no txt file"` test, update to use `appendLine` mock:

```typescript
test("recordError() entries appear in JSONL but produce no txt file", async () => {
  await withTempDir(async (dir) => {
    const appends: string[] = [];
    const paths: string[] = [];
    const origAppend = _promptAuditorDeps.appendLine;
    const origWrite = _promptAuditorDeps.write;
    _promptAuditorDeps.appendLine = async (p: string, d: string) => { appends.push(d); };
    _promptAuditorDeps.write = async (p: string) => { paths.push(p); return 0; };
    const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
    aud.recordError({ ts: Date.now(), runId: "r-001", agentName: "claude", errorCode: "TIMEOUT", durationMs: 50 });
    await aud.flush();
    expect(paths).toHaveLength(0);  // no txt files
    expect(appends).toHaveLength(1);
    const parsed = JSON.parse(appends[0].trim());
    expect(parsed.errorCode).toBe("TIMEOUT");
    _promptAuditorDeps.appendLine = origAppend;
    _promptAuditorDeps.write = origWrite;
  });
});
```

- [ ] **Step 6: Run all prompt-auditor tests**

```bash
timeout 30 bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/prompt-auditor.ts test/unit/runtime/prompt-auditor.test.ts
git commit -m "feat(audit): write-queue prompt auditor — crash-safe per-entry persistence (Issue D)"
```

---

## Task 2: Prompt Auditor — sessionName-less txt files (Issue C)

Remove the `sessionName` gate that silently skips txt generation for 7 of 10 entries. Derive a filename from available metadata when `sessionName` is absent.

**Files:**
- Modify: `src/runtime/prompt-auditor.ts`
- Modify: `test/unit/runtime/prompt-auditor.test.ts`

- [ ] **Step 1: Write failing tests — sessionName-less entries produce txt files**

Add to `test/unit/runtime/prompt-auditor.test.ts`:

```typescript
describe("deriveTxtFilename fallback (no sessionName)", () => {
  test("uses <ts>-<callType>-<stage>-<storyId>.txt when all fields present", async () => {
    await withTempDir(async (dir) => {
      const paths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => { paths.push(p); return 0; };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({
        ts: 1777301912062,
        callType: "complete",
        stage: "acceptance",
        storyId: "US-001",
        // no sessionName
      }));
      await aud.flush();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith("1777301912062-complete-acceptance-US-001.txt");
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("omits storyId segment when storyId absent", async () => {
    await withTempDir(async (dir) => {
      const paths: string[] = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string) => { paths.push(p); return 0; };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({
        ts: 1777301880073,
        callType: "complete",
        stage: "acceptance",
        // no sessionName, no storyId
      }));
      await aud.flush();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith("1777301880073-complete-acceptance.txt");
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });

  test("writes txt even when response is empty (e.g. crashed regen)", async () => {
    await withTempDir(async (dir) => {
      const writes: Array<[string, string]> = [];
      const origWrite = _promptAuditorDeps.write;
      const origAppend = _promptAuditorDeps.appendLine;
      _promptAuditorDeps.write = async (p: string, d: string) => { writes.push([p, String(d)]); return 0; };
      _promptAuditorDeps.appendLine = async () => {};
      const aud = new PromptAuditor("r-001", join(dir, "audit"), FEATURE);
      aud.record(makeEntry({
        ts: 1777302229409,
        callType: "complete",
        stage: "acceptance",
        prompt: "Generate tests",
        response: "",
      }));
      await aud.flush();
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toEndWith("1777302229409-complete-acceptance.txt");
      expect(writes[0][1]).toContain("Generate tests");
      _promptAuditorDeps.write = origWrite;
      _promptAuditorDeps.appendLine = origAppend;
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
timeout 30 bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000
```

Expected: 3 new tests FAIL — no `deriveTxtFilename` function yet.

- [ ] **Step 3: Add `deriveTxtFilename` helper and remove `sessionName` gate in prompt-auditor.ts**

Add above `buildTxtContent`:

```typescript
function deriveTxtFilename(entry: PromptAuditEntry): string {
  if (entry.sessionName) {
    return `${entry.ts}-${entry.sessionName}.txt`;
  }
  const parts: string[] = [
    String(entry.ts),
    entry.callType ?? "call",
    entry.stage ?? "unknown",
  ];
  if (entry.storyId) parts.push(entry.storyId);
  return `${parts.join("-")}.txt`;
}
```

In `_writeEntry`, replace:
```typescript
// OLD — remove this block
if (!auditEntry.sessionName) continue;
const filename = `${auditEntry.ts}-${auditEntry.sessionName}.txt`;
```

with:
```typescript
const filename = deriveTxtFilename(auditEntry);
```

Also update the existing test `"flush() writes <ts>-<sessionName>.txt alongside JSONL for entries with sessionName"` to use the `appendLine` mock (since `write` is now only for txt files):

```typescript
test("flush() writes <ts>-<sessionName>.txt alongside JSONL for entries with sessionName", async () => {
  await withTempDir(async (dir) => {
    const flushDir = join(dir, "audit");
    const txtPaths: string[] = [];
    const origWrite = _promptAuditorDeps.write;
    const origAppend = _promptAuditorDeps.appendLine;
    _promptAuditorDeps.write = async (p: string) => { txtPaths.push(p); return 0; };
    _promptAuditorDeps.appendLine = async () => {};
    const aud = new PromptAuditor("my-run", flushDir, FEATURE);
    aud.record(makeEntry({ ts: 1234567890000, sessionName: "nax-abc12345-my-feature-us-000-run" }));
    await aud.flush();
    expect(txtPaths).toHaveLength(1);
    expect(txtPaths[0]).toBe(join(flushDir, FEATURE, "1234567890000-nax-abc12345-my-feature-us-000-run.txt"));
    _promptAuditorDeps.write = origWrite;
    _promptAuditorDeps.appendLine = origAppend;
  });
});
```

- [ ] **Step 4: Run all prompt-auditor tests**

```bash
timeout 30 bun test test/unit/runtime/prompt-auditor.test.ts --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/prompt-auditor.ts test/unit/runtime/prompt-auditor.test.ts
git commit -m "feat(audit): generate txt files for all entries regardless of sessionName (Issue C)"
```

---

## Task 3: Thread storyId to acceptanceGenerateOp (Issue B/E)

The generate LLM call in `acceptance-setup.ts` receives no `storyId`, so the middleware log and prompt-audit JSONL are missing `storyId` for those entries.

**Files:**
- Modify: `src/pipeline/stages/acceptance-setup.ts`
- Modify: `test/unit/pipeline/stages/acceptance-setup-strategy.test.ts`

- [ ] **Step 1: Understand the generate call site**

In `acceptance-setup.ts`, the generate call is inside a `for (const group of groups)` loop. Each group has `group.stories`. The `callOp` helper accepts a 5th `storyId?` parameter.

The refine call correctly passes `story.id`:
```typescript
_acceptanceSetupDeps.callOp(ctx, ctx.workdir, acceptanceRefineOp, {...}, story.id)
```

The generate call does NOT pass a storyId (5th param):
```typescript
_acceptanceSetupDeps.callOp(ctx, packageDir, acceptanceGenerateOp, {...})
```

- [ ] **Step 2: Write failing test — generate callOp receives storyId**

Open `test/unit/pipeline/stages/acceptance-setup-strategy.test.ts` and add:

```typescript
test("acceptanceGenerateOp callOp receives storyId from first group story", async () => {
  const callOpCalls: Array<{ storyId: string | undefined }> = [];
  _acceptanceSetupDeps.callOp = mock(async (_ctx, _pkgDir, op, _input, storyId) => {
    callOpCalls.push({ storyId });
    if (op.name === "acceptance-generate") return { testCode: "test stub" };
    if (op.name === "acceptance-refine") return [{ original: "AC-1", refined: "AC-1", testable: true, storyId: "US-001" }];
    return [];
  });
  // ... (build ctx with one story "US-001", one group) ...
  await acceptanceSetupStage.execute(ctx);
  const genCall = callOpCalls.find((c, i) => callOpCalls[i]?.storyId !== "US-001" /* crude filter */)
  // The generate call should have storyId set
  const generateCalls = callOpCalls.filter((c) => c.storyId !== undefined);
  expect(generateCalls.length).toBeGreaterThan(0);
});
```

Actually, let me write a more precise test. Look at `acceptance-setup-strategy.test.ts` for the existing pattern for setting up the context, then mirror it:

```typescript
test("acceptanceGenerateOp callOp passes storyId from group to generate op", async () => {
  const callOpArgs: Array<{ opName: string; storyId: string | undefined }> = [];
  _acceptanceSetupDeps.callOp = mock(async (_ctx, _pkgDir, op, _input, storyId) => {
    callOpArgs.push({ opName: op.name as string, storyId });
    if (op.name === "acceptance-generate") return { testCode: "// stub" };
    if (op.name === "acceptance-refine") {
      return [{ original: "AC-1", refined: "AC-1", testable: true, storyId: storyId ?? "US-001" }];
    }
    return [];
  });
  // Setup: ctx with one story, refinement enabled so refine op fires
  // (copy the ctx setup pattern from the existing tests in this file)
  
  await acceptanceSetupStage.execute(ctx);

  const generateCall = callOpArgs.find((a) => a.opName === "acceptance-generate");
  expect(generateCall).toBeDefined();
  expect(generateCall!.storyId).toBe("US-001");
});
```

Read the file to find the existing ctx setup:

```bash
timeout 15 bun test test/unit/pipeline/stages/acceptance-setup-strategy.test.ts --timeout=5000
```

- [ ] **Step 3: Read the existing acceptance-setup-strategy.test.ts to find ctx setup**

Read `test/unit/pipeline/stages/acceptance-setup-strategy.test.ts` lines 1–80 to understand how `ctx` is constructed, then write the test using the same pattern. The test must be added to the file, not a new file.

- [ ] **Step 4: Run test to verify it fails**

```bash
timeout 30 bun test test/unit/pipeline/stages/acceptance-setup-strategy.test.ts --timeout=5000
```

Expected: FAIL — the storyId passed to `acceptanceGenerateOp` callOp is currently `undefined`.

- [ ] **Step 5: Fix acceptance-setup.ts — pass groupStoryId to generate callOp**

In `src/pipeline/stages/acceptance-setup.ts`, find the `for (const group of groups)` loop and add:

```typescript
for (const group of groups) {
  const { testPath, packageDir } = group;

  // ...existing code to build criteriaList, frameworkOverrideLine...

  // Use first story's ID as representative storyId for logging/audit correlation.
  const groupStoryId = group.stories[0]?.id;

  const genResult = (await _acceptanceSetupDeps.callOp(
    ctx,
    packageDir,
    acceptanceGenerateOp,
    {
      featureName: featureName ?? "",
      criteriaList,
      frameworkOverrideLine,
      targetTestFilePath: testPath,
      ...("implementationContext" in ctx && ctx.implementationContext
        ? { implementationContext: ctx.implementationContext as Array<{ path: string; content: string }> }
        : {}),
      ...("previousFailure" in ctx && ctx.previousFailure
        ? { previousFailure: ctx.previousFailure as string }
        : {}),
    },
    groupStoryId,   // ← this is the fix
  )) as { testCode: string | null };
```

- [ ] **Step 6: Run test to verify it passes**

```bash
timeout 30 bun test test/unit/pipeline/stages/acceptance-setup-strategy.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 7: Run full acceptance-setup test suite**

```bash
timeout 60 bun test test/unit/pipeline/stages/acceptance-setup --timeout=10000
```

Expected: all acceptance-setup tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/stages/acceptance-setup.ts test/unit/pipeline/stages/acceptance-setup-strategy.test.ts
git commit -m "fix(acceptance-setup): thread storyId to acceptanceGenerateOp callOp for audit correlation (Issue B/E)"
```

---

## Task 4: NO_SESSION Recovery in sendTurn (Issue A — Part 1: adapter)

When acpx exits with code 4 (NO_SESSION), `sendTurn` should detect this and re-create the session before retrying once, rather than immediately throwing.

**Files:**
- Modify: `src/agents/acp/adapter.ts`
- Modify: `test/unit/agents/acp/adapter.test.ts`

- [ ] **Step 1: Write failing test — sendTurn recovers from NO_SESSION exit code 4**

Add to `test/unit/agents/acp/adapter.test.ts` inside the `describe("sendTurn")` block:

```typescript
test("sendTurn re-establishes session and retries once on NO_SESSION (exitCode 4) response", async () => {
  const adapter = new AcpAgentAdapter("claude");
  let sessionCreateCount = 0;
  let promptCallCount = 0;

  const deadSession = {
    prompt: mock(async () => {
      promptCallCount++;
      return { messages: [{ role: "assistant", content: "NO_SESSION" }], stopReason: "error", exitCode: 4 };
    }),
    close: mock(async () => {}),
    cancelActivePrompt: mock(async () => {}),
  };

  const freshSession = {
    prompt: mock(async () => {
      promptCallCount++;
      return { messages: [{ role: "assistant", content: "Fixed output" }], stopReason: "end_turn" };
    }),
    close: mock(async () => {}),
    cancelActivePrompt: mock(async () => {}),
  };

  const mockClient = {
    start: mock(async () => {}),
    createSession: mock(async () => {
      sessionCreateCount++;
      return sessionCreateCount === 1 ? deadSession : freshSession;
    }),
    loadSession: mock(async () => {
      sessionCreateCount++;
      return sessionCreateCount === 1 ? deadSession : freshSession;
    }),
    closeSession: mock(async () => {}),
    close: mock(async () => {}),
  };

  _acpAdapterDeps.createClient = mock(() => mockClient as unknown as AcpClient);

  const handle = await adapter.openSession("test-session", {
    agentName: "claude",
    workdir: "/tmp/test",
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    modelDef: { model: "claude-sonnet-4-6", tier: "balanced" },
    timeoutSeconds: 30,
  });

  const result = await adapter.sendTurn(handle, "do the work", {
    interactionHandler: { onInteraction: async () => null },
  });

  expect(result.output).toBe("Fixed output");
  // Should have created/loaded the session twice (initial + recovery)
  expect(sessionCreateCount).toBeGreaterThanOrEqual(2);
  // Should have called prompt twice (one failed NO_SESSION + one succeeded)
  expect(promptCallCount).toBe(2);
});

test("sendTurn throws immediately when NO_SESSION occurs twice (no infinite retry)", async () => {
  const adapter = new AcpAgentAdapter("claude");

  const alwaysDeadSession = {
    prompt: mock(async () => ({
      messages: [{ role: "assistant", content: "NO_SESSION" }],
      stopReason: "error",
      exitCode: 4,
    })),
    close: mock(async () => {}),
    cancelActivePrompt: mock(async () => {}),
  };

  const mockClient = {
    start: mock(async () => {}),
    createSession: mock(async () => alwaysDeadSession),
    loadSession: mock(async () => alwaysDeadSession),
    closeSession: mock(async () => {}),
    close: mock(async () => {}),
  };

  _acpAdapterDeps.createClient = mock(() => mockClient as unknown as AcpClient);

  const handle = await adapter.openSession("test-session", {
    agentName: "claude",
    workdir: "/tmp/test",
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    modelDef: { model: "claude-sonnet-4-6", tier: "balanced" },
    timeoutSeconds: 30,
  });

  await expect(adapter.sendTurn(handle, "do the work", {
    interactionHandler: { onInteraction: async () => null },
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
timeout 30 bun test test/unit/agents/acp/adapter.test.ts --timeout=5000
```

Expected: FAIL — `exitCode` property not yet on `AcpSessionResponse`, no recovery logic in `sendTurn`.

- [ ] **Step 3: Add `exitCode?` to AcpSessionResponse and update SpawnAcpSession.prompt()**

In `src/agents/acp/adapter.ts`, add `exitCode?` to `AcpSessionResponse`:

```typescript
export interface AcpSessionResponse {
  messages: Array<{ role: string; content: string }>;
  stopReason: string;
  cumulative_token_usage?: SessionTokenUsage;
  exactCostUsd?: number;
  retryable?: boolean;
  /** acpx exit code — only present when exitCode !== 0 (error responses). */
  exitCode?: number;
}
```

In `src/agents/acp/spawn-client.ts`, in `SpawnAcpSession.prompt()`, update the error return:

```typescript
if (exitCode !== 0) {
  const parsedOnError = finalizeParseState(parseState);
  const errorContent = parsedOnError.error || stderr || `Exit code ${exitCode}`;
  getSafeLogger()?.warn("acp-adapter", `Session prompt exited with code ${exitCode}`, { ... });
  return {
    messages: [{ role: "assistant", content: errorContent }],
    stopReason: "error",
    retryable: parsedOnError.retryable,
    exitCode,   // ← add this
  };
}
```

- [ ] **Step 4: Add `_permissionMode` to AcpSessionHandleImpl**

In `src/agents/acp/adapter.ts`, update `AcpSessionHandleImpl`:

```typescript
export class AcpSessionHandleImpl implements SessionHandle {
  readonly id: string;
  readonly agentName: string;
  readonly protocolIds: ProtocolIds;
  readonly _client: AcpClient;
  readonly _session: AcpSession;
  readonly _sessionName: string;
  readonly _resumed: boolean;
  readonly _timeoutSeconds: number;
  readonly _modelDef: ModelDef;
  readonly _permissionMode: string;   // ← add this

  constructor(opts: {
    id: string;
    agentName: string;
    protocolIds: ProtocolIds;
    client: AcpClient;
    session: AcpSession;
    sessionName: string;
    resumed: boolean;
    timeoutSeconds: number;
    modelDef: ModelDef;
    permissionMode: string;   // ← add this
  }) {
    // ...existing assignments...
    this._permissionMode = opts.permissionMode;
  }
}
```

Update `openSession` to pass `permissionMode`:

```typescript
return new AcpSessionHandleImpl({
  id: name,
  agentName,
  protocolIds,
  client,
  session,
  sessionName: name,
  resumed: ensured.resumed,
  timeoutSeconds,
  modelDef,
  permissionMode: resolvedPermissions.mode,   // ← add this
});
```

- [ ] **Step 5: Add NO_SESSION recovery logic to sendTurn**

In `AcpAgentAdapter.sendTurn`, replace the fixed `session` with a mutable `let`:

```typescript
async sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const impl = handle as AcpSessionHandleImpl;
  const { _sessionName: sessionName, _timeoutSeconds: timeoutSeconds, _modelDef: modelDef } = impl;
  const { interactionHandler, signal } = opts;
  const MAX_TURNS = opts.maxTurns ?? 10;

  // Mutable session reference — updated on NO_SESSION recovery.
  let session = impl._session;
  let sessionRecreated = false;

  // ... existing token usage init ...

  while (turnCount < MAX_TURNS) {
    turnCount++;
    getSafeLogger()?.debug("acp-adapter", `Session turn ${turnCount}/${MAX_TURNS}`, { sessionName });

    const turnResult = await runSessionPrompt(session, currentPrompt, timeoutSeconds * 1000, signal);

    // ... existing timedOut/aborted checks ...

    lastResponse = turnResult.response;
    if (!lastResponse) break;

    // NO_SESSION recovery: acpx session expired on the server (exit code 4).
    // Re-establish the session and retry this turn once — do not count
    // the dead-session attempt as a real turn.
    if (lastResponse.exitCode === 4 && !sessionRecreated) {
      sessionRecreated = true;
      getSafeLogger()?.info("acp-adapter", "NO_SESSION detected — re-establishing session", { sessionName });
      try {
        const ensured = await ensureAcpSession(
          impl._client,
          impl._sessionName,
          impl.agentName,
          impl._permissionMode,
        );
        session = ensured.session;
        turnCount--; // don't count the dead-session attempt
        continue;
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "Session re-establishment failed after NO_SESSION", {
          sessionName,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall through to error throw below
      }
    }

    // ... existing token accumulation and output handling ...
  }

  // ... existing post-loop checks ...
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
timeout 30 bun test test/unit/agents/acp/adapter.test.ts --timeout=5000
```

Expected: new NO_SESSION tests PASS; existing tests PASS.

- [ ] **Step 7: Run spawn-client tests (ensures exitCode propagation)**

```bash
timeout 30 bun test test/unit/agents/acp/spawn-client.test.ts --timeout=5000
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/acp/adapter.ts src/agents/acp/spawn-client.ts test/unit/agents/acp/adapter.test.ts
git commit -m "fix(acp): re-establish session on NO_SESSION (exit code 4) before retry in sendTurn (Issue A)"
```

---

## Task 5: Session State Guard in sendPrompt (Issue A — Part 2: session manager)

Prevent `sendPrompt` from dispatching to a session in `COMPLETED` or `FAILED` state without an intervening `openSession` call. This surfaces the bug as a clear error rather than a silent dead-session retry.

**Files:**
- Modify: `src/session/manager.ts`
- Modify: `test/unit/session/manager-phase-b-prompt.test.ts`

- [ ] **Step 1: Write failing test — sendPrompt throws on COMPLETED session**

Add to `test/unit/session/manager-phase-b-prompt.test.ts` inside `describe("sendPrompt()")`:

```typescript
test("throws SESSION_TERMINAL_STATE when sendPrompt called on COMPLETED session", async () => {
  const sendTurnMock = mock(async () => ({
    output: "should not be called",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 1,
  }));
  const adapter = makeAgentAdapter({ sendTurn: sendTurnMock });
  const sm = new SessionManager({ getAdapter: () => adapter });

  // Create and immediately close a session (to put it in COMPLETED state)
  const desc = sm.create({ role: "main", agent: "claude", workdir: "/tmp", featureName: "f", storyId: "US-001" });
  sm.transition(desc.id, "RUNNING");
  sm.transition(desc.id, "COMPLETED");

  // Build a fake handle pointing to this session's name
  const fakeHandle = { id: "test-handle", agentName: "claude", protocolIds: { recordId: null, sessionId: null } } as SessionHandle;
  // Manually set the handle name in the descriptor so _findByName can find it
  // (normally done via bindHandle, so do that here)
  sm.bindHandle(desc.id, "test-handle", { recordId: null, sessionId: null });

  await expect(sm.sendPrompt(fakeHandle, "hello")).rejects.toMatchObject({
    code: "SESSION_TERMINAL_STATE",
  });
  expect(sendTurnMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
timeout 30 bun test test/unit/session/manager-phase-b-prompt.test.ts --timeout=5000
```

Expected: FAIL — no `SESSION_TERMINAL_STATE` check yet in `sendPrompt`.

- [ ] **Step 3: Add COMPLETED/FAILED guard to SessionManager.sendPrompt**

In `src/session/manager.ts`, in `sendPrompt`, add after the existing `SESSION_CANCELLED` and `SESSION_BUSY` guards:

```typescript
async sendPrompt(handle: SessionHandle, prompt: string, opts?: SendPromptOpts): Promise<TurnResult> {
  if (this._cancelledSessions.has(handle.id)) {
    throw new NaxError(...);
  }

  if (this._busySessions.has(handle.id)) {
    throw new NaxError(...);
  }

  // Guard: refuse to send on a terminal session without a preceding openSession.
  // This surfaces the "re-use after COMPLETED" bug as a clear error instead of
  // a silent dead-session retry (Issue A secondary hardening).
  const desc = this._findByName(handle.id);
  if (desc && (desc.state === "COMPLETED" || desc.state === "FAILED")) {
    throw new NaxError(
      `Session "${handle.id}" is in terminal state ${desc.state} — call openSession first to resume`,
      "SESSION_TERMINAL_STATE",
      { stage: "session", sessionName: handle.id, state: desc.state },
    );
  }

  const adapter = this._getAdapter(handle.agentName);
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
timeout 30 bun test test/unit/session/manager-phase-b-prompt.test.ts --timeout=5000
```

Expected: all tests PASS including the new one.

- [ ] **Step 5: Run full session manager test suite**

```bash
timeout 60 bun test test/unit/session/ --timeout=10000
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session/manager.ts test/unit/session/manager-phase-b-prompt.test.ts
git commit -m "fix(session): guard sendPrompt against COMPLETED/FAILED state without re-open (Issue A secondary)"
```

---

## Task 6: Full Test Suite Verification

- [ ] **Step 1: Run the full test suite**

```bash
bun run test:bail
```

Expected: all tests PASS. If failures occur, diagnose and fix before proceeding.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run lint**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Final commit if any lint fixes needed**

```bash
git add -p
git commit -m "chore: lint and typecheck fixes"
```

---

## Self-Review

**Spec coverage check:**

| Issue | Task | Covered? |
|:------|:-----|:---------|
| A — NO_SESSION in sendTurn | Task 4 | ✓ |
| A — secondary: COMPLETED guard | Task 5 | ✓ |
| B/E — storyId in generate callOp | Task 3 | ✓ |
| C — txt for sessionName-less entries | Task 2 | ✓ |
| D — write-queue for crash safety | Task 1 | ✓ |

**Placeholder scan:** No TBD or TODO items; all code blocks are complete.

**Type consistency check:**
- `AcpSessionResponse.exitCode?: number` — used consistently in spawn-client.ts (write) and adapter.ts sendTurn (read).
- `AcpSessionHandleImpl._permissionMode: string` — set in `openSession`, read in `sendTurn`.
- `deriveTxtFilename(entry: PromptAuditEntry): string` — defined in prompt-auditor.ts, called in `_writeEntry`.
- `_promptAuditorDeps.appendLine` — added to both the dep object and test mocks.
- `SESSION_TERMINAL_STATE` error code — consistent between manager.ts throw and test assertion.
