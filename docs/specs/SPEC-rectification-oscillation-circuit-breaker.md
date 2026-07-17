# SPEC: Rectification Oscillation Circuit-Breaker

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add a generic circuit-breaker to the rectification cycle: when a story's fix
iterations repeatedly end in `regressed-different-source` (the agent resolves one
finding source only for a different source to appear — never converging), stop
re-escalating tiers and instead **pause** the story with a clear, actionable
reason. The trigger is **source-agnostic**: it fires on any oscillating source
pair (lint↔typecheck, test-runner↔semantic, semantic↔adversarial, …), not just
the conflicting-reviewer case that motivated issue #1335. A per-story counter,
run-scoped on `NaxRuntime`, accumulates `regressed-different-source` iterations
across attempts; once it reaches a configurable threshold (default 2), the next
rectification-exhausted escalation is converted into a human-resumable pause.

## Motivation

Telemetry over ~2 months of runs (853 stories that reached rectification, across
5 projects) shows **3.3% (28 stories) hit the repeated-oscillation deadlock**
(≥2 `regressed-different-source` iterations); 0.9% reached ≥3. When it happens,
the story escalates tier-by-tier (`powerful → balanced → powerful → …`) and
**re-runs the whole story each time**, re-hitting the identical wall and burning
cost — one observed repro (`notif-dlq-hardening/US-001`) spent $12+ across
attempts while looping, and the operator saw only a silent money-drain with no
signal. This is issue #1335, but the data shows scoping the fix to the
semantic↔adversarial reviewer conflict would miss more than half the deadlocks:
the worst oscillators (`universe-multi-source` rds=5, `backtester-phase-3` rds=3)
are between non-review sources. A single generic breaker covers ~3.5× the cases
at lower complexity and risk than a reviewer-conflict classifier.

The breaker does **not** fix the underlying non-convergence (often a genuinely
unsatisfiable spec — e.g. mutually exclusive ACs). Its value is to **stop the
expensive silent loop early and surface an actionable pause** so a human decides,
instead of nax escalating into an unwinnable re-run.

## Design

### Integration

This is a **partial extension** of the execution/rectification path plus one new
small store module. All symbols below were verified against the codebase at spec
time.

**Trigger signal (already produced — reused, not modified).**
`classifyOutcome<F>(before, after)` in `src/findings/cycle.ts:71` already returns
the literal `"regressed-different-source"` (`cycle.ts:81`) when a finding
`source` present in `after` was absent from `before`. This outcome is stamped on
each `Iteration.outcome` (`src/findings/cycle-types.ts:50`) and carried on
`FixCycleResult.iterations` (`cycle-types.ts:73`). `IterationOutcome` is the
5-member union at `cycle-types.ts:16`. No change to `classifyOutcome` or the
outcome union — the breaker only *reads* the existing per-iteration outcomes.

