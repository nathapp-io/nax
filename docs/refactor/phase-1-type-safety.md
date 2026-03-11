# Phase 1: Type Safety Fixes (HIGH priority)

**Branch:** `feat/code-audit` (continue from current HEAD)
**Estimated effort:** 40 min
**Risk:** Low — additive type changes, no behavioral change

---

## Task 1.1: Add `storyGitRef` to ExecutionConfig type

**File:** `src/config/types.ts`

Add `storyGitRef?: string` to the `ExecutionConfig` interface/type.

**Then update:** `src/review/orchestrator.ts:77`
- Remove `as any` cast: `(executionConfig as any)?.storyGitRef` → `executionConfig?.storyGitRef`
- Remove the `biome-ignore` comment on the line above

**Verify:** `bun run typecheck` passes

---

## Task 1.2: Define StoryCompletedEvent payload type

**File:** `src/pipeline/stages/completion.ts:71–75`

The `story:completed` event emits extra fields (`cost`, `modelTier`, `testStrategy`) not defined in the event type.

1. Find the event type definitions (likely in `src/pipeline/types.ts` or similar)
2. Add a proper `StoryCompletedEvent` type with all fields:
   - `type: "story:completed"`
   - `cost?: number`
   - `modelTier?: string`
   - `testStrategy?: string`
3. Update `pipelineEventBus.emit()` call to use the typed payload
4. Remove any `as any` or type assertions

**Verify:** `bun run typecheck` passes

---

## Completion Checklist

- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors  
- [ ] `bun test` — no regressions (run full suite with `--bail`)
- [ ] Commit: `fix(types): add storyGitRef to ExecutionConfig, define StoryCompletedEvent type`
- [ ] Do NOT push to remote
