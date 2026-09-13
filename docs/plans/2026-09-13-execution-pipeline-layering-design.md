# Design note: `execution` <-> `pipeline` layering

**Status:** open - proposal, not a ruling. No ADR yet.
**Opened:** 2026-09-13
**Origin:** route A3 in `STATUS-import-cycles-drain.md` section 8.8.
**Prerequisite:** Wave 5 of that plan (Tasks 13-17). This note assumes the cycle ratchet
already reads 0 and that route A1 (`await import`) is in place.

---

## 1. Why this note exists

The import-cycle drain took `src/` from 132 cyclic modules to 0. The last seven were a
genuine `execution` <-> `pipeline` knot, and Wave 5 cut it with route A1: deferring
`execution -> pipeline/stages` to call time with `await import`.

**A1 removed the initialisation-order cycle. It did not make the two layers independent.**
`pipeline/stages/*` still calls into `@/execution`, and once the baseline reads 0 that
dependency is invisible to `check:import-cycles`. This note exists so a green ratchet is not
mistaken for resolved layering.

This is a **debt note with a proposal**, not a plan handover. Nothing here is ready for an
implementer. Sections 5 and 7 are the parts that need a decision.

---

## 2. The assumption this note overturns

`STATUS-import-cycles-drain.md` section 5 proposed the fix as:

> most likely extracting the shared contract (the event bus, the queue interface, the result
> types) into a third layer that both sides depend on and neither owns.

**That is the wrong shape, and each of its three nominated pieces is already resolved.**
Measured 2026-09-13:

| Nominated "shared contract" | Actual state |
|:--|:--|
| the event bus | Already its own nested barrel at `src/pipeline/event-bus/index.ts` (Task 5). Wave 5 Task 13 proved it was never the problem - nine stale parent-barrel imports were, and rewriting those specifiers alone freed 10 of the 20 modules. |
| the queue interface | Already its own layer at `src/queue/` (`manager.ts`, `types.ts`). `execution/queue-handler.ts` *consumes* it via `parseQueueFile` / `QueueCommand`. |
| the result types | `PipelineContext`, `StageResult`, `PipelineStage` already live in `src/pipeline/types.ts` and are imported **as types everywhere**, so they contribute zero runtime edges. |

There is no shared contract left to extract. Standing up a third layer would create an empty
package and move the problem rather than solve it. **The remaining problem is a different
one: a dependency pointing the wrong way.**

---

## 3. Measured facts

All figures from `src/` on 2026-09-13 unless noted.

**3.1 - Only three stage files reach into `@/execution`, and one of them already has the fix.**

| Stage file | Imports from execution | Note |
|:--|:--|:--|
| `stages/completion.ts:20` | `appendProgress` | via the `@/execution` barrel |
| `stages/queue-check.ts:11` | `processQueueFile` | via the `@/execution` barrel |
| `stages/execution.ts:17-24` | `applyPostRunInspection`, `assemblePlanInputsFromCtx`, `buildPlanForStrategy`, `decideStageAction`, `recordRepoScopedFixes`, `requiresInitialRefCapture` | via the `@/execution` barrel |
| `stages/context.ts:40` | `buildStoryContextFullFromCtx` | **already routed through the `@/execution/helpers` nested sub-barrel**, with a comment explaining it closes "a 12-hop pipeline -> execution loop" |

`context.ts` is prior art: someone already hit this and solved their instance locally.

**3.2 - `appendProgress` and `processQueueFile` are not shared contract. They are misfiled.**

Each has **exactly one consumer outside `src/execution/`**, and that consumer is the stage
file above. Their defining modules barely depend on `execution` at all:

| File | Lines | Non-type imports |
|:--|--:|:--|
| `src/execution/progress.ts` | 57 | `node:fs/promises`, `node:path`, `../logger`, `../utils/errors` |
| `src/execution/queue-handler.ts` | 341 | `../config`, `../errors`, `../logger`, `../prd`, **`../queue`**, `../utils/*` |

Neither imports anything from `execution/`. `progress.ts` is a 57-line append-to-a-file
helper. `queue-handler.ts` is queue logic living outside `src/queue/`. **These two are
directory misplacement, not architecture.**

**3.3 - The other three symbols genuinely belong to `execution`.**

`plan-inputs.ts` (486 lines), `build-plan-for-strategy.ts` (497) and `post-run.ts` (596) are
entangled with `./story-orchestrator`, `./oscillation-breaker`, `./recurrence-pause`,
`./session-manager-runtime` and `./tdd-failure-category`. They cannot be relocated. Whatever
happens, `stages/execution.ts` needs code that lives in `execution/`.

Note also `post-run.ts:19` imports `routeTddFailure` from `../pipeline/stages/execution-helpers`
- so the wrong-way edge runs in both directions between these two specific files.

**3.4 - The stage *lists* have no consumer outside `execution/`.**

```
defaultPipeline, preRunPipeline, postRunPipeline
  consumers in src/: execution/{iteration-runner, parallel-worker, unified-executor}.ts
  consumers elsewhere in src/: none
```

`pipeline/stages/index.ts` defines the composition; only `execution/` ever asks for it. This
is the central finding of this note.

**3.5 - The `stages` barrel does have one non-execution consumer.**
`src/cli/prompts-main.ts:14` imports `constitutionStage`, `contextStage`, `promptStage`,
`routingStage` - individual stages, **not** the lists. Any proposal must keep that working.

**3.6 - Blast radius floor.** **62 files under `test/` import `pipeline/stages`.** Any
proposal that moves stage files must budget for that, and it is the main reason this is not
a mechanical task.

