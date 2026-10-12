/**
 * The story loop's advisor seam (spec §8). PR2 ships the deterministic defaults only:
 * no answer to implementer questions, and `hold` for every residual item. PR3 wires the
 * real `implementer-question` and `residual` kinds behind this same interface.
 */
import type { GateName, WorkflowFinding, WorkflowRuling } from "./types";

export interface ResidualRequest {
  readonly storyId: string;
  readonly items: readonly WorkflowFinding[];
  readonly redGates: readonly GateName[];
}

export interface ResidualAnswer {
  readonly rulings: readonly WorkflowRuling[];
  readonly diagnoses: Readonly<Partial<Record<GateName, string>>>;
}

export interface WorkflowAdvisor {
  answerQuestion(q: { storyId: string; status: "NEEDS_CONTEXT" | "BLOCKED"; concerns: string }): Promise<string | null>;
  ruleResidual(req: ResidualRequest): Promise<ResidualAnswer>;
}

export function defaultHold(finding: WorkflowFinding): WorkflowRuling {
  return {
    findingId: finding.id,
    action: "hold",
    text: `hold ${finding.id}: ${finding.issue}`,
    why: "deterministic default (no advisor ruling)",
    costIfWrong: "the finding stays open for the branch review",
    source: "default",
  };
}

export const defaultWorkflowAdvisor: WorkflowAdvisor = {
  answerQuestion: async () => null,
  ruleResidual: async (req) => ({ rulings: req.items.map(defaultHold), diagnoses: {} }),
};

/** A ruling a human must look at before the PR is ready (spec §7.8): a hold, or an advisor-flagged decision. */
export function isFlaggedRuling(r: WorkflowRuling): boolean {
  return r.action === "hold" || r.needsHumanConfirm === true;
}
