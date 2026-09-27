/**
 * Spec-structure self-heal — the single corrective turn a planning op fires when
 * the draft PRD it wrote diverges from the story structure the spec declares.
 *
 * It declares no `_deps` object of its own: each op passes its own injectable
 * `readFile`, so the op's existing hopBody tests keep stubbing their own dep and
 * importing this module from `plan-refine.ts` creates no cycle.
 *
 * NOTE (test-writer session): STUB. `detect`, `buildRepair` and the structured
 * `log` are the implementer's next step — see the story's AC8/AC9.
 */
import type { SpecStructureViolation } from "../prd";
import type { PlanPromptBuilder } from "../prompts";
import { makeSelfHealStep, type SelfHealStep } from "./self-heal";

/** What the step reads off a planning op's input. */
export interface SpecStructureHealInput {
  specContent: string;
  featureName: string;
  branchName: string;
  outputPath: string;
}

export function specStructureSelfHealStep<I extends SpecStructureHealInput>(
  _builder: PlanPromptBuilder,
  _readFile: (path: string) => Promise<string | null>,
): SelfHealStep<I> {
  return makeSelfHealStep<I, SpecStructureViolation>({
    detect: async () => [{ kind: "missing-story", storyId: "US-000" }],
    buildRepair: () => "",
  });
}
