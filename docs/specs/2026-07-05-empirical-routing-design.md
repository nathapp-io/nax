# Empirical Routing — Design

**Date:** 2026-07-05
**Branch:** `feat/empirical-routing`
**Source:** `nax-feature-suggestions-2026-07-04.md` §2.3 (Empirical routing — learn from historical StoryMetrics), Tier 3.

---

## 1. Purpose & Boundary

Calibrate nax's complexity→tier routing against **real run history**. The tool reads the
per-story metrics nax already persists (`features/*/runs/*.jsonl`), detects
complexity bands that are routed to the wrong model tier, and **proposes** concrete
changes to `autoMode.complexityRouting` — plus advisory keyword-misfire hints.

The premise is that nax's classifier makes a prediction (a complexity band → a model
tier) and every run produces the ground truth (did it escalate? pass first time? what
tier actually succeeded?). Comparing the two across accumulated history reveals
systematic mis-routing that a static keyword classifier cannot self-correct.

**Advisory by default.** Nothing mutates routing config unless a human explicitly asks:

- CLI `nax routing calibrate` — read-only by default; writes config **only** with `--apply`.
- `auto-route` post-run plugin — off by default; when enabled it writes a *proposal
  artifact* (`.nax/routing-proposal.json`) and logs a summary, but **never** edits config.

This mirrors the two prior arcs: `nax replay` (pure reader) and the mutation
spot-check gate (advisory, never blocks). It is consistent with the project rule that
run-affecting changes require explicit approval.

### Explicit non-goals

