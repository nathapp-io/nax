# SPEC: Mid-session resume — skip green canonical-order phases on rerun

## Summary

Add mid-session resume so that rerunning `nax run` after a crash or clean abort
skips the canonical-order phases a story already completed green, instead of
restarting every incomplete story from the top of the 12-phase `CANONICAL_ORDER`.
A new `src/execution/checkpoint/` module appends one durable record per green phase
to a per-feature `checkpoint.jsonl` (written through the same sync-append path
`crash-writer` already uses, so records survive SIGKILL). On rerun, a reader loads
the records with a longest-valid-prefix parse, a pure `buildResumePlan` decides which
phases to skip under a git-tree guard, and the story orchestrator seeds its existing
in-memory `phaseOutputs` skip-state so the already-present skip logic elides the
expensive agent phases while the cheap gates (`verify-scoped`, `lint-check`,
`typecheck-check`) always re-run to re-confirm the tree is still green. `nax run`
auto-resumes by default; an explicit `nax resume [-f <feature>]` command and a
`--fresh` / `--no-resume` opt-out are added.

## Motivation

Crash recovery in nax is implicit. All durable run state lives in `prd.json`: each
story carries `status` and `passes`. On crash, `crash-writer` flips `status.json` to
`"crashed"` and writes a fatal log, but nothing sub-story is persisted. Rerunning
`nax run` re-scans `prd.json` and restarts every non-`passed` story from the first
canonical-order phase (`test-writer` → `implementer` → … → `adversarial-review`).

