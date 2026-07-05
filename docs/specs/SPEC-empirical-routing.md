# SPEC: Empirical Routing — History-Driven Complexity→Tier Calibration

## Summary

A calibration pass that turns nax's accumulated run history into a concrete routing-config
proposal. It reads the per-story metrics nax already persists (`metrics.json`, a
`RunMetrics[]`), computes per-complexity-band accuracy (escalation rate, first-pass rate,
tier-mismatch rate), and proposes adjustments to `autoMode.complexityRouting` — the
complexity→model-tier mapping — plus advisory keyword-misfire hints. It ships as three units:
a pure core calibration module, an on-demand CLI (`nax routing calibrate`), and an
off-by-default post-run plugin (`nax-auto-route`). The tool is **advisory by default**: the
CLI writes config only with `--apply`; the plugin never writes config, only emits a proposal
artifact.

## Motivation

nax classifies each story into a complexity band and maps that band to a model tier via a
static keyword classifier plus the `autoMode.complexityRouting` config. A static classifier
cannot self-correct: if `simple` stories in a given repo routinely escalate to a higher tier,
the mapping stays wrong until a human notices. Meanwhile every run already records the ground
truth — did the story escalate, pass first-time, and which tier actually succeeded — in
`StoryMetrics`, and `calculateAggregateMetrics` already derives a per-band `complexityAccuracy`
signal. Nothing consumes that signal to close the loop.