**New run-scoped per-story counter on `NaxRuntime`.**
Mirror the existing `adversarialIterations: Map<string, Iteration[]>` field
(`src/runtime/index.ts:133`, initialized in `createRuntime` at
`src/runtime/index.ts:254`, GC'd on `runtime.close()` with no special teardown).
Add:

```ts
// src/runtime/index.ts — NaxRuntime interface (peer of adversarialIterations)
/** Run-scoped, keyed by storyId. Cumulative count of regressed-different-source
 *  fix iterations, used by the oscillation circuit-breaker. */
rectificationOscillations: Map<string, number>;
```

Initialize `rectificationOscillations: new Map<string, number>()` in
`createRuntime` alongside line 254 and return it in the runtime object literal.

**New store module** `src/execution/oscillation-store.ts` (barrel-exported from
`src/execution/index.ts`) — the seam consumed by the breaker, following the shape
of `src/review/adversarial-iteration-store.ts`:

```ts
// Synchronous get→add→set — NO await between read and write (concurrency invariant).
export function recordOscillations(
  store: Map<string, number>, storyId: string, delta: number,
): number { /* returns new cumulative total */ }

export function getOscillations(
  store: Map<string, number>, storyId: string,
): number { /* 0 if unseen */ }
```

**Increment site** — `src/execution/story-orchestrator/rectification.ts`, after
the `runFixCycle` call (`rectification.ts:319`) returns `cycleResult`. Count
`cycleResult.iterations` whose `outcome === "regressed-different-source"` and, if
> 0, call `recordOscillations(ctx.runtime.rectificationOscillations, ctx.story.id,
count)`. `ctx.runtime` is the stable run-scoped instance threaded through every
per-attempt `PipelineContext` rebuild (same access pattern as `run-phase.ts`),
so the count accumulates across escalation attempts.

**Halt decision** — `src/execution/post-run.ts`, in `decideStageAction`, inside
the existing "Rectification exhausted with unfixed findings" branch that today
returns `{ action: "escalate", reason: exhaustedReason }` (the block ending
~`post-run.ts:411`). Before escalating, read the cumulative count and config; if
the breaker is enabled and `count >= maxOscillations`, mirror the existing
`needsHumanReview` direct-pause path (`post-run.ts:467-487`) — send a `notify`
interaction via `ctx.interaction?.send({ … })` and return
`{ action: "pause", reason }` instead of escalating.

**Why the pause route (not a new `FailureCategory`).** Returning
`{ action: "pause" }` is the same `StageAction` the `needsHumanReview` path
already uses (`post-run.ts:487`); it rides the existing
`pipeline-result-handler.ts` `case "pause"` → `markStoryPaused`
(`src/prd/index.ts:370`) → `story:paused` event → TUI badge / reporters /
next-run resume prompt (`paused-story-prompts.ts`). This means the breaker adds
**no** new `StoryStatus` value and touches **neither** `satisfies never` guard
(`resolveMaxAttemptsOutcome` at `tier-escalation.ts:112`, `routeTddFailure` at
`execution-helpers.ts:123`) — those stay untouched.

**Config** — new sibling of `review.adversarial.recurrenceDemotion` under
`ReviewConfigSchema` (`src/config/schemas-review.ts`), matching that block's
shape/placement exactly:

```ts
conflictDetection: z.object({
  enabled: z.boolean().default(true),
  maxOscillations: z.number().int().min(1).default(2),
}).default({ enabled: true, maxOscillations: 2 }),
```

Read at the halt site as `ctx.config?.review?.conflictDetection`. The `review`
namespace matches issue #1335's framing and keeps it discoverable beside
`recurrenceDemotion`, even though the trigger itself is source-agnostic (noted in
Summary).

### Failure Handling

- **Fail-open on missing config / runtime.** If `conflictDetection.enabled` is
  false, or the runtime counter is absent, `decideStageAction` behaves exactly as
  today (escalate) — the breaker is a pure addition gated behind a default-on
  flag; disabling restores current behavior byte-for-byte.
- **Interaction send failure is non-fatal.** As in the `needsHumanReview` path,
  a throw from `ctx.interaction.send` is caught and logged (`logger.warn`); the
  pause still returns. The pause does not depend on interaction delivery.
- **No false-positive on normal progress.** A single `regressed-different-source`
  iteration is a benign source handoff (e.g. lint resolved → typecheck surfaced)
  and must never halt; the threshold is `>= maxOscillations` (default 2).

## Stories

Two stories. Single-package repo (nax is TS-on-Bun, no workspace) — no `Workdir`.

- **US-001 — Oscillation state primitives** (config field + runtime counter +
  store helpers). No dependencies.
- **US-002 — Circuit-breaker wiring** (increment on `regressed-different-source`
  iterations; convert rectification-exhausted escalation into a pause once the
  threshold is met). Depends on US-001.

No removal keywords → no terminal-cleanup story.

### Seams

- **US-002 consumes US-001's store + config.** US-001 introduces the
  externally-visible symbols `recordOscillations` / `getOscillations` (barrel
  export from `src/execution`) and the `NaxRuntime.rectificationOscillations`
  field and `review.conflictDetection` config. US-002 calls them at the increment
  and halt sites. Declared as a seam invariant in US-002's ACs: US-002's test
  drives the halt path and asserts `getOscillations` is consulted and the pause
  is produced from the accumulated count.

## Acceptance Criteria

### US-001 — Oscillation state primitives

1. `[unit]` `recordOscillations` and `getOscillations` are importable from the
   `src/execution` barrel and are usable as functions.
2. `[unit]` calling `getOscillations(store, "US-9")` on a fresh `Map` returns
   `0` (unseen story yields zero).
3. `[unit]` calling `recordOscillations(store, "US-1", 2)` returns `2`, and a
   subsequent `getOscillations(store, "US-1")` returns `2`.
4. `[unit]` calling `recordOscillations(store, "US-1", 1)` then
   `recordOscillations(store, "US-1", 2)` returns `3` on the second call (delta
   accumulates cumulatively for the same story).
5. `[unit]` recording against two different storyIds in an interleaved sequence —
   `recordOscillations(store, "A", 2)`, `recordOscillations(store, "B", 5)`,
   `recordOscillations(store, "A", 1)` — yields `getOscillations(store, "A") === 3`
   and `getOscillations(store, "B") === 5` (per-story counts are isolated; no
   cross-story leakage). *(pins the concurrency/isolation risk property — the
   store is single-threaded and mutated per storyId key.)*
6. `[unit]` a `NaxRuntime` obtained from `createRuntime` exposes a
   `rectificationOscillations` property that is a `Map` and is empty (size `0`)
   on a freshly created runtime.
7. `[unit]` parsing a config with `review.conflictDetection` unset yields
   `config.review.conflictDetection.enabled === true` and
   `config.review.conflictDetection.maxOscillations === 2` (schema-derived
   defaults).
8. `[unit]` parsing a config that sets `review.conflictDetection.maxOscillations`
   to `4` yields `config.review.conflictDetection.maxOscillations === 4`
   (explicit override is honored).

**Out of scope:** true multi-threaded atomicity — the store is a synchronous
in-process `Map` mutated on the single JS event loop with no `await` between read
and write, keyed per storyId; cross-story concurrency is covered by AC5's
interleave test, and same-story concurrent async mutation does not occur (one
worker owns a storyId). No lock/transaction is introduced.

### US-002 — Circuit-breaker wiring

1. `[unit]` a helper that counts `regressed-different-source` iterations in a
   `FixCycleResult`-shaped value returns `2` when given `iterations` whose
   `outcome` fields are `["regressed-different-source", "partial",
   "regressed-different-source"]`, and `0` when no iteration has that outcome.
2. `[integration]` when a rectification cycle result contains one
   `regressed-different-source` iteration, the story's cumulative oscillation
   count on the runtime (read via `getOscillations`) increases by exactly `1`
   after the increment site runs. *(seam: proves US-001's `recordOscillations`
   is invoked from the rectification path.)*
3. `[integration]` given a rectification-exhausted story with unfixed **blocking**
   findings, `review.conflictDetection.enabled === true`, `maxOscillations === 2`,
   and an accumulated oscillation count of `2`, `decideStageAction` returns
   `action === "pause"` (not `"escalate"`). *(seam: proves US-001's
   `getOscillations` + config gate the halt.)*
4. `[integration]` the pause result from AC3 carries a `reason` string that
   states the story is oscillating and includes the oscillation count (a concrete,
   operator-readable message — e.g. contains the count `2` and the word
   `oscillat…`).
5. `[integration]` given the same rectification-exhausted story but an
   accumulated oscillation count of `1` (below `maxOscillations`),
   `decideStageAction` returns `action === "escalate"` (single/sub-threshold
   oscillation still escalates — no false-positive halt). *(regression guard.)*
6. `[integration]` given the same rectification-exhausted story with count `2`
   but `review.conflictDetection.enabled === false`, `decideStageAction` returns
   `action === "escalate"` (disabling the flag restores current behavior).
7. `[integration]` a normal single-reviewer / single-source unfixable finding
   (rectification exhausted, oscillation count `0`) returns `action === "escalate"`
   exactly as before this change (behavior for the non-oscillating exhaustion
   path is unchanged).
8. `[integration]` when the breaker returns `action === "pause"`, an interaction
   of type `notify` is sent through the injected interaction channel; and when the
   interaction channel throws, `decideStageAction` still returns
   `action === "pause"` (interaction delivery is best-effort, never blocks the
   pause).

**Out of scope:** surfacing the conflict via a dedicated interaction *trigger*
(`human-review`-style) or a run-end advisory-summary counter — the breaker reuses
the existing `notify` + `story:paused` surfacing; richer surfacing is deferred.
Tightening the semantic/adversarial AC-grounding filters (issue #1335 proposal 4)
is also deferred — it does not change the breaker.
