# SPEC: Debate Session Mode — Panel vs Hybrid (Phase 2)

## Summary

Introduce a `mode` field on `DebateStageConfig` to choose between two debate conversation models:

- **`"panel"` (current, default):** Parallel proposals → parallel critique → resolve. Debaters work independently throughout.
- **`"hybrid"` (new):** Parallel proposals → sequential rebuttal rounds with stateful sessions. Debaters see each other's proposals and previous rebuttals before responding. Produces richer argumentative exchange.

## Motivation

The current debate model ("panel") is fast and resilient (parallel execution) but produces shallow argumentation — debaters never actually respond to each other, they just independently grade everyone else's work.

True debate requires turn-by-turn exchange. Hybrid mode enables this while keeping the efficiency of parallel proposals: all debaters first write independently (parallel is correct here — they haven't seen each other yet), then each gets a sequential rebuttal turn where they respond to the full collective output.

## Prerequisite: Split `session.ts`

`src/debate/session.ts` is currently 873 lines — over 2x the 400-line project limit. Adding `runHybrid()` would make this worse. Before implementing hybrid mode, refactor the file:

- Extract shared adapter resolution logic (duplicated across `runStateful`, `runOneShot`, `runPlan`) into a private helper method or `session-helpers.ts`
- Extract `runOneShot()` into `session-one-shot.ts`
- Extract `runStateful()` into `session-stateful.ts`
- Extract `runPlan()` into `session-plan.ts`
- Keep `DebateSession` class in `session.ts` as a thin dispatcher + shared state
- Add `runHybrid()` in its own `session-hybrid.ts`

This is tracked as **US-000** in the Stories section below.

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
   Each debater d gets sessionRole: debate-hybrid-${d}
   keepSessionOpen: true (session will be reused for rebuttals)
3. Rebuttal rounds — sequential per-debater stateful turns
   For each round r (0-indexed):
     For each debater d (in order):
       Build rebuttal context: all proposals + all rebuttals from rounds < r
       Call runStatefulTurn() with:
         sessionRole: debate-hybrid-${d}  (SAME as proposal — resumes ACP session)
         keepSessionOpen: (r < rounds - 1)  (close on final round only)
       Accumulate rebuttal output + cost
4. Close sessions — call closeStatefulSession() for every debater
   (catches sessions left open by early exit, fallback paths, or failed final rounds)
5. Resolve — pass proposals as proposalOutputs, rebuttals as critiqueOutputs
   (rebuttals replace the parallel critique round that panel mode uses)
```

### Session lifecycle in hybrid mode

Each debater maintains **one continuous ACP session** across the entire debate. The `sessionRole` is per-debater (not per-round), matching the existing stateful debate pattern:

| Turn | sessionRole | keepSessionOpen | Notes |
|:-----|:------------|:----------------|:------|
| Proposal (debater 0) | `debate-hybrid-0` | `true` | Session created, kept open |
| Proposal (debater 1) | `debate-hybrid-1` | `true` | Parallel with debater 0 |
| Rebuttal R0 (debater 0) | `debate-hybrid-0` | `true` (if more rounds) | **Resumes** proposal session |
| Rebuttal R0 (debater 1) | `debate-hybrid-1` | `true` (if more rounds) | **Resumes** proposal session |
| Rebuttal R1 (debater 0) | `debate-hybrid-0` | `true` | Penultimate turn — still open |
| Rebuttal R1 (debater 1) | `debate-hybrid-1` | `true` | Penultimate turn — still open |
| **Close all** | all debaters | — | `closeStatefulSession()` per debater |

This works because in the ACP adapter, same `sessionRole` (+ `featureName` + `storyId`) produces the same session name via `buildSessionName()`, and `ensureAcpSession()` resumes the existing session via `client.loadSession()`. Each debater accumulates full conversation history — proposals and rebuttals appear as prior turns in the session, giving the agent richer context than prompt-only injection.

**Session close is always explicit.** All rebuttal rounds use `keepSessionOpen: true`. After the rebuttal loop completes (or on any early exit), `runHybrid()` calls `closeStatefulSession()` for every debater whose session was opened. This follows the same pattern as `runStateful()` in panel mode, which closes sessions after the critique round. A `try/finally` block ensures sessions are closed even if the resolver or an intermediate step throws.

**Semantics of `rounds` in hybrid mode:** `rounds` controls the number of sequential rebuttal rounds after proposals. `rounds: 1` = proposals + 1 rebuttal round. This differs from one-shot mode where `rounds: 1` means proposals only (no critique).

**Scope:** Hybrid mode applies only to `run()` dispatching (`runOneShot`/`runStateful`/`runHybrid`). `runPlan()` is unchanged — plan debates always use parallel proposals with no rebuttal rounds.

**Key invariants:**
- Proposals are always parallel (they must be independent)
- Rebuttals are always sequential (each debater reacts to the accumulated state)
- `maxConcurrentDebaters` applies only to the proposal round (rebuttals are inherently sequential in hybrid)
- Each debater's `sessionRole` is `debate-hybrid-${debaterIndex}` — the same role is reused across proposal and all rebuttal rounds to maintain a single ACP session per debater
- If `mode: "hybrid"` but `sessionMode: "one-shot"` — hybrid requires stateful sessions, fall back to panel with a warning log

### Rebuttal context builder

New utility function in `src/debate/prompts.ts` (alongside existing `buildCritiquePrompt`):

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
    "Respond to the proposals above. Identify strengths and weaknesses, " +
    "then present your revised assessment. Be specific and constructive.");
  return parts.join("");
}
```

### Failure handling

- If a debater fails a rebuttal turn in hybrid mode: log warning, continue with remaining debaters (same resilience as panel)
- If fewer than 2 proposals succeed: close all open sessions, then single-agent fallback (same as panel)
- If `mode: "hybrid"` but `sessionMode: "one-shot"`: log a warning and fall back to panel mode
- **Session cleanup on all exit paths:** `runHybrid()` wraps the rebuttal loop + resolver in a `try/finally` that calls `closeStatefulSession()` for every debater with an open session. This prevents orphaned ACP sessions on errors, early fallbacks, or resolver failures.

### Routing in `run()`

```typescript
async run(prompt: string): Promise<DebateResult> {
  const mode = this.stageConfig.mode ?? "panel";
  const sessionMode = this.stageConfig.sessionMode ?? "one-shot";

  if (mode === "hybrid") {
    // hybrid requires stateful sessions
    if (sessionMode === "one-shot") {
      _debateSessionDeps.getSafeLogger()?.warn("debate", "hybrid mode requires sessionMode: stateful — falling back to panel");
      return this.runOneShot(prompt);
    }
    return this.runHybrid(prompt);
  }

  // panel mode
  return sessionMode === "stateful"
    ? this.runStateful(prompt)
    : this.runOneShot(prompt);
}
```

`runHybrid` is a new method in `session-hybrid.ts`, sharing adapter resolution via the extracted helper. It reuses `runStatefulTurn()` for each rebuttal turn (which uses `adapter.run()` for stateful sessions).

### Timeout considerations

Hybrid mode's sequential rebuttals mean total wall-clock time = proposal_time + (N_debaters x N_rounds x per_turn_time). With 3 debaters and 2 rounds, that's 6 sequential turns. The per-session `timeoutSeconds` applies to the entire hybrid debate. Users configuring hybrid mode with multiple rounds should increase `timeoutSeconds` accordingly.

## Types: `DebateResult` enhancement

Add optional `rebuttals` field to `DebateResult` for hybrid mode observability:

```typescript
// types.ts
export interface Rebuttal {
  debater: Debater;
  round: number;
  output: string;
}

// Add to DebateResult
export interface DebateResult {
  // ... existing fields ...
  /** Rebuttal outputs from hybrid mode (absent in panel mode) */
  rebuttals?: Rebuttal[];
}
```

## Stories

### US-000: Prerequisite — split `session.ts` below 400-line limit

**Depends on:** none

Extract the 873-line `session.ts` into focused modules:
1. `session-helpers.ts` — shared adapter resolution, `buildFailedResult`, `runComplete`, model resolution helpers
2. `session-one-shot.ts` — `runOneShot()` logic
3. `session-stateful.ts` — `runStateful()` + `runStatefulTurn()` + `closeStatefulSession()`
4. `session-plan.ts` — `runPlan()` logic
5. `session.ts` — thin `DebateSession` class (constructor, `run()` dispatcher, `resolve()`)

**Acceptance Criteria:**
1. No file in `src/debate/` exceeds 400 lines
2. All existing debate tests pass without modification
3. Barrel `index.ts` exports remain unchanged (no breaking imports)
4. `_debateSessionDeps` stays in `session.ts` (or a shared deps file) — single injection point

### US-001: Config field — `DebateStageConfig.mode`

**Depends on:** US-000

Add `mode: "panel" | "hybrid"` to `DebateStageConfig`, `DebateStageConfigSchema`, and all stage defaults in `DEFAULT_CONFIG.debate.stages`. Default: `"panel"`.

**Acceptance Criteria:**
1. `NaxConfigSchema.parse({}).debate.stages.plan.mode === "panel"`
2. `NaxConfigSchema.parse({}).debate.stages.review.mode === "panel"`
3. Schema accepts `mode: "hybrid"` without error
4. Schema rejects `mode: "sequential"` or other values
5. TypeScript `DebateStageConfig` interface includes `mode: DebateMode`

### US-001b: `DebateResult.rebuttals` type

**Depends on:** US-001

Add `Rebuttal` interface and optional `rebuttals?: Rebuttal[]` field to `DebateResult` in `types.ts`.

**Acceptance Criteria:**
1. `DebateResult` interface includes `rebuttals?: Rebuttal[]`
2. `Rebuttal` interface has `debater: Debater`, `round: number`, `output: string`
3. Existing code compiles without changes (field is optional)

### US-002: `run()` routing with mode check

**Depends on:** US-001

Update `run()` to check `mode === "hybrid"` before dispatching. Add the warning log when hybrid falls back to panel due to `sessionMode: "one-shot"`. Use `?? "one-shot"` fallback for `sessionMode` to handle undefined.

**Acceptance Criteria:**
1. `run()` with `mode: "panel"` and `sessionMode: "one-shot"` calls `runOneShot()`
2. `run()` with `mode: "panel"` and `sessionMode: "stateful"` calls `runStateful()`
3. `run()` with `mode: "hybrid"` and `sessionMode: "stateful"` calls `runHybrid()`
4. `run()` with `mode: "hybrid"` and `sessionMode: "one-shot"` calls `runOneShot()` with a warn log
5. `run()` with `mode: "hybrid"` and `sessionMode: undefined` calls `runOneShot()` with a warn log (same as AC4)

### US-003: `runHybrid()` — parallel proposals → sequential rebuttal rounds

**Depends on:** US-002, US-001b

Implement `runHybrid()` in `session-hybrid.ts` with:
1. Shared adapter resolution via extracted helper
2. Proposal round via `allSettledBounded` — each debater's `sessionRole` is `debate-hybrid-${debaterIndex}` with `keepSessionOpen: true`
3. Sequential rebuttal rounds — for each round, iterate debaters in order and call `runStatefulTurn()` with:
   - `sessionRole: debate-hybrid-${debaterIndex}` (same as proposal — resumes the ACP session)
   - `keepSessionOpen: (currentRound < rounds - 1)` (close session on final round only)
   - Prompt built via `buildRebuttalContext()` with all proposals + previous rounds' rebuttals
4. Pass rebuttal outputs as `critiqueOutputs` to the resolver (rebuttals replace the parallel critique round that panel mode uses)
5. Populate `DebateResult.rebuttals` with per-turn rebuttal data
6. New debug log events: `debate:rebuttal-start`, `debate:rebuttal-end` with round and debater index
7. On failure cleanup: close any sessions left open by calling `closeStatefulSession()` for each debater whose session was not already closed

**Acceptance Criteria:**
1. `runHybrid()` with 2 debaters and `rounds: 1` calls `runStatefulTurn()` exactly twice (one per debater) in sequential order
2. `runHybrid()` with 3 debaters and `rounds: 2` calls `runStatefulTurn()` exactly 6 times
3. Each rebuttal turn's prompt contains all proposal outputs
4. Rebuttals from round 1 are included in round 2 prompts
5. Failed rebuttal turn does not stop the remaining rebuttal turns (resilient)
6. When fewer than 2 proposals succeed, returns single-agent fallback (same as panel)
7. Rebuttal turn costs are accumulated into `totalCostUsd` on the returned `DebateResult`
8. `DebateResult.rebuttals` contains one entry per successful rebuttal turn with `debater`, `round`, and `output`
9. Proposal `sessionRole` is `debate-hybrid-${debaterIndex}` — matches the debater index pattern used in stateful panel mode (`debate-${stage}-${debaterIdx}`)
10. Rebuttal `sessionRole` reuses `debate-hybrid-${debaterIndex}` (same session as proposal) — verified by asserting `runStatefulTurn()` receives the same roleKey for proposals and rebuttals of the same debater
11. All `runStatefulTurn()` calls use `keepSessionOpen: true` — sessions are never closed mid-debate by the turn itself
12. After rebuttal loop completes (or on early exit/error), `closeStatefulSession()` is called for every debater whose session was opened — wrapped in `try/finally` to guarantee cleanup
13. No orphaned ACP sessions remain after `runHybrid()` returns (success or failure)

### Context Files
- `src/debate/session.ts` — `DebateSession` class, `run()` dispatcher
- `src/debate/session-helpers.ts` — shared adapter resolution, `buildFailedResult`, `runComplete` (new, from US-000)
- `src/debate/session-one-shot.ts` — `runOneShot()` (new, from US-000)
- `src/debate/session-stateful.ts` — `runStateful()`, `runStatefulTurn()`, `closeStatefulSession()` (new, from US-000)
- `src/debate/session-plan.ts` — `runPlan()` (new, from US-000)
- `src/debate/session-hybrid.ts` — `runHybrid()` (new, US-003)
- `src/debate/prompts.ts` — `buildCritiquePrompt()`, new `buildRebuttalContext()`
- `src/debate/types.ts` — `DebateStageConfig` interface, new `DebateMode` type, new `Rebuttal` interface
- `src/config/schemas.ts` — `DebateStageConfigSchema`, add `mode` field
- `src/config/defaults.ts` — `DEFAULT_CONFIG.debate.stages.*`, add `mode: "panel"`
