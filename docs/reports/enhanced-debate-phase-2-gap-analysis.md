# Gap Analysis — Enhanced Debate Phase 2

**Branch:** `feat/enhanced-debate-phase-2`
**Spec:** `docs/specs/SPEC-enhanced-debate-phase-2.md`
**Date:** 2026-05-11
**Reviewer:** Code review via `feature-dev:code-reviewer` subagent

---

## Summary

Five issues were found after implementation: two critical (functional bugs) and three high (rule violations or spec AC failures). All five have been fixed in the same session. A sixth finding raised by the code reviewer was determined to be a reviewer error and was reverted. The gaps are documented here so future runs can avoid the same patterns.

---

## Issues Found and Fixed

### CRITICAL-1 — `specContent` never reached the grounder; strategy always no-oped

**Story:** US-005 (wiring) + US-003 (grounder)
**Files:** `src/debate/runner-plan-helpers.ts`, `src/debate/runner-plan.ts`

`PlanPhaseOpts` had no `specContent` field. `runPlan()` received `opts.specContent` from the caller but `phaseOpts` omitted it before passing to `runPrePhase()`. `runPrePhase()` then built `PreDebatePhaseContext` without `specContent`, so `ctx.specContent` was always `undefined` inside `grounderStrategy`. The grounder's guard `if (!ctx.specContent) return { manifestSection: "", costUsd: 0 }` fired unconditionally — the grounder silently no-oped even when a spec file was provided.

**Fix:** Added `specContent?: string` to `PlanPhaseOpts`, threaded it through `runPrePhase` into `prePhaseCtx`.

**Root cause:** `runner-plan-helpers.ts` was a new file extracted from `runner-plan.ts` during US-003/US-004 implementation. US-005's context file list was authored before implementation and only named `runner-plan.ts`, not the helpers file. The US-005 agent updated `runner-plan.ts` correctly but never saw `PlanPhaseOpts` in the helpers file where the same change was needed.

---

### CRITICAL-2 — Non-plan stages silently stripped `evidenceMode` instead of throwing

**Story:** US-001 (schema)
**File:** `src/config/schemas-debate.ts`

**Spec AC (US-001):** `DebateConfigSchema.parse({ stages: { review: { evidenceMode: "asymmetric" } } })` must throw a `ZodError` because `evidenceMode` is plan-stage-only.

`makeDebateStageSchema` used Zod's default `.strip()` mode for non-plan stages. Passing `evidenceMode: "asymmetric"` to a review/acceptance stage config was silently dropped with no error, violating the AC.

**Fix:** Non-plan schemas now include `evidenceMode: z.undefined()` as an explicit field, causing Zod to throw when any value is provided.

**Root cause:** Individual AC compliance failure in the source story. The agent used Zod's default mode and did not add the explicit rejection. Story dependencies don't catch failures within the story that owns the AC.

---

### HIGH-3 — Plain `Error` thrown in `verifier-pick.ts`

**Story:** US-003 (selector)
**File:** `src/debate/selectors/verifier-pick.ts:136`

A `throw new Error(...)` was used instead of `throw new NaxError(...)`, violating `error-handling.md` which mandates `NaxError` for all thrown errors in the codebase.

**Fix:** Replaced with `new NaxError(..., "VERIFIER_PICK_NO_HANDLE", { stage: "plan", storyId: ctx.storyId })`.

**Root cause:** Straightforward coding standards slip — `NaxError` wasn't imported at the time of writing the throw.

---

### HIGH-4 — `storyId` missing from `logger.warn` call in `runner-plan.ts`

**Story:** US-005 (wiring)
**File:** `src/debate/runner-plan.ts:77`

`logger?.warn("debate", \`Agent '${debater.agent}' not found\`)` had no data object at all, violating `project-conventions.md` which requires `storyId` as the first key in every `logger.*` call inside pipeline stages.

**Fix:** Added `{ storyId: ctx.storyId, stage: ctx.stage, agent: debater.agent }`.

