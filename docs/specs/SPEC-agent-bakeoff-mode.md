# SPEC: Agent Bake-off Mode

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add a report-only benchmark mode to `nax run` that executes the **same feature (or a single story) on N coding agents** in isolated throwaway worktrees, verifies each against the **same acceptance tests**, and emits a ranked comparison — a terminal table plus a machine-readable JSON artifact in the run registry. It answers "which agent should I trust for this repo?" empirically, and produces the cross-agent data that later features (empirical routing, plan-time cost estimation) depend on. Nothing is merged into the user's branch; every contestant's worktree is discarded.

## Motivation

Today `nax run` drives exactly one agent. There is no reproducible, acceptance-test-grounded way to compare agents head-to-head on identical work — the ecosystem lacks it entirely, and nax already has every seam to provide it cheaply (worktree isolation, four ACP adapters, per-story cost/time/escalation metrics). Without empirical cross-agent data, routing defaults and plan-time estimates are guesses. Bake-off mode turns nax into a benchmark harness and generates that data as a byproduct of a normal run.

## Design

Bake-off is an **orchestrator wrapper around the existing run pipeline**, not a fork of it. A new `src/bakeoff/` module adds contestant orchestration, scoring, and reporting; the only core touch-point is a hard-pin that disables cross-agent escalation for the duration of each contestant.

### Integration (extends existing code)

Verified symbols this feature builds on:

- **ACP agent registry** — `KNOWN_AGENT_NAMES` (`src/agents/registry.ts`, exported: `["claude","codex","opencode","gemini","aider"]`). Pre-flight must treat a name as valid only when it is a known name **and** resolves to a real ACP adapter with its binary on PATH (`aider` is listed but ships no ACP adapter entry in `AGENT_REGISTRY` at `src/agents/acp/adapter.ts`, so it must fail pre-flight rather than silently degrade).
- **Worktree lifecycle** — `WorktreeManager` (`src/worktree/manager.ts`): `create(projectRoot, storyId)` and `remove(projectRoot, storyId)`. Each contestant gets its own worktree, removed in a `finally`.
- **Execution reuse** — `executeParallel(...)` (`src/execution/parallel-coordinator.ts`) is the existing per-feature pipeline dispatch a contestant reuses (stories run in parallel within a contestant per `--parallel`).
- **Metrics** — `StoryMetrics` (`src/metrics/types.ts`: `cost`, `durationMs`, `attempts`, `initialTier`, `finalTier`) and `RunMetrics`; persisted via `saveRunMetrics(outputDir, runMetrics)` (`src/metrics/tracker.ts`) to the run registry (`~/.nax/runs/<id>/`). Bake-off **aggregates** these into `ContestantResult` — it does not re-measure.
- **Hard-pin seam** — agent selection lives under `config.agent` (`agent.default` primary; `agent.fallback.enabled` gates the per-agent cross-agent chain in `agent.fallback.map`, default `false` — see `src/config/runtime-types-agent.ts:31`, `.claude/rules/config-patterns.md` / ADR-012). Pinning a contestant means running the pipeline with `agent.default = <contestant>` and `agent.fallback.enabled = false` so no cross-agent hop occurs; tier escalation (routing `modelTier`) is untouched and still happens.
- **Table precedent** — `src/commands/runs.ts` renders the runs registry as a `chalk` + `console.log` table with a status colorizer; the bake-off report mirrors that style.
- **Errors** — `NaxError` (`src/errors`) with a machine-readable `code` and `context.stage`, per `.claude/rules/error-handling.md`. Expected "not found"/validation results return structured `{ errors }` rather than throwing.

Conventions honored: Bun-native APIs only; TypeScript strict, no `any`; module barrel `index.ts` + `types.ts`; logging via `src/logger` (no `console.log` in source); 600-line source file limit; tests mirror `src/` under `test/unit/bakeoff/`.

### Approach

Deterministic orchestration + pure scoring; no LLM decision inside bake-off itself. Contestants run **sequentially** (clean, uncontended wall-time, which is a ranked metric); **stories run in parallel within** each contestant via the existing `--parallel`. Ranking is a pure function.

