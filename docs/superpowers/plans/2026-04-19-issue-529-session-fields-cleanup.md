# Issue #529 — Legacy AgentRunOptions Session Fields Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three legacy session-control symbols from `src/` so the Phase 4 gate check (`grep -rn "buildSessionName\|keepSessionOpen\|acpSessionName" src/`) returns 0 hits: rename `buildSessionName` → `computeAcpHandle`, rename `keepSessionOpen` → `keepOpen`, and remove the `acpSessionName` field from `AgentRunOptions` (replacing it with `sessionHandle` for the rare cases that need an explicit override).

**Architecture:** `acpSessionName` is redundant in every call site except `dialogue.ts` — callers already pass `featureName`, `storyId`, and `sessionRole`, so the adapter can auto-derive the same name. For callers that needed the explicit value (e.g. to pass to `closeSession()`), they call the renamed `computeAcpHandle`. `keepSessionOpen` is a pure rename to `keepOpen`. `buildSessionName` is renamed to `computeAcpHandle` everywhere (both the export and all import sites). Net result: call sites become simpler (no manual pre-computation of session names), and the Phase 4 gate unblocks.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, bun:test

---

## File Map

| Action | File | What changes |
|:---|:---|:---|
| Modify | `src/agents/acp/adapter.ts` | Rename `buildSessionName` → `computeAcpHandle`; rename `keepSessionOpen` → `keepOpen` in run() finally; drop `options.acpSessionName` tier, add `options.sessionHandle` tier |
| Modify | `src/agents/types.ts` | Remove `acpSessionName` field; add `sessionHandle`; rename `keepSessionOpen` → `keepOpen`; update Phase 5.5 comment |
| Modify | `src/debate/session-helpers.ts` | Update import + call: `buildSessionName` → `computeAcpHandle` |
| Modify | `src/pipeline/stages/autofix-adversarial.ts` | Update import; remove `acpSessionName:` line (auto-derived); rename `keepSessionOpen:` → `keepOpen:` |
| Modify | `src/pipeline/stages/autofix.ts` | Same as autofix-adversarial |
| Modify | `src/pipeline/stages/execution.ts` | Rename `keepSessionOpen` variable → `keepOpen`; rename field pass |
| Modify | `src/acceptance/fix-executor.ts` | Update import; remove `acpSessionName:` line |
| Modify | `src/acceptance/fix-diagnosis.ts` | Update import; remove `acpSessionName:` line |
| Modify | `src/review/adversarial.ts` | Update import; remove `acpSessionName:` line; rename `keepSessionOpen:` → `keepOpen:` |
| Modify | `src/review/semantic.ts` | Same as adversarial |
| Modify | `src/review/dialogue.ts` | Rename `acpSessionName` local → `sessionHandle`; rename field pass; rename `keepSessionOpen:` → `keepOpen:` |
| Modify | `src/debate/session-stateful.ts` | Rename param + field pass: `keepSessionOpen` → `keepOpen` |
| Modify | `src/verification/rectification-loop.ts` | Update import; remove `acpSessionName:` line; rename `keepSessionOpen:` → `keepOpen:` |
| Modify | `src/execution/merge-conflict-rectify.ts` | Update dynamic import: `buildSessionName` → `computeAcpHandle` |
| Modify | `src/tdd/session-runner.ts` | Update import; rename `acpSessionName` variable + field pass; rename `keepSessionOpen` variable + field pass |
| Modify | `src/tdd/rectification-gate.ts` | Update import; remove `acpSessionName:` line; rename `keepSessionOpen:` → `keepOpen:` |
| Create | `test/unit/agents/session-fields-invariants.test.ts` | Source invariant tests — greps src for all three legacy symbols |

---

### Task 1: Write the source invariant tests (they must fail now)

**Files:**
- Create: `test/unit/agents/session-fields-invariants.test.ts`

- [ ] **Step 1: Write failing invariant tests**

