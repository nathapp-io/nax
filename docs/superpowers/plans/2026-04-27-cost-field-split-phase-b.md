# Cost/Token Mapper Decoupling — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `AgentResult.estimatedCost` into `estimatedCostUsd` (always present, from tokens) + `exactCostUsd?` (when wire reports it), and propagate both through `CostEvent`, middleware, aggregator, metrics, and all consumers.

**Architecture:** `AgentResult` carries both numbers independently — neither is computed from the other. The adapter (producer) populates both; middleware (observer) forwards both; aggregator (sink) retains both. Canonical `costUsd = exactCostUsd ?? estimatedCostUsd`. Confidence derived from presence: `exactCostUsd != null ? "exact" : "estimated"`.

**Tech Stack:** TypeScript strict, bun:test, Biome.

---

## File Inventory

| File | Action | Responsibility |
|:---|:---|:---|
| `src/agents/types.ts` | Modify | `AgentResult.estimatedCost` → `estimatedCostUsd` + `exactCostUsd?` |
| `src/agents/acp/adapter.ts` | Modify | Populate both fields; remove `?? estimateCost(...)` collapse in `sendTurn()` and `complete()` |
| `src/runtime/cost-aggregator.ts` | Modify | `CostEvent` gets `estimatedCostUsd`, `exactCostUsd?`, `confidence`; `CostSnapshot` gets `totalEstimatedCostUsd`, `totalExactCostUsd?` |
| `src/runtime/middleware/cost.ts` | Modify | Read both off `AgentResult`, emit both into `CostEvent`; no calculation |
| `src/agents/manager.ts` | Modify | Fallback-hop `costUsd` reads `result.estimatedCostUsd` |
| `src/metrics/types.ts` | Modify | `AgentFallbackHop.costUsd` comment updated; optionally add `exactCostUsd?` to metrics |
| `src/metrics/tracker.ts` | Modify | Read `estimatedCostUsd` / `exactCostUsd` from `AgentResult` |
| `src/tdd/types.ts` | Modify | `TddSessionResult.estimatedCost` → `estimatedCostUsd` |
| `src/pipeline/types.ts` | Modify | `RoutingResult.estimatedCost` → `estimatedCostUsd` |
| `src/prd/types.ts` | Modify | `estimatedCost?` → `estimatedCostUsd?` |
| `src/logging/formatter.ts` | Modify | Read `estimatedCostUsd` |
| `src/agents/utils.ts` | Modify | Map `cost.total` → `estimatedCostUsd` |
| `src/runtime/session-run-hop.ts` | Modify | Map `cost.total` → `estimatedCostUsd` |
| `src/operations/build-hop-callback.ts` | Modify | Map `cost.total` → `estimatedCostUsd` |
| `src/review/semantic.ts` | Modify | Read `estimatedCostUsd` |
| `src/review/adversarial.ts` | Modify | Read `estimatedCostUsd` |
| `src/tdd/rectification-gate.ts` | Modify | Read `estimatedCostUsd` |
| `src/verification/rectification-loop.ts` | Modify | Read `estimatedCostUsd` |
| `src/pipeline/stages/execution.ts` | Modify | Read `estimatedCostUsd` |
| `src/pipeline/stages/autofix.ts` | Modify | Read `estimatedCostUsd` |
| `src/pipeline/stages/autofix-adversarial.ts` | Modify | Read `estimatedCostUsd` |
| `src/pipeline/stages/completion.ts` | Modify | Read `estimatedCostUsd` |
| `src/execution/merge-conflict-rectify.ts` | Modify | Read `estimatedCostUsd` |
| `src/execution/iteration-runner.ts` | Modify | Read `estimatedCostUsd` |
| `src/execution/pipeline-result-handler.ts` | Modify | Read `estimatedCostUsd` |
| `src/execution/parallel-worker.ts` | Modify | Read `estimatedCostUsd` |
| `src/acceptance/fix-diagnosis.ts` | Modify | Read `estimatedCostUsd` |
| `src/acceptance/fix-executor.ts` | Modify | Read `estimatedCostUsd` |
| `src/tdd/orchestrator.ts` | Modify | Read `estimatedCostUsd` from sessions |
| `src/tdd/session-runner.ts` | Modify | Read `estimatedCostUsd` |
| `src/session/session-runner.ts` | Modify | Comment update |
| `src/agents/registry.ts` | Inspect | May need mock adapter updates |
| `test/**/*` | Modify | Replace `estimatedCost` with `estimatedCostUsd` in all 374+ occurrences |