This feature closes it: compare prediction (band→tier) against outcome across history and
propose grounded mapping changes — both **upgrades** (a band that under-classifies and keeps
escalating) and **downgrades** (a band that over-classifies and never needs its tier, wasting
cost). It is the cheaper, grounded complement to the deferred LLM run-time routing (#1289),
not a replacement, and it pairs with the shipped `--max-cost` cap by helping the routing
config reflect reality.

## Design

### Integration (extending existing code)

Verified integration points (signatures confirmed against the current tree):

- **`loadRunMetrics(outputDir: string): Promise<RunMetrics[]>`** — `src/metrics/tracker.ts:324`
  (re-exported from `src/metrics/index.ts`). Reads `<outputDir>/metrics.json` and returns the
  persisted `RunMetrics[]` (empty array when absent/invalid). This is the history source.
- **`RunMetrics` / `StoryMetrics`** — `src/metrics/types.ts`. Per-story fields consumed:
  `complexity: string` (the predicted band), `finalTier: string` (the tier that succeeded),
  `attempts: number`, `firstPassSuccess: boolean`. `StoryMetrics` has **no** per-story
  `escalations` field — escalation is derived from `attempts > 1` (the `attempts` doc comment
  reads "Number of attempts (includes escalations)"). `RunMetrics.stories` is the
  `StoryMetrics[]` to flatten across runs.
- **`Complexity`** — `src/config/schema-types.ts:8`: `"simple" | "medium" | "complex" | "expert"`.
- **`ModelTier`** — `src/config/schema-types.ts:13`: `"fast" | "balanced" | "powerful"`
  (widened with `(string & {})`; the three named rungs are the calibratable set).
- **`complexityToModelTier(complexity, config): ModelTier`** — `src/routing/router.ts:98`
  (barrel `@/routing`). Reads `config.autoMode.complexityRouting`. Used to compute the
  predicted tier for mismatch and to know a band's current tier.
- **`autoMode.complexityRouting`** — `src/config/schemas.ts:76`, a
  `Record<Complexity, ModelTier>`; default `{ simple: "fast", medium: "balanced",
  complex: "powerful", expert: "powerful" }`. This is the applyable knob.
- **`IPostRunAction` / `PostRunContext` / `PostRunActionResult` / `NaxPlugin`** —
  `src/plugins/extensions.ts` (barrel `src/plugins/types.ts`). `IPostRunAction` =
  `{ name; description; shouldRun(ctx): Promise<boolean>; execute(ctx): Promise<PostRunActionResult> }`.
  `PostRunContext` fields consumed: `workdir`, `config` (typed `unknown`, read loosely),
  `logger` (`PluginLogger`, write-only). `PostRunActionResult` =
  `{ success; message; url?; skipped?; reason? }`.
- **Precedent to mirror:** `src/plugins/builtin/curator/index.ts` — the built-in
  `IPostRunAction` (`PLUGIN_NAME = "nax-curator"`), reads its config loosely off
  `ctx.config.curator`, returns a result (never throws) on error, and writes artifacts under
  resolved output paths. `src/plugins/builtin/auto-pr/` is the second precedent and the closer
  structural twin (config → pure modules → `_deps` DI → `index.ts` + loader registration).
- **Registration:** `src/plugins/loader.ts` registers built-ins (`curatorPlugin`,
  `autoPrPlugin`) and skips disabled ones; `autoRoutePlugin` is registered the same way and
  surfaced via `pluginRegistry.getPostRunActions()`.
- **Config writer precedent:** `src/cli/setup-write.ts` — `_writeSetupDeps.writeFile` wraps
  `Bun.write` to persist `.nax/config.json`. The `--apply` path uses the same injected-writer
  shape.
- **CLI registration:** `bin/nax.ts` registers command groups (e.g. the `config` group at
  `:1164`); `routing calibrate` is added as a peer command group.

### Approach

Deterministic and dependency-injected — no LLM calls. The core is pure (no I/O): it takes
`RunMetrics[]`, the current mapping, and thresholds, and returns a plain data proposal, so it
unit-tests without touching disk. The CLI and plugin are thin I/O shells that inject their
external calls (`loadRunMetrics`, config write, artifact write) through a `_deps` object per
`forbidden-patterns.md`, so their tests never read real metrics or write real config.

Module layout under `src/routing/calibrate/`:

| File | Concern | I/O |
|:-----|:--------|:----|
| `types.ts` | `BandStat`, `TierAdjustment`, `KeywordHint`, `SkippedBand`, `CalibrationProposal`, `CalibrationThresholds` | none |
| `band-stats.ts` | `computeBandStats(runs, mapping)` | none (pure) |
| `propose.ts` | `proposeAdjustments(bandStats, mapping, thresholds)` | none (pure) |
| `index.ts` | barrel re-exporting the above | none |

The CLI (`src/cli/routing-calibrate.ts`) and plugin (`src/plugins/builtin/auto-route/`) both
consume the `src/routing/calibrate` barrel.

`CalibrationThresholds` is the core's own input type (min samples + the four rule numbers), so
the pure core has no dependency on the config schema. The CLI and plugin map the `autoRoute`
config slice onto `CalibrationThresholds`.

### CLI Behavior (`nax routing calibrate`)

- **Args/flags:** `--apply` (write the proposal into project `.nax/config.json`), `--json`
  (emit machine-readable proposal), `--min-samples <n>` (override the per-band sample floor for
  this invocation).
- **stdout:** the human report (accuracy table + proposed adjustments + keyword hints), or the
  JSON proposal when `--json` is set.
- **stderr:** warnings only (e.g. skipped-band notices, "insufficient history").
- **Exit codes:** `0` on success, on a clean no-op (no proposals, or `--apply` with nothing to
  write), and on insufficient history. Non-zero only on an unexpected failure (e.g. a config
  write that rejects under `--apply`).
- **Read-only default:** without `--apply`, the command never writes config.

Example (`--json`):

```json
{
  "generatedAt": "2026-07-05T00:00:00.000Z",
  "adjustments": [
    { "band": "simple", "from": "fast", "to": "balanced", "direction": "upgrade",
      "complexity": "simple", "fromTier": "fast", "toTier": "balanced",
      "rationale": "escalationRate=0.4 >= 0.3 and mismatchRate=0.3 >= 0.25" }
  ],
  "keywordHints": [
    { "message": "classify.ts: high mismatch for band \"simple\" (mismatchRate=0.3) — review keyword classification." }
  ],
  "skipped": [
    { "complexity": "expert", "reason": "insufficient-samples", "sampleCount": 3, "minSamples": 8 }
  ]
}
```

### File Format (`routing-proposal.json`)

The post-run plugin writes one artifact per run, via the same
`buildProposalArtifact()` transform (`src/routing/calibrate/propose.ts`) the CLI's
`--json` output uses — one on-disk contract for both writers:

```json
{
  "generatedAt": "2026-07-05T00:00:00.000Z",
  "adjustments": [
    { "band": "complex", "from": "powerful", "to": "balanced", "direction": "downgrade",
      "complexity": "complex", "fromTier": "powerful", "toTier": "balanced",
      "rationale": "firstPassRate=0.95 >= 0.9 and escalationRate=0.02 <= 0.05" }
  ],
  "keywordHints": [],
  "skipped": []
}
```

- `generatedAt` — ISO timestamp stamped at the I/O boundary (the pure core is wall-clock free).
- `adjustments[]` — `{ band, from, to, direction: "upgrade" | "downgrade", complexity, fromTier,
  toTier, rationale }` (`band`/`from`/`to` are the canonical fields; `complexity`/`fromTier`/`toTier`
  duplicate them for consumers that prefer the longer keys).
- `keywordHints[]` — `{ message, keyword?, targetComplexity?, occurrences? }` (text-first advisory;
  carries no `from`/`to` — never applyable).
- `skipped[]` — `{ complexity, reason: "insufficient-samples" | "missing-mapping" | "no-history",
  sampleCount?, minSamples? }` for bands below the sample floor.

An empty proposal serializes `adjustments`, `keywordHints`, and `skipped` all empty.

### Failure Handling

- **Plugin fail-open** — a failed calibration never fails the run: `execute` catches, logs via
  `ctx.logger` (write-only `PluginLogger`; no `console.*`, no emojis), and returns
  `{ success: true }`. The post-run action already runs after the run has succeeded.
- **Insufficient / empty history** — not an error: the CLI reports it and exits `0`; the plugin
  writes an empty-proposal artifact (or skips via `shouldRun`).
- **Corrupt `metrics.json`** — `loadRunMetrics` already returns `[]` for absent/invalid files;
  the tool treats that as empty history.
- **`--apply` with zero adjustments** — no-op: the config writer is not invoked.
- **Bounds** — the core never proposes a tier below `fast` or above `powerful`, and never moves
  more than one rung per calibration.

## Stories

Single-package repo (no workspaces) → no `Workdir`. 5 stories. The core is split into two
pure stories (stats vs proposal) so each stays under the AC-count cap; both are independently
unit-testable with synthetic `RunMetrics[]`.

- **US-001 — `autoRoute` config foundation.** Add the top-level `autoRoute` config with
  defaults (`enabled`, `minSamples`, `upgrade`, `downgrade`). *Depends on:* nothing.
  *Creates:* none (modifies `src/config/schemas.ts`).
- **US-002 — Band-stat computation.** Pure `computeBandStats(runs, mapping)` + the shared
  proposal/stat types. *Depends on:* nothing. *Creates:*
  `src/routing/calibrate/{types,band-stats}.ts`.
- **US-003 — Adjustment proposal.** Pure `proposeAdjustments(bandStats, mapping, thresholds)`
  (upgrade/downgrade rules, clamps, hysteresis, keyword hints, skipped bands) + the module
  barrel. *Depends on:* US-002 (`BandStat` + types). *Creates:*
  `src/routing/calibrate/{propose,index}.ts`.
- **US-004 — CLI `nax routing calibrate`.** Command wiring `loadRunMetrics` → core → report,
  with `--apply` / `--json` / `--min-samples` and the injected config writer. *Depends on:*
  US-001 (reads `autoRoute` thresholds), US-003 (core barrel). *Creates:*
  `src/cli/routing-calibrate.ts`.
- **US-005 — `auto-route` post-run plugin + registration.** `autoRoutePlugin` (`shouldRun` /
  `execute`) writing the proposal artifact, registered in `loader.ts`. *Depends on:* US-001
  (enabled gate + thresholds), US-003 (core barrel). *Creates:*
  `src/plugins/builtin/auto-route/{types,index}.ts`.

### Seams

- **US-002 → US-003:** `computeBandStats` produces the `BandStat[]` that `proposeAdjustments`
  consumes. US-003's ACs run `proposeAdjustments` over `BandStat` inputs shaped by US-002.
- **US-002 + US-003 → US-004:** the core (`computeBandStats` then `proposeAdjustments`, via the
  `src/routing/calibrate` barrel) is composed inside the CLI action. US-004 AC-1 injects
  `_deps.loadRunMetrics` returning a fixture `RunMetrics[]` that breaches the upgrade rule and
  asserts the CLI's proposal contains the resulting adjustment — proving both core functions
  run in the production path.
- **US-002 + US-003 → US-005:** the same composed core is consumed by `execute`. US-005 AC-4
  injects `_deps.loadRunMetrics` with the same fixture and asserts the written artifact's parsed
  JSON contains the computed adjustment.
- **US-004 `--apply` → config writer:** US-004 AC-4 stubs the injected `_deps.writeConfig` and
  asserts `--apply` invokes it with a merged `autoMode.complexityRouting`; AC-3 asserts the
  default path never invokes it.
- **US-005 → loader:** `autoRoutePlugin` becomes discoverable via
  `pluginRegistry.getPostRunActions()` after `loadPlugins`. US-005 AC-7 asserts this.

## Acceptance Criteria

### US-001 — `autoRoute` config foundation

1. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoRoute.enabled === false` (opt-in default).
2. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoRoute.minSamples === 8`.
3. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoRoute.upgrade.escalationRate === 0.3` and `config.autoRoute.upgrade.mismatchRate === 0.25`.
4. `[unit]` `NaxConfigSchema.parse({})` yields `config.autoRoute.downgrade.firstPassRate === 0.9` and `config.autoRoute.downgrade.escalationRate === 0.05`.
5. `[unit]` `NaxConfigSchema.parse({ autoRoute: { minSamples: 20 } })` yields `autoRoute.minSamples === 20` and `autoRoute.enabled === false` (a partial override preserves the other defaults).
6. `[unit]` `NaxConfigSchema.safeParse({ autoRoute: { enabled: "yes" } }).success === false` (a non-boolean `enabled` is rejected at parse time).

### US-002 — Band-stat computation

1. `[unit]` `computeBandStats` over a `RunMetrics[]` containing 10 stories of `complexity` `"simple"`, 4 of which have `attempts > 1`, returns a `BandStat` for `"simple"` with `sampleCount === 10` and `escalationRate === 0.4`.
2. `[unit]` `computeBandStats` computes `firstPassRate` as the fraction of a band's stories with `firstPassSuccess === true` (9 of 10 → `0.9`).
3. `[unit]` `computeBandStats`, given a mapping of `simple → "fast"`, computes `mismatchRate` for the `"simple"` band as the fraction of its stories whose `finalTier` is not `"fast"` (3 of 10 finished on `"balanced"` → `0.3`).
4. `[unit]` `computeBandStats` returns exactly one `BandStat` per distinct `complexity` value present in the history and none for complexities absent from it.

### US-003 — Adjustment proposal

1. `[unit]` `proposeAdjustments` proposes an `upgrade` for a `BandStat` whose `escalationRate` is `0.4` and `mismatchRate` is `0.3` against a `simple → "fast"` mapping, returning a `TierAdjustment` with `band === "simple"`, `from === "fast"`, `to === "balanced"`, `direction === "upgrade"`.
2. `[unit]` `proposeAdjustments` proposes a `downgrade` for a `complex → "powerful"` `BandStat` whose `firstPassRate` is `0.95`, `escalationRate` is `0.02`, and whose observed `finalTier`s are all at or below `"balanced"`, returning `to === "balanced"` and `direction === "downgrade"`.
3. `[unit]` `proposeAdjustments` returns no adjustment for a `BandStat` whose `sampleCount` is below `thresholds.minSamples` and lists it under `skipped` with its `sampleCount` and the `minSamples` used.
4. `[unit]` `proposeAdjustments` returns no `downgrade` for a band already mapped to `"fast"` even when it meets the downgrade criteria (never below the lowest rung).
5. `[unit]` `proposeAdjustments` returns no `upgrade` for a band already mapped to `"powerful"` even when it meets the upgrade criteria (never above the highest rung).
6. `[unit]` `proposeAdjustments` moves at most one rung: a `simple → "fast"` `BandStat` with `escalationRate` `0.9` and `mismatchRate` `0.9` proposes `to === "balanced"`, not `"powerful"`.
7. `[unit]` `proposeAdjustments` returns no adjustment for a `BandStat` whose `escalationRate` falls between the downgrade and upgrade thresholds (e.g. `0.15`) and whose `firstPassRate` is `0.7` — neither rule fires (hysteresis, no flip-flop).
8. `[unit]` `proposeAdjustments` emits a `KeywordHint` for a large-sample, high-mismatch `BandStat` whose `message` references `classify.ts`, and the emitted hint object exposes no `from` or `to` tier field (advisory, not applyable).

### US-004 — CLI `nax routing calibrate`

1. `[integration]` Running the calibrate action with `_deps.loadRunMetrics` returning a fixture `RunMetrics[]` that yields a threshold-breaching `"simple"` band produces a proposal whose `adjustments` include one with `band === "simple"`, `from === "fast"`, `to === "balanced"` (the core runs in the CLI path).
2. `[integration]` The calibrate action in `--json` mode emits a JSON object exposing `adjustments`, `keywordHints`, and `skipped` arrays.
3. `[integration]` Without `--apply`, the action does not invoke `_deps.writeConfig` (read-only default).
4. `[integration]` With `--apply` and at least one adjustment, the action invokes `_deps.writeConfig` once with a config whose `autoMode.complexityRouting` equals the prior mapping with only the proposed bands' tiers replaced (other bands preserved).
5. `[integration]` With `--apply` and zero adjustments, the action does not invoke `_deps.writeConfig`.
6. `[integration]` Passing `--min-samples 20` causes a band with `sampleCount` `10` to be reported under `skipped` (the CLI override reaches the core threshold).
7. `[integration]` When `_deps.loadRunMetrics` returns an empty array, the action reports insufficient history, does not invoke `_deps.writeConfig`, and completes without throwing.

### US-005 — `auto-route` post-run plugin + registration

1. `[unit]` `autoRoutePlugin.shouldRun` returns `false` when `ctx.config.autoRoute.enabled` is `false`.
2. `[unit]` `shouldRun` returns `false` when the injected `_deps.loadRunMetrics` yields history in which no band reaches `minSamples` (nothing to propose).
3. `[unit]` `shouldRun` returns `true` when the plugin is enabled and the injected history yields at least one adjustment.
4. `[integration]` `execute` on the happy path invokes `_deps.writeFile` exactly once with a path ending in `routing-proposal.json` whose parsed JSON `adjustments` contain the adjustment the core computes for the injected fixture history.
5. `[integration]` `execute` writes only the proposal artifact: the single `_deps.writeFile` call targets the `routing-proposal.json` path and no `autoMode.complexityRouting` write occurs (advisory — config is never mutated).
6. `[integration]` `execute` returns `{ success: true }` and does not throw when `_deps.writeFile` rejects, logging the failure via `ctx.logger`.
7. `[integration]` The `PluginRegistry` returned by `loadPlugins` (with `"nax-auto-route"` not in the disabled set) yields an action named `"nax-auto-route"` from `getPostRunActions()`.

<!-- spec-writing: completed-through-phase-6 -->
