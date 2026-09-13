# Design note: `execution` <-> `pipeline` layering

**Status:** open - proposal, not a ruling. No ADR yet.
**Resolved so far:** the section-1.4 escalation for A3a (section 9, ruled 2026-09-13) and
open question 7.1. A3b remains unruled.
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

**3.2 - `appendProgress` and `processQueueFile` are not shared contract.**

> **Revised 2026-09-13 (section 9).** This section originally claimed both were "directory
> misplacement, not architecture". That holds for `queue-handler.ts` and **does not hold for
> `progress.ts`** - see 3.2.1. The revised text is below.

Each has **exactly one consumer outside `src/execution/`**, and that consumer is the stage
file above. Neither defining module imports anything from `execution/`:

| File | Lines | Non-type imports |
|:--|--:|:--|
| `src/execution/progress.ts` | 57 | `node:fs/promises`, `node:path`, `../logger`, `../utils/errors` |
| `src/execution/queue-handler.ts` | 341 | `../config`, `../errors`, `../logger`, `../prd`, **`../queue`**, `../utils/*` |

**3.2.1 - but only one of them is actually misplaced.**

`queue-handler.ts` **is** misplaced. `CLAUDE.md:113` describes `src/queue/` as "Mid-run queue
control (PAUSE, ABORT, SKIP)", which is precisely this file's job. `src/queue/` today contains
only the *parsing* half (`parseQueueFile`, `QueueCommand`, `QueueFileResult` - 106 B of
barrel, one exported function); `queue-handler.ts` is the *applying* half: file I/O, locking,
and PRD mutation (`injectStory`, `markStorySkipped`, `resetStoryToPending`,
`setStoryPriority`). It already imports `../queue`. Its dependencies are all lower layers.

`progress.ts` **is not misplaced.** It writes `progress.txt` into `featureDir`, takes a
`StoryStatus` from `@/prd`, logs under the `"execution"` stage label, and its docstring is
entirely about story completion and the BUG-09 terminal-failure paths (tier exhaustion, max
attempts, escalation failure). It is small and dependency-light, but it is **execution-domain
code**. Relocating it to `src/utils/` would be filing by size rather than by domain.

**3.2.2 - every execution-internal consumer already bypasses the barrel.**

| Symbol | Barrel (`@/execution`) consumers | Relative-path consumers |
|:--|:--|:--|
| `appendProgress` | `stages/completion.ts:20` | `merge-conflict-outcomes.ts:26`, `pipeline-result-handler.ts:29`, `escalation/tier-outcome.ts:15`, `escalation/tier-escalation.ts:22` |
| `processQueueFile` | `stages/queue-check.ts:11` | - |
| `drainQueueAtBatchBoundary` | - | `unified-executor.ts:36` |
| `readQueueFile`, `clearQueueFile`, `BatchQueueDrainResult` | - | - |

So `src/execution/index.ts:92-94` exist to serve **two import statements**, and both are the
stage files this note is about. This is the fact that resolves the section 1.4 question -
see section 9.

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

### A3a - two different fixes, not one (small, low risk)

> **Revised 2026-09-13 (section 9).** Originally written as "correct the two misplacements".
> Only one of the two is a misplacement (3.2.1), so the halves now differ in both technique
> and in how much they actually buy.

Together these kill the `completion.ts -> @/execution` and `queue-check.ts -> @/execution`
edges.

**A3a-i - `execution/queue-handler.ts` -> `src/queue/` (a real correction).** It is queue
control living outside the directory `CLAUDE.md` defines for queue control, it already
imports `../queue`, and `src/queue/` has a barrel holding only the parsing half. Move the
file, update `src/queue/index.ts`, and repoint the two relative importers plus
`stages/queue-check.ts`. **Do not leave a value re-export in `@/execution`** - that would keep
the edge and defeat the move; update the call sites instead.

**A3a-ii - `execution/progress.ts` -> `src/execution/progress/index.ts` (a nested barrel).**
`progress.ts` is execution-domain code (3.2.1) and should stay in `execution/`. Promote it to
its own nested barrel - technique (C) in the drain plan - so `stages/completion.ts` can import
`@/execution/progress` without loading `src/execution/index.ts`. **This is exactly what
`stages/context.ts:40` already does with `@/execution/helpers`** (3.1), comment and all, so it
is precedented rather than novel.

**Be honest about what A3a-ii buys.** It *narrows* the wrong-way edge - `pipeline` ends up
depending on one 57-line leaf instead of the whole `@/execution` barrel - but `pipeline` still
depends on `execution` code. That is the same criticism that ruled out route A2 in the drain
plan's 8.8. It is worth doing because a narrow, named edge is honest and reviewable where a
barrel edge is not, **but it is not a layering fix and must not be described as one.** Only
A3b is that.

Cost: one file move, one nested-barrel promotion, 4 import statements in `src/` and 2 in
`test/` (3.2.2), plus `bun run test:coverage` because files move under `src/`.
**Section 1.4 is not engaged - see section 9.**

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

1. ~~**A3a:** where does `progress.ts` go - `src/utils/progress.ts`, or its own
   `src/progress/`?~~ **Resolved 2026-09-13 (section 9): neither.** It stays in `execution/`
   and is promoted to a nested barrel. The premise of the question - that it was misplaced -
   was wrong.
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