---

## Task Grouping Strategy

Phase B has one **breaking rename** (`estimatedCost` → `estimatedCostUsd`) that touches ~50 source files and 374+ test references. All these must ship together in a single typecheck-passing commit group. To manage this, we group tasks into **waves** that can each be committed separately but must all land before any test/typecheck verification:

1. **Wave 1 — Core type change** (`agents/types.ts` + `agents/acp/adapter.ts`)
2. **Wave 2 — Cost layer** (`cost-aggregator.ts`, `middleware/cost.ts`, `manager.ts`)
3. **Wave 3 — Metrics & TDD types** (`metrics/types.ts`, `metrics/tracker.ts`, `tdd/types.ts`, `pipeline/types.ts`, `prd/types.ts`)
4. **Wave 4 — Source consumers** (all remaining `src/` files that read `estimatedCost`)
5. **Wave 5 — Test updates** (all `test/` files — bulk mechanical rename)
6. **Wave 6 — Verification** (typecheck, lint, test, grep audit)

---

## Wave 1: Core Type Change

### Task 1: Rename `AgentResult.estimatedCost` → `estimatedCostUsd`; add `exactCostUsd?`

**Files:**
- Modify: `src/agents/types.ts:42`

**Step 1 — Update `AgentResult` interface**

```typescript
  /** Estimated cost for this run (USD), computed from token usage × pricing rates. Always present. */
  estimatedCostUsd: number;
  /** Exact cost reported by the wire protocol (USD), when available. Independent of estimatedCostUsd. */
  exactCostUsd?: number;
```

**Step 2 — Commit**

```bash
git add src/agents/types.ts
git commit -m "feat(cost): split AgentResult.estimatedCost into estimatedCostUsd + exactCostUsd?"
```

---

### Task 2: Refactor `AcpAgentAdapter` to populate both fields

**Files:**
- Modify: `src/agents/acp/adapter.ts`

**Context:** Today `sendTurn()` collapses exact and estimated with `totalExactCostUsd ?? estimateCostFromTokenUsage(...)`. The spec requires both to be independent and always stored separately.

**Step 1 — Update `sendTurn()` return value (around line 953-964)**

Replace:
```typescript
    const estimatedCost =
      totalExactCostUsd ??
      (totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, modelDef.model)
        : 0);

    return {
      output,
      tokenUsage,
      cost: { total: estimatedCost },
      internalRoundTrips: turnCount,
    };
```

With:
```typescript
    const estimatedCostUsd =
      totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0
        ? estimateCostFromTokenUsage(totalTokenUsage, modelDef.model)
        : 0;
    const exactCostUsd = totalExactCostUsd; // undefined if wire never reported

    return {
      output,
      tokenUsage,
      estimatedCostUsd,
      exactCostUsd,
      internalRoundTrips: turnCount,
    };
```

**Step 2 — Update `complete()` return paths**

The `complete()` method returns `CompleteResult`, not `AgentResult`, so it is unaffected by the `AgentResult` rename. However, verify it already uses `costUsd` and `source` correctly (it does — already returns `{ output, costUsd, source }`). No change needed.

**Step 3 — Update `AcpSessionResponse` type if needed**

`AcpSessionResponse` already has `exactCostUsd?: number` (line 91). Good.

**Step 4 — Commit**

```bash
git add src/agents/acp/adapter.ts
git commit -m "feat(cost): AcpAgentAdapter.populates both estimatedCostUsd and exactCostUsd independently"
```

---

## Wave 2: Cost Layer

### Task 3: Update `CostEvent` and `CostSnapshot` in `cost-aggregator.ts`

**Files:**
- Modify: `src/runtime/cost-aggregator.ts`

**Step 1 — Expand `CostEvent`**

```typescript
export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Estimated cost from token usage × pricing rates (always present). */
  readonly estimatedCostUsd: number;
  /** Exact cost reported by wire protocol (when available). */
  readonly exactCostUsd?: number;
  /** Canonical cost for budget/totals: exact when available, else estimated. */
  readonly costUsd: number;
  /** Confidence derived from presence of exactCostUsd. */
  readonly confidence: "exact" | "estimated";
  readonly durationMs: number;
}
```