Consequences: story-level resume already works implicitly (passed stories are
skipped), but a story that crashed at step 11 (`adversarial-review`) re-runs
`test-writer` + `implementer` + `verifier` + all reviews from scratch, discarding
hours of green agent work. `nax replay` (#1304) reads the JSONL timeline but is
read-only. This is IMPROVEMENT-REPORT §1.2 — the recommended next pick now that the
cost-budget cap (§1.1, #1291) has shipped. Design doc:
`docs/superpowers/specs/2026-07-10-mid-session-resume-design.md`.

## Design

New module `src/execution/checkpoint/` with a pure record schema, a sync-append
writer, a longest-valid-prefix reader, and a pure resume planner. The story
orchestrator (`src/execution/story-orchestrator/execution-plan.ts`) is extended at
two points: a `recordGreen` hook after each phase passes, and a seed-plus-skip guard
on its main phase loop. A thin `nax resume` command mirrors `registerReplayCommand`.

### Scope

**In scope:** durable per-green-phase checkpoint at the feature level; sync-append
writer; longest-valid-prefix + latest-`runId` reader; pure resume planner with
git-tree guard and a cheap-gate revalidation set; orchestrator integration (record on
pass, seed `phaseOutputs`, main-loop skip guard, cheap gates always re-run);
`nax run` auto-resume default; explicit `nax resume` command; `--fresh` /
`--no-resume` opt-out. Covers crash/kill and clean aborts (cost-limit #1291, queue
`PAUSE`/`ABORT`) — any interrupted run that leaves a `checkpoint.jsonl`.

**Out of scope (deferred):** mid-*phase* resume within a single phase (a phase
re-runs whole); resuming after a structurally hand-edited `prd.json` (tree/PRD
mismatch falls back to full rerun); deriving checkpoints from the events JSONL (a
dedicated file is used instead); a persisted `execution.resume` config field (v1 is
CLI-only, always-on with opt-out); parallel-mode cross-story coupling (each story is
an independent resume unit).

### Approach — seed the existing in-memory skip state

The orchestrator already maintains an in-memory `phaseOutputs: Record<string,
unknown>` (`execution-plan.ts:45`) and every rectification-resume loop skips a phase
via `if (name in phaseOutputs && phasePassed(name, phaseOutputs[name], storyId))
continue` (`execution-plan.ts:123`, `:195`). Mid-session resume persists this state
across process restarts and rehydrates it:

- **Record on pass.** After `runPhase` populates `phaseOutputs[name]` and the phase
  passes (`phasePassed(...) === true`), the orchestrator calls
  `CheckpointWriter.recordGreen(storyId, phaseName, treeState)` — one durably-appended
  JSONL line, flushed to disk before `recordGreen` resolves (and therefore before the
  next phase begins). Records are written **only after a phase passes**; a mid-phase
  crash leaves no record for that phase, so it re-runs. This is the correctness
  invariant. (A SIGKILL mid-append tears only the final line, which the reader's
  longest-valid-prefix parse drops — so the interrupted phase simply re-runs.)

- **Rehydrate on resume.** `buildResumePlan` returns the set of green **agent** phases
  to skip. Before the main loop, the orchestrator seeds `phaseOutputs[phase] =
  { success: true }` for each skip. `phasePassed` treats `{ success: true }` as
  passed (`phase-eval.ts:43`), and `extractPhaseFindings` returns `[]` for a
  `success: true` output (`phase-eval.ts:94-96`) — so a seeded phase carries no
  phantom findings and no phantom gate-failure keys.

- **Skip guard on the main loop.** The main loop (`execution-plan.ts:64-89`)
  currently runs every phase unconditionally; the integration adds the same
  `if (name in phaseOutputs && phasePassed(...)) continue` guard the resume loops
  already use, so seeded phases are elided.

- **Cheap gates always re-run.** `buildResumePlan` never lists `verify-scoped`,
  `lint-check`, or `typecheck-check` in its skip set — these re-execute on resume to
  re-confirm the working tree is still green. If a re-run gate fails, the seeded
  green agent work is stale; the plan is discarded and the story runs from its first
  non-green phase (existing short-circuit behavior).

- **Git-tree guard.** Each record carries the HEAD sha (`captureGitRef(workdir)`,
  `src/utils/git.ts:90`) and a working-tree digest (from `git status --porcelain`).
  `buildResumePlan` returns an empty skip set (full rerun for that story) when the
  current tree state does not match the checkpoint's — so resume never skips over a
  tree that moved between attempts.

### Integration (extension touchpoints)

Verified symbols this feature consumes or extends:

- **`phaseOutputs: Record<string, unknown>`** — `execution-plan.ts:45`. The in-memory
  per-story phase-skip state. Resume seeds it; the main loop gains a skip guard.
- **`runPhase(ctx, slot, phaseCosts, phaseOutputs, isThreeSession, opts?)`** —
  `src/execution/story-orchestrator/run-phase.ts:111`. Populates
  `phaseOutputs[op.name]`. The `recordGreen` hook fires immediately after it when the
  phase passes.
- **`phasePassed(opName, output, storyId?): boolean`** — `phase-eval.ts:19`. Green
  test: object output with `success !== false` (or `passed !== false`). A seeded
  `{ success: true }` passes. `extractPhaseFindings` (`phase-eval.ts:79`) yields `[]`
  for such output, so seeding introduces no phantom findings.
- **`CANONICAL_ORDER: readonly PhaseKind[]`** and **`PhaseKind`** —
  `src/execution/story-orchestrator/types.ts:135`, `:65`. The 12 phase kinds. Cheap
  gates that always re-run: `verify-scoped`, `lint-check`, `typecheck-check`
  (`types.ts:143-145`).
- **`captureGitRef(workdir): Promise<string | undefined>`** — `src/utils/git.ts:90`.
  HEAD sha for the tree guard. Working-tree digest derives from
  `git status --porcelain` via the injected `_gitDeps.spawn` pattern
  (`src/utils/git.ts:14`) — no direct `Bun.spawn`.
- **`featureDir`** — threaded into the run via `CrashRecoveryContext.featureDir`
  (`src/execution/crash-recovery.ts:44`) and `StatusWriter.writeFeatureStatus(
  featureDir, …)` (`src/execution/status-writer.ts:262`), which writes
  `join(featureDir, "status.json")`. `checkpoint.jsonl` sits beside it:
  `join(featureDir, "checkpoint.jsonl")`. `featureDir` resolves under the project
  output dir (`projectOutputDir(projectKey, config.outputDir)` →
  `~/.nax/<projectKey>/features/<feature>/`).
- **Durable append (Bun-native)** — `crash-writer.ts` uses node:fs `appendFileSync`
  **only** under a documented signal/exception-handler exception (`crash-writer.ts:31,34`),
  where the async loop may be mid-flight. `recordGreen` runs on the **normal async
  execution path** (after a phase passes), so it must NOT use node:fs sync I/O — that
  would violate the Bun-native rule (`.claude/rules/forbidden-patterns.md`). Instead it
  performs a Bun-native durable append (a `Bun.file(path).writer()` FileSink `write` +
  `flush`, or equivalent) via an injected `_deps.append`, awaited so the record is on
  disk before `recordGreen` resolves. `_deps` injection keeps it unit-testable without
  real fs.
- **CLI registration** — `registerReplayCommand(program)`
  (`src/commands/replay.ts:163`, wired in `bin/nax.ts:1486`). `nax resume` follows the
  same pattern via an exported `registerResumeCommand(program)`.

### Novel shape — resume planner skeleton

A pure planner with no existing precedent (the codebase's resume logic is inline in
`execution-plan.ts`, not a standalone function). Worked skeleton:

```typescript
// src/execution/checkpoint/resume-plan.ts
import type { PhaseKind } from "../story-orchestrator/types";

export interface TreeState { headSha: string; dirtyDigest: string; }
export interface StoryCheckpoint {
  storyId: string;
  greenPhases: PhaseKind[];      // phases recorded green, in canonical order
  tree: TreeState;               // tree state captured at last green record
}
export interface ResumePlan {
  skipPhases: PhaseKind[];       // green AGENT phases to elide (never cheap gates)
  revalidateGates: PhaseKind[];  // cheap gates that must re-run
  reason: "resume" | "tree-moved" | "no-checkpoint";
}

const CHEAP_GATES: readonly PhaseKind[] = ["verify-scoped", "lint-check", "typecheck-check"];

export function buildResumePlan(cp: StoryCheckpoint | null, current: TreeState): ResumePlan {
  if (!cp) return { skipPhases: [], revalidateGates: [...CHEAP_GATES], reason: "no-checkpoint" };
  if (cp.tree.headSha !== current.headSha || cp.tree.dirtyDigest !== current.dirtyDigest) {
    return { skipPhases: [], revalidateGates: [...CHEAP_GATES], reason: "tree-moved" };
  }
  return {
    skipPhases: cp.greenPhases.filter((p) => !CHEAP_GATES.includes(p)),
    revalidateGates: [...CHEAP_GATES],
    reason: "resume",
  };
}
```

### CLI Behavior

`nax resume [-f <feature>]`:

- **stdout:** a one-line resume summary — the feature, the number of stories with a
  checkpoint, and the phases being skipped — then the normal run output.
- **stderr:** warnings and errors only (mirrors existing commands).
- **Exit codes:** `0` on a run that completes green; non-zero on run failure — the
  same code the underlying `nax run` returns. `nax resume` for a feature with **no**
  `checkpoint.jsonl` is not an error: it prints "No checkpoint found — running from
  scratch" and proceeds as a full `nax run` (exit `0`).
- **`nax run`** auto-resumes when a `checkpoint.jsonl` exists for the feature.
  `--fresh` / `--no-resume` truncates/ignores the checkpoint and runs every
  incomplete story from scratch.

### File Format

`checkpoint.jsonl` — append-only, one JSON object per line, at
`~/.nax/<projectKey>/features/<feature>/checkpoint.jsonl`. Every field:

```jsonc
{
  "runId": "run-2026-07-10-abc123",   // originating run; reader keeps only the latest
  "storyId": "US-003",                 // story the phase belongs to
  "phase": "implementer",              // a CANONICAL_ORDER PhaseKind
  "headSha": "9f2c1ab",                // git HEAD at record time (captureGitRef)
  "dirtyDigest": "sha256:1b9e…",       // digest of `git status --porcelain` at record time
  "ts": "2026-07-10T12:34:56.000Z"     // ISO-8601 record time
}
```

Reader contract: parse line-by-line, keep the **longest valid prefix** (a torn final
line from a crash mid-append is dropped, not fatal); keep only records whose `runId`
equals the newest `runId` present; group by `storyId` into `StoryCheckpoint`. A
missing or fully-unparseable file yields an empty map — never throws.

### Failure Handling

- **No / corrupt checkpoint file** → reader returns an empty map → today's
  from-scratch behavior. Fail-open; never throws.
- **Torn final line** (crash mid-append) → dropped by longest-valid-prefix parse; all
  prior records honored.
- **Tree moved since checkpoint** (`headSha`/`dirtyDigest` mismatch) → `buildResumePlan`
  returns `reason: "tree-moved"`, empty `skipPhases` → that story fully reruns.
- **Cheap-gate re-run fails on resume** → seeded green work is stale; the existing
  main-loop short-circuit halts and the story runs from its first non-green phase.
- **`--fresh` / `--no-resume`** → checkpoint truncated/ignored; clean restart.
- Errors use `NaxError` with `stage: "checkpoint"`; every log call puts `storyId`
  first in its data object per `.claude/rules/project-conventions.md`.

## Stories

Single-package repo (nax itself) — no `Workdir`. Four stories, dependency-chained.

- **US-001 — Checkpoint store (record + writer + reader).** New module
  `src/execution/checkpoint/`: `types.ts` (`CheckpointRecord`, `StoryCheckpoint`,
  `TreeState`), `writer.ts` (`CheckpointWriter.recordGreen` sync-append via injected
  `_deps.append`), `reader.ts` (`loadCheckpoints(featureDir)` — longest-valid-prefix
  parse + latest-`runId` filter → `Map<storyId, StoryCheckpoint>`), barrel `index.ts`.
  - Context Files: `src/execution/crash-writer.ts`, `src/execution/story-orchestrator/types.ts`, `.claude/rules/error-handling.md`
  - Creates: `src/execution/checkpoint/types.ts`, `src/execution/checkpoint/writer.ts`, `src/execution/checkpoint/reader.ts`, `src/execution/checkpoint/index.ts`
  - Depends on: none

- **US-002 — Resume planner (pure).** `src/execution/checkpoint/resume-plan.ts`:
  `buildResumePlan(checkpoint, currentTree) → ResumePlan`, with the cheap-gate
  exclusion and git-tree guard. Pure function, no I/O.
  - Context Files: `src/execution/checkpoint/types.ts` — created by US-001, integrated here; `src/execution/story-orchestrator/types.ts`
  - Creates: `src/execution/checkpoint/resume-plan.ts`
  - Depends on: US-001

- **US-003 — Orchestrator integration.** Extend `execution-plan.ts`: fire
  `CheckpointWriter.recordGreen` after each phase passes; before the main loop, seed
  `phaseOutputs` from `buildResumePlan`'s `skipPhases` with a `{ success: true }`
  sentinel; add the `if (name in phaseOutputs && phasePassed(...)) continue` skip
  guard to the main loop; ensure cheap gates re-run. Capture `TreeState` via
  `captureGitRef` + a `git status --porcelain` digest through `_gitDeps`.
  - Context Files: `src/execution/story-orchestrator/execution-plan.ts`, `src/execution/story-orchestrator/run-phase.ts`, `src/execution/story-orchestrator/phase-eval.ts`, `src/utils/git.ts`, `src/execution/checkpoint/resume-plan.ts` — created by US-002, integrated here
  - Creates: (none — extends existing files + a `resume-hydrate.ts` helper under `src/execution/checkpoint/`)
  - Depends on: US-002

- **US-004 — CLI surface.** `registerResumeCommand(program)` in
  `src/commands/resume.ts` (mirrors `registerReplayCommand`), wired in `bin/nax.ts`;
  `nax run` auto-resume detection via `loadCheckpoints`; `--fresh` / `--no-resume`
  flag that truncates/ignores `checkpoint.jsonl`.
  - Context Files: `src/commands/replay.ts`, `bin/nax.ts`, `src/execution/checkpoint/reader.ts` — created by US-001, integrated here
  - Creates: `src/commands/resume.ts`
  - Depends on: US-001

### Seams

- **US-001 → US-002:** `buildResumePlan` consumes `StoryCheckpoint`/`TreeState` from
  US-001. Verified by US-002 AC that constructs a `StoryCheckpoint` and asserts the
  plan shape.
- **US-002 → US-003:** the orchestrator calls `buildResumePlan` and seeds
  `phaseOutputs` from its result. Seam AC in US-003 stubs `buildResumePlan`, triggers
  the orchestrator's resume path, and asserts it was called and its `skipPhases`
  drove the seeding.
- **US-001 → US-003:** the orchestrator calls `CheckpointWriter.recordGreen` after a
  green phase. Seam AC in US-003 spies `recordGreen` and asserts one call per passed
  phase with the phase name.
- **US-001 → US-004:** `nax run` / `nax resume` call `loadCheckpoints`. Seam AC in
  US-004 stubs `loadCheckpoints` and asserts the command consults it.

## Acceptance Criteria

### US-001 — Checkpoint store

1. `[unit]` `CheckpointWriter` is importable from `src/execution/checkpoint` and is
   constructable with an injected `_deps` object exposing an `append` function.
2. `[unit]` Calling `recordGreen(storyId, phase, treeState)` on a `CheckpointWriter`
   invokes `_deps.append` exactly once with a single newline-terminated line whose
   parsed JSON has `storyId`, `phase`, `headSha`, `dirtyDigest`, `runId`, and `ts`
   fields equal to the inputs.
3. `[unit]` `recordGreen` awaits the injected `_deps.append` and does not resolve until
   that append has completed (assert the append promise settles before `recordGreen`
   resolves), so a record is durably on disk before the next phase begins.
4. `[unit]` `loadCheckpoints(featureDir)` on a directory with no `checkpoint.jsonl`
   returns an empty `Map` and does not throw.
5. `[unit]` `loadCheckpoints` on a file whose final line is a truncated (unparseable)
   JSON fragment returns a `Map` containing every record from the valid prefix and
   omits the torn line.
6. `[unit]` Given records from two different `runId` values, `loadCheckpoints` returns
   only the records whose `runId` equals the newest `runId` present in the file.
7. `[unit]` `loadCheckpoints` groups records by `storyId`, returning a `StoryCheckpoint`
   per story whose `greenPhases` lists that story's recorded phases in canonical order.
8. `[unit]` A record whose JSON is well-formed but missing a required field (e.g.
   `phase`) is skipped by `loadCheckpoints` without aborting the parse of other lines.

### US-002 — Resume planner

1. `[unit]` `buildResumePlan` is importable from `src/execution/checkpoint` and
   callable with a `StoryCheckpoint` and a `TreeState`.
2. `[unit]` Given a `StoryCheckpoint` whose `greenPhases` include `implementer` and
   `verify-scoped`, and a matching `TreeState`, `buildResumePlan` returns `skipPhases`
   containing `implementer` and **not** containing `verify-scoped`.
3. `[unit]` For the same matching input, `buildResumePlan` returns `revalidateGates`
   equal to `["verify-scoped", "lint-check", "typecheck-check"]` and `reason: "resume"`.
4. `[unit]` When the passed `TreeState.headSha` differs from the checkpoint's,
   `buildResumePlan` returns an empty `skipPhases` array and `reason: "tree-moved"`.
5. `[unit]` When `TreeState.dirtyDigest` differs from the checkpoint's,
   `buildResumePlan` returns an empty `skipPhases` array and `reason: "tree-moved"`.
6. `[unit]` `buildResumePlan(null, tree)` returns an empty `skipPhases` array and
   `reason: "no-checkpoint"`.
7. `[unit]` None of the three cheap gates (`verify-scoped`, `lint-check`,
   `typecheck-check`) ever appears in `skipPhases`, even when all three are present in
   `greenPhases` with a matching tree.

### US-003 — Orchestrator integration

1. `[integration]` When the orchestrator runs a story with no prior checkpoint, each
   canonical phase that passes triggers exactly one `recordGreen` call whose `phase`
   argument equals that phase's op name (spy on `CheckpointWriter.recordGreen`).
2. `[integration]` A phase that fails (`phasePassed` returns false) does **not** trigger
   a `recordGreen` call for that phase.
3. `[integration]` On a resume where `buildResumePlan` yields `skipPhases: ["test-writer",
   "implementer"]`, the orchestrator seeds `phaseOutputs` such that `test-writer` and
   `implementer` are not dispatched through `runPhase` (spy on `runPhase`), while a
   non-skipped agent phase still is.
4. `[integration]` A phase seeded from a resume plan reports as passed: after seeding,
   `phasePassed(phase, phaseOutputs[phase], storyId)` returns true and
   `extractPhaseFindings(phaseOutputs[phase])` returns an empty array.
5. `[integration]` On resume, each cheap gate in `revalidateGates` (`verify-scoped`,
   `lint-check`, `typecheck-check`) is dispatched through `runPhase` even though the
   story is resuming (spy on `runPhase`).
6. `[integration]` When a re-run cheap gate returns a failing output on resume, the
   orchestrator short-circuits the canonical loop at that gate (no later phase is
   dispatched) — i.e. stale seeded work does not produce a false pass.
7. `[integration]` The orchestrator calls `buildResumePlan` once per story on the resume
   path and drives `phaseOutputs` seeding from its returned `skipPhases` (stub
   `buildResumePlan` to return a known plan and assert the seeded phases match).
8. `[unit]` The tree-state capture helper returns a `TreeState` whose `headSha` equals
   the value from `captureGitRef` and whose `dirtyDigest` is derived from the
   `git status --porcelain` output (both via injected `_gitDeps.spawn`, no real git).

### US-004 — CLI surface

1. `[cli]` `registerResumeCommand(program)` registers a `resume` command on the
   commander program (after registration, `program.commands` includes one named
   `resume`).
2. `[cli]` Running `resume` for a feature whose `checkpoint.jsonl` is absent prints a
   "No checkpoint found — running from scratch" message to stdout and exits with code
   `0`.
3. `[cli]` Running `resume` for a feature with a checkpoint prints a resume summary line
   naming the feature and the count of stories with a checkpoint before the run output.
4. `[integration]` `nax run` for a feature with an existing `checkpoint.jsonl` calls
   `loadCheckpoints` for that feature (stub `loadCheckpoints` and assert it was invoked
   with the feature's `featureDir`).
5. `[integration]` `nax run` invoked with `--fresh` truncates/ignores the existing
   `checkpoint.jsonl` so `loadCheckpoints` (or the seeding path) yields no skip phases
   for any story.
6. `[integration]` `--no-resume` behaves identically to `--fresh` for the purpose of
   producing an empty resume plan (no phases skipped).

<!-- spec-writing: completed-through-phase-6 -->
