# SPEC: `nax status --cost --json` — stable cost export

<!-- spec-writing: completed-through-phase-5 -->

## Summary

Add a stable, versioned JSON export to `nax status --cost`. Today the cost views
(`--cost`, `--cost --last`, `--cost --model`) render through the structured logger as
human lines only; no downstream tool can consume nax cost data without scraping log
text. This feature introduces a curated public contract — `CostReportV1` — produced by
a pure mapper `toCostReport`, and emits it to stdout when `--json` accompanies `--cost`.
It is the "cheapest slice" of IMPROVEMENT-REPORT §1.4 (metrics export).

## Motivation

- **No machine-readable cost surface.** `src/cli/status-cost.ts` emits via
  `logger.info`; there is no `--json` flag on `status`. A dashboard, CI spend gate, or
  spend-report script must parse formatted log output.
- **Internal types would leak if exposed naively.** `AggregateMetrics` / `RunMetrics` /
  `StoryMetrics` are internal shapes that evolve. Exporting them directly would couple
  every internal refactor to the public contract — the exact coupling §1.4 exists to
  remove. A curated `CostReportV1` behind a mapper is the seam.

## Design

### Approach

Curated stable schema behind a pure mapper, mirroring the established
`nax replay --json` pattern in `src/commands/replay.ts` (a `ReplayCommandDeps` object
with an injectable `stdout` and the mapper `toReplayJson` itself injected). A dedicated
`CostReportV1` type plus a pure `toCostReport(runs, deps)` mapper form the seam;
internal metrics types change freely behind it. Chosen over a thin passthrough of
internal types, which would re-couple the contract to internals.

### Integration (extends existing code)

Verified integration points (signatures confirmed against HEAD):

- **`src/metrics` barrel** (`src/metrics/index.ts`) — currently re-exports the metrics
  types and `loadRunMetrics`, `calculateAggregateMetrics`, `getLastRun`. The new
  `CostReportV1` type and `toCostReport` mapper are exported from this barrel.
  Consumers import from `@/metrics`, never the leaf (`project-conventions.md` barrel
  rule).
- **`calculateAggregateMetrics(runs: RunMetrics[]): AggregateMetrics`** and
  **`getLastRun(runs: RunMetrics[]): RunMetrics | null`** (`src/metrics/aggregator.ts`) —
  the mapper composes these two existing helpers; it does not recompute metrics.
- **`RunMetrics`** fields used: `runId`, `feature`, `startedAt`, `completedAt`,
  `totalDurationMs`, `totalStories`, `storiesCompleted`, `storiesFailed`, `totalCost`,
  `stories`. **`StoryMetrics`** fields used: `storyId`, `cost`, `modelUsed`, `attempts`.
  **`AggregateMetrics`** fields used: `totalRuns`, `totalStories`, `totalCost`,
  `avgCostPerStory`, `avgCostPerFeature`, `firstPassRate`, `escalationRate`,
  `modelEfficiency` (a `Record<string, {attempts, successes, passRate, avgCost, totalCost}>`).
- **`src/cli/status-cost.ts`** — currently holds `displayCostMetrics`,
  `displayLastRunMetrics`, `displayModelEfficiency` plus private `resolveOutputDir`
  (which loads config, derives `projectKey = config?.name?.trim() || basename(workdir)`,
  and calls `projectOutputDir`) and imports `loadRunMetrics`. A new
  `emitCostReportJson(workdir, deps?)` is added here; the three `display*` functions are
  untouched. `emitCostReportJson` resolves the same `projectKey` `resolveOutputDir`
  derives and passes it to `toCostReport`.
- **`src/cli/status.ts`** barrel — re-exports `displayCostMetrics` etc.;
  `emitCostReportJson` is added to this re-export so `bin/nax.ts` imports it from
  `./status` like its siblings.
- **`bin/nax.ts`** `status` command (currently `.option("--cost")` / `--last` / `--model`
  with an inline `if (options.cost) { ... }` router) — gains
  `.option("--json", "Emit machine-readable cost JSON to stdout (requires --cost)", false)`
  and, as the first branch inside `if (options.cost)`, `if (options.json) { await
  emitCostReportJson(workdir); return; }` so JSON mode runs before any human view.

### CLI Behavior

- **Invocation:** `nax status --cost --json`.
- **stdout:** exactly the pretty-printed (`JSON.stringify(report, null, 2)`) JSON of one
  `CostReportV1` object, followed by a trailing newline. Nothing else on stdout.
- **stderr:** unused on the success path (no human logger lines in JSON mode).
- **Exit code:** `0` on success, including the empty-metrics case.
- **Flag precedence:** in JSON mode `--last` and `--model` are ignored — the report
  always carries all three sections, so consumers never juggle which flag produced which
  shape.
- **`--json` without `--cost`:** out of scope; falls through to the existing human
  feature-status view unchanged (a future feature-status JSON export is a separate spec).

### File Format — `CostReportV1`