**Step 2 — Expand `CostSnapshot`**

```typescript
export interface CostSnapshot {
  readonly totalCostUsd: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalExactCostUsd?: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
  readonly errorCount: number;
}
```

**Step 3 — Update `accumulate()` and `emptySnap()`**

```typescript
function emptySnap(): CostSnapshot {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    errorCount: 0,
  };
}

function accumulate(snap: CostSnapshot, e: CostEvent): CostSnapshot {
  return {
    totalCostUsd: snap.totalCostUsd + e.costUsd,
    totalEstimatedCostUsd: snap.totalEstimatedCostUsd + e.estimatedCostUsd,
    totalExactCostUsd: e.exactCostUsd != null
      ? (snap.totalExactCostUsd ?? 0) + e.exactCostUsd
      : snap.totalExactCostUsd,
    totalInputTokens: snap.totalInputTokens + e.tokens.input,
    totalOutputTokens: snap.totalOutputTokens + e.tokens.output,
    callCount: snap.callCount + 1,
    errorCount: snap.errorCount,
  };
}
```

**Step 4 — Update `EMPTY_SNAPSHOT` constant**

```typescript
const EMPTY_SNAPSHOT: CostSnapshot = {
  totalCostUsd: 0,
  totalEstimatedCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
};
```

**Step 5 — Commit**

```bash
git add src/runtime/cost-aggregator.ts
git commit -m "feat(cost): CostEvent carries estimatedCostUsd, exactCostUsd?, costUsd, confidence; snapshot tracks both totals"
```

---

### Task 4: Update cost middleware to read both fields, never calculate

**Files:**
- Modify: `src/runtime/middleware/cost.ts`

**Step 1 — Rewrite `extractCostUsd` → `extractCosts`**

Replace the entire file content:

```typescript
import { NaxError } from "../../errors";
import type { AgentMiddleware, MiddlewareContext } from "../agent-middleware";
import type { CostErrorEvent, CostEvent, ICostAggregator } from "../cost-aggregator";

function extractTokens(
  result: unknown,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  if (!result || typeof result !== "object") return null;
  const tu = (result as Record<string, unknown>).tokenUsage as Record<string, number> | undefined;
  if (!tu) return null;
  return {
    input: tu.inputTokens ?? 0,
    output: tu.outputTokens ?? 0,
    cacheRead: tu.cacheReadInputTokens,
    cacheWrite: tu.cacheCreationInputTokens,
  };
}

function extractCosts(result: unknown): { estimatedCostUsd: number; exactCostUsd?: number } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const estimatedCostUsd = (r.estimatedCostUsd as number | undefined) ?? (r.costUsd as number | undefined) ?? 0;
  const exactCostUsd = r.exactCostUsd as number | undefined;
  if (estimatedCostUsd === 0 && exactCostUsd == null) return null;
  return { estimatedCostUsd, exactCostUsd };
}

export function costMiddleware(aggregator: ICostAggregator, runId: string): AgentMiddleware {
  return {
    name: "cost",
    async after(ctx: MiddlewareContext, result: unknown, durationMs: number): Promise<void> {
      const tokens = extractTokens(result);
      const costs = extractCosts(result);
      if (!tokens && !costs) return;

      const estimatedCostUsd = costs?.estimatedCostUsd ?? 0;
      const exactCostUsd = costs?.exactCostUsd;
      const costUsd = exactCostUsd ?? estimatedCostUsd;
      const confidence: "exact" | "estimated" = exactCostUsd != null ? "exact" : "estimated";

      const event: CostEvent = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        model: ((result as Record<string, unknown>).model as string | undefined) ?? "unknown",
        stage: ctx.stage,
        storyId: ctx.storyId,
        packageDir: ctx.packageDir,
        tokens: tokens ?? { input: 0, output: 0 },
        estimatedCostUsd,
        exactCostUsd,
        costUsd,
        confidence,
        durationMs,
      };
      aggregator.record(event);
    },
    async onError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
      const event: CostErrorEvent = {
        ts: Date.now(),
        runId,
        agentName: ctx.agentName,
        stage: ctx.stage,
        storyId: ctx.storyId,
        errorCode: err instanceof NaxError ? err.code : "UNKNOWN",
        durationMs,
      };
      aggregator.recordError(event);
    },
  };
}
```

**Step 2 — Commit**

