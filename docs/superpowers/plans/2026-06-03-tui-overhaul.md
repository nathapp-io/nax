# TUI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken TUI event wiring and replace the stale layout with a Stories + Live Activity two-panel design that surfaces failure reasons, escalation, parallel execution, and run completion.

**Architecture:** The execution layer already emits rich events on `PipelineEventBus` (singleton in `src/pipeline/event-bus.ts`). The TUI currently subscribes to the wrong bus (`PipelineEventEmitter`). This plan (1) patches three missing event gaps on the new bus, (2) replaces the TUI hooks and `AgentPanel` with a new `usePipelineBusEvents` hook and `LiveActivityPanel`, and (3) rewires `App.tsx` to the new data sources.

**Tech Stack:** Bun + TypeScript strict, React/Ink 6.x, `ink-testing-library` for TUI tests, `bun:test`

---

## File Map

| File | Action |
|---|---|
| `src/pipeline/event-bus.ts` | Add `StorySkippedEvent`, `StoryEscalatedEvent`; extend `PipelineEvent` union |
| `src/pipeline/index.ts` | Export `pipelineEventBus` singleton + new event types |
| `src/execution/pipeline-result-handler.ts` | Emit `story:skipped` in `case "skip":` |
| `src/execution/escalation/tier-escalation.ts` | Emit `story:escalated` after `escalatedTier` is assigned |
| `src/execution/lifecycle/run-regression.ts` | Emit `regression:detected` per affected story |
| `src/tui/types.ts` | Add `failureReason`, `modelTier`, `iteration` to `StoryDisplayState`; remove `totalCost`/`elapsedMs` from `TuiProps` |
| `src/tui/hooks/useAgentStreamEvents.ts` | Add `model` + `lastToolName` to `ActiveCallState` |
| `src/tui/hooks/usePipelineBusEvents.ts` | **New** — subscribes to `pipelineEventBus`, returns all story lifecycle state |
| `src/tui/hooks/usePipelineEvents.ts` | Trim to stage-only (`stage:enter` → `currentStage`) |
| `src/tui/components/LiveActivityPanel.tsx` | **New** — 2-line active call rows + run summary |
| `src/tui/components/AgentPanel.tsx` | **Delete** |
| `src/tui/components/StoriesPanel.tsx` | Enrich rows (failure sub-line, retrying tier), remove footer |
| `src/tui/components/StatusBar.tsx` | Keybinding hints left, story context right |
| `src/tui/App.tsx` | New header (cost/time), wire `usePipelineBusEvents`, replace `AgentPanel` |
| `bin/nax.ts` | Remove `totalCost`/`elapsedMs` from `renderTui` call |
| `test/unit/pipeline/event-bus.test.ts` | Add tests for two new event types |
| `test/unit/execution/pipeline-result-handler.test.ts` | Add test for `story:skipped` emission |
| `test/unit/execution/escalation/tier-escalation.test.ts` | Add test for `story:escalated` emission |
| `test/ui/usePipelineBusEvents.test.tsx` | **New** — uses ink-testing-library wrapper component |
| `test/ui/LiveActivityPanel.test.tsx` | **New** (renames `tui-agent-panel.test.tsx` target) |

---

## Task 1: Add new event types to PipelineEventBus

**Files:**
- Modify: `src/pipeline/event-bus.ts`
- Modify: `src/pipeline/index.ts`
- Modify: `test/unit/pipeline/event-bus.test.ts`

- [ ] **Step 1: Write failing tests for new event types**

Add to `test/unit/pipeline/event-bus.test.ts` before the closing `});`:

```typescript
test("story:skipped event is typed and receivable", () => {
  const bus = new PipelineEventBus();
  const received: PipelineEvent[] = [];
  bus.on("story:skipped", (e) => received.push(e));

  bus.emit({ type: "story:skipped", storyId: "US-001", reason: "user requested skip" });

  expect(received).toHaveLength(1);
  expect(received[0].type).toBe("story:skipped");
});

test("story:escalated event is typed and receivable", () => {
  const bus = new PipelineEventBus();
  const received: PipelineEvent[] = [];
  bus.on("story:escalated", (e) => received.push(e));

  bus.emit({ type: "story:escalated", storyId: "US-001", fromTier: "fast", toTier: "balanced" });

  expect(received).toHaveLength(1);
  expect(received[0].type).toBe("story:escalated");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
timeout 30 bun test test/unit/pipeline/event-bus.test.ts --timeout=5000
```

Expected: type error or runtime error — `story:skipped` and `story:escalated` are not in the union yet.

- [ ] **Step 3: Add the new event interfaces to `src/pipeline/event-bus.ts`**

After the `StoryPausedEvent` interface (around line 122), add:

```typescript
export interface StorySkippedEvent {
  type: "story:skipped";
  storyId: string;
  reason: string;
}

export interface StoryEscalatedEvent {
  type: "story:escalated";
  storyId: string;
  fromTier: string;
  toTier: string;
}
```

Then extend the `PipelineEvent` union (replace existing):

```typescript
export type PipelineEvent =
  | StoryStartedEvent
  | StoryCompletedEvent
  | StoryFailedEvent
  | StorySkippedEvent
  | StoryEscalatedEvent
  | RegressionDetectedEvent
  | RunCompletedEvent
  | HumanReviewRequestedEvent
  | RunStartedEvent
  | RunPausedEvent
  | StoryPausedEvent
  | RunResumedEvent
  | RunErroredEvent;
```

- [ ] **Step 4: Export `pipelineEventBus` and new types from the pipeline barrel**

In `src/pipeline/index.ts`, add after the existing `export { PipelineEventEmitter }` line:

