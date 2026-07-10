# Design: `nax status --cost --json` — stable cost export

> Date: 2026-07-10
> Source: IMPROVEMENT-REPORT §1.4 (Dashboard / metrics export), "cheapest slice."
> Scope: stabilize and machine-expose the cost metrics `nax status --cost` already
> computes. OTel/Prometheus export and feature-status JSON are explicitly deferred.

## Problem

`nax status --cost` (and its `--last` / `--model` sub-views) render metrics through
`logger.info` as human-formatted lines. There is no stable, machine-readable export,
so no downstream tool (dashboard, CI gate, spend report) can consume nax cost data
without scraping log text. IMPROVEMENT-REPORT §1.4 names `nax status --cost --json`
schema stabilization as the cheapest first step toward a metrics-export surface.

## Goals

- Emit a **stable, versioned** JSON contract for cost metrics to stdout.
- Decouple the public contract from internal metrics types so internal refactors do
  not silently break consumers.
- Zero behavioural change to the existing human `--cost` / `--last` / `--model` views.

## Non-goals (YAGNI)

- OTel / Prometheus exporter (the deferred second half of §1.4).
- `nax status --json` for feature/story status (a separate, larger surface).
- Any new computed metric. This slice exposes only what `--cost` already computes.

## Approach

Curated stable schema behind a pure mapper — mirroring the established
`nax replay --json` pattern (`src/replay/json.ts` `toReplayJson` → `deps.stdout`).
A dedicated public `CostReportV1` type plus a pure `toCostReport` mapper form the
seam; internal `AggregateMetrics` / `RunMetrics` / `StoryMetrics` can change freely
behind it. Chosen over a thin passthrough of internal types precisely because a
passthrough would couple every internal metrics-type change to the public contract —
the coupling §1.4 exists to avoid.

## Components

Three pieces, smallest layer that fits:

1. **`src/metrics/report.ts`** (new, pure) — public `CostReportV1` type + a pure
   mapper `toCostReport(runs, deps)`. No I/O, no logger. `deps = { now: () => string }`
   is the injected ISO-timestamp seam (defaults to `() => new Date().toISOString()` at
   the boundary). Total function: never throws on empty input — returns nulls.
   Exported from the `src/metrics` barrel (`src/metrics/index.ts`).

2. **`src/cli/status-cost.ts`** (extend) — add `emitCostReportJson(workdir, deps)`.
   Reuses the existing private `resolveOutputDir` + `loadRunMetrics`, calls
   `toCostReport`, and writes `JSON.stringify(report, null, 2)` to stdout via an
   injected `deps.stdout` (default `(s) => process.stdout.write(s)`). The three existing
   `display*` human functions are untouched.

3. **`bin/nax.ts`** (wire) — add `.option("--json", "Emit machine-readable cost JSON to
   stdout (requires --cost)", false)` to the `status` command. When
   `options.cost && options.json`, route to `emitCostReportJson` and `return` before any
   human view or logger line runs.

## Schema — `CostReportV1`

```ts
interface CostReportV1 {
  schemaVersion: "1.0";
  project: string;        // resolved projectKey
  generatedAt: string;    // ISO timestamp, injected via deps.now
  aggregate: CostAggregate | null;
  lastRun: CostRunSummary | null;
  modelEfficiency: CostModelStat[];   // sorted desc by totalCost; [] when none
}

interface CostAggregate {
  totalRuns: number;
  totalStories: number;
  totalCost: number;
  avgCostPerStory: number;
  avgCostPerFeature: number;
  firstPassRate: number;
  escalationRate: number;
}

interface CostRunSummary {
  runId: string;
  feature: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalStories: number;
  storiesCompleted: number;
  storiesFailed: number;
  totalCost: number;
  avgCostPerStory: number;
  stories: CostStory[];   // all stories in the last run, sorted desc by cost
}

interface CostStory {
  storyId: string;
  cost: number;
  model: string;
  attempts: number;
}

interface CostModelStat {
  model: string;
  attempts: number;
  passRate: number;
  avgCost: number;
  totalCost: number;
}
```

Curated fields only. Every field maps from an existing metrics field
(`AggregateMetrics`, `RunMetrics`, `StoryMetrics`, `AggregateMetrics.modelEfficiency`).
Internal-only fields (token usage, context pollution, fallback aggregates, complexity
accuracy) are intentionally excluded from v1 — additive fields can land in a future
`schemaVersion` without breaking `1.0` consumers.

`avgCostPerStory` in `lastRun` = `totalCost / totalStories`, guarded for
`totalStories === 0` → `0` (avoid NaN in the JSON).

## Data flow

`nax status --cost --json`
→ `resolveOutputDir(workdir)`
→ `loadRunMetrics(outputDir)` → `RunMetrics[]`
→ `toCostReport(runs, { now })`
→ `JSON.stringify(report, null, 2)`
→ `deps.stdout(...)`
→ exit 0.

`aggregate` / `modelEfficiency` derive from `calculateAggregateMetrics(runs)`;
`lastRun` derives from `getLastRun(runs)`. The mapper is the single place these three
existing helpers are composed into the public shape.

## Empty state

When `loadRunMetrics` returns `[]`, `toCostReport` emits a **valid** report:
`aggregate: null`, `lastRun: null`, `modelEfficiency: []`, with `schemaVersion`,
`project`, and `generatedAt` present. **Exit 0.** A consuming script always gets
parseable JSON and never has to special-case a non-JSON "no data" line or a nonzero
exit. This is the deliberate contrast with the human path, which logs "No metrics data
available yet".

## Flag interactions

- `--cost --json` → unified `CostReportV1` (all three sections). `--last` / `--model`
  are **ignored** in JSON mode — the report always carries all sections, so consumers
  never juggle which flag produced which shape.
- `--json` **without** `--cost` → out of scope for this slice; falls through to the
  existing human feature-status view unchanged. A future feature-status JSON export is
  a separate design.

## Error handling

- `toCostReport` is total — returns nulls on empty, never throws.
- `avgCostPerStory` guards divide-by-zero → `0`.
- I/O errors from `loadRunMetrics` propagate exactly as they do for the human path
  today (no new swallow).
- No `console.log` / `console.error` in `src/` — stdout goes through the injected
  `deps.stdout` seam (the `deps.stdout` pattern from `src/commands/replay.ts`),
  keeping the emit testable and out of the structured logger.

## Testing

- **`test/unit/metrics/report.test.ts`** (new) — `toCostReport` with injected `now`:
  - populated runs → correct curated shape, `schemaVersion === "1.0"`,
    `modelEfficiency` sorted desc by `totalCost`, `lastRun.stories` sorted desc by cost.
  - empty `[]` → valid empty report (nulls + `[]` + envelope), `generatedAt` from
    injected `now`.
  - assert no internal-only fields (tokens, pollution, complexityAccuracy) leak into
    the output.
  - `totalStories === 0` in last run → `avgCostPerStory === 0`, no NaN.
- **`status-cost` JSON emit** (add to existing `status-cost` unit test) — injected
  `stdout` + `now` deps assert the exact JSON string emitted; empty-state path writes a
  valid report and does not throw.

Deterministic via DI (`now`, `stdout`); no real clock, no snapshot fragility.

## Convention compliance

- Bun-native, no Node fs/process APIs in new logic; stdout via injected dep.
- `_deps` DI pattern for `now` and `stdout` (nax `_deps` convention).
- Barrel export from `src/metrics`; consumers import from `@/metrics`, never the leaf.
- File sizes well under limits; `status-cost.ts` gains one small function.
- Conventional commits, one concern per commit.
