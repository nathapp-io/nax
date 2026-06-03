# TUI Overhaul Design

**Date:** 2026-06-03  
**Status:** Approved

---

## Problem

The TUI has two compounding issues that make it non-functional for story lifecycle tracking:

1. **Dead event wiring.** The TUI subscribes to the old `PipelineEventEmitter` (`src/pipeline/events.ts`) for `story:start`, `story:complete`, `story:escalate`, and `run:complete`. None of these events are ever emitted — the execution layer (`unified-executor`, `pipeline-result-handler`, `escalation/tier-outcome`) emits exclusively to the new `PipelineEventBus` singleton (`src/pipeline/event-bus.ts`). Only `stage:enter` and `stage:exit` (emitted from `pipeline/runner.ts`) actually fire. Stories never transition from `pending` → `running` → `passed/failed`.

2. **Stale layout and content.** The current layout (narrow Stories panel | wide Agent panel) was designed before parallel execution, escalation tiers, failure reasons, and richer agent stream events existed. The Agent panel shows raw counters (`msg:4 think:2 usage:1`) that are not actionable. There is no run completion view. The `retry` keybinding is an unimplemented TODO.

Additionally, `regression:detected` is defined in the new bus but never emitted anywhere, and there is no `story:escalated` event type on the new bus (escalation surfaces only as `story:paused` + `story:failed`).

---

## Design

### Layout: Stories + Live Activity (two-panel)

```
┌─ nax run — <feature> ──────────────────── 1 running · $0.0063 · 3m 12s ─┐
│ Stories (6)      │ Live Activity                                           │
│──────────────────│────────────────────────────────────────────────────────│
│ ✅ story-1       │ ● story-3  [execution]  sonnet  1m 24s                 │
│ ✅ story-2       │   └ 🔧 Edit → src/auth/session-manager.ts              │
│ 🔄 story-3 son   │                                                         │
│ ❌ story-4       │   story-5 escalated fast → balanced after 2 failures   │
│   └ 3 tests fail │                                                         │
│ 🔁 story-5 →son  │                                                         │
│ ⬚  story-6       │                                                         │
│──────────────────│────────────────────────────────────────────────────────│
│ p pause  a abort  s skip  c cost  ? help        story-3 · execution · bal │
└──────────────────────────────────────────────────────────────────────────┘
```

**Header** absorbs cost and elapsed time (moves out of StoriesPanel footer).  
**Stories panel** stays narrow (~30 cols). Each row: icon + story ID + model tier (dimmed). Failed stories get one sub-line with the truncated failure reason.  
**Live Activity panel** replaces the Agent panel. Shows all active agent calls as 2-line entries (header: story + stage + model + elapsed; sub-line: current tool call with path/command). When idle: spinner. When run complete: replaced by Run Summary.  
**Status bar** becomes a keybinding hint line on the left + current story context on the right.

**Parallel mode:** multiple 2-line entries stack in the Live Activity panel, one per active story. Status bar right side shows `parallel mode · N active · concurrency K`.

**Run complete:** Live Activity panel replaced by a Run Summary showing passed/failed/skipped counts, total cost, duration, and per-failed-story reason.

---

## Component Changes

### 1. Migrate `usePipelineEvents` → `usePipelineBusEvents`

Replace the hook entirely. The new hook subscribes to `PipelineEventBus` (the singleton from `src/pipeline/event-bus.ts`) instead of the passed-in `PipelineEventEmitter`.

Events consumed:

| Event | Action |
|---|---|
| `run:started` | Set total story count, start elapsed timer |
| `story:started` | Mark story `running`, record `modelTier` + `agent` + `iteration` |
| `story:completed` | Mark story `passed`, accumulate cost |
| `story:skipped` | Mark story `skipped` (new event — see Event Bus Gaps below) |
| `story:failed` | Mark story `failed`, store `reason` on `StoryDisplayState` |
| `story:paused` | Mark story `paused`, store `reason` |
| `run:paused` | Show run-level pause indicator in header |
| `run:resumed` | Clear pause indicator |
| `run:completed` | Stop timer, set summary state, switch Live Activity → Run Summary |
| `run:errored` | Show error banner in Live Activity panel |