```typescript
export { pipelineEventBus } from "./event-bus";
export type {
  PipelineEvent,
  PipelineEventType,
  RunCompletedEvent,
  StorySkippedEvent,
  StoryEscalatedEvent,
  StoryStartedEvent,
  StoryFailedEvent,
} from "./event-bus";
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
timeout 30 bun test test/unit/pipeline/event-bus.test.ts --timeout=5000
```

Expected: all tests PASS including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/event-bus.ts src/pipeline/index.ts test/unit/pipeline/event-bus.test.ts
git commit -m "feat(pipeline): add story:skipped and story:escalated event types"
```

---

## Task 2: Wire `story:skipped` emit in pipeline-result-handler

**Files:**
- Modify: `src/execution/pipeline-result-handler.ts`
- Modify: `test/unit/execution/pipeline-result-handler.test.ts`

- [ ] **Step 1: Write a failing test**

In `test/unit/execution/pipeline-result-handler.test.ts`, add a new `describe` block (using the existing `makeCtx`/`makeStory`/`makePRD`/`makeMinimalResult` helpers already in that file):

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import type { PipelineEvent } from "../../../src/pipeline/event-bus";

// Add inside a new describe block at the bottom of the file:
describe("story:skipped event emission", () => {
  let received: PipelineEvent[] = [];

  beforeEach(() => {
    received = [];
    pipelineEventBus.clear();
    pipelineEventBus.on("story:skipped", (e) => received.push(e));
  });

  afterEach(() => {
    pipelineEventBus.clear();
  });

  test("emits story:skipped when finalAction is skip", async () => {
    const story = makeStory("US-001");
    const prd = makePRD([story]);
    const result = { ...makeMinimalResult(), finalAction: "skip" as const, reason: "user skipped" };
    const ctx = makeCtx(story, { prd, prdPath: "/tmp/prd.json" });

    // handlePipelineFailure drives the skip path
    await handlePipelineFailure(result, ctx);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "story:skipped", storyId: "US-001", reason: "user skipped" });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
timeout 30 bun test test/unit/execution/pipeline-result-handler.test.ts --timeout=5000
```

Expected: FAIL — `story:skipped` event not emitted yet.

- [ ] **Step 3: Add the emit to `src/execution/pipeline-result-handler.ts`**

Locate the `case "skip":` branch (around line 241). Replace it:

```typescript
case "skip":
  logger?.warn("pipeline", "Story skipped", { storyId: ctx.story.id, reason: pipelineResult.reason });
  pipelineEventBus.emit({
    type: "story:skipped",
    storyId: ctx.story.id,
    reason: pipelineResult.reason || "Story skipped",
  });
  prdDirty = true;
  break;
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
timeout 30 bun test test/unit/execution/pipeline-result-handler.test.ts --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/pipeline-result-handler.ts test/unit/execution/pipeline-result-handler.test.ts
git commit -m "feat(execution): emit story:skipped event when story is skipped"
```

---

## Task 3: Wire `story:escalated` emit in tier-escalation

**Files:**
- Modify: `src/execution/escalation/tier-escalation.ts`
- Modify: `test/unit/execution/escalation/tier-escalation.test.ts`

- [ ] **Step 1: Write a failing test**

Add to `test/unit/execution/escalation/tier-escalation.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { PipelineEvent } from "../../../../src/pipeline/event-bus";

// Add at the bottom of the file:
describe("story:escalated event emission", () => {
  let received: PipelineEvent[] = [];

  beforeEach(() => {
    received = [];
    pipelineEventBus.clear();
    pipelineEventBus.on("story:escalated", (e) => received.push(e));
  });

  afterEach(() => {
    pipelineEventBus.clear();
  });

  test("emits story:escalated when story exceeds tier budget and next tier exists", async () => {
    const { checkAndEscalateTier } = await import("../../../../src/execution/escalation/tier-escalation");

    // Minimal config with two-tier escalation enabled
    const config = {
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 1, agent: "claude" },
            { tier: "balanced", attempts: 3, agent: "claude" },
          ],
        },
      },
      routing: { llm: { mode: "keyword" } },
    } as any;

    const story = {
      id: "US-001",
      title: "Test",
      attempts: 1, // equals tierCfg.attempts → triggers escalation
      escalations: [],
      routing: { modelTier: "fast", testStrategy: "tdd", complexity: "simple" },
    } as any;

    const prd = { userStories: [story] } as any;

    await checkAndEscalateTier({
      story,
      currentTier: "fast",
      routing: story.routing,
      config,
      prd,
      prdPath: "/tmp/prd.json",
      featureDir: undefined,
      hooks: {} as any,
      logger: undefined,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "story:escalated",
      storyId: "US-001",
      fromTier: "fast",
      toTier: "balanced",
    });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000
```

Expected: FAIL — `story:escalated` not emitted yet.

- [ ] **Step 3: Add the import and emit to `src/execution/escalation/tier-escalation.ts`**

Add to the imports at the top of the file:

```typescript
import { pipelineEventBus } from "../pipeline/event-bus";
```

Then in the escalation success branch, after `clearCacheForStory(story.id)` and before the hybrid mode check (around line 188), add:

```typescript
pipelineEventBus.emit({
  type: "story:escalated",
  storyId: story.id,
  fromTier: currentTier,
  toTier: escalatedTier,
});
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
timeout 30 bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/escalation/tier-escalation.ts test/unit/execution/escalation/tier-escalation.test.ts
git commit -m "feat(execution): emit story:escalated event on tier promotion"
```

---

## Task 4: Wire `regression:detected` emit in run-regression

**Files:**
- Modify: `src/execution/lifecycle/run-regression.ts`

- [ ] **Step 1: Add the import to `src/execution/lifecycle/run-regression.ts`**

The file already uses `@/` imports. Add:

```typescript
import { pipelineEventBus } from "@/pipeline";
```

