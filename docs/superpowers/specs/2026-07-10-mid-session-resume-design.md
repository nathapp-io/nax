# Mid-session resume — design

> Design for IMPROVEMENT-REPORT §1.2 "No mid-session resume".
> Status: brainstormed 2026-07-10, awaiting spec review then `writing-plans`.

## Problem

Crash recovery in nax is implicit. All durable run state lives in `prd.json`: each
story carries `status` (`pending` / `in-progress` / `passed` / `failed` / …) and
`passes: boolean`. On crash, `crash-writer.ts` flips `status.json` to `"crashed"`
and writes a fatal log, but **nothing sub-story is persisted**.

Rerunning `nax run` re-scans `prd.json` and restarts every non-passed story **from
the top of the 12-step `CANONICAL_ORDER`** (`test-writer` → `greenfield-gate` →
`implementer` → … → `adversarial-review`). Consequences:

- **Story-level resume already works implicitly** — passed stories are skipped.
- **The real gap is intra-story.** A story that crashed at step 11
  (`adversarial-review`) re-runs `test-writer` + `implementer` + `verifier` + all
  reviews from scratch, discarding hours of green agent work.
- `nax replay` (#1304) reads the JSONL timeline but is **read-only** — no skip logic.

The canonical-order phase is the natural checkpoint granularity: each phase is an op
that passes or fails, and a green phase's *effect* (tests written, code implemented)
already persists on disk in the working tree.

## Scope (decided during brainstorming)

| Axis | Decision |
|---|---|
| **Trigger** | Crash/kill **and** clean aborts — SIGTERM/SIGINT/SIGHUP, uncaught exceptions, cost-limit abort (#1291), queue `PAUSE`/`ABORT`. |
| **Invocation** | **Both** — `nax run` auto-resumes an interrupted run by default; `nax resume [-f <feature>]` is an explicit entry for discoverability/scripting. `--fresh` / `--no-resume` forces a clean restart. |
| **Trust model** | **Cheap re-validate, then skip.** Skip green *agent* phases, but always re-run the cheap non-agent gates first to confirm the working tree is still green. Revalidation failure → rerun from the first non-green phase. |
| **Granularity** | Per canonical-order **phase**, keyed by `storyId`. In parallel mode the story is the resume unit (no cross-story coupling). |

Non-goals: mid-*phase* resume within a single phase (a phase re-runs whole);
resuming a run whose `prd.json` was structurally edited between attempts (tree/PRD
mismatch → fall back to full rerun).

## Correctness invariant

**A checkpoint record is appended only *after* a phase passes.** Therefore a
mid-phase crash leaves no record for that phase, and it re-runs. This single rule is
what makes "skip green phases" safe — we never persist optimistic/partial state.

The second guard is the **working tree** being the real state. A checkpoint carries
the git HEAD sha and a working-tree hash at record time; on resume, a mismatch
invalidates that story's checkpoint (→ full rerun of the story) rather than skipping
stale work. The `verify-scoped` / `lint-check` / `typecheck-check` gates then
re-confirm green before any expensive agent phase is skipped.

## Checkpoint file location

Run artifacts live under the project output dir (`~/.nax/<projectKey>/`, from
`projectOutputDir()`):

```
~/.nax/<projectKey>/features/<feature>/
├── status.json              ← featureDir-level (crash-writer.writeFeatureStatus)
├── checkpoint.jsonl         ← NEW — resume checkpoint stream
└── runs/
    └── <runId>.jsonl        ← events log (what `nax replay` reads)
```

**The checkpoint is keyed to the feature, not the run.** Resume executes under a
*new* `runId`, so a checkpoint stored at `runs/<runId>.jsonl` level would be invisible
to the resuming run. It lives at the **`featureDir` level, next to `status.json`** —
the durable cross-run-attempt state that survives a crash:

```
join(featureDir, "checkpoint.jsonl")
  where featureDir = join(projectOutputDir(projectKey, config.outputDir), "features", feature)
```

No new path convention — it reuses the `featureDir` that `crash-writer` already
receives. It lives under `~/.nax/`, outside the working tree, so it never pollutes
the user's repo or `git status`. Each record carries its originating `runId` so the
resuming run filters to the latest crashed run and `--fresh` can truncate/ignore it.

### Why a dedicated append-only file (rejected alternatives)

- **Derive from the events JSONL** — elegant SSOT, but couples *resume correctness*
  to a log written for *observability*. A crash — the case we care about — is the
  case most likely to leave a torn final line. `replay` tolerates that (read-only
  cosmetics); resume can't, since a mis-parsed record could skip a phase that never
  completed. Also inverts the dependency (debug log becomes recovery source of truth).
- **Field on `prd.json`** — co-locates with `status`, but `prd.json` is user-facing
  and hand-edited. Volatile sub-phase state there invites confusing diffs/corruption
  and raises torn-write risk on the very file that drives story selection.
- **Dedicated append-only JSONL wins:** purpose-built minimal schema we control;
  written through the same sync-append path `crash-writer` already uses (survives
  SIGKILL); torn-line-tolerant via longest-valid-prefix read; isolated blast radius
  (corrupt/absent → discard → today's full-rerun behavior, no harm to `prd.json`).

## Architecture & data flow

```
Runner.run()
  runSetupPhase()
    → CheckpointReader.load(featureDir) ── longest-valid-prefix parse
        → Map<storyId, { phasesGreen, runId, headSha, treeHash }>
  runExecutionPhase()
    → per story:
        resume-plan.build(story, checkpoint, currentTreeState)
          → { skipPhases, revalidateGates, reason }   (tree mismatch → skipPhases:[])
        StoryOrchestrator runs CANONICAL_ORDER:
          - if a gate in revalidateGates: run it once; any fail → discard plan,
            rerun from first non-green phase
          - if phase ∈ skipPhases (and revalidation green): skip
          - else run phase; on pass → CheckpointWriter.recordGreen(...)  (sync append)
```

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/execution/checkpoint/types.ts` | `CheckpointRecord`, `ResumePlan`, `TreeState`. | — |
| `src/execution/checkpoint/writer.ts` | `CheckpointWriter.recordGreen(storyId, phase, treeState)` — sync-append one JSONL record. `_deps` for append + git hashing. | crash-writer sync-append pattern, git hasher |
| `src/execution/checkpoint/reader.ts` | `load(featureDir)` → longest-valid-prefix parse → `Map<storyId, checkpoint>`. Drops torn/invalid final line; filters to latest `runId`. | `Bun.file` |
| `src/execution/checkpoint/resume-plan.ts` | Pure fn `(story, checkpoint, currentTree) → ResumePlan`. Tree-hash mismatch → full rerun. | reader output |
| **touched** `src/execution/story-orchestrator/` | Consult `ResumePlan` before each `CANONICAL_ORDER` phase: revalidate cheap gates, skip green agent phases, record green on pass. | resume-plan |
| **touched** `src/execution/crash-writer.ts` / lifecycle | Wire `CheckpointWriter` into the per-phase success path; reuse sync-append durability. | existing |
| **touched** `src/cli/` + `src/commands/` | `nax resume [-f <feature>]`; `nax run` auto-resume default + `--fresh` / `--no-resume`. | reader |

All external effects (git hasher, file append) go through `_deps` injection per the
project DI rule — unit-testable without a real git tree.

### `CheckpointRecord` (draft schema)

```jsonc
{
  "runId": "<originating run>",
  "storyId": "US-003",
  "phase": "implementer",      // a CANONICAL_ORDER PhaseKind
  "gitHeadSha": "<HEAD at record time>",
  "treeDirtyHash": "<hash of working-tree state>",
  "ts": "<ISO8601>"
}
```

## Error handling & edge cases

- **No / corrupt checkpoint file** → `load` returns empty → today's from-scratch
  behavior. Never throws.
- **Tree moved since checkpoint** (`gitHeadSha` or `treeDirtyHash` mismatch) →
  invalidate that story's checkpoint → full rerun of the story.
- **Cheap-gate revalidation fails on resume** → discard skip plan, rerun from the
  first non-green phase (persisted "green" is no longer true).
- **Mid-phase crash** → no green record for that phase (records written only after a
  phase passes) → phase re-runs. The correctness invariant.
- **`--fresh` / `--no-resume`** → ignore + truncate `checkpoint.jsonl`, clean restart.
- **Parallel mode** → per-story checkpoints keyed by `storyId`; story is the resume
  unit, no cross-story coupling.
- Errors use `NaxError` with `stage: "checkpoint"`; log data puts `storyId` first per
  project logging rules.

## Testing (TDD, ≥80%)

**Unit**
- `reader`: longest-valid-prefix, including a torn final line; latest-`runId` filter.
- `resume-plan`: truth table — all-green / partial-green / tree-mismatch / gate-fail.
- `writer`: sync-append via injected `_deps` (no real fs/git).

**Integration**
- Orchestrator skips green phases and re-validates cheap gates before skipping.
- Cost-limit abort (#1291) → resume continues from checkpoint.
- SIGINT mid-story → resume reruns only the crashed phase onward.
- Tree modified between attempts → story fully reruns.

All `bun test` invocations use the mandatory `timeout` wrapper per
`.claude/rules/testing-commands.md`.

## Open questions for spec review

- Exact working-tree hash: `git status --porcelain` digest vs `git write-tree`
  (stash-free) — pick the cheapest that reflects uncommitted edits.
- Does `nax resume` with no interrupted run error, no-op, or fall through to `nax run`?
- Interaction with tier escalation: a phase that passed at `fast` tier — does resume
  preserve the tier context, or is only pass/fail persisted (recommended: pass/fail
  only; escalation state is re-derived)?
