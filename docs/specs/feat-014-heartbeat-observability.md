# FEAT-014 — Structured Log & Heartbeat

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

nax runs take 30–120 minutes for multi-story features with no "where are we?" view:
- `nax status` shows last known state (stale, no stage detail)
- `nax logs --follow` is raw JSONL event stream (too noisy)

Users have no visibility into current story, current stage, elapsed time, cost, or pass/fail counts during a run.

---

## 2. Heartbeat Data Model

```typescript
// src/events/types.ts
interface RunHeartbeat {
  type: "run.heartbeat";
  timestamp: string;
  runId: string;
  elapsedSeconds: number;
  currentStory: {
    id: string;
    title: string;
    status: string;
    currentStage: string;       // "routing" | "execution" | "verify" | "review" | "completion"
    stageElapsedSeconds: number;
    attempts: number;
    modelTier: string;
  } | null;                     // null between stories (e.g. deferred regression)
  storyCounts: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    running: number;
  };
  estimatedCostUsd: number;
  lastActivityAt: string;
}
```

---

## 3. Implementation Plan

**Heartbeat emitter** (`runner.ts`):
```typescript
const intervalSec = config.logging?.heartbeatIntervalSeconds ?? 30;
if (intervalSec > 0) {
  const id = setInterval(async () => {
    const hb = buildHeartbeat(runState);
    emitEvent("run.heartbeat", hb);
    await statusWriter.writeHeartbeat(hb);
  }, intervalSec * 1000);
  runCleanup(() => clearInterval(id));
}
```

**Stage transition events** — each pipeline stage emits:
```typescript
emitEvent("stage.enter", { storyId, stage: "verify", timestamp });
// ... logic ...
emitEvent("stage.exit", { storyId, stage: "verify", result: action, durationMs });
```

---

## 4. CLI Changes

**`nax status`** (extended output):
```
┌─ Run Status ──────────────────────────────────────────────────┐
│ Feature: verify-v2    Elapsed: 12m 34s    Cost: $0.42         │
│ Stories: ✅ 2 passed  ❌ 0 failed  ⏳ 3 pending               │
├─ Current Story ───────────────────────────────────────────────┤
│ US-003: Smart test runner baseline tracking                    │
│ Stage: execution (fast tier, attempt 1)  — 2m 18s in stage    │
└───────────────────────────────────────────────────────────────┘
```

**`nax logs --follow --heartbeat`** — filter to heartbeat-only lines (progress bar style, replaces previous line).

---

## 5. Files Affected

| File | Change |
|---|---|
| `src/execution/runner.ts` | Add heartbeat `setInterval`, clear on cleanup |
| `src/events/types.ts` | Add `RunHeartbeat` interface |
| `src/execution/status-writer.ts` | Add `writeHeartbeat()` method |
| `src/pipeline/stages/*.ts` | Emit `stage.enter` / `stage.exit` |
| `src/cli/status.ts` | Render heartbeat table from `status.json` |
| `src/cli/logs.ts` | Add `--heartbeat` filter flag |
| `src/config/schemas.ts` | Add `logging.heartbeatIntervalSeconds` |
| `src/config/types.ts` | Add `LoggingConfig` interface |

---

## 6. Config Changes

```jsonc
{
  "logging": {
    "heartbeatIntervalSeconds": 30   // 0 = disabled
  }
}
```

---

## 7. Test Plan

- Heartbeat emitted every N seconds (mock `setInterval`)
- Heartbeat written to `status.json`
- `stage.enter` / `stage.exit` emitted by each pipeline stage
- `heartbeatIntervalSeconds: 0` → no interval, no events
- Interval cleared on run completion (no leak)
- `nax status` renders table when `status.json` has `heartbeat` field