Worked skeleton for the novel pure-scoring shape (`src/bakeoff/ranking.ts`):

```typescript
// Pure, dependency-free. Correctness-first lexicographic order.
export function rankContestants(results: ContestantResult[]): ContestantResult[] {
  return [...results].sort((a, b) =>
    b.storiesPassed - a.storiesPassed ||   // more passed wins
    a.costUsd - b.costUsd ||               // cheaper wins ties
    a.wallTimeMs - b.wallTimeMs);          // faster wins remaining ties
}
```

### CLI Behavior

```
nax run --compare claude,codex,gemini -f <feature> [--story US-002] [--max-cost <usd>] [--parallel <n>]
```

- `--compare <a,b,c>` activates bake-off mode. **Mutually exclusive with `--agent`** — supplying both is a usage error (non-zero exit, message names the conflict).
- `--story <id>` (new) narrows the comparison to a single story; omitted → whole feature.
- `--max-cost <usd>` is enforced **per contestant** (reuses the shipped `cost-limit` status); worst-case exposure `N × max-cost` is printed and confirmed before any contestant spawns.
- `--parallel <n>` applies to stories *within* each contestant (unchanged).
- **stdout:** ranked table (human) + a one-line winner summary. **stderr:** pre-flight failures, warnings.
- **Exit codes:** `0` when at least one contestant finished and a report was produced; non-zero when pre-flight rejects an agent (before spend) or when every contestant DNFs.

### File Format — bake-off JSON artifact

Written to the run registry directory (`~/.nax/runs/<id>/bakeoff.json`). Shape:

```jsonc
{
  "feature": "inline-charts",
  "story": "US-002",                 // omitted when whole-feature
  "createdAt": "2026-07-04T12:00:00.000Z",
  "maxCostPerContestant": 5.0,       // omitted when no cap set
  "ranking": [                        // sorted, winner first
    {
      "agent": "claude",
      "status": "passed",             // passed|failed|cost-limit|dnf-crashed|dnf-not-installed|timeout
      "storiesPassed": 3,
      "storiesTotal": 3,
      "costUsd": 0.42,
      "wallTimeMs": 190000,
      "tierEscalations": 0,
      "reviewFindings": 1,
      "error": null                   // populated string for dnf-* statuses
    }
  ]
}
```

### Failure Handling

- **Fail-closed at pre-flight:** any requested agent that is unknown, has no ACP adapter, or whose binary is absent from PATH aborts the whole bake-off **before spending anything** (non-zero exit, offenders listed). This is the only place a bad agent aborts the run.
- **Fail-open mid-run (per-contestant isolation):** once contestants are running, any throw / timeout / cost-limit is caught at the contestant boundary and converted to a terminal `ContestantResult` with the matching status; remaining contestants continue. Worktree teardown runs in `finally` so a crash never leaks a worktree.
- **Total wipeout:** if every contestant DNFs, still write the report (all DNFs) and exit non-zero, so the failure is diagnosable.
- `timeout` is **not** a new flag — it is inherited from existing pipeline bounds (`-m/--max-iterations`, adapter session timeouts). The contestant boundary records `timeout` when those bounds are exhausted without passing.

## Stories

### US-001 — Bake-off types and ranking (foundation)
New pure module: `src/bakeoff/types.ts` (`ContestantStatus`, `ContestantResult`, `BakeoffResult`) and `src/bakeoff/ranking.ts` (`rankContestants`). No dependencies. Barrel `src/bakeoff/index.ts` exports both.
- **Context Files:** `src/metrics/types.ts`
- **Creates:** `src/bakeoff/types.ts`, `src/bakeoff/ranking.ts`, `src/bakeoff/index.ts`, `test/unit/bakeoff/ranking.test.ts`
- **Dependencies:** none

### US-002 — CLI options, pre-flight validation, cost confirmation
Parse `--compare`/`--story`, reject `--compare`+`--agent`, validate each requested agent against the ACP registry + PATH, and compute the worst-case `N × max-cost` for the confirmation prompt. New: `src/bakeoff/preflight.ts`.
- **Context Files:** `src/agents/registry.ts`, `src/agents/acp/adapter.ts`, `bin/nax.ts`, `src/bakeoff/types.ts` — created by US-001, integrated here
- **Creates:** `src/bakeoff/preflight.ts`, `test/unit/bakeoff/preflight.test.ts`
- **Dependencies:** US-001