- [ ] **Step 2: Add the emit after affected stories are mapped**

In `runDeferredRegressionGate`, locate the section after `affectedStories` is populated and `affectedStories.size === 0` early return is passed (around line 310). Add before the rectification loop begins:

```typescript
// Emit regression:detected for each affected story so the TUI can surface it
for (const storyId of affectedStories) {
  pipelineEventBus.emit({
    type: "regression:detected",
    storyId,
    failedTests: testFilesInFailures.size,
  });
}
```

- [ ] **Step 3: Run the regression test file to confirm nothing broken**

```bash
timeout 30 bun test test/unit/execution/ --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/execution/lifecycle/run-regression.ts
git commit -m "feat(execution): emit regression:detected event on deferred regression failure"
```

---

## Task 5: Update TUI types

**Files:**
- Modify: `src/tui/types.ts`

- [ ] **Step 1: Update `StoryDisplayState` in `src/tui/types.ts`**

Replace the `StoryDisplayState` interface:

```typescript
export interface StoryDisplayState {
  /** Story data from PRD */
  story: UserStory;
  /** Current status for display */
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "retrying" | "paused";
  /** Routing result (if classified) */
  routing?: StoryRouting;
  /** Cost incurred for this story */
  cost?: number;
  /** Active model tier (from story:started) */
  modelTier?: string;
  /** Failure reason for display (from story:failed.reason, truncated) */
  failureReason?: string;
  /** Attempt iteration count — >1 means escalated (from story:started.iteration) */
  iteration?: number;
}
```

- [ ] **Step 2: Update `TuiProps` — remove dead fields**

Replace the `TuiProps` interface:

```typescript
export interface TuiProps {
  /** Feature name */
  feature: string;
  /** All stories to display (initial state; updates come from pipeline bus) */
  stories: StoryDisplayState[];
  /** Pipeline event emitter for stage tracking (stage:enter/stage:exit) */
  events: PipelineEventEmitter;
  /** Path to queue file for writing commands (optional) */
  queueFilePath?: string;
  /** PTY spawn options — reserved for future PTY re-integration */
  ptyOptions?: PtySpawnOptions | null;
  /** Agent stream event bus for live call metadata (optional) */
  agentStreamEvents?: IAgentStreamEventBus | null;
}
```

- [ ] **Step 3: Run typecheck to confirm no regressions**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: errors only in `App.tsx` and `bin/nax.ts` (which reference the removed fields — those are fixed in later tasks). No new errors in other files.

- [ ] **Step 4: Commit**

```bash
git add src/tui/types.ts
git commit -m "refactor(tui): enrich StoryDisplayState, remove dead TuiProps fields"
```

---

## Task 6: Enrich `ActiveCallState` with model and lastToolName

**Files:**
- Modify: `src/tui/hooks/useAgentStreamEvents.ts`

- [ ] **Step 1: Add `model` and `lastToolName` to `ActiveCallState`**

In `src/tui/hooks/useAgentStreamEvents.ts`, update the `ActiveCallState` interface:

```typescript
export interface ActiveCallState {
  callId: string;
  agentName: string;
  storyId?: string;
  stage?: string;
  startedAt: number;
  lastActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
  toolCallUpdates: number;
  status: "active" | "ended";
  /** Model used for this call (from agent.call_started) */
  model?: string;
  /** Most recently called tool name (from agent.tool_call_update) */
  lastToolName?: string;
}
```

- [ ] **Step 2: Populate `model` on `agent.call_started` and `lastToolName` on `agent.tool_call_update`**

In the `switch (event.kind)` block, update the two relevant cases:

```typescript
case "agent.call_started": {
  const now = event.timestamp;
  next.set(event.callId, {
    callId: event.callId,
    agentName: event.agentName,
    storyId: event.storyId,
    stage: event.stage,
    startedAt: now,
    lastActivityAt: now,
    messageUpdates: 0,
    thinkingUpdates: 0,
    usageUpdates: 0,
    toolCallUpdates: 0,
    status: "active",
    model: event.model,        // new
  });
  break;
}
```

```typescript
case "agent.tool_call_update": {
  const state = next.get(event.callId);
  if (state) {
    next.set(event.callId, {
      ...state,
      toolCallUpdates: state.toolCallUpdates + 1,
      lastActivityAt: event.timestamp,
      lastToolName: event.toolName,   // new
    });
  }
  break;
}
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: no new errors from this file.

- [ ] **Step 4: Commit**

```bash
git add src/tui/hooks/useAgentStreamEvents.ts
git commit -m "feat(tui): track model and lastToolName in ActiveCallState"
```

---

## Task 7: Implement `usePipelineBusEvents` hook

**Files:**
- Create: `src/tui/hooks/usePipelineBusEvents.ts`
- Create: `test/ui/usePipelineBusEvents.test.tsx`

The project uses `ink-testing-library` (not `@testing-library/react`) for TUI tests — see `test/ui/tui-agent-panel.test.tsx`. Hook tests use a minimal wrapper component rendered with `ink-testing-library`.

- [ ] **Step 1: Write failing tests**

Create `test/ui/usePipelineBusEvents.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Text } from "ink";
import { pipelineEventBus } from "../../src/pipeline/event-bus";
import { usePipelineBusEvents } from "../../src/tui/hooks/usePipelineBusEvents";
import type { StoryDisplayState } from "../../src/tui/types";

function makeInitialStory(id: string): StoryDisplayState {
  return {
    story: { id, title: `Story ${id}`, passes: false, workdir: ".", acceptanceCriteria: [] } as any,
    status: "pending",
  };
}

