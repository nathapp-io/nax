# ENH-008: Review/autofix — scope to story.workdir in monorepo

**Type:** Enhancement  
**Component:** `src/decompose/apply.ts`, `src/pipeline/stages/autofix.ts`  
**Filed:** 2026-03-19  
**Status:** Spec ready — implementation pending  
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

---

## Problem

In the koda run, `US-002` (workdir: `apps/api`) was decomposed into `US-002-1` through `US-002-5`. These sub-stories had **no `workdir` set**, so review ran against the monorepo root, finding typecheck errors in unrelated packages. The autofix agent then touched 9 files in `apps/web` trying to fix errors it had no business touching.

---

## Root Cause Analysis

### What already works (MW-010, shipped v0.49.1)

`review.ts` and `autofix.ts` already scope to `story.workdir`:

```typescript
// review.ts line 33
const effectiveWorkdir = ctx.story.workdir
  ? join(ctx.workdir, ctx.story.workdir)
  : ctx.workdir;
```

```typescript
// autofix.ts line 62 — mechanical fix (Phase 1)
const effectiveWorkdir = ctx.story.workdir
  ? join(ctx.workdir, ctx.story.workdir)
  : ctx.workdir;
```

### What's broken

**`applyDecomposition()` doesn't inherit `workdir` from the parent story.**

```typescript
// src/decompose/apply.ts — current
const newStories = subStories.map((sub): UserStory => ({
  id: sub.id,
  title: sub.title,
  // ...
  // ❌ workdir never set — defaults to undefined
}));
```

So `US-002-1` through `US-002-5` have `workdir: undefined` → review runs at repo root.

### Second gap: agent rectification (Phase 2) ignores workdir

Even when `effectiveWorkdir` is correct for mechanical fixes, agent rectification uses `ctx.workdir` (repo root) instead:

```typescript
// autofix.ts line 216 — WRONG
await agent.run({
  prompt,
  workdir: ctx.workdir,  // ❌ should be effectiveWorkdir
  ...
});
```

The prompt also lacks a workdir constraint, so the agent is free to modify any file.

---

## Fix: Two Changes

### Fix 1 — Inherit `workdir` in `applyDecomposition`

```typescript
// src/decompose/apply.ts
export function applyDecomposition(prd: PRD, result: DecomposeResult): void {
  const { subStories } = result;
  if (subStories.length === 0) return;

  const parentStoryId = subStories[0].parentStoryId;
  const originalIndex = prd.userStories.findIndex((s) => s.id === parentStoryId);
  if (originalIndex === -1) return;

  const parentStory = prd.userStories[originalIndex];  // ← grab parent
  prd.userStories[originalIndex].status = "decomposed";

  const newStories = subStories.map((sub): UserStory & { parentStoryId: string } => ({
    id: sub.id,
    title: sub.title,
    description: sub.description,
    acceptanceCriteria: sub.acceptanceCriteria,
    tags: sub.tags,
    dependencies: sub.dependencies,
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    parentStoryId: sub.parentStoryId,
    // ✅ Inherit workdir from parent
    ...(parentStory.workdir !== undefined && { workdir: parentStory.workdir }),
  }));

  prd.userStories.splice(originalIndex + 1, 0, ...newStories);
}
```

### Fix 2 — Use `effectiveWorkdir` for agent rectification

```typescript
// src/pipeline/stages/autofix.ts — runAgentRectification()

// BEFORE (line 216)
await agent.run({
  prompt,
  workdir: ctx.workdir,   // ❌ repo root
  ...
});

// AFTER
const effectiveWorkdir = ctx.story.workdir
  ? join(ctx.workdir, ctx.story.workdir)
  : ctx.workdir;

await agent.run({
  prompt,
  workdir: effectiveWorkdir,  // ✅ package dir
  ...
});
```

### Fix 3 — Add workdir constraint to rectification prompt

```typescript
// src/pipeline/stages/autofix.ts — buildReviewRectificationPrompt()

export function buildReviewRectificationPrompt(
  failedChecks: ReviewCheckResult[],
  story: UserStory,
): string {
  const errors = failedChecks
    .map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``)
    .join("\n\n");

  // ✅ Scope constraint when workdir is set
  const scopeConstraint = story.workdir
    ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
    : "";

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.${scopeConstraint}`;
}
```

---

## Files to Change

| # | File | Change | Lines |
|:--|:-----|:-------|:------|
| 1 | `src/decompose/apply.ts` | Inherit `workdir` from parent story when building sub-stories | +3 |
| 2 | `src/pipeline/stages/autofix.ts` | Use `effectiveWorkdir` for `agent.run()` in rectification | +4 |
| 3 | `src/pipeline/stages/autofix.ts` | Add scope constraint to `buildReviewRectificationPrompt()` | +4 |
| 4 | `test/unit/decompose/apply.test.ts` | **New file** — test workdir inheritance | ~60 |
| 5 | `test/unit/pipeline/stages/autofix.test.ts` | Add tests: rectification workdir + prompt scope constraint | ~30 |

**Total: 3 files modified, 1 new test file**

---

## Test Plan

### `apply.test.ts` (new)

| Test | Input | Expected |
|:-----|:------|:---------|
| Parent has `workdir` | `US-002` with `workdir: "apps/api"` → decomposed | All sub-stories get `workdir: "apps/api"` |
| Parent has no `workdir` | `US-001` with no `workdir` → decomposed | Sub-stories have no `workdir` (not set to `undefined` explicitly) |
| Multiple sub-stories | 3 sub-stories, parent has `workdir: "packages/core"` | All 3 inherit `workdir: "packages/core"` |
| Sub-story workdir from LLM | LLM-generated `SubStory` has no `workdir` field | `applyDecomposition` still inherits from parent |

### `autofix.test.ts` additions

| Test | Input | Expected |
|:-----|:------|:---------|
| Rectification uses package workdir | `ctx.story.workdir = "apps/api"` | `agent.run()` called with `workdir = join(repoRoot, "apps/api")` |
| Rectification uses root when no workdir | `ctx.story.workdir` unset | `agent.run()` called with `workdir = ctx.workdir` |
| Prompt includes scope constraint | `story.workdir = "packages/api"` | Prompt contains `"Only modify files within \`packages/api/\`"` |
| Prompt has no constraint when unscoped | `story.workdir` unset | Prompt does NOT contain "Only modify files within" |

---

## What This Does NOT Change

- **Coding session** stays unscoped — agent greps what it needs (intentional decision)
- **Per-package `nax/config.json`** already works via `effectiveConfig` (PKG-004)
- **Review stage workdir scoping** already correct via MW-010

---

## Acceptance Criteria

- [ ] Decomposed sub-stories inherit `workdir` from parent
- [ ] Agent rectification runs in `story.workdir`, not repo root
- [ ] Rectification prompt includes scope constraint when `story.workdir` is set
- [ ] Parent without `workdir` → sub-stories also have no `workdir`
- [ ] All 8 test cases pass
- [ ] No regressions in existing autofix / decompose tests