### US-003 — Contestant runner (hard-pin, worktree lifecycle, isolation)
`runContestant(agent, options, deps)` runs one pinned agent to a terminal `ContestantResult`: create worktree → run pipeline with cross-agent escalation disabled → aggregate `StoryMetrics` → remove worktree in `finally`. All failure modes isolated to a status. New: `src/bakeoff/contestant.ts`.
- **Context Files:** `src/worktree/manager.ts`, `src/execution/parallel-coordinator.ts`, `src/metrics/types.ts`, `src/config/selectors.ts`, `src/bakeoff/types.ts` — created by US-001, integrated here
- **Creates:** `src/bakeoff/contestant.ts`, `test/unit/bakeoff/contestant.test.ts`
- **Dependencies:** US-001

### US-004 — Coordinator, report, and CLI wiring
`runBakeoff(options)` runs contestants sequentially, ranks results, and returns a `BakeoffResult`. `renderBakeoffReport(result)` produces the terminal table; `persistBakeoffResult(result, outputDir)` writes `bakeoff.json` to the run registry. Wire `runBakeoff` into the `bin/nax.ts` run action when `--compare` is present. New: `src/bakeoff/coordinator.ts`, `src/bakeoff/report.ts`.
- **Context Files:** `bin/nax.ts`, `src/metrics/tracker.ts`, `src/bakeoff/preflight.ts` — created by US-002, integrated here, `src/bakeoff/contestant.ts` — created by US-003, integrated here, `src/bakeoff/ranking.ts` — created by US-001, integrated here (`src/commands/runs.ts` is the table-rendering style precedent — see Integration; not read directly)
- **Creates:** `src/bakeoff/coordinator.ts`, `src/bakeoff/report.ts`, `test/unit/bakeoff/coordinator.test.ts`, `test/unit/bakeoff/report.test.ts`
- **Dependencies:** US-001, US-002, US-003

### Seams

- **`rankContestants` (US-001 → US-004):** US-004's coordinator test stubs `rankContestants`, triggers `runBakeoff`, and asserts it was called with the full collected results array and that `BakeoffResult.ranking` is its return value.
- **`validateContestants` (US-002 → US-004):** US-004's test stubs `validateContestants` to return a failure, triggers `runBakeoff`, and asserts no `runContestant` call happened (pre-flight gates spend).
- **`runContestant` (US-003 → US-004):** US-004's test spies `runContestant`, triggers `runBakeoff` with two validated agents, and asserts it was invoked once per agent in sequence.

## Acceptance Criteria

### US-001 — Types and ranking

1. `[unit]` Importing `rankContestants` from `@/bakeoff` succeeds and it is usable as a function accepting a `ContestantResult[]` and returning a `ContestantResult[]`.
2. `[unit]` Given two results, one with `storiesPassed: 3` and `costUsd: 9` and one with `storiesPassed: 2` and `costUsd: 1`, `rankContestants` returns the 3-passed result first (correctness outranks lower cost).
3. `[unit]` Given two results with equal `storiesPassed` and `costUsd: 1` vs `costUsd: 2`, `rankContestants` returns the `costUsd: 1` result first.
4. `[unit]` Given two results with equal `storiesPassed` and equal `costUsd` but `wallTimeMs: 100` vs `wallTimeMs: 200`, `rankContestants` returns the `wallTimeMs: 100` result first.
5. `[unit]` Given a finisher (`status: "passed"`, `storiesPassed: 1`) and a DNF (`status: "dnf-crashed"`, `storiesPassed: 0`), `rankContestants` returns the finisher first regardless of the DNF's cost or time.
6. `[unit]` Given an all-DNF input array, `rankContestants` returns an array of the same length without throwing, ordered by `costUsd` ascending.
7. `[unit]` A `ContestantResult` can be constructed with `status: "passed"` and no `error` field, and its `error` reads as `undefined`.

### US-002 — CLI options, pre-flight, cost confirmation

