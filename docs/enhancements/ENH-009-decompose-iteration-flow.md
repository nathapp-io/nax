# ENH-009: Decompose Iteration Flow + Story Lifecycle Events

**Status:** Implemented (v0.50.1)  
**Component:** `pipeline/stages/routing.ts`, `execution/sequential-executor.ts`, `prd/index.ts`  
**Found:** 2026-03-20

---

## Problem

When a story is decomposed into sub-stories during the routing stage, **four issues** exist:

1. **Wasted iteration:** Routing returns `{ action: "skip" }` → pipeline returns `finalAction: "skip"` → executor increments `iterations` counter and loops. One full iteration consumed with no real work done.

2. **Missing lifecycle event:** `story:started` was emitted for the parent before the pipeline ran, but no `story:decomposed` (or `story:completed`/`story:failed`) event is ever emitted. Hooks (`on-story-complete`), reporters, and the events log writer all silently miss the parent story.

3. **Semantic ambiguity:** `"skip"` is reused for both "skipped by user" and "decomposed into sub-stories" — different semantics, same signal.

4. **Dependents permanently blocked (DEP-001):** After US-001 is decomposed into US-001-1…US-001-N and all sub-stories pass, US-001 remains `status=decomposed, passes=false`. Stories that depend on US-001 (e.g. US-006, US-008) check `completedIds` in `getNextStory()` — US-001 is never in that set, so dependents never run.

---

## Fix (Option A — decomposed signal + parent promotion)

### Issues 1–3: New `"decomposed"` finalAction

New `"decomposed"` finalAction threaded through the pipeline:

- `pipeline/types.ts` — added `"decomposed"` to `StageResult` actions
- `pipeline/runner.ts` — handles `"decomposed"` case (like `"skip"` but distinct)
- `pipeline/event-bus.ts` — added `story:decomposed` event type
- `pipeline/stages/routing.ts` — returns `{ action: "decomposed" }` instead of `{ action: "skip" }` after successful decompose
- `execution/iteration-runner.ts` — passes `finalAction: "decomposed"` through
- `execution/sequential-executor.ts` — when `finalAction === "decomposed"`: does NOT increment `iterations`, emits `story:decomposed` event, continues loop immediately
- `pipeline/subscribers/hooks.ts` — wires `story:decomposed` → `on-story-complete` with `status: "decomposed"`
- `pipeline/subscribers/events-writer.ts` — logs `story:decomposed` entry

### Issue 4: DEP-001 — Decomposed parent promotion

- `prd/types.ts` — added `parentStoryId?: string` to `UserStory` interface (was previously only an intersection type in `apply.ts`)
- `decompose/apply.ts` — cast updated to use plain `UserStory` (no more intersection type)
- `prd/index.ts` (`markStoryPassed`) — after marking a sub-story as passed, checks if it has a `parentStoryId`. If all sibling sub-stories (those with the same `parentStoryId`) have now passed, promotes the parent from `status=decomposed` to `status=passed, passes=true`. This naturally unblocks any story in the PRD that depends on the parent.

**Example:** US-001 decomposed → US-001-1…5. When US-001-5 (last sub-story) is marked passed, `markStoryPassed` detects all siblings passed and promotes US-001 to `passed`. On the next `getNextStory()` call, `completedIds` includes US-001 and US-006/US-008 become eligible.

---

## Architectural Debt Note

Option A is pragmatic but exposes a deeper design concern:

**The executor loop is too tightly coupled to pipeline finalAction semantics.**

The routing stage currently signals decomposition via a return value that propagates through 3 layers (stage → runner → iteration-runner → executor) before any action is taken. The executor then makes branching decisions based on the signal.

### Future Restructuring Direction

Consider an **event-first execution model** where:
- Stages emit domain events directly to the bus (`story:decomposed`, `story:started`, etc.)
- The executor is a pure event consumer — it reacts to events rather than inspecting return values
- Pipeline `StageResult` is only for flow control (`continue`, `retry`, `fail`, `pause`) — not semantic signals

This would eliminate the current pattern where lifecycle semantics (decomposed, skipped, escalated) bleed into pipeline flow control. Stages would remain thin, and the executor would own all lifecycle decisions.

**Reference:** ADR-005 (Phase 3 intent was to decouple via event bus, but the executor loop still inspects finalAction directly.)

---

## Tests

### Issues 1–3
- `routing.ts`: returns `"decomposed"` action on successful decompose
- `sequential-executor.ts`: does NOT increment iterations on decompose; emits `story:decomposed`; picks first sub-story on next loop
- `hooks.ts`: `story:decomposed` → `on-story-complete` fires with `status: "decomposed"`
- `events-writer.ts`: logs `story:decomposed` entry

### DEP-001 (added in `test/unit/prd/apply-decomposition.test.ts`)
- Parent stays `decomposed` while only partial sub-stories have passed
- Parent promoted to `passed` when ALL sub-stories pass
- Dependent story (US-006) becomes eligible via `getNextStory()` after parent promoted
- Dependent story blocked while parent still partially complete