```ts
interface CostReportV1 {
  schemaVersion: "1.0";
  project: string;        // resolved projectKey (config.name || basename(workdir))
  generatedAt: string;    // ISO timestamp, injected via deps.now
  aggregate: CostAggregate | null;      // null when there are no runs
  lastRun: CostRunSummary | null;       // null when there are no runs
  modelEfficiency: CostModelStat[];     // sorted desc by totalCost; [] when none
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
  durationMs: number;         // from RunMetrics.totalDurationMs
  totalStories: number;
  storiesCompleted: number;
  storiesFailed: number;
  totalCost: number;
  avgCostPerStory: number;    // totalCost / totalStories, 0 when totalStories === 0
  stories: CostStory[];       // every story in the last run, sorted desc by cost
}

interface CostStory {
  storyId: string;
  cost: number;
  model: string;              // from StoryMetrics.modelUsed
  attempts: number;
}

interface CostModelStat {
  model: string;              // the modelEfficiency record key
  attempts: number;
  passRate: number;
  avgCost: number;
  totalCost: number;
}
```

Concrete example (populated, one run, two models):

```json
{
  "schemaVersion": "1.0",
  "project": "nax",
  "generatedAt": "2026-07-10T12:00:00.000Z",
  "aggregate": {
    "totalRuns": 3, "totalStories": 12, "totalCost": 4.87,
    "avgCostPerStory": 0.406, "avgCostPerFeature": 1.623,
    "firstPassRate": 0.75, "escalationRate": 0.25
  },
  "lastRun": {
    "runId": "run_abc123", "feature": "status-cost-json",
    "startedAt": "2026-07-10T11:40:00.000Z", "completedAt": "2026-07-10T11:52:00.000Z",
    "durationMs": 720000, "totalStories": 2, "storiesCompleted": 2, "storiesFailed": 0,
    "totalCost": 1.42, "avgCostPerStory": 0.71,
    "stories": [
      { "storyId": "US-001", "cost": 0.9, "model": "claude-sonnet-4.5", "attempts": 1 },
      { "storyId": "US-002", "cost": 0.52, "model": "claude-haiku-4.5", "attempts": 2 }
    ]
  },
  "modelEfficiency": [
    { "model": "claude-sonnet-4.5", "attempts": 8, "passRate": 0.875, "avgCost": 0.45, "totalCost": 3.6 },
    { "model": "claude-haiku-4.5", "attempts": 4, "passRate": 0.75, "avgCost": 0.32, "totalCost": 1.27 }
  ]
}
```

Empty example (no runs yet):

```json
{
  "schemaVersion": "1.0",
  "project": "nax",
  "generatedAt": "2026-07-10T12:00:00.000Z",
  "aggregate": null,
  "lastRun": null,
  "modelEfficiency": []
}
```

Internal-only fields (`totalTokens`, per-story `context`/pollution, run `fallback`
aggregates, `complexityAccuracy`) are intentionally excluded from v1. Additive fields
can land under a future `schemaVersion` without breaking `1.0` consumers.

### Failure Handling

- **Fail-open on empty metrics.** No runs → `toCostReport` returns a valid report with
  `aggregate: null`, `lastRun: null`, `modelEfficiency: []`; `emitCostReportJson` prints
  it and returns normally (exit 0). No exception, no non-JSON "no data" line — a
  consuming script always parses valid JSON.
- **Divide-by-zero.** `avgCostPerStory` in `lastRun` is `0` when `totalStories === 0`
  (never `NaN` in the JSON).
- **I/O errors** from `loadRunMetrics` propagate exactly as on the human path today —
  no new swallow, no new catch.
- **No `console.*` in `src/`.** stdout is written through the injected `deps.stdout`
  seam (the `deps.stdout` pattern from `src/commands/replay.ts`), keeping the emit
  testable and out of the structured logger. `emitCostReportJson`'s dependencies —
  `loadRuns`, `toCostReport`, `now`, `stdout` — are injected via a deps parameter with
  real defaults, mirroring `ReplayCommandDeps`.

## Stories

Two stories, linear dependency (US-002 depends on US-001).

### US-001 — Cost report schema and pure mapper

Introduce the public `CostReportV1` contract and the pure `toCostReport` mapper in a
new `src/metrics/report.ts`, exported from the `src/metrics` barrel. Pure, no I/O, no
logger; composes the existing `calculateAggregateMetrics` and `getLastRun` helpers.

- **Depends on:** none.
- **Context Files (reads):** `src/metrics/types.ts`, `src/metrics/aggregator.ts`,
  `src/commands/replay.ts` (mapper/deps precedent).
- **Creates:** `src/metrics/report.ts`, `test/unit/metrics/report.test.ts`.
- **Also modifies:** `src/metrics/index.ts` (barrel export of `CostReportV1` +
  `toCostReport`).

### US-002 — CLI JSON emit and `--json` wiring

Add `emitCostReportJson(workdir, deps?)` to `src/cli/status-cost.ts` (re-exported from
`src/cli/status.ts`) that loads run metrics, resolves the project key, maps via the
injected `toCostReport`, and writes pretty JSON through the injected `stdout`. Wire the
`--json` option and its route into the `bin/nax.ts` `status` command.