```bash
git add src/runtime/middleware/cost.ts
git commit -m "feat(cost): middleware observes estimatedCostUsd + exactCostUsd? from AgentResult, never calculates"
```

---

### Task 5: Update fallback-hop accounting in `manager.ts`

**Files:**
- Modify: `src/agents/manager.ts:292`

**Step 1 — Update `AgentFallbackRecord.costUsd` source**

Change line 292:
```typescript
        costUsd: result.estimatedCostUsd ?? 0,
```

And update the comment in `src/metrics/types.ts:87-92` to reference `estimatedCostUsd`.

**Step 2 — Commit**

```bash
git add src/agents/manager.ts src/metrics/types.ts
git commit -m "feat(cost): fallback-hop cost sourced from AgentResult.estimatedCostUsd"
```

---

## Wave 3: Metrics & TDD Types

### Task 6: Update metrics tracker and related type comments

**Files:**
- Modify: `src/metrics/tracker.ts`

**Step 1 — Update tracker reads**

Line 160:
```typescript
    cost: (ctx.accumulatedAttemptCost ?? 0) + (agentResult?.estimatedCostUsd || 0),
```

Line 208:
```typescript
  const totalCost = agentResult?.estimatedCostUsd || 0;
```

**Step 2 — Commit**

```bash
git add src/metrics/tracker.ts
git commit -m "feat(cost): metrics tracker reads estimatedCostUsd"
```

---

### Task 7: Update TDD and pipeline types

**Files:**
- Modify: `src/tdd/types.ts:43`
- Modify: `src/pipeline/types.ts:34`
- Modify: `src/prd/types.ts:71`

**Step 1 — `TddSessionResult`**

```typescript
  /** Estimated cost of this session (USD) */
  estimatedCostUsd: number;
```

**Step 2 — `RoutingResult`**

```typescript
  /** Estimated cost for this story (USD) */
  estimatedCostUsd?: number;
```

**Step 3 — Check `prd/types.ts`**

Read the file first; rename `estimatedCost?` → `estimatedCostUsd?` if present.

**Step 4 — Commit**

```bash
git add src/tdd/types.ts src/pipeline/types.ts src/prd/types.ts
git commit -m "feat(cost): rename estimatedCost → estimatedCostUsd in TDD, pipeline, PRD types"
```

---

## Wave 4: Source Consumers (mechanical rename)

### Task 8: Update all remaining `src/` consumers

This is a bulk mechanical rename. Use `sed` or careful find-replace for each file. The pattern is: every read of `.estimatedCost` on `AgentResult` or `CompleteResult` (or objects shaped like them) becomes `.estimatedCostUsd`.

**Files to modify (confirmed from grep):**