// Wrapper that renders hook state as inspectable text
function HookOutput({ stories }: { stories: StoryDisplayState[] }) {
  const state = usePipelineBusEvents(stories);
  const first = state.stories[0];
  return (
    <Text>
      status:{first?.status ?? "none"}
      |tier:{first?.modelTier ?? "none"}
      |reason:{first?.failureReason ?? "none"}
      |escalations:{state.escalationLog.length}
      |cost:{state.totalCost.toFixed(4)}
      |summary:{state.runSummary ? state.runSummary.passedStories : "none"}
    </Text>
  );
}

beforeEach(() => pipelineEventBus.clear());
afterEach(() => pipelineEventBus.clear());

describe("usePipelineBusEvents", () => {
  test("story:started marks story running with modelTier", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({
      type: "story:started",
      storyId: "US-001",
      story: { id: "US-001", title: "S", status: "pending", attempts: 0 },
      workdir: ".",
      modelTier: "balanced",
      iteration: 1,
    });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("status:running");
    expect(lastFrame()).toContain("tier:balanced");
  });

  test("story:completed marks story passed and accumulates cost", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({
      type: "story:completed",
      storyId: "US-001",
      story: { id: "US-001", title: "S", status: "passed", attempts: 1 },
      passed: true,
      runElapsedMs: 5000,
      cost: 0.0042,
    });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("status:passed");
    expect(lastFrame()).toContain("cost:0.0042");
  });

  test("story:failed marks story failed with reason", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({
      type: "story:failed",
      storyId: "US-001",
      story: { id: "US-001", title: "S", status: "failed", attempts: 3 },
      reason: "3 tests failed",
      countsTowardEscalation: true,
    });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("status:failed");
    expect(lastFrame()).toContain("reason:3 tests failed");
  });

  test("story:skipped marks story skipped", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({ type: "story:skipped", storyId: "US-001", reason: "user skip" });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("status:skipped");
  });

  test("story:escalated marks story retrying and appends escalation log", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({
      type: "story:escalated",
      storyId: "US-001",
      fromTier: "fast",
      toTier: "balanced",
    });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("status:retrying");
    expect(lastFrame()).toContain("escalations:1");
  });

  test("run:completed sets runSummary passedStories", () => {
    const { lastFrame, rerender } = render(
      <HookOutput stories={[makeInitialStory("US-001")]} />
    );

    pipelineEventBus.emit({
      type: "run:completed",
      totalStories: 1,
      passedStories: 1,
      failedStories: 0,
      skippedStories: 0,
      pausedStories: 0,
      durationMs: 8000,
      totalCost: 0.0063,
    });
    rerender(<HookOutput stories={[makeInitialStory("US-001")]} />);

    expect(lastFrame()).toContain("summary:1");
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
timeout 30 bun test test/ui/usePipelineBusEvents.test.tsx --timeout=5000
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tui/hooks/usePipelineBusEvents.ts`**

```typescript
import { useEffect, useRef, useState } from "react";
import { pipelineEventBus } from "@/pipeline";
import type { RunCompletedEvent } from "@/pipeline";

import type { StoryDisplayState } from "../types";

export interface EscalationEntry {
  storyId: string;
  fromTier: string;
  toTier: string;
  timestamp: number;
}

export interface PipelineBusState {
  stories: StoryDisplayState[];
  totalCost: number;
  elapsedMs: number;
  runPaused: boolean;
  runSummary: RunCompletedEvent | undefined;
  runErrored: string | undefined;
  escalationLog: EscalationEntry[];
}

export function usePipelineBusEvents(initialStories: StoryDisplayState[]): PipelineBusState {
  const [state, setState] = useState<PipelineBusState>({
    stories: initialStories,
    totalCost: 0,
    elapsedMs: 0,
    runPaused: false,
    runSummary: undefined,
    runErrored: undefined,
    escalationLog: [],
  });

  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    const startTime = startTimeRef.current;
    let timer: ReturnType<typeof setInterval> | null = null;

    const startTimer = () => {
      if (!timer) {
        timer = setInterval(() => {
          setState((prev) => ({ ...prev, elapsedMs: Date.now() - startTime }));
        }, 1000);
      }
    };

    const stopTimer = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    const unsubStoryStarted = pipelineEventBus.on("story:started", (e) => {
      startTimer();
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === e.storyId
            ? { ...s, status: "running" as const, modelTier: e.modelTier, iteration: e.iteration }
            : s,
        ),
      }));
    });

    const unsubStoryCompleted = pipelineEventBus.on("story:completed", (e) => {
      setState((prev) => {
        const newStories = prev.stories.map((s) =>
          s.story.id === e.storyId
            ? { ...s, status: "passed" as const, cost: (s.cost ?? 0) + (e.cost ?? 0), modelTier: e.modelTier ?? s.modelTier }
            : s,
        );
        return {
          ...prev,
          stories: newStories,
          totalCost: newStories.reduce((sum, s) => sum + (s.cost ?? 0), 0),
        };
      });
    });

    const unsubStoryFailed = pipelineEventBus.on("story:failed", (e) => {
      stopTimer();
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === e.storyId
            ? { ...s, status: "failed" as const, failureReason: e.reason }
            : s,
        ),
      }));
    });

    const unsubStorySkipped = pipelineEventBus.on("story:skipped", (e) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === e.storyId ? { ...s, status: "skipped" as const } : s,
        ),
      }));
    });

    const unsubStoryPaused = pipelineEventBus.on("story:paused", (e) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === e.storyId
            ? { ...s, status: "paused" as const, failureReason: e.reason }
            : s,
        ),
      }));
    });

    const unsubStoryEscalated = pipelineEventBus.on("story:escalated", (e) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === e.storyId ? { ...s, status: "retrying" as const } : s,
        ),
        escalationLog: [
          ...prev.escalationLog,
          { storyId: e.storyId, fromTier: e.fromTier, toTier: e.toTier, timestamp: Date.now() },
        ],
      }));
    });

    const unsubRunPaused = pipelineEventBus.on("run:paused", () => {
      stopTimer();
      setState((prev) => ({ ...prev, runPaused: true }));
    });

    const unsubRunResumed = pipelineEventBus.on("run:resumed", () => {
      startTimer();
      setState((prev) => ({ ...prev, runPaused: false }));
    });

    const unsubRunCompleted = pipelineEventBus.on("run:completed", (e) => {
      stopTimer();
      setState((prev) => ({ ...prev, runSummary: e, totalCost: e.totalCost ?? prev.totalCost }));
    });

    const unsubRunErrored = pipelineEventBus.on("run:errored", (e) => {
      stopTimer();
      setState((prev) => ({ ...prev, runErrored: e.reason }));
    });

    return () => {
      stopTimer();
      unsubStoryStarted();
      unsubStoryCompleted();
      unsubStoryFailed();
      unsubStorySkipped();
      unsubStoryPaused();
      unsubStoryEscalated();
      unsubRunPaused();
      unsubRunResumed();
      unsubRunCompleted();
      unsubRunErrored();
    };
  }, []);

  return state;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