```typescript
// test/unit/agents/session-fields-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

function grepSrc(pattern: RegExp): string[] {
  const hits: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const src = readFileSync(full, "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) {
          hits.push(`${full.replace(ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  walk(join(ROOT, "src"));
  return hits;
}

describe("Legacy session field cleanup (#529 invariants)", () => {
  test("buildSessionName is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/buildSessionName/);
    expect(hits).toEqual([]);
  });

  test("acpSessionName is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/acpSessionName/);
    expect(hits).toEqual([]);
  });

  test("keepSessionOpen is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/keepSessionOpen/);
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm all 3 tests fail**

```bash
bun test test/unit/agents/session-fields-invariants.test.ts --timeout=30000
```

Expected: all 3 FAIL — each showing 10–30 hits.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/unit/agents/session-fields-invariants.test.ts
git commit -m "test(#529): add source invariant tests for legacy session field removal"
```

---

### Task 2: Rename `buildSessionName` → `computeAcpHandle` in adapter + all 11 import sites

**Files:**
- Modify: `src/agents/acp/adapter.ts`
- Modify: `src/debate/session-helpers.ts`
- Modify: `src/pipeline/stages/autofix-adversarial.ts`
- Modify: `src/pipeline/stages/autofix.ts`
- Modify: `src/acceptance/fix-executor.ts`
- Modify: `src/acceptance/fix-diagnosis.ts`
- Modify: `src/review/adversarial.ts`
- Modify: `src/review/semantic.ts`
- Modify: `src/verification/rectification-loop.ts`
- Modify: `src/execution/merge-conflict-rectify.ts`
- Modify: `src/tdd/session-runner.ts`
- Modify: `src/tdd/rectification-gate.ts`

- [ ] **Step 1: Rename the export in `src/agents/acp/adapter.ts`**

Find (~line 189):
```typescript
export function buildSessionName(
  workdir: string,
  featureName?: string,
  storyId?: string,
  sessionRole?: string,
): string {
```

Change to:
```typescript
export function computeAcpHandle(
  workdir: string,
  featureName?: string,
  storyId?: string,
  sessionRole?: string,
): string {
```

Also update the two internal call sites in the same file:

Line ~441 (`deriveSessionName`):
```typescript
// Before:
return buildSessionName(descriptor.workdir, descriptor.featureName, descriptor.storyId, descriptor.role);
// After:
return computeAcpHandle(descriptor.workdir, descriptor.featureName, descriptor.storyId, descriptor.role);
```

Line ~639 (session name resolution in `_runWithClient`):
```typescript
// Before:
buildSessionName(options.workdir, options.featureName, options.storyId, options.sessionRole);
// After:
computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
```

Line ~918 (session name in `complete()`):
```typescript
// Before:
buildSessionName(workdir ?? process.cwd(), _options?.featureName, _options?.storyId, _options?.sessionRole);
// After:
computeAcpHandle(workdir ?? process.cwd(), _options?.featureName, _options?.storyId, _options?.sessionRole);
```

Also update the JSDoc comment above `computeAcpHandle` (~line 185) to reference the new name.

- [ ] **Step 2: Update all 11 import sites**

In each file, change:
```typescript
import { buildSessionName } from "../agents/acp/adapter";
// or
import { buildSessionName } from "../../agents/acp/adapter";
```
to:
```typescript
import { computeAcpHandle } from "../agents/acp/adapter";
// or
import { computeAcpHandle } from "../../agents/acp/adapter";
```

And rename every `buildSessionName(` call → `computeAcpHandle(`.

Files and their relative import paths:
- `src/debate/session-helpers.ts` → `"../agents/acp/adapter"`
- `src/pipeline/stages/autofix-adversarial.ts` → `"../../agents/acp/adapter"`
- `src/pipeline/stages/autofix.ts` → `"../../agents/acp/adapter"`
- `src/acceptance/fix-executor.ts` → `"../agents/acp/adapter"`
- `src/acceptance/fix-diagnosis.ts` → `"../agents/acp/adapter"`
- `src/review/adversarial.ts` → `"../agents/acp/adapter"`
- `src/review/semantic.ts` → `"../agents/acp/adapter"`
- `src/verification/rectification-loop.ts` → `"../agents/acp/adapter"`
- `src/tdd/session-runner.ts` → `"../agents/acp/adapter"`
- `src/tdd/rectification-gate.ts` → `"../agents/acp/adapter"`

For `src/execution/merge-conflict-rectify.ts` which uses a dynamic import:
```typescript
// Before:
const { buildSessionName } = await import("../agents/acp/adapter");
const staleSessionName = buildSessionName(worktreePath, prd.feature, storyId);
// After:
const { computeAcpHandle } = await import("../agents/acp/adapter");
const staleSessionName = computeAcpHandle(worktreePath, prd.feature, storyId);
```

- [ ] **Step 3: Run typecheck and invariant test for `buildSessionName`**

```bash
bun run typecheck && bun test test/unit/agents/session-fields-invariants.test.ts --timeout=30000
```

Expected: typecheck passes. First invariant test PASSES; other two still FAIL.

- [ ] **Step 4: Commit**

```bash
git add src/ test/
git commit -m "refactor(#529): rename buildSessionName → computeAcpHandle"
```

---

### Task 3: Remove `acpSessionName` from `AgentRunOptions`, add `sessionHandle`

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/agents/acp/adapter.ts`
- Modify: All 10 non-dialogue callers (remove the field pass)
- Modify: `src/review/dialogue.ts` (rename local variable + field)
- Modify: `src/tdd/session-runner.ts` (rename local variable + field)

- [ ] **Step 1: Update `src/agents/types.ts`**

Replace lines 104-105:
```typescript
/** ACP session name to resume for plan→run session continuity */
acpSessionName?: string;
```
with:
```typescript
/**
 * Explicit ACP session handle override. When set, the adapter uses this
 * name instead of auto-deriving from featureName/storyId/sessionRole.
 * Use only when a non-standard session name is required (e.g. generation-scoped
 * reviewer sessions in dialogue.ts). Most callers should omit this field.
 */
sessionHandle?: string;
```

Also update the Phase 5.5 comment (~line 140):
```typescript
// Before:
// Phase 5.5: replaces acpSessionName, featureName, storyId, sessionRole, keepSessionOpen.
// After:
// Phase 5.5: replaces sessionHandle, featureName, storyId, sessionRole, keepOpen.
```

- [ ] **Step 2: Update `src/agents/acp/adapter.ts` session name resolution**

Find the session name resolution in `_runWithClient` (~line 636-639):
```typescript
const sessionName =
  (options.session ? this.deriveSessionName(options.session) : undefined) ??
  options.acpSessionName ??
  computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
```

Change to:
```typescript
const sessionName =
  (options.session ? this.deriveSessionName(options.session) : undefined) ??
  options.sessionHandle ??
  computeAcpHandle(options.workdir, options.featureName, options.storyId, options.sessionRole);
```

- [ ] **Step 3: Remove `acpSessionName:` from the 8 callers where it is fully redundant**

In each of these files, find the `acpSessionName: <varName>,` line and delete it entirely. The adapter will auto-derive the same value from `featureName`, `storyId`, and `sessionRole` which are already passed.

Also delete the local variable computed by `computeAcpHandle(...)` that was only used to supply `acpSessionName`. The `computeAcpHandle` import may also become unused — remove it if so.

**`src/pipeline/stages/autofix-adversarial.ts`:**
```typescript
// Delete these two lines:
const testWriterSession = computeAcpHandle(ctx.workdir, ctx.prd.feature, ctx.story.id, "test-writer");
// and:
acpSessionName: testWriterSession,
// (keep import only if computeAcpHandle is used elsewhere in the file)
```

**`src/pipeline/stages/autofix.ts`:**
```typescript
// Delete these two lines:
const implementerSession = computeAcpHandle(ctx.workdir, ctx.prd.feature, ctx.story.id, "implementer");
// and:
acpSessionName: implementerSession,
```

**`src/acceptance/fix-executor.ts`** (two call sites, lines ~49 and ~120):
```typescript
// Delete both occurrences of:
const sessionName = computeAcpHandle(workdir, featureName, storyId, "<role>");
// and:
acpSessionName: sessionName,
// Remove import if computeAcpHandle is now unused in this file.
```

**`src/acceptance/fix-diagnosis.ts`:**
```typescript
// Delete:
const sessionName = computeAcpHandle(workdir, featureName, storyId, "diagnose");
// and:
acpSessionName: sessionName,
```

**`src/review/adversarial.ts`:**
```typescript
// Delete:
const adversarialSessionName = computeAcpHandle(workdir, featureName, story.id, "reviewer-adversarial");
// and:
acpSessionName: adversarialSessionName,
```
NOTE: `adversarialSessionName` is also used in `agent.closeSession(adversarialSessionName, workdir)` — keep the variable and the `computeAcpHandle` import. Only delete the `acpSessionName:` pass in the run() call.

**`src/review/semantic.ts`:**
```typescript
// Delete:
acpSessionName: reviewerSessionName,
```
Same note: `reviewerSessionName` is used in `closeSession` — keep the variable.

**`src/verification/rectification-loop.ts`:**
```typescript
// Delete:
acpSessionName: rectificationSessionName,
```
NOTE: `rectificationSessionName` is used in `sessionManager.bindHandle()` — keep the variable.

**`src/tdd/rectification-gate.ts`:**
```typescript
// Delete:
acpSessionName: rectificationSessionName,
```
Same note: keep the variable if used elsewhere.

- [ ] **Step 4: Update `src/tdd/session-runner.ts` — rename acpSessionName variable → sessionHandle**

Find (~lines 214-237):
```typescript
const acpSessionName =
  role === "implementer" && featureName ? computeAcpHandle(workdir, featureName, story.id, "implementer") : undefined;
// ...
acpSessionName,
```

Change to:
```typescript
const sessionHandle =
  role === "implementer" && featureName ? computeAcpHandle(workdir, featureName, story.id, "implementer") : undefined;
// ...
sessionHandle,
```

Wait — `session-runner.ts` also passes `featureName`, `storyId: story.id`, `sessionRole: role` to run(). Since `sessionRole: role` where `role === "implementer"`, the adapter auto-derives the same name. So `sessionHandle` is redundant here too and can be removed entirely:

```typescript
// Delete:
const sessionHandle = role === "implementer" && featureName
  ? computeAcpHandle(workdir, featureName, story.id, "implementer") : undefined;
// and:
sessionHandle,
// Remove computeAcpHandle import if now unused.
```

- [ ] **Step 5: Update `src/review/dialogue.ts` — rename `acpSessionName` local → `sessionHandle`**

The `buildEffectiveRunArgs` function returns `{ effectivePrompt, acpSessionName }`. Change to return `{ effectivePrompt, sessionHandle }`:

```typescript
// Before:
function buildEffectiveRunArgs(prompt: string): { effectivePrompt: string; acpSessionName: string | undefined } {
  if (sessionState.pendingCompactionContext !== null) {
    const context = sessionState.pendingCompactionContext;
    sessionState.pendingCompactionContext = null;
    return {
      effectivePrompt: `${context}\n\n---\n\n${prompt}`,
      acpSessionName: `nax-reviewer-${storyId}-gen${sessionState.generation}`,
    };
  }
  const acpSessionName =
    sessionState.generation > 1 ? `nax-reviewer-${storyId}-gen${sessionState.generation}` : undefined;
  return { effectivePrompt: prompt, acpSessionName };
}

// After:
function buildEffectiveRunArgs(prompt: string): { effectivePrompt: string; sessionHandle: string | undefined } {
  if (sessionState.pendingCompactionContext !== null) {
    const context = sessionState.pendingCompactionContext;
    sessionState.pendingCompactionContext = null;
    return {
      effectivePrompt: `${context}\n\n---\n\n${prompt}`,
      sessionHandle: `nax-reviewer-${storyId}-gen${sessionState.generation}`,
    };
  }
  const sessionHandle =
    sessionState.generation > 1 ? `nax-reviewer-${storyId}-gen${sessionState.generation}` : undefined;
  return { effectivePrompt: prompt, sessionHandle };
}
```

At every call site of `buildEffectiveRunArgs` (5 occurrences), rename the destructured variable and the field pass:
```typescript
// Before:
const { effectivePrompt, acpSessionName } = buildEffectiveRunArgs(prompt);
// ...
acpSessionName,

// After:
const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(prompt);
// ...
sessionHandle,
```

Also update the JSDoc comment for `buildEffectiveRunArgs` (~line 256) to reference `sessionHandle` instead of `acpSessionName`.

- [ ] **Step 6: Run typecheck and invariant test for `acpSessionName`**

```bash
bun run typecheck && bun test test/unit/agents/session-fields-invariants.test.ts --timeout=30000
```

Expected: typecheck passes. First two invariant tests PASS; `keepSessionOpen` test still FAILS.

- [ ] **Step 7: Commit**

```bash
git add src/ test/
git commit -m "refactor(#529): remove acpSessionName from AgentRunOptions, add sessionHandle"
```

---

### Task 4: Rename `keepSessionOpen` → `keepOpen` everywhere

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/agents/acp/adapter.ts`
- Modify: `src/pipeline/stages/execution.ts`
- Modify: `src/pipeline/stages/autofix-adversarial.ts`
- Modify: `src/pipeline/stages/autofix.ts`
- Modify: `src/debate/session-stateful.ts`
- Modify: `src/review/adversarial.ts`
- Modify: `src/review/semantic.ts`
- Modify: `src/review/dialogue.ts`
- Modify: `src/verification/rectification-loop.ts`
- Modify: `src/tdd/session-runner.ts`
- Modify: `src/tdd/rectification-gate.ts`

- [ ] **Step 1: Update `src/agents/types.ts`**

Replace lines 124-130:
```typescript
/**
 * When true, the adapter will NOT close the session after a successful run.
 * Use this for rectification loops where the same session must persist across
 * multiple attempts so the agent retains full conversation context.
 * The caller is responsible for closing the session when the loop is done.
 */
keepSessionOpen?: boolean;
```
with:
```typescript
/**
 * When true, the adapter will NOT close the session after a successful run.
 * Use for multi-attempt loops (rectification, review) where the same session
 * must persist across calls so the agent retains conversation context.
 * The caller is responsible for closing the session when the loop ends.
 */
keepOpen?: boolean;
```

- [ ] **Step 2: Update `src/agents/acp/adapter.ts` finally block**

Find the finally block (~line 789):
```typescript
if ((runState.succeeded && !options.keepSessionOpen) || isSessionBroken) {
```
Change to:
```typescript
if ((runState.succeeded && !options.keepOpen) || isSessionBroken) {
```

Also update the comments in the finally block (~lines 786-797) that mention `keepSessionOpen`:
```typescript
// Before:
// On success with keepSessionOpen=true, keep open so the next turn resumes context.
// ...
getSafeLogger()?.debug("acp-adapter", "Keeping session open (keepSessionOpen=true)", { sessionName });

// After:
// On success with keepOpen=true, keep open so the next turn resumes context.
// ...
getSafeLogger()?.debug("acp-adapter", "Keeping session open (keepOpen=true)", { sessionName });
```

- [ ] **Step 3: Update `src/pipeline/stages/execution.ts`**

Find (~line 146):
```typescript
const keepSessionOpen = !!(
  ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true
);
```
Change to:
```typescript
const keepOpen = !!(
  ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true
);
```

Find the two field passes (~lines 192 and 360):
```typescript
keepSessionOpen,
```
Change both to:
```typescript
keepOpen,
```

- [ ] **Step 4: Update `src/pipeline/stages/autofix-adversarial.ts`**

Find the `keepOpen` variable (it was already named `keepOpen` in this file, not `keepSessionOpen`):

Actually check the exact name — the grep showed `keepSessionOpen: keepOpen`. So the variable is `keepOpen` but the field pass uses `keepSessionOpen:`. Update:
```typescript
// Before:
keepSessionOpen: keepOpen,
// After:
keepOpen,   // shorthand since variable name matches field name now
```

- [ ] **Step 5: Update `src/pipeline/stages/autofix.ts`**

Find (~line 516):
```typescript
keepSessionOpen: !isLastAttempt,
```
Change to:
```typescript
keepOpen: !isLastAttempt,
```

- [ ] **Step 6: Update `src/debate/session-stateful.ts`**

Find the function signature (~line 47):
```typescript
keepSessionOpen: boolean,
```
Change to:
```typescript
keepOpen: boolean,
```

Find the run() call (~line 66):
```typescript
keepSessionOpen,
```
Change to:
```typescript
keepOpen,
```

Find the explicit `keepSessionOpen: false` pass (~line 105):
```typescript
keepSessionOpen: false,
```
Change to:
```typescript
keepOpen: false,
```

Also update the JSDoc comment in `src/debate/session-hybrid.ts` (~line 124) that references `keepSessionOpen`.

- [ ] **Step 7: Update `src/review/adversarial.ts`**

Find (~line 311):
```typescript
const runResult = await agent.run({ prompt, ...runOpts, keepSessionOpen: true });
```
Change to:
```typescript
const runResult = await agent.run({ prompt, ...runOpts, keepOpen: true });
```

Find (~line 348):
```typescript
keepSessionOpen: false,
```
Change to:
```typescript
keepOpen: false,
```

- [ ] **Step 8: Update `src/review/semantic.ts`**

Find (~line 462):
```typescript
const runResult = await agent.run({ prompt, ...runOpts, keepSessionOpen: true });
```
Change to:
```typescript
const runResult = await agent.run({ prompt, ...runOpts, keepOpen: true });
```

Find (~line 496):
```typescript
keepSessionOpen: false,
```
Change to:
```typescript
keepOpen: false,
```

- [ ] **Step 9: Update `src/review/dialogue.ts`**

All 5 occurrences of `keepSessionOpen: true` in run() calls:
```typescript
// Before:
keepSessionOpen: true,
// After:
keepOpen: true,
```

Also update the file header JSDoc (~line 4):
```typescript
// Before:
 * Maintains a persistent reviewer session via agent.run() with keepSessionOpen: true.
// After:
 * Maintains a persistent reviewer session via agent.run() with keepOpen: true.
```

And inline comments (~lines 232, 256, 261, 264) that mention `acpSessionName`/`keepSessionOpen`.

- [ ] **Step 10: Update `src/verification/rectification-loop.ts`**

Find (~line 274):
```typescript
keepSessionOpen: !isLastAttempt,
```
Change to:
```typescript
keepOpen: !isLastAttempt,
```

- [ ] **Step 11: Update `src/tdd/session-runner.ts`**

Find (~line 208):
```typescript
const keepSessionOpen = role === "implementer" && (config.execution.rectification?.enabled ?? false);
```
Change to:
```typescript
const keepOpen = role === "implementer" && (config.execution.rectification?.enabled ?? false);
```

Find (~line 238):
```typescript
keepSessionOpen,
```
Change to:
```typescript
keepOpen,
```

- [ ] **Step 12: Update `src/tdd/rectification-gate.ts`**

Find (~line 235):
```typescript
keepSessionOpen: !isLastAttempt,
```
Change to:
```typescript
keepOpen: !isLastAttempt,
```

- [ ] **Step 13: Run typecheck and all three invariant tests**

```bash
bun run typecheck && bun test test/unit/agents/session-fields-invariants.test.ts --timeout=30000
```

Expected: typecheck passes. All 3 invariant tests PASS.

- [ ] **Step 14: Commit**

```bash
git add src/
git commit -m "refactor(#529): rename keepSessionOpen → keepOpen in AgentRunOptions and all callers"
```

---

### Task 5: Final validation — full suite + Phase 4 gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
bun run typecheck && bun run lint && bun run test --timeout=30000
```

Expected: all tests pass, no lint errors.

- [ ] **Step 2: Run the Phase 4 gate check**

```bash
grep -rn "buildSessionName\|keepSessionOpen\|acpSessionName" src/ --include="*.ts" \
  | grep -v ".test.ts\|//_\|//.*keep\|//.*build"
```

Expected: **0 hits**. Phase 4 is now unblocked.

- [ ] **Step 3: Confirm `AllAgentsUnavailableError` still present (Phase 4 not yet started)**

```bash
grep -rn "AllAgentsUnavailableError" src/ --include="*.ts" | grep -v ".test.ts"
```

Expected: hits in `src/errors.ts`, `src/agents/index.ts`, `src/agents/acp/adapter.ts`.

- [ ] **Step 4: Commit**

```bash
git add test/unit/agents/session-fields-invariants.test.ts
git commit -m "chore(#529): complete legacy session field cleanup — Phase 4 gate now clear"
```

---

## Self-Review Checklist

After writing this plan, checking spec coverage and consistency:

1. **All three symbols removed from non-comment, non-test src/**: `buildSessionName` ✓ (renamed to `computeAcpHandle`), `acpSessionName` ✓ (removed from `AgentRunOptions`; dialogue uses `sessionHandle`), `keepSessionOpen` ✓ (renamed to `keepOpen`).

2. **No behaviour change**: Session names are identical — callers already passed the same `featureName/storyId/sessionRole` values the adapter was using. `keepOpen` semantics are identical to `keepSessionOpen`. `sessionHandle` takes the same role as `acpSessionName`.

3. **Type consistency**: `sessionHandle` is used consistently in `AgentRunOptions`, `dialogue.ts` local variable, and adapter session name resolution chain. `keepOpen` is used consistently in `AgentRunOptions`, adapter finally block, and all call sites.

4. **Close-session callers still work**: `adversarial.ts` and `semantic.ts` keep their local `*SessionName` variable (now computed by `computeAcpHandle`) for passing to `agent.closeSession()`. `merge-conflict-rectify.ts` dynamic import updated to `computeAcpHandle`.

5. **No placeholder steps**: Every code change is shown in full.
