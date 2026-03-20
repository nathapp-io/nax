# ENH-009: Decompose Iteration Flow + Story Lifecycle Events

**Status:** Implemented (v0.50.1)  
**Component:** `pipeline/stages/routing.ts`, `execution/sequential-executor.ts`  
**Found:** 2026-03-20

---

## Problem

When a story is decomposed into sub-stories during the routing stage, three issues exist:

1. **Wasted iteration:** Routing returns `{ action: "skip" }` → pipeline returns `finalAction: "skip"` → executor increments `iterations` counter and loops. One full iteration consumed with no real work done.

2. **Missing lifecycle event:** `story:started` was emitted for the parent before the pipeline ran, but no `story:decomposed` (or `story:completed`/`story:failed`) event is ever emitted. Hooks (`on-story-complete`), reporters, and the events log writer all silently miss the parent story.

3. **Semantic ambiguity:** `"skip"` is reused for both "skipped by user" and "decomposed into sub-stories" — different semantics, same signal.

---

## Fix (Option A — decomposed signal)

New `"decomposed"` finalAction threaded through the pipeline:

- `pipeline/types.ts` — added `"decomposed"` to `StageResult` actions
- `pipeline/runner.ts` — handles `"decomposed"` case (like `"skip"` but distinct)
- `pipeline/event-bus.ts` — added `story:decomposed` event type
- `pipeline/stages/routing.ts` — returns `{ action: "decomposed" }` instead of `{ action: "skip" }` after successful decompose
- `execution/iteration-runner.ts` — passes `finalAction: "decomposed"` through
- `execution/sequential-executor.ts` — when `finalAction === "decomposed"`: does NOT increment `iterations`, emits `story:decomposed` event, continues loop immediately
- `pipeline/subscribers/hooks.ts` — wires `story:decomposed` → `on-story-complete` with `status: "decomposed"`
- `pipeline/subscribers/events-writer.ts` — logs `story:decomposed` entry

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

## Tests Required

- `routing.ts`: returns `"decomposed"` action on successful decompose
- `sequential-executor.ts`: does NOT increment iterations on decompose; emits `story:decomposed`; picks first sub-story on next loop
- `hooks.ts`: `story:decomposed` → `on-story-complete` fires with `status: "decomposed"`
- `events-writer.ts`: logs `story:decomposed` entry