| File | Line(s) | Change |
|:---|:---|:---|
| `src/review/semantic.ts` | 649, 653, 684 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/review/adversarial.ts` | 415, 419, 450 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/operations/build-hop-callback.ts` | 65, 200 | `r.cost?.total` stays (this is `TurnResult.cost.total`, not `AgentResult`) — verify |
| `src/tdd/rectification-gate.ts` | 320, 325, 347 | `rectifyResult.estimatedCost` → `rectifyResult.estimatedCostUsd` |
| `src/verification/rectification-loop.ts` | 226, 300, 315, 326, 474, 478 | `agentResult.estimatedCost` / `debateResult.totalCostUsd` → `estimatedCostUsd` |
| `src/pipeline/stages/autofix.ts` | 567, 632 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/pipeline/stages/execution.ts` | 63, 316 | `result.estimatedCost` / `tddResult.totalCost` → verify |
| `src/acceptance/fix-diagnosis.ts` | 122, 129 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/acceptance/fix-executor.ts` | 73, 143 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/execution/merge-conflict-rectify.ts` | 144 | `agentResult?.estimatedCost` → `agentResult?.estimatedCostUsd` |
| `src/logging/formatter.ts` | 193 | `data.estimatedCost` → `data.estimatedCostUsd` |
| `src/execution/pipeline-result-handler.ts` | 108, 216, 302 | `agentResult?.estimatedCost` → `agentResult?.estimatedCostUsd` |
| `src/execution/parallel-worker.ts` | 74 | `agentResult?.estimatedCost` → `agentResult?.estimatedCostUsd` |
| `src/pipeline/stages/completion.ts` | 34 | `agentResult?.estimatedCost` → `agentResult?.estimatedCostUsd` |
| `src/pipeline/stages/autofix-adversarial.ts` | 169 | `twResult.estimatedCost` → `twResult.estimatedCostUsd` |
| `src/tdd/orchestrator.ts` | 148, 212, 250, 355 | `s.estimatedCost` → `s.estimatedCostUsd` |
| `src/tdd/session-runner.ts` | 286, 360 | `result.estimatedCost` → `result.estimatedCostUsd` |
| `src/agents/utils.ts` | 92, 105 | `turnResult.cost?.total` → map to `estimatedCostUsd` |
| `src/runtime/session-run-hop.ts` | 62, 76 | `turnResult.cost?.total` → map to `estimatedCostUsd` |
| `src/session/session-runner.ts` | 29 | comment only |

**Important rules:**
- `TurnResult.cost.total` (from `sendTurn()`) must be mapped to `estimatedCostUsd` at consumption sites, OR we should also update `TurnResult` to return `estimatedCostUsd` directly.
- `CompleteResult.costUsd` stays as-is (already correct naming).
- `AgentResult.estimatedCost` → `AgentResult.estimatedCostUsd` everywhere.

**Step 1 — Update `TurnResult` interface to also carry `estimatedCostUsd`**

Since `sendTurn()` now returns `{ estimatedCostUsd, exactCostUsd }` instead of `cost: { total }`, update the `TurnResult` interface in `src/agents/types.ts:336-345`:

```typescript
export interface TurnResult {
  /** Final assistant output from the last ACP response. */
  output: string;
  /** Accumulated token usage across all turns. */
  tokenUsage: TokenUsage;
  /** Estimated cost from token usage × pricing rates (always present). */
  estimatedCostUsd: number;
  /** Exact cost reported by wire protocol (when available). */
  exactCostUsd?: number;
  /** Number of session.prompt() calls made. */
  internalRoundTrips: number;
}
```

Then update all `TurnResult` consumers that read `.cost.total` to read `.estimatedCostUsd`.

**Step 2 — Execute mechanical rename across all source files**

Use a script or careful sed. For each file, replace `\.estimatedCost\b` with `.estimatedCostUsd` where it refers to `AgentResult` or `TddSessionResult`.

**Step 3 — Commit (one large commit or split by domain)**

```bash
git add -A
git commit -m "feat(cost): rename estimatedCost → estimatedCostUsd across all source consumers"
```

---

## Wave 5: Test Updates

### Task 9: Bulk rename in all test files

**Context:** 374+ matches across test files. All are mechanical: `estimatedCost:` → `estimatedCostUsd:` and `.estimatedCost` → `.estimatedCostUsd`.

**Step 1 — Execute bulk rename**

```bash
# In test/ directory, replace all occurrences
find test -type f -name "*.ts" -exec sed -i '' 's/\.estimatedCost\b/.estimatedCostUsd/g' {} +
find test -type f -name "*.ts" -exec sed -i '' 's/estimatedCost:/estimatedCostUsd:/g' {} +
```

**Step 2 — Verify no broken tests**

Run targeted tests on modified areas:
```bash
bun test test/unit/agents/acp/adapter.test.ts --timeout=30000
bun test test/unit/runtime/middleware/cost.test.ts --timeout=30000
bun test test/unit/runtime/cost-aggregator.test.ts --timeout=30000
```

**Step 3 — Add new test coverage for `exactCostUsd`**

In `test/unit/agents/acp/adapter.test.ts` or a new file:

```typescript
test("sendTurn populates both estimatedCostUsd and exactCostUsd when wire reports exact cost", async () => {
  // Mock acpx response with cumulative_token_usage AND exactCostUsd
  // Assert result.estimatedCostUsd > 0 && result.exactCostUsd != null
});