---

## 4. The actual problem

`pipeline/` owns two different things that have different dependency directions:

| Concern | Files | Depends on `execution`? |
|:--|:--|:--|
| **Machinery** - the stage contract, the runner, the event bus, scope resolution | `types.ts`, `runner.ts`, `event-bus/`, `scope-files.ts`, `subscribers/` | No. Clean. |
| **Composition** - the concrete stage list and the stages that drive per-story work | `stages/index.ts`, `stages/execution.ts` | Yes, necessarily. |

The machinery is a genuine lower layer. The composition is not: it is the *place where
execution's work is wired into the machinery*, and it is consumed only by `execution`
(3.4). It has been filed under `pipeline/` because it lives next to the stages, which reads
naturally but inverts the dependency.

**So the fix is dependency inversion on the composition, not extraction of a third layer.**

---

## 5. Proposals

Two independent pieces. **A3a is worth doing on its own merits even if A3b is never
approved.**

### A3a - correct the two misplacements (small, low risk)

Kills the `completion.ts -> @/execution` and `queue-check.ts -> @/execution` edges outright,
by moving code to where it already belongs (3.2).

1. **`execution/queue-handler.ts` -> `src/queue/`.** It is queue logic, it already imports
   `../queue`, and `src/queue/` exists with a barrel. Re-export from `@/execution` for one
   release if convenient - but note that a value re-export keeps an edge, so prefer updating
   the call sites.
2. **`execution/progress.ts` -> a neutral home.** 57 lines, no `execution` imports, one
   outside consumer. Candidates: `src/utils/progress.ts`, or its own `src/progress/`.
   **Open question (7.1): which.**

Cost: two file moves, a handful of import rewrites, `bun run test:coverage` (files move under
`src/`), and the `@/execution` barrel loses two exports - which **engages section 1.4 of the
drain plan** (public barrel API change) and is why this is a design note and not a task.

### A3b - invert the composition (larger, the real fix)

Make `pipeline/` machinery-only and let `execution/` own the composition.

- `pipeline/` keeps `types.ts`, `runner.ts`, `event-bus/`, `scope-files.ts`, `subscribers/`,
  and the individual stage implementations that do not reach into `execution`.
- The stage **lists** (`defaultPipeline`, `preRunPipeline`, `postRunPipeline`) move to
  whoever consumes them - `execution/`, or a thin composition root - since nothing else uses
  them (3.4).
- `stages/execution.ts` is the hard case. It is 230 lines whose entire job is to delegate
  per-story work into `StoryOrchestratorBuilder` (per `CLAUDE.md`). It is an execution
  concern wearing a pipeline costume. Either it moves to `execution/` and registers itself,
  or `pipeline` gains a registration seam and `execution` supplies the stage.

  **Open question (7.2): move the file, or add a registration seam?** A registration seam
  keeps the file where readers expect it but adds indirection to a path that is currently
  explicit and easy to follow. Moving the file is blunter and honest but disturbs the
  "all stages live in `stages/`" convention that `prompts-main.ts` (3.5) and 62 test files
  rely on.

Cost: real. Public exports move out of `@/pipeline` and `@/execution` (section 1.4), 62 test
files are in scope (3.6), and `ARCHITECTURE.md` plus the `CLAUDE.md` architecture block would
need rewriting. **This needs its own spec and its own review. It is not a drain task.**

### A3c - do nothing, keep the note

Legitimate. A1 removed the real initialisation hazard; what remains is a readability and
coupling concern, not a correctness one. If A3a is done and A3b is not, the residual wrong-way
edge is a single file (`stages/execution.ts`) reaching six symbols - small enough to carry
knowingly.

---

## 6. What is explicitly not the problem

To stop these being re-proposed:

- **The event bus.** Resolved by Task 5 plus Wave 5 Task 13. Do not "extract" it again.
- **`PipelineContext` / `StageResult` / `PipelineStage`.** Type-only imports, zero runtime
  edges. Moving them buys nothing.
- **`pipeline/runner.ts`.** Never in the cycle. `execution/{pre-run, parallel-worker,
  iteration-runner, unified-executor}` import it freely and correctly - `execution` depending
  on `pipeline` machinery is the *right* direction.
- **The `await import` sites from A1.** If A3b lands, they can revert to static imports and
  the cycle will not return. Until then they stay.

---

## 7. Open questions

1. **A3a:** where does `progress.ts` go - `src/utils/progress.ts`, or its own `src/progress/`?
   57 lines and one outside consumer argues for `utils/`; a run-artifact writer arguably
   deserves its own name.
2. **A3b:** move `stages/execution.ts` into `execution/`, or add a registration seam to
   `pipeline/` and have `execution/` supply the stage?
3. **Scope:** is A3a worth doing on its own now, or should both halves wait for one spec?
4. **Does the composition root exist?** A3b assumes `execution/` owns composition. An
   alternative is a thin `src/app/` or `src/composition/` that wires stages to the runner and
   is imported by neither layer. That is closer to the original section-5 guess, but it is a
   *composition* root, not a *contract* layer - the distinction matters, since 2 shows there
   is no contract to put in it.

---

## 8. Recommendation

Take **A3a now** as a small, separately-reviewed change: it corrects two genuine
misplacements, needs no architectural ruling beyond the section 1.4 barrel-export question,
and removes two of the three wrong-way edges.

Hold **A3b** until someone is prepared to fund a spec with 62 test files in scope. Record it
here rather than in the drain plan, so the drain can close at 0.

**Do not open A3b as a "finish the drain" task.** The drain is finished. This is separate
work that happens to have been discovered by it.