Drop `story:escalate` from `StoryDisplayState.status`. Map escalation to `retrying` via `story:started` arriving for a story already in a terminal-ish state (or via the `iteration > 1` field on `story:started`). The `→son` suffix in the Stories panel row indicates escalated tier, read from the latest `story:started.modelTier`.

Keep passing `PipelineEventEmitter` to the execution layer (it still drives `stage:enter`/`stage:exit` for the status bar). Keep `events: PipelineEventEmitter` in `TuiProps` — required, not optional. The trimmed `usePipelineEvents` hook subscribes only to `stage:enter` from this emitter and returns `{ currentStage }` for the status bar. All story lifecycle state comes from `usePipelineBusEvents`.

### 2. `StoryDisplayState` — add `failureReason`

```typescript
export interface StoryDisplayState {
  story: UserStory;
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "retrying" | "paused";
  routing?: StoryRouting;
  cost?: number;
  modelTier?: string;        // from story:started
  failureReason?: string;    // from story:failed.reason (truncated for display)
  iteration?: number;        // from story:started.iteration (>1 = escalated)
}
```

### 3. `StoriesPanel` — enrich rows

- Normal row: `{icon} {id} {dimmed modelTier}`
- Failed row: adds sub-line `  └ {failureReason truncated to ~25 chars}`
- Retrying row: `🔁 {id} →{newTier}` using `iteration` + current `modelTier`
- Footer removed (cost/time moves to header)

### 4. `LiveActivityPanel` — new component (replaces `AgentPanel`)

Consumes `activeCalls: Map<string, ActiveCallState>` (from existing `useAgentStreamEvents`) and `runSummary?: RunCompletedEvent` (from `src/pipeline/event-bus.ts`, not the old `RunSummary` from `src/pipeline/events.ts` — these are different types with different field names).

**Active state:** renders each call as a 2-line entry:
```
● {storyId}  [{stage}]  {model}  {elapsed}
  └ {toolIcon} {toolName} → {toolArg truncated}
```
Tool icons: `🔧` for file ops (Write/Edit/Read), `🔩` for Bash, `💬` for thinking/message.  
When `activeCalls` is empty and run not complete: spinner "Waiting for agent..."

**Complete state:** when `runSummary` is set, replaces the active list with:
- Counts row: `{runSummary.passedStories} passed  {runSummary.failedStories} failed  {runSummary.skippedStories} skipped`
- `Total cost: $X.XXXX` (from `runSummary.totalCost`)
- `Duration: Xm Xs` (from `runSummary.durationMs`)
- One line per failed story: `{id}: {reason}`

**Escalation log:** a dimmed sub-section below active calls showing recent escalation messages (e.g. "story-5 escalated fast → balanced after 2 failures"). Populated from `story:started` events where `iteration > 1`.

### 5. `App.tsx` — header + status bar changes

**Header:** `nax run — {feature}` left, `{N running} · ${cost} · {elapsed}` right. Running count comes from `stories.filter(s => s.status === "running").length`.

**Status bar:** left side becomes keybinding hints (replaces `HelpOverlay` as primary discovery — overlay still exists for full reference). Right side: current story context or `parallel mode · N active` or `done`.

**Panel focus:** keep Tab toggle between Stories and Live Activity. Ctrl+] escape. Live Activity panel is read-only (no PTY in this design — PTY options kept in `TuiProps` for future use but not wired to the new panel).

### 6. `TuiProps` — remove dead fields, keep forward-compat

Remove: `totalCost`, `elapsedMs` (now derived from bus events internally).  
Keep: `ptyOptions` (unused but preserved for future PTY re-integration).  
Keep: `agentStreamEvents` (drives `LiveActivityPanel`).  
Keep: `events: PipelineEventEmitter` (still used for `stage:enter`/`stage:exit`).  
Add: nothing — all new data flows through the bus.