- **Not** the deferred LLM run-time agent routing (#1289). This is a static, grounded
  calibration pass — cheaper and complementary, not a replacement.
- **Not** an editor of keyword code. Keyword lists live in `src/routing/classify.ts`
  as code constants; the tool only *points at* them via advisory text, never edits them
  and never treats them as an applyable diff.
- **No** auto-commit of config on unattended runs. The plugin proposes; it never applies.

---

## 2. Architecture

Three units, mirroring the structure of the `auto-pr` plugin arc that shipped cleanly
(config → pure core → surface → plugin + registration):

### 2.1 Core calibration module — `src/routing/calibrate/`

Pure, no I/O, fully unit-testable on synthetic `RunMetrics[]`.

- `computeBandStats(runs: RunMetrics[]): BandStat[]`
  For each complexity band present in history, derive:
  - `sampleCount` — number of stories classified at this band
  - `escalationRate` — fraction of stories that escalated (`attempts > 1` or a non-empty
    `escalations` record)
  - `firstPassRate` — fraction with `firstPassSuccess === true`
  - `mismatchRate` — fraction where the tier that actually succeeded (`finalTier`)
    differs from the tier the band's current mapping predicts
  - `tierDistribution` — count of `finalTier` values observed for the band
  - `avgCost` — mean `StoryMetrics.cost` for the band

  Per-band escalation is computed **directly from `StoryMetrics`**, not from
  `AggregateMetrics.escalationRate` (which is global). `AggregateMetrics.complexityAccuracy`
  supplies an equivalent per-band mismatch signal, but the core recomputes it against the
  *current* mapping so proposals reflect live config, not whatever was configured when a
  historical run executed.

- `proposeAdjustments(bandStats, currentMapping, thresholds): CalibrationProposal`
  Applies the upgrade/downgrade rules (§4) with guardrails and returns:
  - `adjustments: TierAdjustment[]` — `{ band, from, to, direction, reason, evidence }`
  - `keywordHints: KeywordHint[]` — text-only diagnostics (never applyable)
  - `skipped: SkippedBand[]` — bands below `minSamples`, with the sample count

### 2.2 CLI command — `nax routing calibrate`

`src/cli/routing-calibrate.ts`, wired into `bin/nax.ts` following the existing
subcommand pattern (peer to the `config` command group).

- Loads run history via `loadRunMetrics(outputDir)` across **all features** in the repo,
  runs the core, and renders: an accuracy table (band → samples, escalation, first-pass,
  mismatch), the proposed `complexityRouting` adjustments, and keyword hints.
- `--apply` — merges the proposed `complexityRouting` into the **project**
  `.nax/config.json` (repo-scoped calibration), preserving all other config, and prints a
  before/after diff. Uses the existing config-write precedent (`src/cli/setup-write.ts`).
- `--json` — machine-readable proposal for scripting.
- `--min-samples N` — override the default per-band sample floor for this invocation.
- Read-only by default; no flag → no write.

### 2.3 Post-run plugin — `src/plugins/builtin/auto-route/`

An `IPostRunAction`, off by default, following the `curator`/`auto-pr` built-in pattern
with `_deps` dependency injection so tests never touch the filesystem.

- `shouldRun` gate: `enabled === true` && enough history to produce at least one non-skipped
  band.
- `execute`: runs the core, writes `.nax/routing-proposal.json` (the proposal artifact) into
  `ctx.workdir`, logs a one-line summary via `ctx.logger`. **Never** writes config.
- **Fail-open**: any error is caught and logged via `ctx.logger.warn`; returns
  `success: true`; the run is never failed or blocked by this plugin.
- Registered in the plugin loader alongside `curator` and `auto-pr` built-ins.

---

## 3. Data Flow

```
features/*/runs/*.jsonl
      │  loadRunMetrics(outputDir)
      ▼
RunMetrics[]
      │  computeBandStats
      ▼
BandStat[]
      │  proposeAdjustments(bandStats, currentMapping, thresholds)
      ▼
CalibrationProposal
      ├─ CLI: render table + proposal;  --apply → merge into .nax/config.json + diff
      └─ plugin: write .nax/routing-proposal.json + log summary  (never writes config)
```

---

## 4. Calibration Rules

Defaults, all overridable under the new `autoRoute` config block (§5):

- **min samples / band = 8.** Below this, the band is skipped (reported as "insufficient
  data"), never proposed on.
- **UPGRADE** the band's tier by one rung when
  `escalationRate ≥ 0.30` **AND** `mismatchRate ≥ 0.25`
  (the band under-classifies — it routinely needs a higher tier than predicted).
- **DOWNGRADE** the band's tier by one rung when
  `firstPassRate ≥ 0.90` **AND** `escalationRate ≤ 0.05`
  **AND** the actual tier used stayed at or below the next-lower rung
  (the band over-classifies — it is paying for a tier it never needs).
- **Hysteresis / margin.** A band is only proposed on when it sits clear of the opposite
  rule's thresholds by a margin, so a band hovering near a boundary does not flip-flop
  between calibrations.
- **One rung per calibration.** Never jump two tiers in a single pass; never propose below
  `fast` or above `powerful`.
- **Keyword hint (text only, never applyable).** When a band shows high mismatch but a tier
  remap would not help (e.g. a large-sample `simple` band with high escalation, suggesting
  the band itself is mis-assigned upstream), emit a diagnostic:
  "`SIMPLE_KEYWORDS` may over-trigger; review `src/routing/classify.ts`." This is the
  "bump keyword thresholds" signal from the source doc — surfaced as guidance, since keyword
  lists are code, not config.

Tier rungs, low → high: `fast` < `balanced` < `powerful`.

---

## 5. Config Surface

New top-level `autoRoute` block, sibling to `curator` and `autoPr` (not a per-package
override — routing calibration is repo-level):

```jsonc
autoRoute: {
  enabled: false,          // plugin only; the CLI is always available regardless
  minSamples: 8,
  upgrade:   { escalationRate: 0.30, mismatchRate: 0.25 },
  downgrade: { firstPassRate: 0.90, escalationRate: 0.05 }
}
```

All fields optional with the defaults above. `enabled` governs only the post-run plugin;
`nax routing calibrate` works whether or not the plugin is enabled.

---

## 6. Error Handling

- **No / short history** — friendly message ("not enough runs to calibrate; need ≥ N stories
  per band"); exit 0. Not an error condition.
- **Corrupt JSONL** — `loadRunMetrics` is already tolerant of malformed records; the tool
  notes how many records were skipped and proceeds with the rest.
- **`--apply` with zero proposals** — no-op with an explanatory message; config untouched.
- **Plugin errors** — caught, logged via `ctx.logger.warn`, `success: true`; the run is
  never affected.

---

## 7. Testing

- **Core** (pure, no I/O): synthetic `RunMetrics[]` fixtures assert band stats and each rule
  independently — upgrade fires, downgrade fires, min-sample block, hysteresis prevents
  flip-flop, clamp at `fast`/`powerful`, keyword-hint emission.
- **CLI**: a temp `outputDir` seeded with fixture runs asserts the rendered table and
  proposal; `--apply` writes a correctly merged `.nax/config.json` and prints the diff;
  `--json` shape is stable.
- **Plugin**: injected `_deps` assert the proposal artifact is written, config is left
  untouched, and a thrown dependency is handled fail-open (`success: true`).

---

## 8. Stories

Four stories, mirroring the `auto-pr` shape (config → pure core → surface → plugin +
registration):

- **US-001** — `autoRoute` config schema + defaults. Small.
- **US-002** — core calibration module (`computeBandStats` + `proposeAdjustments` + keyword
  hints). Pure; the largest AC cluster.
- **US-003** — CLI `nax routing calibrate` (+ `--apply` / `--json` / `--min-samples` +
  config writer).
- **US-004** — `auto-route` post-run plugin + loader registration.

Dependency chain: US-002 depends on US-001 (shared types); US-003 and US-004 both consume
US-002's exports. No removal keywords → no terminal-cleanup story.
