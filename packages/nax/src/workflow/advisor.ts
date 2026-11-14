/**
 * The story loop's advisor seam (spec §8). PR2 ships the deterministic defaults only:
 * no answer to implementer questions, and `hold` for every residual item. PR3 wires the
 * real `implementer-question` and `residual` kinds behind this same interface.
 */
import type { ConfigChangeCandidate, QualityCommandKey } from "../advisor";
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

/**
 * What the implementer's question needs an answer to: which paths no session may write, the
 * commands the gates run today and the config changes nax is willing to make. A command is a
 * string or, for a multi-command gate, the commands it runs (`joined with " && "` when shown).
 */
export interface ImplementerQuestionFacts {
  readonly protectedPaths: readonly string[];
  readonly commands: Readonly<Partial<Record<QualityCommandKey, string | readonly string[]>>>;
  readonly candidates: readonly ConfigChangeCandidate[];
}

export interface ImplementerQuestionRequest {
  readonly storyId: string;
  readonly status: "NEEDS_CONTEXT" | "BLOCKED";
  readonly concerns: string;
  readonly facts?: ImplementerQuestionFacts;
}

/** A config change the advisor picked off the menu; the loop applies it, the advisor never names one. */
export interface ConfigChangeAnswer {
  readonly kind: "config-change";
  readonly key: QualityCommandKey;
  readonly to: string;
  readonly script: string;
  readonly reason: string;
  readonly decisionId: string;
  readonly needsHumanConfirm: boolean;
}

export interface WorkflowAdvisor {
  /** A string is still an answer to the implementer's question; a config change is a ruling nax applies. */
  answerQuestion(q: ImplementerQuestionRequest): Promise<string | ConfigChangeAnswer | null>;
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