test("sendTurn populates estimatedCostUsd only when wire does not report exact cost", async () => {
  // Mock acpx response with cumulative_token_usage but no exactCostUsd
  // Assert result.estimatedCostUsd > 0 && result.exactCostUsd === undefined
});
```

**Step 4 — Add integration test for CostAggregator snapshot**

In `test/unit/runtime/cost-aggregator.test.ts`:

```typescript
test("snapshot retains both totalEstimatedCostUsd and totalExactCostUsd separately", () => {
  const agg = new CostAggregator("run-1", "/tmp");
  agg.record({
    ts: 1, runId: "run-1", agentName: "claude", model: "claude-sonnet-4",
    estimatedCostUsd: 0.5, exactCostUsd: 0.6, costUsd: 0.6, confidence: "exact",
    tokens: { input: 1000, output: 500 }, durationMs: 1000,
  });
  agg.record({
    ts: 2, runId: "run-1", agentName: "claude", model: "claude-sonnet-4",
    estimatedCostUsd: 0.3, exactCostUsd: undefined, costUsd: 0.3, confidence: "estimated",
    tokens: { input: 500, output: 200 }, durationMs: 500,
  });
  const snap = agg.snapshot();
  expect(snap.totalEstimatedCostUsd).toBeCloseTo(0.8);
  expect(snap.totalExactCostUsd).toBeCloseTo(0.6);
  expect(snap.totalCostUsd).toBeCloseTo(0.9);
});
```

**Step 5 — Commit**

```bash
git add -A
git commit -m "test(cost): update all tests for estimatedCostUsd rename; add exactCostUsd coverage"
```

---

## Wave 6: Verification

### Task 10: Typecheck, lint, test, grep audit

**Step 1 — Typecheck**

```bash
bun run typecheck
```
Expected: zero errors.

**Step 2 — Lint**

```bash
bun run lint
```
Expected: zero errors.

**Step 3 — Run full test suite**

```bash
bun run test
```
Expected: all green.

**Step 4 — Grep audit for old field name**

```bash
grep -rn '\.estimatedCost[^U]' src/ test/
```
Expected: zero hits (may need to exclude comments/docstrings intentionally keeping legacy references).

**Step 5 — Grep audit for wire-format quarantine (AC-A10 re-verify)**

```bash
grep -rn 'input_tokens\|output_tokens\|cache_read_input_tokens\|cache_creation_input_tokens' src/
```
Expected: only `acp/wire-types.ts`, `acp/parser.ts`, `acp/spawn-client.ts`, and inside `AcpTokenUsageMapper.toInternal()`.

**Step 6 — Drift smoke test**

In `test/unit/agents/acp/adapter.test.ts`, add or run:

```typescript
test("exact and estimated costs are within 50% drift (smoke)", async () => {
  // Mock adapter that reports both
  // Assert |exact - estimated| / estimated < 0.5
});
```

**Step 7 — Commit final verification marker**

```bash
git commit --allow-empty -m "verify(cost): Phase B typecheck, lint, tests, grep audit all pass"
```

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|:---|:---|
| B1 — Rename `AgentResult.estimatedCost` → `estimatedCostUsd`; add `exactCostUsd?` | Task 1 |
| B2 — Adapter populates both independently | Task 2 |
| B3 — `CostEvent` carries both + `costUsd` + `confidence` | Task 3, 4 |
| B4 — Middleware observes, never calculates | Task 4 |
| B5 — Fallback-hop `costUsd` from `estimatedCostUsd` | Task 5 |
| B6 — Metrics carry both numbers | Task 3 (snapshot), Task 6 |
| B7 — Tests updated + new coverage | Task 9 |
| AC-B1 — Zero hits for old name | Task 10 (grep) |
| AC-B2 — Adapter populates both | Task 2 |
| AC-B3 — `exactCostUsd === undefined` when wire absent | Task 2 + tests |
| AC-B4 — `CostEvent` shape correct | Task 3 |
| AC-B5 — Middleware no calculation | Task 4 |
| AC-B6 — Fallback-hop source correct | Task 5 |
| AC-B7 — Aggregator snapshot retains both | Task 3 + tests |
| AC-B8 — Drift smoke test | Task 10 |

## Risk Notes

- **TurnResult interface change** is a breaking change for any mock that returns `cost: { total }`. All mock returns in tests must be updated.
- **`estimatedCostUsd` in `CompleteResult`** — no, `CompleteResult` already uses `costUsd` and `source`. It is NOT affected.
- **Pipeline `StageAction.cost`** — some stage actions carry `cost?: number`. These are pipeline-internal cost tracking, not `AgentResult` fields. Review whether they should also be renamed for consistency (out of scope unless they reference `AgentResult.estimatedCost`).
- **Mock adapters in tests** — many tests mock `AgentAdapter.run()` returning `{ estimatedCost: 0 }`. All must be updated to `{ estimatedCostUsd: 0 }`.
