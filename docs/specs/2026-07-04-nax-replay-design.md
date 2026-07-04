# `nax replay` — Post-mortem Run Timeline Viewer — Design

**Date:** 2026-07-04
**Feature:** `nax-replay`
**Repo:** `repos/nax` (branch `feat/nax-replay`)
**Origin:** `projects/nax/nax-feature-suggestions-2026-07-04.md` §2.2 (Tier-2 #3), next arc after agent-bakeoff-mode (PR #1302) shipped. Build order: flaky-quarantine ✅ → pytest/go parsers ✅ → bake-off ✅ → **replay**.

---

## 1. Purpose

A **read-only** command that reconstructs a completed (or crashed) run from already-persisted artifacts and prints a **failure-focused timeline report**. Today, debugging a failed run means hand-reading raw JSONL; `replay` makes the adversarial-review whack-a-mole problem (#1157) and escalation tuning actually diagnosable.

**Explicit non-goals (deferred to follow-up arcs):**

- **Diffs / checkpoints** — no per-story/per-phase patch is persisted anywhere (see §5); "diff at each step" is not buildable without new persistence and is out of scope.
- **Clean-event persistence** — Arc 1 is a pure reader; it does **not** add any subscriber to the live run path. Phases/escalations/fix-cycles are *inferred* from the existing log. If inference proves too lossy in practice, a clean-event persistence subscriber is a fast-follow arc.
- **Interactive Ink TUI** — a navigable viewer is a later arc that will reuse this arc's reconstruction core unchanged.

**Design ethos:** smallest possible blast radius — same as flaky-test-quarantine and bake-off. No new config concepts, no writes to the hot run path.

---

## 2. Command Surface

Top-level, symmetric with `nax logs` (which the doc names it after):

```
nax replay [run-id]
  [run-id]      optional positional; prefix-matched via resolveRunFileFromRegistry;
                omitted => latest run (lexicographic max of registry runIds)
  --all         expand passed stories too (default: passed collapsed to one line)
  --story <id>  focus a single story (implies expand)
  --json        emit the reconstructed RunTimeline model instead of the report
```

- Honors the existing `NO_COLOR` / color convention.
- Registered in `bin/nax.ts` alongside `logs` (`bin/nax.ts:1301`) as `program.command("replay [run-id]")`, mirroring `logs` ergonomics (`-r/--run` resolution, `--json`).

---

## 3. Architecture — new `src/replay/`

All modules are pure/testable with dependency-injection seams; only `src/commands/replay.ts` and `bin/nax.ts` touch I/O and process wiring.

| Module | Responsibility |
|---|---|
| `types.ts` | `RunTimeline` / `StoryTimeline` / `PhaseStep` model (the reconstruction output; also the `--json` shape). |
| `phase-infer.ts` | **pure** — infer the phase/gate/escalation/fix-cycle sequence from `{stage, message, data}` log records. No I/O. |
| `reconstruct.ts` | **pure** — merge JSONL spine + inferred phases + metrics entry + review findings + end-state into a `RunTimeline`. Gracefully degrades when metrics absent. |
| `discovery.ts` | run-id → concrete artifact paths. Wraps `resolveRunFileFromRegistry` (prefix match, `getRunsDir()` DI); "latest" default; unknown-id → helpful error listing recent runs. |
| `report.ts` | **pure** — `RunTimeline` → terminal string; failure-focused default; reuses `runs.ts` table helpers + `formatLogEntry`. |
| `json.ts` | serialize `RunTimeline` for `--json`. |
| `src/commands/replay.ts` | thin orchestrator: discovery → read files → reconstruct → report/json → exit code. |

### 3.1 Grounded seams (all verified to exist)

- **Discovery:** `resolveRunFileFromRegistry(runId)` — `src/commands/logs-reader.ts` (prefix match: `meta.runId.startsWith(runId)`); `getRunsDir()` — `src/utils/paths.ts:31` (SSOT, `NAX_RUNS_DIR` override; direct `homedir()` joins are forbidden).
- **Registry `meta.json`** — `src/pipeline/subscribers/registry.ts:21` `{ runId, project, feature, workdir, statusPath, eventsDir, registeredAt }`. `statusPath` → feature `status.json`; `eventsDir` → the per-feature `runs/` JSONL directory.
- **Log spine schema** — `LogEntry` `{ timestamp, level, stage, message, storyId?, sessionRole?, data? }` (`src/logger/types.ts`, emitted `src/logger/logger.ts:100`). Milestone messages already consumed by tooling: `run.start` (data `runId`, nax version), `run.complete` (data `totalCost, storiesCompleted/Failed, totalStories, totalDurationMs`); per-story `stage === "execution" && data.storyId` (`src/cli/runs.ts:104`).
- **Metrics enrichment** — `loadRunMetrics(outputDir)` / `RunMetrics` (`src/metrics/tracker.ts:324`, `src/metrics/types.ts:235`). `StoryMetrics` (`types.ts:98`): `complexity, modelTier, finalTier, attempts, success, cost, durationMs, firstPassSuccess, tokens, fallback{hops}, reviewMetrics{adversarial{findingsBySeverity,findingsByCategory}}`. `metrics.json` is a **project-global array** keyed by `runId` inside entries — replay filters by `runId`, tolerates absence.
- **Review detail** — `.nax/review-audit/<feature>/<epochMs>-<sessionName>.json` (`src/review/review-audit.ts`, full per-reviewer findings) + `.nax/review-verdicts/<feature>/<storyId>.json` (`src/review/verdict-writer.ts`).
- **End-state** — `NaxStatusFile` (`src/execution/status-file.ts:58`): `run{status,pid,crashedAt?,crashSignal?}`, `progress`, `cost`, `durationMs`.
- **Render reuse** — `runs.ts` table helpers `pad`/`visibleLength`/`colorStatus`/`formatDuration` (`src/commands/runs.ts:52`); `formatLogEntry` (`src/log-format/formatter.ts`). CLI registration precedent: `logs` (`bin/nax.ts:1301`), `runs` subcommands (`bin/nax.ts:1400`).

### 3.2 Phase inference (best-effort, from the existing log)

The clean phase/step event (`story:step`) is **bus-only and not persisted** — so phases are inferred from stage+message strings that *are* in the log:

- Phase transitions: `stage === "story-orchestrator"`, message `"Phase passed: <op>"` (test-writer, greenfield-gate, implementer, full-suite-gate, verifier, verify-scoped, lint-check, typecheck-check, semantic-review, adversarial-review).
- TDD sessions: `stage === "tdd"` (`-> Session: test-writer` / `implementer`).
- Escalation transitions: `stage === "agent-manager"` fail-stale, plus tier-escalation log lines; the **final** tier is authoritative from `StoryMetrics.finalTier`.
- Fix cycles: `stage === "findings.cycle"` iterations; count corroborated by `StoryMetrics.attempts` / `firstPassSuccess`.
- Gate outcomes: `stage` ∈ `quality`, `review`, `verify[scoped]`, `verify[regression]`.

The report notes that phases are **reconstructed from logs, not an exact event record.**

---

## 4. Data Flow

```
run-id (or omitted -> latest)
  -> discovery.ts         : registry meta.json -> { feature, workdir, statusPath, eventsDir, jsonlPath }
  -> read <runId>.jsonl   : ordered LogEntry spine
   + loadRunMetrics()     : matching RunMetrics/StoryMetrics entry (may be absent -> crashed)
   + review-audit / verdicts
   + status.json          : end-state / crash signal
  -> phase-infer.ts       : per-story PhaseStep[] from stage+message
  -> reconstruct.ts       : RunTimeline model
  -> report.ts | json.ts  : stdout
  -> exit code            : 0 on success (report printed regardless of run outcome); 1 only on replay error (unknown id / unreadable)
```

---

## 5. Report — failure-focused default

Header: feature, nax version, run status, story count, total duration, total cost.
Body: one-line row per **passed** story; **failed/escalated** stories auto-expanded with phase timeline, escalation transitions (inferred), fix-cycle count, and review findings. Root-cause hint: the **first failed gate** in a failed story is marked `<-- root cause` (a labeled heuristic, not an authoritative verdict).

```
REPLAY run-2026-07-04T10-51  FAILED  4 stories  42m  $2.10   nax v0.71.1
(phases reconstructed from logs — best-effort)

 US-001 persistence        PASS  8m  $0.42
 US-002 REST CRUD          FAIL 12m  $1.10
   test-writer (claude)  RED    1m
   implementer           tier1 -> tier2 (fail-stale)
   verify[regression]    FAIL  <-- root cause
   adversarial (codex)   2 high findings
 US-003 web form           PASS  6m  $0.31
 US-004 e2e                PASS  9m  $0.58

(use --all to expand passed stories · --story US-002 to focus one · --json for machine output)
```

- `--all` expands passed stories with the same detail.
- `--story <id>` prints only that story, fully expanded.
- `--json` emits the `RunTimeline` model (stable shape for tooling), bypassing the renderer.

---

## 6. Robustness

- **Crashed / incomplete run** (no `metrics.json` entry): degrade to the log-derived summary, read crash signal from `status.json`, header shows `CRASHED` / `INCOMPLETE`, cost/tier fields render `n/a` rather than throwing.
- **Unknown / ambiguous run-id:** helpful error listing recent runs (mirrors `logs` behavior); exit 1.
- **Empty / truncated JSONL:** render whatever spine exists; never throw on a malformed line (skip-and-continue, as the existing readers do).
- **Inference is best-effort** and the report says so — this is the explicit trade of the "pure reader now, persist later" decision.

---

## 7. Testing (TDD, repo conventions)

- **Unit** — `phase-infer` and `reconstruct` against a committed fixture JSONL (real-shaped, trimmed): cover (a) passed run, (b) failed run with a tier escalation + fix cycles, (c) crashed run with no metrics entry.
- **Snapshot** — `report.ts` output for default vs `--all` vs `--story` on the three run shapes.
- **`json.ts`** — shape / round-trip stability.
- **`discovery.ts`** — unknown-id error, prefix match, latest-selection, via the `getRunsDir()` DI seam.

---

## 8. Story Breakdown (for the spec)

- **US-001** — `types.ts` + `phase-infer.ts` (pure inference) + `reconstruct.ts` (RunTimeline assembly, graceful degrade for crashed runs).
- **US-002** — `discovery.ts` (resolve / latest / prefix / unknown-id) + CLI wiring in `bin/nax.ts`.
- **US-003** — `report.ts` failure-focused renderer (default / `--all` / `--story`, root-cause hint, "reconstructed" notice).
- **US-004** — `json.ts` (`--json`) + `src/commands/replay.ts` orchestrator + exit codes + crashed-run end-to-end.