timeout 30 bun test test/ui/usePipelineBusEvents.test.tsx --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/usePipelineBusEvents.ts test/ui/usePipelineBusEvents.test.tsx
git commit -m "feat(tui): implement usePipelineBusEvents hook"
```

---

## Task 8: Trim `usePipelineEvents` to stage-only

**Files:**
- Modify: `src/tui/hooks/usePipelineEvents.ts`

- [ ] **Step 1: Replace the hook body**

Replace the entire contents of `src/tui/hooks/usePipelineEvents.ts`:

```typescript
/**
 * usePipelineEvents — stage tracking only.
 *
 * Subscribes to stage:enter on the PipelineEventEmitter (old bus) which
 * is still used by pipeline/runner.ts to emit stage transitions.
 * All story lifecycle state comes from usePipelineBusEvents.
 */

import { useEffect, useState } from "react";
import type { PipelineEventEmitter } from "../../pipeline/events";

export function usePipelineEvents(events: PipelineEventEmitter): { currentStage: string | undefined } {
  const [currentStage, setCurrentStage] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onStageEnter = (stage: string) => setCurrentStage(stage);
    events.on("stage:enter", onStageEnter);
    return () => events.off("stage:enter", onStageEnter);
  }, [events]);

  return { currentStage };
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck 2>&1 | grep "usePipelineEvents" | head -10
```

Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/usePipelineEvents.ts
git commit -m "refactor(tui): trim usePipelineEvents to stage tracking only"
```

---

## Task 9: Implement `LiveActivityPanel`

**Files:**
- Create: `src/tui/components/LiveActivityPanel.tsx`
- Create: `test/ui/LiveActivityPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `test/ui/LiveActivityPanel.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { LiveActivityPanel } from "../../../src/tui/components/LiveActivityPanel";
import type { ActiveCallState } from "../../../src/tui/hooks/useAgentStreamEvents";
import type { RunCompletedEvent } from "../../../src/pipeline/event-bus";

function makeCall(overrides: Partial<ActiveCallState> = {}): ActiveCallState {
  return {
    callId: "call-1",
    agentName: "claude",
    storyId: "US-001",
    stage: "execution",
    startedAt: Date.now() - 45000,
    lastActivityAt: Date.now() - 2000,
    messageUpdates: 3,
    thinkingUpdates: 1,
    usageUpdates: 1,
    toolCallUpdates: 4,
    status: "active",
    model: "sonnet",
    lastToolName: "Write",
    ...overrides,
  };
}