1. `[unit]` `parseCompareList("claude, codex ,gemini")` returns `["claude","codex","gemini"]` with surrounding whitespace trimmed.
2. `[unit]` `parseCompareList("claude,,")` returns `["claude"]`, dropping empty entries.
3. `[unit]` `validateContestants(["claude","codex"], deps)` — with a PATH-probe dep reporting both binaries present — returns a result with no errors and both agents marked valid.
4. `[unit]` `validateContestants(["bogus"], deps)` returns an errors list identifying `bogus` as an unknown agent (not in `KNOWN_AGENT_NAMES`).
5. `[unit]` `validateContestants(["aider"], deps)` returns an error for `aider` because it has no ACP adapter entry, even though it is in `KNOWN_AGENT_NAMES`.
6. `[unit]` `validateContestants(["gemini"], deps)` — with a PATH-probe dep reporting the `gemini` binary absent — marks `gemini` invalid with reason `dnf-not-installed`.
7. `[unit]` `assertCompareAgentExclusive({ compare: "claude", agent: "codex" })` throws a `NaxError` whose `code` indicates the `--compare`/`--agent` conflict.
8. `[unit]` `computeWorstCaseCost(3, 5)` returns `15` (N contestants × per-contestant cap).

### US-003 — Contestant runner

1. `[unit]` Importing `runContestant` from `@/bakeoff` succeeds and calling it with a stubbed pipeline resolves to a `ContestantResult` whose `agent` equals the requested agent name.
2. `[integration]` `runContestant` invokes `WorktreeManager.create` before running the pipeline and `WorktreeManager.remove` after; when the injected pipeline throws, `remove` is still called (teardown in `finally`).
3. `[integration]` `runContestant` invokes the pipeline with a config where `agent.default` equals the contestant name and cross-agent escalation is disabled (`agent.fallback.enabled === false`), leaving tier escalation untouched.
4. `[integration]` When the injected pipeline reports all stories passing, `runContestant` returns `status: "passed"` with `storiesPassed === storiesTotal`.
5. `[integration]` When the injected pipeline completes with unpassed stories, `runContestant` returns `status: "failed"`.
6. `[integration]` When the injected pipeline throws mid-run, `runContestant` returns `status: "dnf-crashed"` with a non-empty `error` string and does not re-throw.
7. `[integration]` When the injected pipeline signals a per-contestant cost-limit abort, `runContestant` returns `status: "cost-limit"`.
8. `[integration]` `runContestant` maps the run's `StoryMetrics` onto the result: `costUsd` from the aggregated `cost`, `wallTimeMs` from `durationMs`, and `tierEscalations` derived from `attempts`.

### US-004 — Coordinator, report, CLI wiring

1. `[integration]` `runBakeoff` with two validated agents invokes `runContestant` for the second agent only after the first agent's `runContestant` promise has resolved (sequential order).
2. `[integration]` `runBakeoff` calls `validateContestants` first; when it returns a failure, `runContestant` is never invoked and `runBakeoff` resolves/exits with a non-zero outcome.
3. `[integration]` `runBakeoff` calls `runContestant` exactly once per validated agent.
4. `[integration]` `runBakeoff` passes the full array of collected `ContestantResult`s to `rankContestants` and returns a `BakeoffResult` whose `ranking` is that function's return value.
5. `[integration]` `persistBakeoffResult(result, outputDir)` writes a `bakeoff.json` under `outputDir` whose parsed contents match the `BakeoffResult` (feature, ranking length, first-place agent).
6. `[unit]` `renderBakeoffReport(result)` returns a string containing each contestant's agent name, status, `storiesPassed/storiesTotal`, `costUsd`, and `wallTimeMs`, with the winner's row appearing before lower-ranked rows.
7. `[integration]` When every contestant resolves to a DNF status, `runBakeoff` still returns a `BakeoffResult` containing all contestants and signals a non-zero exit outcome.
8. `[integration]` Invoking the `bin/nax.ts` run action with `--compare claude,codex` routes to `runBakeoff` (rather than the single-agent path), verified by stubbing `runBakeoff` and asserting it receives the parsed contestant list.
