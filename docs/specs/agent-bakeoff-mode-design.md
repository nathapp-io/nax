# Agent Bake-off Mode — Design

**Date:** 2026-07-04
**Feature:** `agent-bakeoff-mode`
**Repo:** `repos/nax` (branch `feat/agent-bakeoff-mode`)
**Origin:** `projects/nax/nax-feature-suggestions-2026-07-04.md` §2.1 (Tier-1 strategic value), next arc after flaky-test-quarantine (PR #1299) shipped.

---

## 1. Purpose

Run the **same work on N coding agents** in parallel-isolated worktrees, verify each against the **same acceptance tests**, and emit a ranked comparison so a user can decide *which agent to trust for this repo*. It is a **benchmark harness**, not a code-producing run.

**Report-only (decided).** Every contestant's worktree is throwaway; nothing is merged into the user's branch. The output is a decision aid plus a machine-readable artifact that later features (empirical routing §2.3, plan-time estimation §2.5) can consume. "Keep the winning implementation" is an explicit non-goal for this arc — a clean fast-follow once the harness exists.

### Non-goals
- Merging any contestant's code (`--keep-winner`) — deferred.
- Shared/global cost budget across contestants — rejected (corrupts fairness; see §7).
- Racing contestants concurrently (`--race`) — deferred (corrupts wall-time metric; see §7).
- Markdown/committed report file — trivial fast-follow off the JSON artifact.

---

## 2. Scope of comparison

- **Feature-level by default.** Each contestant runs the entire feature (all stories, full dependency graph) end-to-end via the existing run pipeline, in its own worktree.
- **`--story <id>` narrows** to a single story for a cheaper, tighter, apples-to-apples micro-benchmark.

The two paths share all machinery; the only difference is what work is handed to each contestant's pipeline.

---

## 3. Agent pinning

Each contestant is **hard-pinned to its agent** for the duration: cross-agent escalation (ADR-025 agent swap) is disabled so a `claude` contestant can never become a claude/codex hybrid. **Tier escalation within the same agent is retained** — it reflects how nax actually drives an agent, and the resulting escalation count becomes a real signal (an agent that escalates less is more capable on this repo).

---

## 4. Ranking

Contestants are ranked **lexicographically**, correctness first:

1. `storiesPassed` (desc) — a failing agent never outranks a passing one, no matter how cheap.
2. `costUsd` (asc) — cheaper wins ties.
3. `wallTimeMs` (asc) — faster wins remaining ties.

`tierEscalations` and `reviewFindings` are shown as columns but do **not** drive the sort. DNF statuses sink below all finishers (0 stories passed). The full metric table is always printed under the ranking — an opinionated winner and full transparency are not mutually exclusive.

---

## 5. Output

Two audiences, one run:

- **Terminal:** ranked table, winner first, DNFs last. Columns: rank, agent, status, stories (passed/total), cost, wall-time, escalations, findings.
- **JSON artifact:** the `BakeoffResult` (§8) persisted to the **run registry** (`~/.nax/runs/…`), alongside existing per-run StoryMetrics. This is operational/machine-local data — not versioned in the repo — and is where routing/estimation already look for metrics.

---

## 6. CLI surface

```
nax run --compare claude,codex,gemini -f <feature> [--story US-002] [--max-cost <usd>] [--parallel <n>]
```

- `--compare <a,b,c>` activates bake-off mode. **Mutually exclusive with `--agent`** — passing both is an error.
- `--story <id>` (new) narrows the comparison to one story (§2).
- `--max-cost <usd>` is enforced **per contestant** (§7).
- `--parallel <n>` applies to stories *within* each contestant (§9), unchanged from today.
- Reuses existing `-f/--feature`, `-d/--dir`, logging flags.

---

## 7. Cost safety

- **Per-contestant cap.** `--max-cost` is enforced against each contestant independently, reusing the shipped `cost-limit` run status (#1291). A contestant that blows its cap is aborted and recorded as `cost-limit`; others are unaffected. Total worst-case exposure = `N × max-cost`, set knowingly. A shared global budget was rejected: a fast-failing agent could starve a slower-but-better one and distort the comparison.
- **Upfront confirmation.** Before spawning anything, print the worst-case `N × max-cost` and require confirmation.

---

## 8. Execution model

Contestants run **sequentially**; **stories run in parallel within** each contestant (existing `--parallel`). Sequential contestants give clean, uncontended wall-time numbers — important because wall-time is a *ranked* metric (§4); parallel contestants would contend for CPU/IO and pollute it. A `--race` flag (concurrent contestants) is a deferred opt-in for users who value speed over clean numbers.

```
validate agents (pre-flight)           # unknown/not-installed → abort, free, exit non-zero
  → confirm worst-case N × cap
  → for each contestant (sequential):
        new throwaway worktree
        → run pipeline (agent hard-pinned, stories parallel)   # = existing `nax run`
        → collect ContestantResult + StoryMetrics
        → tear down worktree (finally)
  → rank results
  → render terminal table + persist bakeoff.json to run registry
```

**Key reuse:** a contestant's actual work *is* `nax run` as it exists today, handed one pinned agent in a throwaway worktree. Bake-off adds orchestration + scoring + reporting around the unchanged core loop — the only core touch-point is a hard-pin hook that disables cross-agent escalation.

### Module layout — new `src/bakeoff/`
- `coordinator.ts` — sequential loop over contestants; worktree setup/teardown; invokes the run pipeline per contestant.
- `contestant.ts` — runs one agent to a terminal `ContestantResult`, with per-contestant failure isolation (§10).
- `ranking.ts` — pure `ContestantResult[] → ranked[]` (§4); independently unit-testable.
- `report.ts` — renders the ranked terminal table + writes the JSON artifact.
- `types.ts` — `ContestantStatus`, `ContestantResult`, `BakeoffResult`.

---

## 9. Data model

```ts
type ContestantStatus =
  | "passed"            // all targeted stories green
  | "failed"            // ran to completion, tests never passed
  | "cost-limit"        // hit per-contestant --max-cost (reuses #1291)
  | "dnf-crashed"       // adapter/session died mid-run
  | "dnf-not-installed" // caught at pre-flight (never spawned)
  | "timeout";          // exceeded max wall-time

interface ContestantResult {
  agent: string;
  status: ContestantStatus;
  storiesPassed: number;   // of storiesTotal
  storiesTotal: number;
  costUsd: number;         // from existing StoryMetrics aggregation
  wallTimeMs: number;
  tierEscalations: number; // tier bumps only — agent hard-pinned (§3)
  reviewFindings: number;  // adversarial-review findings the pipeline surfaced
  error?: string;          // populated for dnf-* statuses
}

interface BakeoffResult {
  feature: string;
  story?: string;               // set when --story narrows scope
  createdAt: string;            // ISO; caller-stamped via nax's clock seam
  ranking: ContestantResult[];  // sorted, winner first
  maxCostPerContestant?: number;
}
```

All per-contestant numbers already come out of `src/metrics/` — bake-off **aggregates**, it does not re-measure.

---

## 10. Error handling

- **Pre-flight** — every named agent must resolve in the ACP registry (`src/agents/acp/adapter.ts`) with its binary on PATH. Any miss → abort before spend, exit non-zero, list offenders (`dnf-not-installed` conceptually, but never spawned).
- **Mid-run isolation** — the coordinator wraps each contestant in a boundary that converts any throw / timeout / cost-limit into a terminal `ContestantResult` and continues. A broken contestant is a *data point*, not a reason to discard others' results. Worktree teardown runs in `finally` so a crash never leaks a worktree.
  - `timeout` is **not** a new bake-off flag — it is inherited from the existing pipeline bounds (e.g. `-m/--max-iterations` and adapter-level session timeouts). When the underlying run pipeline exhausts those bounds without passing, the contestant boundary records `timeout`. Bake-off adds no timeout knob of its own in this arc.
- **Total wipeout** — if every contestant DNFs, still write the report (all DNFs) and exit non-zero so the failure is diagnosable.

---

## 11. Testing

Fast unit-level tests with fakes for the run pipeline and ACP adapters — **no live agents** in tests, consistent with nax's existing style.

- `ranking.ts` — correctness-first ordering; tie-breaks (equal passes → cheaper → faster); DNFs sink to bottom; all-DNF ordering stable.
- `contestant.ts` — injected crash/timeout/cost-limit each yield the correct status and never propagate; worktree teardown always invoked.
- `coordinator.ts` — sequential order (contestant 2 starts only after 1 finishes); pre-flight rejects unknown agent before any spawn; `--compare` + `--agent` together errors.
- `report.ts` — snapshot of table rendering; JSON artifact shape matches `BakeoffResult`.

---

## 12. Decision log

| # | Decision | Rationale |
|---|---|---|
| Q1 | Report-only benchmark; throwaway worktrees | Self-contained, no new merge logic, matches "generate empirical data" framing |
| Q2 | Feature by default, `--story` to narrow | Shared machinery; cost-controllable |
| Q3 | Hard-pin agent, keep tier escalation | Measures the agent as nax really drives it; escalation count becomes signal |
| Q4 | Lexicographic correctness → cost → time | Un-gameable, clear winner, no arbitrary weights |
| Q5 | Terminal table + JSON artifact | Serves human + downstream features in one run |
| Q6 | JSON in run registry (`~/.nax/runs/`) | Operational data; one place for all per-run metrics |
| Q7 | Per-contestant `--max-cost` + upfront `N×cap` confirm | Fair comparison; no budget starvation; no surprise spend |
| Q8 | Pre-flight binary check + mid-run isolation | Fail free on not-installed; broken contestant = data point |
| Q9 | Contestants sequential, stories parallel within | Clean uncontended wall-time (a ranked metric); `--race` deferred |