- **Depends on:** US-001 (`toCostReport` / `CostReportV1` from `@/metrics`).
- **Context Files (reads):** `src/cli/status-cost.ts`, `src/cli/status.ts`,
  `src/commands/replay.ts` (deps pattern), `src/metrics/report.ts` — created by US-001,
  consumed here.
- **Creates:** (none — extends existing files and the existing `status-cost` unit test).

### Seams

- **`toCostReport` (US-001 → US-002).** US-001 exports `toCostReport` from the
  `@/metrics` barrel; US-002's `emitCostReportJson` calls it. US-002 declares a seam AC
  that injects a spy `toCostReport` via `emitCostReportJson`'s deps, triggers the emit
  path, and asserts the spy was invoked with the loaded runs array — proving the call
  site exists and is wired, not merely that the name appears.

## Acceptance Criteria

### US-001 — Cost report schema and pure mapper

1. `[unit]` `toCostReport` is importable from `@/metrics` and is usable as a function
   (calling it with `([], deps)` returns an object, does not throw).
2. `[unit]` `toCostReport([], deps)` returns an object whose `schemaVersion` equals the
   string `"1.0"`.
3. `[unit]` Given `deps.now` returning `"2026-01-01T00:00:00.000Z"`,
   `toCostReport([], deps).generatedAt` equals `"2026-01-01T00:00:00.000Z"` (clock is
   injected, not read from the real system clock).
4. `[unit]` Given `deps.project` equal to `"myproj"`, `toCostReport(runs, deps).project`
   equals `"myproj"`.
5. `[unit]` `toCostReport([], deps)` returns `aggregate === null`, `lastRun === null`,
   and `modelEfficiency` deep-equals `[]` (empty-metrics report).
6. `[unit]` For a `runs` array of length ≥1, `toCostReport(runs, deps).aggregate` has
   `totalRuns`, `totalCost`, and `avgCostPerStory` equal to the corresponding fields of
   `calculateAggregateMetrics(runs)`.
7. `[unit]` For a non-empty `runs` array, `toCostReport(runs, deps).lastRun.runId` and
   `.feature` equal those of the run returned by `getLastRun(runs)`.
8. `[unit]` In a last run with two stories of costs `0.2` and `0.9`,
   `toCostReport(runs, deps).lastRun.stories` is ordered `[0.9, 0.2]` by `cost`
   (descending), and each entry exposes exactly `storyId`, `cost`, `model`, `attempts`
   (with `model` taken from `StoryMetrics.modelUsed`).
9. `[unit]` When the aggregate has two models with `totalCost` `1.0` and `3.0`,
   `toCostReport(runs, deps).modelEfficiency` is ordered `[3.0, 1.0]` by `totalCost`
   (descending), and each entry exposes exactly `model`, `attempts`, `passRate`,
   `avgCost`, `totalCost`.
10. `[unit]` For a last run whose `totalStories` is `0`,
    `toCostReport(runs, deps).lastRun.avgCostPerStory` equals `0` (not `NaN`).
11. `[unit]` For a populated `runs` array, the returned `aggregate`, `lastRun`, and each
    `lastRun.stories` entry contain none of the keys `totalTokens`, `context`,
    `pollution`, `complexityAccuracy`, or `fallback` (internal fields do not leak).

### US-002 — CLI JSON emit and `--json` wiring

1. `[unit]` `emitCostReportJson` is importable from `@/cli/status` and is usable as a
   function.
2. `[integration]` Given injected deps where `loadRuns` resolves to a non-empty runs
   array and `stdout` is a spy, `emitCostReportJson(workdir, deps)` calls `stdout`
   exactly once with a string that `JSON.parse`s to an object whose `schemaVersion`
   equals `"1.0"`.
3. `[integration]` (seam) Given injected deps whose `toCostReport` is a spy returning a
   fixed report, `emitCostReportJson(workdir, deps)` invokes that spy exactly once with
   the runs array returned by the injected `loadRuns`.
4. `[integration]` Given injected deps where `loadRuns` resolves to `[]`,
   `emitCostReportJson(workdir, deps)` resolves without throwing and its single `stdout`
   string `JSON.parse`s to an object with `aggregate === null` and `modelEfficiency`
   deep-equal to `[]`.
5. `[integration]` The string passed to `stdout` by `emitCostReportJson` round-trips:
   `JSON.parse` of it deep-equals the report object returned by the injected
   `toCostReport`, and the string contains a newline (pretty-printed, not minified).

**Verification note (US-002 wiring):** the `bin/nax.ts` `--json` option registration and
the `if (options.cost && options.json) { await emitCostReportJson(workdir); return; }`
route are thin CLI wiring over the behaviour covered by ACs above; they are verified by
the build/typecheck gate (`bun run build` / `bun run typecheck`) and manual
`nax status --cost --json`, not by a runtime AC (commander action handlers are not unit
-tested in this repo).