Take **A3a now** as a small, separately-reviewed change. Section 1.4 is resolved (section 9)
and the remaining work is one file move plus one nested-barrel promotion, touching six import
statements. It removes two of the three wrong-way edges - though only A3a-i is a genuine
correction; A3a-ii narrows an edge rather than removing the dependency.

Hold **A3b** until someone is prepared to fund a spec with 62 test files in scope. Record it
here rather than in the drain plan, so the drain can close at 0.

**Do not open A3b as a "finish the drain" task.** The drain is finished. This is separate
work that happens to have been discovered by it.

---

## 9. Ruling - section 1.4 is not engaged by A3a

**Question.** A3a removes `appendProgress` and the `queue-handler` symbols from the
`@/execution` barrel. Section 1.4 of `STATUS-import-cycles-drain.md` says: *"Do not delete or
relocate a public re-export from a barrel to break a cycle ... That changes the public API of
`@/context`. If a task looks like it needs this, stop and escalate."* This is that escalation.

**Ruled 2026-09-13: section 1.4 does not apply to A3a. Proceed without further escalation.**
Three independent grounds, each sufficient on its own.

### 9.1 - there is no public API to change

`package.json` for `@nathapp/nax` declares **no `main`, no `module`, no `types`, and no
`exports` field**. It ships:

```json
"bin":   { "nax": "./dist/nax.js" },
"files": ["dist/", "README.md", "CHANGELOG.md"]
```

`src/` is never published. The sole artifact is a single bundled `dist/nax.js` (the build has
no `--splitting` flag). **No consumer outside this repository can import `@/execution` at
all**, so no barrel here has a public API in the semver sense. `@/execution` is an internal
module boundary whose entire consumer set is `src/`, `bin/` and `test/` in this tree - all of
which are edited in the same commit.

Section 1.4's worked example is `@/context`, and the same is true of it. The rule's phrase
"public API" should be read as "a boundary other modules rely on", not "a published surface".

### 9.2 - the exports in question have one consumer each, and both are already in scope

Every execution-internal consumer of these symbols **already imports them by relative path**
and never touches the barrel (3.2.2). `src/execution/index.ts:92-94` therefore serve exactly
two import statements in `src/`:

- `src/pipeline/stages/completion.ts:20` - `appendProgress`
- `src/pipeline/stages/queue-check.ts:11` - `processQueueFile`

Both are the precise sites A3a exists to fix. `readQueueFile`, `clearQueueFile` and
`BatchQueueDrainResult` are exported from the barrel and have **zero importers anywhere** -
they are dead barrel surface.

Full churn, measured:

| Scope | Import statements to rewrite |
|:--|--:|
| `src/` | 4 |
| `test/` | 2 (`test/unit/execution/queue-handler.test.ts:15`, `test/integration/execution/progress.test.ts:6`) |
| `bin/` | 0 (`bin/nax.ts:92` imports only `run`) |

Nothing does `export * from "@/execution"`. One test does
`import * as checkpointBarrel from "@/execution"`
(`test/unit/execution/checkpoint/resume-plan.test.ts:20`) but asserts on a named symbol
(`buildResumePlan`), not on barrel shape - so it is unaffected. **Checked, not assumed.**

This is not the situation section 1.4 was written to prevent. That rule exists because
removing `export ... from "./engine"` in `src/context/index.ts` would silently break an
unknown number of importers to make a number go down. Here the importer set is two, both
known, both being edited.

### 9.3 - section 1.4 governs cycle-breaking, and A3a does not break a cycle

The rule is scoped by its own wording: *"to break a cycle"*. A3a is sequenced **after** Wave 5
Task 17, at a measured count of 0. There is no cycle for it to break, and the ratchet cannot
move. The barrel export moves because **the code moves**; the export is following its
definition, not being surgically removed to satisfy a gate.

That distinction is the whole point of the rule. Section 1.4 forbids using barrel surgery as a
cheap way to make the ratchet green. A3a is ordinary refactoring justified on domain grounds
(3.2.1), whose effect on the ratchet is nil.

### 9.4 - what the ruling does not cover

- **A3b is still escalated.** It moves the stage lists and possibly `stages/execution.ts`,
  whose barrel exports have real consumers - including `src/cli/prompts-main.ts:14` and 62
  test files (3.5, 3.6). Section 1.4's concern applies there with full force. A3b needs a
  spec, not this ruling.
- **Do not generalise 9.1 into "barrel exports are free to move".** The operative reason is
  9.2 - a measured, two-element importer set. Re-measure for any other barrel before citing
  this ruling; the `@/context` and `@/pipeline` barrels have broader consumers.
- **A3a-ii is narrowed, not removed.** After A3a, `pipeline` still depends on `execution`
  code. See the honesty note under A3a in section 5.

### 9.5 - conditions on proceeding

1. Do A3a **after** the drain closes at 0, not inside it.
2. Delete the three dead barrel exports (`readQueueFile`, `clearQueueFile`,
   `BatchQueueDrainResult`) rather than relocating them, unless a consumer appears - re-grep
   first, since this note's counts are a 2026-09-13 snapshot.
3. Run `bun run test:coverage` - files move under `src/`.
4. Re-run `bun run scripts/check-import-cycles.ts` and confirm it still reads **0**. A3a must
   not be the thing that reveals a new cycle; if it does, stop and re-open this note.
5. A3a-i and A3a-ii are independent. They can land as two commits and be reviewed separately.