describe("LiveActivityPanel", () => {
  test("shows spinner when no active calls and no summary", () => {
    const { lastFrame } = render(React.createElement(LiveActivityPanel, {}));
    expect(lastFrame()).toContain("Waiting for agent");
  });

  test("renders 2-line entry for an active call", () => {
    const calls = new Map([["call-1", makeCall()]]);
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { activeCalls: calls }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("US-001");
    expect(frame).toContain("execution");
    expect(frame).toContain("sonnet");
    expect(frame).toContain("Write");
  });

  test("shows run summary when runSummary is set", () => {
    const summary: RunCompletedEvent = {
      type: "run:completed",
      totalStories: 3,
      passedStories: 2,
      failedStories: 1,
      skippedStories: 0,
      pausedStories: 0,
      durationMs: 120000,
      totalCost: 0.0421,
    };
    const { lastFrame } = render(React.createElement(LiveActivityPanel, { runSummary: summary }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2");
    expect(frame).toContain("passed");
    expect(frame).toContain("$0.0421");
  });

  test("shows error banner when runErrored is set", () => {
    const { lastFrame } = render(
      React.createElement(LiveActivityPanel, { runErrored: "config load failed" })
    );
    expect(lastFrame()).toContain("config load failed");
  });

  test("shows escalation log entries when present", () => {
    const calls = new Map([["call-1", makeCall()]]);
    const escalationLog = [{ storyId: "US-001", fromTier: "fast", toTier: "balanced", timestamp: Date.now() }];
    const { lastFrame } = render(
      React.createElement(LiveActivityPanel, { activeCalls: calls, escalationLog })
    );
    expect(lastFrame()).toContain("fast");
    expect(lastFrame()).toContain("balanced");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
timeout 30 bun test test/ui/LiveActivityPanel.test.tsx --timeout=5000
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tui/components/LiveActivityPanel.tsx`**

```tsx
/**
 * LiveActivityPanel — shows active agent calls (2-line rows) and run completion summary.
 *
 * Replaces AgentPanel. Data comes from useAgentStreamEvents (active calls)
 * and usePipelineBusEvents (runSummary, escalationLog).
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { RunCompletedEvent } from "../../pipeline/event-bus";
import type { ActiveCallState } from "../hooks/useAgentStreamEvents";
import type { EscalationEntry } from "../hooks/usePipelineBusEvents";

export interface LiveActivityPanelProps {
  activeCalls?: Map<string, ActiveCallState>;
  runSummary?: RunCompletedEvent;
  runErrored?: string;
  escalationLog?: EscalationEntry[];
  focused?: boolean;
}

function toolIcon(name: string | undefined): string {
  if (!name) return "💬";
  const lower = name.toLowerCase();
  if (lower === "bash") return "🔩";
  return "🔧";
}

function formatElapsed(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function LiveActivityPanel({
  activeCalls,
  runSummary,
  runErrored,
  escalationLog = [],
  focused = false,
}: LiveActivityPanelProps) {
  const borderColor = focused ? "cyan" : "gray";
  const activeList = activeCalls ? Array.from(activeCalls.values()) : [];
  const now = Date.now();

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={borderColor}>
      <Box paddingX={1} borderStyle="single" borderBottom borderColor={borderColor}>
        <Text bold color={focused ? "cyan" : undefined}>
          Live Activity
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1} flexGrow={1}>
        {runSummary ? (
          <RunSummaryView summary={runSummary} />
        ) : runErrored ? (
          <Text color="red">Run error: {runErrored}</Text>
        ) : activeList.length > 0 ? (
          <>
            {activeList.map((call) => (
              <ActiveCallRow key={call.callId} call={call} now={now} />
            ))}
            {escalationLog.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {escalationLog.slice(-3).map((entry, i) => (
                  <Text key={i} dimColor>
                    {entry.storyId} escalated {entry.fromTier} → {entry.toTier}
                  </Text>
                ))}
              </Box>
            )}
          </>
        ) : (
          <Text dimColor>
            <Spinner type="dots" /> Waiting for agent...
          </Text>
        )}
      </Box>
    </Box>
  );
}

function ActiveCallRow({ call, now }: { call: ActiveCallState; now: number }) {
  const elapsed = now - call.startedAt;
  const icon = toolIcon(call.lastToolName);
  const toolDisplay = call.lastToolName ?? "thinking";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">● {call.storyId ?? call.agentName}</Text>
        {call.stage && <Text dimColor>  [{call.stage}]</Text>}
        <Text>  {call.model ?? call.agentName}</Text>
        <Text dimColor>  {formatElapsed(elapsed)}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          └ {icon} {toolDisplay}
        </Text>
      </Box>
    </Box>
  );
}

function RunSummaryView({ summary }: { summary: RunCompletedEvent }) {
  const mins = Math.floor(summary.durationMs / 60000);
  const secs = Math.floor((summary.durationMs % 60000) / 1000);
  const cost = (summary.totalCost ?? 0).toFixed(4);

  return (
    <Box flexDirection="column">
      <Box gap={3} marginBottom={1}>
        <Text>
          <Text color="green">{summary.passedStories}</Text> passed
        </Text>
        <Text>
          <Text color={summary.failedStories > 0 ? "red" : "gray"}>{summary.failedStories}</Text> failed
        </Text>
        <Text dimColor>{summary.skippedStories} skipped</Text>
      </Box>
      <Text>
        Total cost: <Text color="green">${cost}</Text>
      </Text>
      <Text>
        Duration: <Text color="cyan">{mins}m {secs}s</Text>
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
timeout 30 bun test test/ui/LiveActivityPanel.test.tsx --timeout=5000
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/LiveActivityPanel.tsx test/ui/LiveActivityPanel.test.tsx
git commit -m "feat(tui): implement LiveActivityPanel with 2-line activity rows and run summary"
```

---

## Task 10: Update `StoriesPanel`

**Files:**
- Modify: `src/tui/components/StoriesPanel.tsx`

- [ ] **Step 1: Update `getStatusIcon` — icons are unchanged, keep as-is**

No changes needed to icon mapping.

- [ ] **Step 2: Update story row rendering — add failure sub-line, retrying tier indicator, remove footer**

Replace the `StoriesPanel` function body. Key changes: (a) show `failureReason` sub-line for failed/paused stories, (b) show `→{modelTier}` for retrying stories, (c) remove the footer (cost/time now in App header), (d) pass `width` prop through unchanged.

```tsx
export function StoriesPanel({ stories, width, compact = false, maxHeight }: Omit<StoriesPanelProps, "totalCost" | "elapsedMs">) {
  const maxVisible = compact ? COMPACT_MAX_VISIBLE_STORIES : MAX_VISIBLE_STORIES;
  const needsScrolling = stories.length > maxVisible;
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const runningIndex = stories.findIndex((s) => s.status === "running");
    if (runningIndex !== -1 && needsScrolling) {
      if (runningIndex < scrollOffset) setScrollOffset(runningIndex);
      else if (runningIndex >= scrollOffset + maxVisible) setScrollOffset(runningIndex - maxVisible + 1);
    }
  }, [stories, scrollOffset, maxVisible, needsScrolling]);

  const visibleStories = needsScrolling ? stories.slice(scrollOffset, scrollOffset + maxVisible) : stories;
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < stories.length;

  return (
    <Box flexDirection="column" width={width} height={maxHeight} borderStyle="single" borderColor="gray">
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="gray">
        <Text bold>Stories</Text>
        {needsScrolling && <Text dimColor> ({stories.length})</Text>}
      </Box>

      {needsScrolling && canScrollUp && (
        <Box paddingX={1}><Text dimColor>▲ {scrollOffset} above</Text></Box>
      )}

      <Box flexDirection="column" paddingX={1} paddingY={1} flexGrow={1}>
        {visibleStories.map((s) => {
          const icon = getStatusIcon(s.status);

          if (compact) {
            return (
              <Box key={s.story.id}>
                <Text>{icon} {s.story.id}</Text>
              </Box>
            );
          }

          const tierSuffix = s.status === "retrying" && s.modelTier
            ? <Text dimColor> →{s.modelTier.slice(0, 3)}</Text>
            : s.modelTier
            ? <Text dimColor> {s.modelTier.slice(0, 3)}</Text>
            : null;

          const showReason = (s.status === "failed" || s.status === "paused") && s.failureReason;

          return (
            <Box key={s.story.id} flexDirection="column">
              <Box>
                <Text color={s.status === "running" ? "cyan" : s.status === "failed" ? "red" : undefined}>
                  {icon} {s.story.id}
                </Text>
                {tierSuffix}
              </Box>
              {showReason && (
                <Box paddingLeft={2}>
                  <Text dimColor>└ {s.failureReason!.slice(0, 25)}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {needsScrolling && canScrollDown && (
        <Box paddingX={1}><Text dimColor>▼ {stories.length - scrollOffset - maxVisible} below</Text></Box>
      )}
    </Box>
  );
}
```

Also remove `totalCost` and `elapsedMs` from `StoriesPanelProps`:

```typescript
export interface StoriesPanelProps {
  stories: StoryDisplayState[];
  width?: number;
  compact?: boolean;
  maxHeight?: number;
}
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck 2>&1 | grep "StoriesPanel" | head -10
```

Expected: errors only in `App.tsx` (which still passes the removed props — fixed in Task 12).

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/StoriesPanel.tsx
git commit -m "feat(tui): enrich StoriesPanel rows with failure reasons and tier indicators"
```

---

## Task 11: Update `StatusBar`

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`

- [ ] **Step 1: Update `StatusBar` to show keybinding hints left, context right**

Replace the entire component:

```tsx
/**
 * StatusBar — keybinding hints (left) and current story context (right).
 */

import { Box, Text } from "ink";

export interface StatusBarProps {
  currentStage?: string;
  currentStoryId?: string;
  modelTier?: string;
  runPaused?: boolean;
  runComplete?: boolean;
  isParallel?: boolean;
  activeCount?: number;
}

export function StatusBar({
  currentStage,
  currentStoryId,
  modelTier,
  runPaused,
  runComplete,
  isParallel,
  activeCount = 0,
}: StatusBarProps) {
  const hints = runComplete
    ? "q quit  c cost  ? help"
    : "p pause  a abort  s skip  c cost  ? help";

  let context: string;
  if (runComplete) {
    context = "done";
  } else if (runPaused) {
    context = "run paused";
  } else if (isParallel && activeCount > 0) {
    context = `parallel · ${activeCount} active`;
  } else if (currentStoryId) {
    const parts = [currentStoryId, currentStage, modelTier].filter(Boolean);
    context = parts.join(" · ");
  } else {
    context = "idle";
  }

  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray" justifyContent="space-between">
      <Text dimColor>{hints}</Text>
      <Text dimColor>{context}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck 2>&1 | grep "StatusBar" | head -10
```

Expected: errors only in `App.tsx` (fixed in Task 12).

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/StatusBar.tsx
git commit -m "feat(tui): rework StatusBar with keybinding hints and parallel mode context"
```

---

## Task 12: Rewire `App.tsx`

**Files:**
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Replace the full `App.tsx`**

```tsx
/**
 * App — root TUI component.
 *
 * Orchestrates the layout, stories panel, live activity panel, and status bar.
 */

import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { writeQueueCommand } from "../utils/queue-writer";
import { CostOverlay } from "./components/CostOverlay";
import { HelpOverlay } from "./components/HelpOverlay";
import { LiveActivityPanel } from "./components/LiveActivityPanel";
import { StatusBar } from "./components/StatusBar";
import { StoriesPanel } from "./components/StoriesPanel";
import { useAgentStreamEvents } from "./hooks/useAgentStreamEvents";
import { type KeyboardAction, useKeyboard } from "./hooks/useKeyboard";
import { MIN_TERMINAL_WIDTH, useLayout } from "./hooks/useLayout";
import { usePipelineBusEvents } from "./hooks/usePipelineBusEvents";
import { usePipelineEvents } from "./hooks/usePipelineEvents";
import { usePty } from "./hooks/usePty";
import { PanelFocus } from "./types";
import type { TuiProps } from "./types";

export function App({
  feature,
  stories: initialStories,
  events,
  queueFilePath,
  ptyOptions,
  agentStreamEvents,
}: TuiProps) {
  const layout = useLayout();
  const busState = usePipelineBusEvents(initialStories);
  const { currentStage } = usePipelineEvents(events);
  const { activeCalls } = useAgentStreamEvents(agentStreamEvents);
  const { exit } = useApp();

  const [focus, setFocus] = useState<PanelFocus>(PanelFocus.Stories);
  const [showHelp, setShowHelp] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  // PTY wired for future use (currently read-only panel)
  const { handle: ptyHandle } = usePty(ptyOptions ?? null);

  const isRunComplete = !!busState.runSummary;
  const runningStories = busState.stories.filter((s) => s.status === "running");
  const isParallel = runningStories.length > 1;
  const currentRunningStory = runningStories[0];

  const handleKeyboardAction = async (action: KeyboardAction) => {
    switch (action.type) {
      case "TOGGLE_FOCUS":
        setFocus((prev) => (prev === PanelFocus.Stories ? PanelFocus.Agent : PanelFocus.Stories));
        break;
      case "ESCAPE_AGENT":
        setFocus(PanelFocus.Stories);
        break;
      case "SHOW_HELP":
        setShowHelp(true);
        break;
      case "SHOW_COST":
        setShowCost(true);
        break;
      case "CLOSE_OVERLAY":
        setShowHelp(false);
        setShowCost(false);
        setShowQuitConfirm(false);
        setShowAbortConfirm(false);
        break;
      case "QUIT":
        if (currentRunningStory) {
          setShowQuitConfirm(true);
        } else {
          exit();
        }
        break;
      case "PAUSE":
        if (queueFilePath) await writeQueueCommand(queueFilePath, { type: "PAUSE" });
        break;
      case "ABORT":
        if (currentRunningStory) {
          setShowAbortConfirm(true);
        } else if (queueFilePath) {
          await writeQueueCommand(queueFilePath, { type: "ABORT" });
        }
        break;
      case "SKIP":
        if (queueFilePath) await writeQueueCommand(queueFilePath, { type: "SKIP", storyId: action.storyId });
        break;
      default:
        break;
    }
  };

  useInput((input, key) => {
    if (showQuitConfirm || showAbortConfirm) {
      const k = input.toLowerCase();
      if (k === "y") {
        if (showQuitConfirm) exit();
        else if (showAbortConfirm && queueFilePath) {
          writeQueueCommand(queueFilePath, { type: "ABORT" });
          setShowAbortConfirm(false);
        }
      } else if (k === "n" || input === "\x1b") {
        setShowQuitConfirm(false);
        setShowAbortConfirm(false);
      }
      return;
    }

    if (focus === PanelFocus.Agent && ptyHandle) {
      if (key.ctrl && input === "]") return;
      ptyHandle.write(input);
    }
  });

  useKeyboard({
    focus,
    currentStory: currentRunningStory?.story,
    onAction: handleKeyboardAction,
    disabled: showQuitConfirm || showAbortConfirm,
  });

  const isTooSmall = layout.width < MIN_TERMINAL_WIDTH;

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} borderStyle="single" borderBottom borderColor="cyan" justifyContent="space-between">
        <Text bold color="cyan">nax run — {feature}</Text>
        <Text dimColor>
          {isRunComplete
            ? "done"
            : runningStories.length > 0
            ? `${runningStories.length} running  ·  `
            : ""}
          <Text color="green">${busState.totalCost.toFixed(4)}</Text>
          {"  ·  "}
          <Text color="cyan">{formatElapsed(busState.elapsedMs)}</Text>
        </Text>
      </Box>

      {isTooSmall && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">Terminal too narrow ({layout.width} cols, min {MIN_TERMINAL_WIDTH})</Text>
        </Box>
      )}

      {/* Main panels */}
      <Box flexDirection={layout.mode === "single" ? "column" : "row"} flexGrow={1}>
        <StoriesPanel
          stories={busState.stories}
          width={layout.mode === "single" ? layout.width : layout.storiesPanelWidth}
          compact={layout.mode === "single"}
          maxHeight={layout.mode === "single" ? 10 : undefined}
        />
        <LiveActivityPanel
          focused={focus === PanelFocus.Agent}
          activeCalls={activeCalls}
          runSummary={busState.runSummary}
          runErrored={busState.runErrored}
          escalationLog={busState.escalationLog}
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        currentStage={currentStage}
        currentStoryId={currentRunningStory?.story.id}
        modelTier={currentRunningStory?.modelTier}
        runPaused={busState.runPaused}
        runComplete={isRunComplete}
        isParallel={isParallel}
        activeCount={runningStories.length}
      />

      <HelpOverlay visible={showHelp} />
      <CostOverlay visible={showCost} stories={busState.stories} totalCost={busState.totalCost} />

      {showQuitConfirm && (
        <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
          <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1} backgroundColor="black">
            <Text color="yellow">Story is running. Quit anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel</Text>
            </Box>
          </Box>
        </Box>
      )}

      {showAbortConfirm && (
        <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
          <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={2} paddingY={1} backgroundColor="black">
            <Text color="red">Story is running. Abort anyway?</Text>
            <Box paddingTop={1}>
              <Text dimColor>Press <Text color="yellow">y</Text> to confirm, <Text color="yellow">n</Text> to cancel</Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
```

- [ ] **Step 2: Run typecheck to confirm App.tsx is clean**

```bash
bun run typecheck 2>&1 | head -30
```

Expected: errors only in `bin/nax.ts` (removed props — fixed next task).

- [ ] **Step 3: Commit**

```bash
git add src/tui/App.tsx
git commit -m "feat(tui): rewire App with new header, usePipelineBusEvents, and LiveActivityPanel"
```

---

## Task 13: Update `bin/nax.ts`, delete `AgentPanel.tsx`, run full suite

**Files:**
- Modify: `bin/nax.ts`
- Delete: `src/tui/components/AgentPanel.tsx`

- [ ] **Step 1: Remove `totalCost` and `elapsedMs` from `renderTui` call in `bin/nax.ts`**

Find the `renderTui({...})` call (around line 554) and remove the two dead fields:

```typescript
tuiInstance = renderTui({
  feature: options.feature,
  stories: initialStories,
  events: eventEmitter,
  ptyOptions: null,
});
```

- [ ] **Step 2: Run typecheck — should now be clean**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 3: Delete `AgentPanel.tsx`**

```bash
rm src/tui/components/AgentPanel.tsx
```

- [ ] **Step 4: Run full typecheck again to confirm no stray imports**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: zero errors (no remaining imports of `AgentPanel`).

- [ ] **Step 5: Run the full test suite**

```bash
bun run test:bail
```

Expected: all tests pass. If any test imports `AgentPanel` directly, delete or update it.

- [ ] **Step 6: Run lint**

```bash
bun run lint
```

Expected: no errors. Fix any that appear.

- [ ] **Step 7: Commit**

```bash
git add bin/nax.ts
git rm src/tui/components/AgentPanel.tsx
git commit -m "chore(tui): remove dead AgentPanel, drop totalCost/elapsedMs from renderTui call"
```
