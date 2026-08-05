/**
 * Plan fidelity helpers shared by the plan ops (single + refine).
 *
 * `nax plan` is intentionally recovery-tolerant: it always produces a usable
 * PRD rather than failing. These helpers are the residual-drift signals —
 * deterministic backfill where a drop is repairable, a structured warning where
 * it is not. spec-review remains the explicit gate before any story executes.
 */
import { getSafeLogger } from "../logger";
import {
  applyModifiedFiles,
  applyOutOfScopeFallback,
  demoteStoryScopedOutOfScope,
  extractSpecContextFiles,
  findMissingOutOfScope,
  findSpecDriftViolations,
  getContextFiles,
} from "../prd";
import type { PRD } from "../prd/types";

/**
 * Scope-fidelity repair shared by the plan ops (single + refine).
 *
 * Feature-level exclusions have exactly one home (`prd.outOfScope`), so unlike
 * a dropped AC — where restoring it would require knowing which story owns it —
 * both directions of drift are repairable deterministically:
 *
 * - **Over-hoisting** — a story-local `**Out of scope:**` block promoted to
 *   feature level is pushed back down onto its owning story (#1446). Runs first
 *   so the backfill's substring check sees the corrected list.
 * - **Dropping** — the prompt asks the planner for its own wording; whatever it
 *   drops is appended verbatim from the spec.
 *
 * Each warning records that the planner needed the safety net. Returns the input
 * reference when the PRD was already faithful.
 */
export function backfillOutOfScope(prd: PRD, specContent: string, featureName: string): PRD {
  const scoped = demoteStoryScopedOutOfScope(prd, specContent);
  if (scoped !== prd) {
    getSafeLogger()?.warn("plan", "Story-local out-of-scope blocks hoisted to feature level — demoted to their story", {
      featureName,
      hoistedCount: (prd.outOfScope ?? []).length - (scoped.outOfScope ?? []).length,
    });
  }

  const missing = findMissingOutOfScope(specContent, scoped);
  if (missing.length === 0) return scoped;
  getSafeLogger()?.warn("plan", "Spec out-of-scope statements dropped from PRD — backfilled verbatim from the spec", {
    featureName,
    missingCount: missing.length,
    missing,
  });
  return applyOutOfScopeFallback(scoped, specContent);
}

/**
 * Carry the spec's `### Modifies` entries onto the stories that declared them.
 *
 * Unlike the out-of-scope backfill there is nothing to reconcile: the planner is
 * never asked for this field, because the value is the spec's verbatim
 * specificity — which test, which assertion, what the new invariant is — and a
 * paraphrase ("update affected engine tests") is the exact loss #1450 records.
 * So this is a pure carry, not a repair.
 *
 * Orphans (an entry naming no story, or one absent from the PRD) are warned
 * about and dropped rather than broadcast. Attaching an unowned authorisation to
 * every story would tell four implementers they may rewrite a test that only one
 * of them should touch.
 */
export function backfillModifiedFiles(prd: PRD, specContent: string, featureName: string): PRD {
  const { prd: applied, orphans, invalidPaths } = applyModifiedFiles(prd, specContent);
  if (invalidPaths.length > 0) {
    getSafeLogger()?.warn("plan", "Spec Modifies entries declare an absolute or traversing path — rejected", {
      featureName,
      rejectedCount: invalidPaths.length,
      rejected: invalidPaths.map((entry) => ({ storyId: entry.storyId, path: entry.path })),
    });
  }
  if (orphans.length > 0) {
    getSafeLogger()?.warn("plan", "Spec Modifies entries name no story in the PRD — dropped, not applied", {
      featureName,
      orphanCount: orphans.length,
      orphans: orphans.map((entry) => ({ storyId: entry.storyId, path: entry.path })),
    });
  }
  return applied;
}

/**
 * Warn when a spec-declared `### Context Files` entry is absent from the story
 * it was attributed to (#1466). Observability only — no PRD mutation.
 *
 * Unlike out-of-scope and `### Modifies`, `contextFiles` is intentionally
 * planner-chosen: the LLM reasons about what it needs to read, and injection is
 * capped at `FILE_INJECTION_MAX_FILES` (`src/context/builder.ts`). A dropped
 * entry may be a correct eviction under that cap rather than a bug, and
 * reconciling spec-declared vs. planner-inferred reads needs a priority rule
 * that does not exist yet — so this only makes the drop frequency measurable,
 * exactly as #1466's suggested first step, rather than backfilling a fallback
 * the way `backfillOutOfScope` / `backfillModifiedFiles` do.
 */
export function warnOnDroppedContextFiles(prd: PRD, specContent: string, featureName: string): void {
  const declared = extractSpecContextFiles(specContent);
  if (declared.length === 0) return;

  const byStory = new Map<string, typeof declared>();
  for (const entry of declared) {
    if (!entry.storyId) continue;
    const list = byStory.get(entry.storyId) ?? [];
    list.push(entry);
    byStory.set(entry.storyId, list);
  }

  for (const story of prd.userStories) {
    const storyDeclared = byStory.get(story.id);
    if (!storyDeclared || storyDeclared.length === 0) continue;
    const present = new Set(getContextFiles(story));
    const dropped = storyDeclared.filter((entry) => !present.has(entry.path));
    if (dropped.length === 0) continue;
    getSafeLogger()?.warn("plan", "Spec Context Files entries absent from the resulting story — not backfilled", {
      featureName,
      storyId: story.id,
      droppedCount: dropped.length,
      dropped: dropped.map((entry) => entry.path),
    });
  }
}

/**
 * Every deterministic spec→PRD fidelity repair, in the order they must run.
 *
 * One entry point so the four plan strategies (single, refine, pipeline, debate)
 * cannot drift on which repairs they apply — the class of bug that let
 * `### Modifies` reach only some paths would otherwise recur per-field.
 *
 * `warnOnDroppedContextFiles` runs last — it is observability, not a repair,
 * so it inspects the fully-repaired PRD without changing what is returned.
 */
export function applyPlanFidelity(prd: PRD, specContent: string, featureName: string): PRD {
  const scoped = backfillModifiedFiles(backfillOutOfScope(prd, specContent, featureName), specContent, featureName);
  warnOnDroppedContextFiles(scoped, specContent, featureName);
  return scoped;
}

/**
 * Residual-drift warning for spec-guard: fires when the specGuard repair turn
 * did not eliminate all behavioral-fidelity violations. Non-fatal — the plan
 * continues with a warning so the user can manually correct or rerun.
 */
export function warnOnSpecDrift(prd: PRD, featureName: string): void {
  const violations = findSpecDriftViolations(prd);
  if (violations.length > 0) {
    getSafeLogger()?.warn("plan", "spec-drift violations remain after specGuard repair — review PRD before executing", {
      featureName,
      violationCount: violations.length,
      violations,
    });
  }
}