**Root cause:** Oversight during implementation — the log line was likely ported from an earlier version of the file that predated the storyId-first rule.

---

### HIGH-5 — `runner.ts` one-shot pre-phase path threw uncaught on grounder error

**Story:** Unclaimed (no Phase 2 story owned `runner.ts`)
**File:** `src/debate/runner.ts:140-155`

`runPanelOneShot()` called `resolvePreDebatePhase(...)` with no try/catch and no `onFailure` handling. A grounder failure would propagate unhandled to the caller rather than applying the configured degrade/block policy. Only `runner-plan-helpers.ts` had the correct handling; the shared one-shot path used by review/acceptance stages was left unguarded.

**Fix:** Wrapped the pre-phase call in try/catch that reads `config.preDebatePhase.onFailure ?? "degrade"` and either returns `buildFailedResult(...)` (block) or logs a warning and continues (degrade).

**Root cause:** `src/debate/runner.ts` was not listed in any Phase 2 story's context files. All Phase 2 stories focused on the plan-stage path (`runner-plan.ts`, `runner-plan-helpers.ts`). The shared one-shot infrastructure was an out-of-scope blind spot.

---

### REVERTED — Reviewer error: `buildPlanComposition` `overlapThreshold`/`maxDeltas` values

**Story:** US-005 (wiring)
**File:** `src/cli/plan.ts`

The code reviewer flagged `buildPlanComposition` injecting `overlapThreshold: 0.8, maxDeltas: 5` as a violation of the US-001 AC. This was incorrect. The reviewer conflated two distinct concepts:

- **US-001 AC** — `DebateStageConfigSchema.parse(...)` must return `overlapThreshold === undefined`. This governs **Zod schema parsing** behavior: the schema must not add `.default()` for those fields. It does not govern what `buildPlanComposition` injects.
- **`buildPlanComposition`** — A runtime macro expansion function. The spec's own "Plan composition" design section and `buildPlanComposition` sketch explicitly show `{ enabled: true, overlapThreshold: 0.8, maxDeltas: 5 }` as the intended expansion.

The original implementation was correct per the spec. The change was reverted and the test restored to its original assertion.

**Lesson:** When a reviewer flags a conflict between a design sketch and an AC, verify which artifact each AC is actually testing before acting on the finding. ACs scoped to schema parsing do not constrain runtime composition functions.

---

## Root Cause Patterns

Three distinct failure modes produced the five real gaps:

| Pattern | Issues | Description |
|:--------|:-------|:------------|
| **Context file staleness** | #1 | Story context files are authored before implementation. New files extracted during implementation are not visible to downstream stories. |
| **Unclaimed infrastructure** | #5 | Shared files used by multiple stages (e.g. `runner.ts`) can be missed if no story explicitly claims ownership of them. |
| **Individual AC compliance failure** | #2 | The source story misimplemented its own AC (Zod default `.strip()` instead of explicit rejection). Story dependencies don't catch failures within the story that owns the AC. |
| **Coding standards slip** | #3, #4 | `NaxError` import omitted; storyId-first logger rule missed. These are caught by code review but not by tests. |

---

## Recommendations

1. **Context file refresh pass** — After implementation of each story, have the next story's session re-scan for any new files created and include them in context. Specifically: if a story's implementation extracted a new module (e.g. `runner-plan-helpers.ts`), downstream stories should receive that file path in their context.

2. **Shared infrastructure ownership** — Files like `src/debate/runner.ts` that are shared across stages should have an explicit "shared infrastructure" story or be listed in every story that touches the surrounding subsystem.

3. **Post-implementation code review as a gate** — Gaps #3 and #4 are reliably caught by a code reviewer but not by tests. Making code review a mandatory step before closing a story prevents these from reaching the branch.

4. **Push back on reviewers when scope is ambiguous** — The reverted finding shows that code reviewer agents can misread AC scope. When a finding claims a conflict between a design sketch and an AC, verify the AC's actual subject before acting.
