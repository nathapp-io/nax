# SPEC: `nax replay` — Post-mortem Run Timeline Viewer

## Summary

Add a read-only `nax replay [run-id]` command that reconstructs a completed or crashed run from already-persisted artifacts (the per-feature `<runId>.jsonl` log, `metrics.json`, review-audit files, `status.json`) and prints a **failure-focused timeline report**. It is a pure post-mortem reader: it makes no writes and adds nothing to the live run path. Phases, escalations, and fix-cycles are **inferred** from the existing log (the clean `story:step` bus event is not persisted); diffs/checkpoints are out of scope (no backing data). A `--json` flag emits the reconstructed model for tooling.

## Motivation

Debugging a failed run today means hand-reading raw JSONL. `nax replay` turns that into a structured, failure-focused view so operators can diagnose the adversarial-review whack-a-mole problem (#1157), tune escalation, and see where a run went wrong — cheaply, from data that already exists on disk. It is Tier-2 #3 in `projects/nax/nax-feature-suggestions-2026-07-04.md` §2.2, and the next arc after agent-bakeoff-mode (PR #1302). It also de-risks later features (empirical routing, plan-time estimation) by making run history legible.

## Design

Design doc: `docs/specs/2026-07-04-nax-replay-design.md`.

New module `src/replay/` with a pure reconstruction core, a discovery layer, a renderer, and a JSON serializer; a thin command in `src/commands/replay.ts` wires them and is registered in `bin/nax.ts` alongside `logs`.

### Scope

**In scope (Arc 1):** discovery by run-id (prefix-matched, latest-default); JSONL-spine reconstruction enriched with `metrics.json` + review-audit + `status.json`; best-effort phase/escalation/fix-cycle inference; failure-focused terminal report with `--all` / `--story` / `--json`; graceful degrade for crashed runs.

**Out of scope (deferred arcs):** persisting clean timeline events to the run path (this arc infers instead); per-story/per-phase diffs or checkpoints (nothing persists them); an interactive Ink TUI (a later arc reusing this arc's reconstruction core unchanged).

### Integration (extension touchpoints)

Verified symbols this feature consumes or extends:

- **`getRunsDir(): string`** — `src/utils/paths.ts:31`. SSOT for the central run registry directory (`NAX_RUNS_DIR` override). Direct `join(homedir(), ".nax", …)` is forbidden; discovery uses this helper via an injected dep.
- **`MetaJson`** — `src/pipeline/subscribers/registry.ts:21`: `{ runId, project, feature, workdir, statusPath, eventsDir, registeredAt }`. `statusPath` → the feature `status.json`; `eventsDir` → the per-feature `runs/` JSONL directory. Discovery reads `<getRunsDir()>/<dir>/meta.json`.
- **`resolveRunFileFromRegistry(runId): Promise<string | null>`** — `src/commands/logs-reader.ts:22`. Existing resolver; **prefix-matches** `meta.runId.startsWith(runId)` and returns only the jsonl path, discarding the `MetaJson`, and has no latest-default. `discovery.ts` **mirrors** its prefix-match + `getRunsDir()` DI but returns `{ meta, jsonlPath }` and supports a latest-default — a deliberate parallel, since replay needs the richer shape.
- **`loadRunMetrics(outputDir): Promise<RunMetrics[]>`** — `src/metrics/tracker.ts:324`. `metrics.json` is a project-global array; reconstruct filters by `runId`. `RunMetrics`/`StoryMetrics` (`src/metrics/types.ts`) provide authoritative per-story `success`, `finalTier` (`:114`), `attempts`, `firstPassSuccess` (`:122`), `cost`, `durationMs`, `reviewMetrics.findingsBySeverity` (`:190`), and run-level `storiesFailed` (`:251`) / `totalDurationMs` (`:253`). Absent when a run crashed before completion — reconstruct tolerates this.
- **`LogEntry`** — `src/logger/types.ts`: `{ timestamp, level, stage, message, storyId?, sessionRole?, data? }`. The ordered spine. Milestone signals already relied on by tooling: `stage === "run.start"` (carries `data.naxVersion`, e.g. `"0.71.1"`, and `data.runId`/`data.feature`), `stage === "run.complete"`, `story-orchestrator` "Phase passed/failed: `<op>`", `agent-manager` "fail-stale".
- **`formatLogEntry(entry, options)`** — `src/log-format/formatter.ts:91`. Exported SSOT for human-readable log lines; the renderer reuses it for phase/detail lines. (The `runs.ts` table helpers `pad`/`colorStatus`/`formatDuration` are module-private, so the renderer keeps its own small presentation helpers rather than importing them.)
- **CLI registration** — `bin/nax.ts` registers `logs` (`:1301`) and `runs` (`:1401`) via commander `program.command(...)`. `replay` is registered the same way through an exported `registerReplayCommand(program)`.

### Approach — phase inference (best-effort)

The clean `story:step` event is bus-only and never persisted, so `inferPhases` derives the phase timeline from log signals that *are* in the JSONL, per this defined contract:

- **Phase pass:** `stage === "story-orchestrator"`, message `"Phase passed: <op>"` → a `PhaseStep { name: <op>, status: "pass" }`, in log order.
- **Phase fail:** `stage === "story-orchestrator"`, message `"Phase failed: <op>"` → a `PhaseStep { name: <op>, status: "fail" }`. This is the signal a failed story's root-cause phase is derived from.
- **Escalation occurrence:** `stage === "agent-manager"`, message containing `"fail-stale"` → an escalation marker on the story (authoritative tier values come from `StoryMetrics.finalTier`, not from inference).
- **Fix cycle:** `stage === "findings.cycle"` iteration records → a fix-cycle count (corroborated by `StoryMetrics.attempts` / `firstPassSuccess`).

`inferPhases` does **not** decide story pass/fail — `reconstruct` takes that from `StoryMetrics.success` or, when metrics are absent, from `status.json`. The report states that phases are reconstructed from logs (best-effort), not read from an exact event record.

### CLI Behavior

```
nax replay [run-id]
  [run-id]      optional; prefix-matched; omitted => latest run (lexicographically greatest registry runId)
  --all         expand passed stories (default: passed collapsed to one line)
  --story <id>  render only that story, fully expanded
  --json        emit the reconstructed RunTimeline JSON instead of the report
```

- **stdout:** the report (or, with `--json`, the serialized model). **stderr:** operational errors.
- **Exit codes:** `0` when a report is produced (regardless of the *run's* pass/fail/crashed outcome); `1` on a replay error (unknown/ambiguous run-id, unreadable registry). `runReplay(...)` returns the exit code; the bin action calls `process.exit(code)`.

Report shape (failure-focused default):

```
REPLAY run-2026-07-04T10-51  FAILED  4 stories  42m  $2.10   nax v0.71.1
(phases reconstructed from logs — best-effort)

 US-001 persistence        PASS  8m  $0.42
 US-002 REST CRUD          FAIL 12m  $1.10
   test-writer (claude)  pass
   implementer           tier1 -> tier2 (fail-stale)
   verify[regression]    fail  <-- root cause
   adversarial (codex)   2 high findings
 US-003 web form           PASS  6m  $0.31
 US-004 e2e                PASS  9m  $0.58

(use --all to expand passed stories · --story US-002 to focus one · --json for machine output)
```

### Failure Handling

- **Crashed / incomplete run** (no matching `metrics.json` entry): degrade to the log-derived summary; read the crash signal from `status.json`; header shows `CRASHED`; per-story cost/tier render a placeholder rather than throwing. `runReplay` still returns `0`.
- **Unknown / ambiguous run-id:** `discoverRun` throws a `NaxError` with code `RUN_NOT_FOUND`; the command prints the message (with the run-id) to stderr and returns `1`.
- **Empty / truncated JSONL:** malformed lines are skipped (as existing readers do); whatever spine exists is rendered; never throws on a bad line.
- Errors use `NaxError` (`src/errors`) with a `stage` in context, per project convention.

## Stories

Single-package repo (no `Workdir`). Dependency chain: US-001 → US-002 → US-003 → US-004. US-004 integrates the three upstream symbols and declares the seams.

- **US-001 — Reconstruction core.** `src/replay/types.ts` (`RunTimeline` / `StoryTimeline` / `PhaseStep`), `phase-infer.ts` (`inferPhases`), `reconstruct.ts` (`reconstructTimeline`), `index.ts` barrel. Pure; no I/O. Graceful degrade for crashed runs.
  - *Context Files:* `src/logger/types.ts`, `src/metrics/types.ts`, `src/execution/status-file.ts`.
  - *Creates:* `src/replay/types.ts`, `src/replay/phase-infer.ts`, `src/replay/reconstruct.ts`, `src/replay/index.ts`.
- **US-002 — Run discovery.** `src/replay/discovery.ts` (`discoverRun`): registry scan, prefix match, latest-default, not-found error. Mirrors `resolveRunFileFromRegistry` but returns `{ meta, jsonlPath }`; `getRunsDir()` via an injected dep.
  - *Context Files:* `src/pipeline/subscribers/registry.ts`, `src/utils/paths.ts`, `src/errors.ts`, `src/replay/index.ts` — barrel from US-001, integrated here.
  - *Creates:* `src/replay/discovery.ts`.
- **US-003 — Failure-focused renderer.** `src/replay/report.ts` (`renderReport`): default (passed collapsed / failed expanded), `--all`, `--story`, root-cause marker, best-effort notice, crashed-run header. Consumes `RunTimeline`.
  - *Context Files:* `src/log-format/formatter.ts`, `src/replay/types.ts` — created by US-001, consumed here.
  - *Creates:* `src/replay/report.ts`.
- **US-004 — JSON, orchestrator & CLI wiring.** `src/replay/json.ts` (`toReplayJson`), `src/commands/replay.ts` (`runReplay` orchestrator + `registerReplayCommand`), wired into `bin/nax.ts`. Exit codes; crashed-run end-to-end.
  - *Context Files:* `bin/nax.ts`, `src/commands/runs.ts` (command precedent), `src/replay/index.ts` — discovery/reconstruct/render created by US-001–US-003, integrated here.
  - *Creates:* `src/replay/json.ts`, `src/commands/replay.ts`.

### Seams

- **`reconstructTimeline` + `RunTimeline`** (US-001) → consumed by US-003 (`renderReport`) and US-004 (`runReplay`). Seam AC in US-004 stubs `renderReport` and asserts `runReplay` passes it the reconstructed timeline.
- **`discoverRun`** (US-002) → consumed by US-004. Seam AC in US-004 stubs `discoverRun` and asserts `runReplay` invokes it with the query.
- **`renderReport`** (US-003) → consumed by US-004. Seam AC in US-004 stubs it and asserts a single invocation on the default (non-`--json`) path.

## Acceptance Criteria

### US-001 — Reconstruction core

1. `[unit]` `inferPhases` is importable from `@/replay` and callable as a function; given a log-entry array containing `{ stage: "story-orchestrator", message: "Phase passed: implementer", data: { storyId: "US-002" } }`, calling `inferPhases(entries, "US-002")` returns a phase list containing an entry with `name === "implementer"` and `status === "pass"`.
2. `[unit]` `inferPhases` preserves chronological order: given "Phase passed: test-writer" followed by "Phase passed: implementer" for `storyId "US-002"`, the returned phase names are exactly `["test-writer", "implementer"]` in that order.
3. `[unit]` `inferPhases` marks a failed phase: given `{ stage: "story-orchestrator", message: "Phase failed: full-suite-gate", data: { storyId: "US-002" } }`, the returned phase list contains an entry with `name === "full-suite-gate"` and `status === "fail"`.
4. `[unit]` `inferPhases` records an escalation: given an entry `{ stage: "agent-manager", message: "fail-stale: immediate same-agent retry", data: { storyId: "US-002" } }`, the returned result's escalation list for `US-002` is non-empty.
5. `[unit]` `reconstructTimeline` is importable from `@/replay`; given a parsed log spine plus a `RunMetrics` entry whose `runId` matches, it returns a `RunTimeline` whose `runId` and `feature` equal the metrics/registry values and whose `stories` length equals the number of stories in the metrics entry.
6. `[unit]` `reconstructTimeline` enriches each story from `StoryMetrics`: for a story with `success: true, finalTier: "balanced", cost: 0.42, attempts: 2`, the corresponding `StoryTimeline` has `status === "passed"`, `finalTier === "balanced"`, `cost === 0.42`, and `attempts === 2`.
7. `[unit]` `reconstructTimeline` degrades gracefully when metrics are absent: given a log spine and a `status.json` object carrying a crash signal but **no** matching `RunMetrics`, the returned `RunTimeline` has `status === "crashed"` and each `StoryTimeline.cost` is `undefined` (not a thrown error).
8. `[unit]` `reconstructTimeline` marks a root-cause phase for a failed story: for a story with `success: false` whose inferred phases end in a `status === "fail"` phase, the resulting `StoryTimeline.rootCausePhaseIndex` equals the index of that failed phase.
9. `[unit]` `reconstructTimeline` sets `inferred === true` on the returned `RunTimeline` (marking the timeline as log-reconstructed, not event-sourced).
10. `[unit]` `reconstructTimeline` reads the nax version from the `run.start` entry: given a `{ stage: "run.start", data: { naxVersion: "0.71.1" } }` entry, the returned `RunTimeline.naxVersion === "0.71.1"`.

### US-002 — Run discovery

1. `[unit]` `discoverRun` is importable from `@/replay`; given an injected runs-dir containing a `<dir>/meta.json` whose `runId` equals the query, `discoverRun("run-2026-07-04T10-51-37-987Z")` resolves to an object whose `meta.feature` equals the meta's feature and whose `jsonlPath` ends in `.jsonl`.
2. `[unit]` `discoverRun` prefix-matches: with the same registry entry, `discoverRun("run-2026-07-04")` resolves to that same run (its `meta.runId` starts with the query).
3. `[unit]` `discoverRun` with no argument selects the latest run: given two registry entries, `discoverRun()` resolves to the one whose `runId` is lexicographically greatest.
4. `[unit]` `discoverRun` throws a `NaxError` with `code === "RUN_NOT_FOUND"` when no registry entry matches the query.

### US-003 — Failure-focused renderer

1. `[unit]` `renderReport` is importable from `@/replay`; given a `RunTimeline` with one `passed` and one `failed` story and default options, the returned string contains the passed story's id on a single summary line and the failed story's inferred phase names on their own lines.
2. `[unit]` With default options, a `passed` story contributes no per-phase lines (only its summary line); the failed story's phases are present — proving passed-collapse / failed-expand.
3. `[unit]` With `{ all: true }`, a `passed` story's phase names appear in the returned string.
4. `[unit]` With `{ story: "US-002" }`, the returned string contains US-002's block and does **not** contain any other story's id.
5. `[unit]` For a failed story whose terminal phase has `status: "fail"`, the returned string contains a root-cause marker (the text `root cause`) on that phase's line.
6. `[unit]` The report header contains the `runId`, the `feature`, the run `status`, the story count, and the total cost.
7. `[unit]` The returned string contains the best-effort notice indicating phases were reconstructed from logs.
8. `[unit]` Given a `RunTimeline` with `status: "crashed"` and a story whose `cost` is `undefined`, `renderReport` returns a string whose header contains `CRASHED` and renders a placeholder for the missing cost without throwing.

### US-004 — JSON, orchestrator & CLI wiring

1. `[unit]` `toReplayJson` is importable from `@/replay`; given a `RunTimeline`, it returns an object whose `runId`, `feature`, and `status` equal the timeline's and whose `stories` array length equals `timeline.stories.length`.
2. `[integration]` Seam (`discoverRun`): stub `discoverRun`, call `runReplay("run-x", {})`, and assert `discoverRun` was invoked once with `"run-x"`.
3. `[integration]` Seam (`reconstruct` → `renderReport`): with `discoverRun` and file reads stubbed to yield a known `RunTimeline`, stub `renderReport`, call `runReplay(query, {})` (default options), and assert `renderReport` was invoked once with a timeline whose `runId` matches the known value.
4. `[integration]` `--json` path: with the same stubs, calling `runReplay(query, { json: true })` invokes `toReplayJson` and writes its serialization to the injected output writer, and `renderReport` is **not** invoked.
5. `[integration]` `registerReplayCommand` is importable from `@/replay` (or the command module) and, applied to a fresh commander `Command` instance, adds a subcommand named `replay` that accepts an optional positional run-id and exposes a `--json` option.
6. `[integration]` `runReplay` returns exit code `1` for an unknown run-id: with `discoverRun` throwing `NaxError { code: "RUN_NOT_FOUND" }`, `runReplay("missing", {})` resolves to `1` and writes a message containing `"missing"` to the injected error writer.
7. `[integration]` Crashed-run end-to-end: given an injected registry + files for a run with a crash signal and no metrics entry, `runReplay(query, {})` writes a report whose header contains `CRASHED` to the injected output writer and resolves to exit code `0`.

<!-- spec-writing: completed-through-phase-6 -->
