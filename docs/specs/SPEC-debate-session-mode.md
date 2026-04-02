# SPEC: Debate Session Mode — Panel vs Hybrid (Phase 2)

## Summary

Introduce a `mode` field on `DebateStageConfig` to choose between two debate conversation models:

- **`"panel"` (current, default):** Parallel proposals → parallel critique → resolve. Debaters work independently throughout.
- **`"hybrid"` (new):** Parallel proposals → sequential rebuttal rounds with stateful sessions. Debaters see each other's proposals and previous rebuttals before responding. Produces richer argumentative exchange.

## Motivation

The current debate model ("panel") is fast and resilient (parallel execution) but produces shallow argumentation — debaters never actually respond to each other, they just independently grade everyone else's work.

True debate requires turn-by-turn exchange. Hybrid mode enables this while keeping the efficiency of parallel proposals: all debaters first write independently (parallel is correct here — they haven't seen each other yet), then each gets a sequential rebuttal turn where they respond to the full collective output.

## Design

### Config: `DebateStageConfig.mode`

```typescript
// types.ts — add to DebateStageConfig
type DebateMode = "panel" | "hybrid";
mode: DebateMode;
```

```typescript
// schemas.ts — add to DebateStageConfigSchema defaults
mode: z.enum(["panel", "hybrid"]).default("panel"),
```

```typescript
// defaults.ts — per stage
plan: { ... mode: "panel" }
review: { ... mode: "panel" }
```

**Scope:** `mode` is per-stage. A user could have `plan.mode: "hybrid"` and `review.mode: "panel"`.

### `"panel"` mode (current behavior — unchanged)

`run()` already dispatches based on `sessionMode`. No changes needed.

### `"hybrid"` mode flow

```
1. Resolve adapters (same as panel)
2. Proposal round — parallel via allSettledBounded (same as panel)
   Each debater writes a proposal independently, no visibility into others
3. Rebuttal rounds (new) — sequential per-debater stateful turns
   For each round r:
     For each debater d (in order):
       Build rebuttal context: all proposals + all rebuttals from rounds < r
       Call adapter.complete() with stateful session (sessionRole: debate-hybrid-${r}-${d})
       Accumulate rebuttal output
4. Resolve — same resolver as panel
```

**Key invariants:**
- Proposals are always parallel (they must be independent)
- Rebuttals are always sequential (each debater reacts to the accumulated state)
- `maxConcurrentDebaters` applies only to the proposal round (rebuttals are inherently sequential in hybrid)
- If `mode: "hybrid"` but `sessionMode: "one-shot"` — hybrid requires stateful sessions, fall back to panel with a warning log

### Rebuttal context builder

New utility function in `src/debate/session.ts`:

```typescript
function buildRebuttalContext(
  prompt: string,
  proposals: Array<{ debater: Debater; output: string }>,
  rebuttalOutputs: string[],        // previous rounds' rebuttals (flattened)
  currentDebaterIndex: number,
): string {
  const parts = [prompt, "\n\n## Proposals\n"];
  proposals.forEach((p, i) => {
    parts.push(`\n### Proposal ${i + 1} (${p.debater.agent})\n${p.output}`);
  });
  if (rebuttalOutputs.length > 0) {
    parts.push("\n\n## Previous Rebuttals\n");
    rebuttalOutputs.forEach((r, i) => {
      parts.push(`\n${i + 1}. ${r}`);
    });
  }
  parts.push(`\n\n## Your Task\nYou are debater ${currentDebaterIndex + 1}. ` +
    "Read all proposals and previous rebuttals above, then write a rebuttal against the weakest proposal(s). " +
    "Be specific and constructive. Output your rebuttal.");
  return parts.join("");
}
```

### Failure handling

- If a debater fails a rebuttal turn in hybrid mode: log warning, continue with remaining debaters (same resilience as panel)
- If fewer than 2 proposals succeed: single-agent fallback (same as panel)
- If `mode: "hybrid"` but `sessionMode: "one-shot"`: log a warning and fall back to panel mode

### Routing in `run()`

```typescript
async run(prompt: string): Promise<DebateResult> {
  const mode = this.stageConfig.mode ?? "panel";

  if (mode === "hybrid") {
    // hybrid requires stateful sessions
    if (this.stageConfig.sessionMode === "one-shot") {
      _debateSessionDeps.getSafeLogger()?.warn("debate", "hybrid mode requires sessionMode: stateful — falling back to panel");
      return this.runOneShot(prompt);
    }
    return this.runHybrid(prompt);
  }

  // panel mode
  return this.stageConfig.sessionMode === "stateful"
    ? this.runStateful(prompt)
    : this.runOneShot(prompt);
}
```

`runHybrid` is a new method sharing the adapter resolution and proposal round code with `runOneShot`.

## Stories

### US-001: Config field — `DebateStageConfig.mode`

**Depends on:** none

Add `mode: "panel" | "hybrid"` to `DebateStageConfig`, `DebateStageConfigSchema`, and all stage defaults in `DEFAULT_CONFIG.debate.stages`. Default: `"panel"`.

**Acceptance Criteria:**
1. `NaxConfigSchema.parse({}).debate.stages.plan.mode === "panel"`
2. `NaxConfigSchema.parse({}).debate.stages.review.mode === "panel"`
3. Schema accepts `mode: "hybrid"` without error
4. Schema rejects `mode: "sequential"` or other values
5. TypeScript `DebateStageConfig` interface includes `mode: DebateMode`

### US-002: `run()` routing with mode check

**Depends on:** US-001

Update `run()` to check `mode === "hybrid"` before dispatching. Add the warning log when hybrid falls back to panel due to `sessionMode: "one-shot"`.

**Acceptance Criteria:**
1. `run()` with `mode: "panel"` and `sessionMode: "one-shot"` calls `runOneShot()`
2. `run()` with `mode: "panel"` and `sessionMode: "stateful"` calls `runStateful()`
3. `run()` with `mode: "hybrid"` and `sessionMode: "stateful"` calls `runHybrid()`
4. `run()` with `mode: "hybrid"` and `sessionMode: "one-shot"` calls `runOneShot()` with a warn log

### US-003: `runHybrid()` — parallel proposals → sequential rebuttal rounds

**Depends on:** US-002

Implement `runHybrid()` with:
1. Shared adapter resolution from `runOneShot`
2. Proposal round via `allSettledBounded` (identical to `runOneShot`)
3. Sequential rebuttal rounds — for each rebuttal round, iterate debaters in order and call `runStatefulTurn()` with `buildRebuttalContext()`
4. Same resolver call as panel after rebuttal rounds complete
5. New debug log events: `debate:rebuttal-start`, `debate:rebuttal-end` with round and debater index

**Acceptance Criteria:**
1. `runHybrid()` with 2 debaters and `rounds: 1` calls `runStatefulTurn()` exactly twice (one per debater) in sequential order
2. `runHybrid()` with 3 debaters and `rounds: 2` calls `runStatefulTurn()` exactly 6 times
3. Each rebuttal turn's prompt contains all proposal outputs
4. Rebuttals from round 1 are included in round 2 prompts
5. Failed rebuttal turn does not stop the remaining rebuttal turns (resilient)
6. When fewer than 2 proposals succeed, returns single-agent fallback (same as panel)

### Context Files
- `src/debate/session.ts` — `run()`, `runOneShot()`, `runStatefulTurn()`, new `runHybrid()`
- `src/debate/types.ts` — `DebateStageConfig` interface, new `DebateMode` type
- `src/config/schemas.ts` — `DebateStageConfigSchema`, add `mode` field
- `src/config/defaults.ts` — `DEFAULT_CONFIG.debate.stages.*`, add `mode: "panel"`
