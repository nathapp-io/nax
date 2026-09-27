/**
 * Spec-structure self-heal — the single corrective turn a planning op fires when
 * the draft PRD it wrote diverges from the story structure the spec declares.
 *
 * A planner that folds one spec story into another writes a PRD that no longer
 * matches the spec's own story list. The plan write step catches that and refuses
 * the plan outright (`PLAN_SPEC_STRUCTURE_VIOLATION`), which ends the run with no
 * route back — the divergence is reported only after the planning turn is spent.
 * This step gives the planner one chance to put the draft back into the spec's
 * shape, in the same session, before that gate sees it.
 *
 * It declares no `_deps` object of its own: each op passes its own injectable
 * `readFile`, so the op's existing hopBody tests keep stubbing their own dep and
 * importing this module from `plan-refine.ts` creates no cycle.
 */

import { getSafeLogger } from "../logger";
import {
  backfillSpecWorkdirs,
  extractSpecStructure,
  findSpecStructureViolations,
  type SpecStructureViolation,
  validatePlanOutput,
} from "../prd";
import type { PlanPromptBuilder } from "../prompts";
import { errorMessage } from "../utils/errors";
import { makeSelfHealStep, type SelfHealStep } from "./self-heal";

/** What the step reads off a planning op's input. */
export interface SpecStructureHealInput {
  specContent: string;
  featureName: string;
  branchName: string;
  outputPath: string;
}

/**
 * Read the draft PRD at `outputPath` and report every way it diverges from the
 * structure the spec declares. Returns `[]` when the file is absent or does not
 * parse as a PRD — an unparseable draft is a parse/recover concern, not a
 * structural divergence, and the op's own retry and `recover` handle it.
 */
async function detectSpecStructureViolations<I extends SpecStructureHealInput>(
  input: I,
  readFile: (path: string) => Promise<string | null>,
): Promise<SpecStructureViolation[]> {
  const content = await readFile(input.outputPath);
  if (!content) return [];

  const structure = extractSpecStructure(input.specContent);
  try {
    const draft = validatePlanOutput(content, input.featureName, input.branchName);
    // A workdir the spec states and the planner omitted is not a divergence —
    // the write step backfills it. Compare what the backfill would produce, so
    // the repair turn is not spent on a difference that cannot survive anyway.
    return findSpecStructureViolations(backfillSpecWorkdirs(draft, structure).prd, input.specContent);
  } catch (err) {
    getSafeLogger()?.debug("plan", "Skipped spec-structure self-heal — draft PRD not yet parseable", {
      featureName: input.featureName,
      error: errorMessage(err),
    });
    return [];
  }
}

/**
 * Build the spec-structure self-heal step for a planning op. `readFile` is the
 * op's own injectable read — the step owns no I/O boundary of its own, so the
 * op's hopBody tests stay hermetic. At most one corrective turn per plan.
 */
export function specStructureSelfHealStep<I extends SpecStructureHealInput>(
  builder: PlanPromptBuilder,
  readFile: (path: string) => Promise<string | null>,
): SelfHealStep<I> {
  return makeSelfHealStep<I, SpecStructureViolation>({
    detect: (input) => detectSpecStructureViolations(input, readFile),
    buildRepair: (violations, input) => builder.buildSpecStructureRepair(violations, input.outputPath),
    log: {
      kind: "plan",
      message: "PRD diverged from the spec's declared story structure — issuing one repair turn",
      meta: (input, violations) => ({ featureName: input.featureName, violationCount: violations.length }),
    },
  });
}