---

## Event Bus Gaps to Fix

### `regression:detected` — wire or remove

Defined in `PipelineEventBus` but never emitted. Two options:
- **Wire it**: emit from the regression gate in `src/execution/lifecycle/run-regression.ts` when regression tests fail, surface as a dimmed sub-line in the failed story row: `└ regression: {N} tests`.
- **Remove it**: delete the interface and type union entry.

Decision: **wire it**. The regression gate already has the failure count; emitting gives the TUI a precise failure mode.

### `story:skipped` — add to new bus

The `case "skip":` branch in `src/execution/pipeline-result-handler.ts` logs a warning and updates the PRD but emits nothing on `pipelineEventBus`. Without this event the TUI has no way to transition skipped stories out of `running`. Add:

```typescript
export interface StorySkippedEvent {
  type: "story:skipped";
  storyId: string;
  reason: string;
}
```

Emit from `pipeline-result-handler.ts` in the `case "skip":` branch, immediately after the existing `logger.warn` call.

### `story:escalated` — add to new bus

The new `PipelineEventBus` has no escalation event. `tier-outcome.ts` handles the *failure* cases (no tier available); the actual tier promotion — where both `fromTier` and `toTier` are known — happens in `src/execution/escalation/tier-escalation.ts` around line 151, after `escalateTier()` is called and `escalatedTier` is computed. Add:

```typescript
export interface StoryEscalatedEvent {
  type: "story:escalated";
  storyId: string;
  fromTier: string;
  toTier: string;
}
```

Emit from `tier-escalation.ts` (not `tier-outcome.ts`) immediately after `escalatedTier` is assigned. The TUI uses this to populate the escalation log in `LiveActivityPanel` and to update the `→{tier}` suffix in the Stories panel row.

---

## Files to Create / Modify

| File | Change |
|---|---|
| `src/tui/hooks/usePipelineBusEvents.ts` | New hook replacing `usePipelineEvents.ts` |
| `src/tui/hooks/usePipelineEvents.ts` | Trim to stage-only: subscribe to `stage:enter`, return `{ currentStage }` |
| `src/tui/components/LiveActivityPanel.tsx` | New component replacing `AgentPanel.tsx` |
| `src/tui/components/AgentPanel.tsx` | Delete |
| `src/tui/components/StoriesPanel.tsx` | Enrich rows, remove footer |
| `src/tui/components/StatusBar.tsx` | Keybinding hints left, context right |
| `src/tui/App.tsx` | New header, wire new hook + panel, remove dead fields |
| `src/tui/types.ts` | Add `failureReason`, `modelTier`, `iteration` to `StoryDisplayState`; update `TuiProps` |
| `src/pipeline/event-bus.ts` | Add `StorySkippedEvent`, `StoryEscalatedEvent` types and union entries |
| `src/pipeline/index.ts` | Export `pipelineEventBus` singleton so `usePipelineBusEvents` can import via barrel (`@/pipeline`) |
| `src/execution/pipeline-result-handler.ts` | Emit `story:skipped` in `case "skip":` branch |
| `src/execution/escalation/tier-escalation.ts` | Emit `story:escalated` after `escalatedTier` is assigned |
| `src/execution/lifecycle/run-regression.ts` | Emit `regression:detected` on failure |
| `bin/nax.ts` | Remove `totalCost`/`elapsedMs` from `renderTui` call |
| `test/unit/tui/` | Tests for new hook and `LiveActivityPanel` |

---

## Out of Scope

- PTY re-integration into `LiveActivityPanel` (kept as forward-compat stub)
- Retry keybinding implementation (depends on queue-level retry support not yet designed)
- Scrollable Live Activity history / log persistence
- `CostOverlay` redesign (kept as-is)
- `HelpOverlay` redesign (kept as-is)
