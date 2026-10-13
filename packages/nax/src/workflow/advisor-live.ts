/** A5 PR3: the real workflow advisor kinds behind PR2's WorkflowAdvisor seam (spec section 8). */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, Advisor, QuestionDraft } from "@/advisor";
import { buildMenu } from "@/advisor";
import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";
import type { ResidualAnswer, ResidualRequest, WorkflowAdvisor } from "./advisor";
import type { GateName, WorkflowFinding, WorkflowRuling } from "./types";

/** The ledger/log scope for work that belongs to no single story. */
export const FEATURE_SCOPE = "_run";

export interface LiveAdvisorInput {
  readonly advisor: Advisor;
  readonly feature: string;
  /** Absent: a feature-scoped residual (branch adjudication, P4-R18). */
  readonly storyId?: string;
  /** Stories that depend on this one and have not passed yet (carry targets, P3-R1). */
  readonly dependents: readonly string[];
}

export function dependentsOf(prd: PRD, storyId: string): string[] {
  return prd.userStories
    .filter(
      (s) => (s.dependencies ?? []).includes(storyId) && !s.passes && s.status !== "passed" && s.status !== "skipped",
    )
    .map((s) => s.id);
}

/** P3-R9: what being wrong costs, in the ledger's words. */
export function costIfWrongOf(d: AdviceDecision): string {
  return [
    `${d.confidence} confidence`,
    d.reversible ? "reversible" : "hard to undo",
    ...(d.needsHumanConfirm ? ["needs confirmation"] : []),
  ].join("; ");
}

export function toWorkflowRuling(
  findingId: string,
  d: AdviceDecision,
  scope: "story" | "branch" = "story",
): WorkflowRuling | null {
  const base = {
    findingId,
    why: d.rationale,
    costIfWrong: costIfWrongOf(d),
    source: "advisor" as const,
    decisionId: d.id,
    ...(d.needsHumanConfirm ? { needsHumanConfirm: true } : {}),
  };
  const a = d.action;
  switch (a.type) {
    case "defer":
      // #2496: nothing reviews again after branch adjudication, so a defer can only mean "a human decides".
      if (scope === "branch") {
        return { ...base, action: "hold", text: a.reason, needsHumanConfirm: true, coercedFrom: "defer" };
      }
      return { ...base, action: "defer", text: a.reason };
    case "waive":
    case "hold":
      return { ...base, action: a.type, text: a.reason };
    case "carry":
      return { ...base, action: "carry", text: a.instruction, toStories: a.toStories };
    default:
      return null;
  }
}

function findingEvidence(f: WorkflowFinding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  const ac = f.acId ? ` [${f.acId}]` : "";
  const fix = f.suggestion ? ` Suggested fix: ${f.suggestion}` : "";
  return `[${f.severity}/${f.kind}]${ac}${where} ${f.issue}${fix}`;
}

export function createLiveWorkflowAdvisor(input: LiveAdvisorInput): WorkflowAdvisor {
  const { advisor, feature, storyId, dependents } = input;
  return {
    async answerQuestion(q) {
      const draft: QuestionDraft = {
        kind: "implementer-question",
        feature,
        storyId: q.storyId,
        summary: `The implementer for ${q.storyId} stopped with ${q.status} and needs an answer to continue.`,
        evidence: [{ source: "agent-diagnosis", text: q.concerns || "(no concern text)" }],
        options: buildMenu({ kind: "implementer-question" }),
      };
      try {
        const { decision } = await advisor.advise(draft);
        return decision?.action.type === "answer" ? decision.action.text : null;
      } catch (err) {
        getSafeLogger()?.warn("workflow", "Advisor answer failed — the story keeps today's behaviour", {
          storyId: q.storyId,
          error: errorMessage(err),
        });
        return null;
      }
    },
    async ruleResidual(req: ResidualRequest): Promise<ResidualAnswer> {
      const scope = storyId ? "story" : "branch";
      const items: QuestionDraft[] = req.items.map((f) => ({
        kind: "residual",
        feature,
        ...(storyId ? { storyId } : {}),
        summary: f.issue,
        evidence: [{ source: f.kind === "gate" ? "gate" : "finding", ref: f.id, text: findingEvidence(f) }],
        options: buildMenu({ kind: "residual", dependents: [...dependents], scope }),
        findingSeverity: f.severity,
        ...(f.file ? { anchorFile: f.file } : {}),
        rulingTitle: f.issue,
      }));
      const result = await advisor.adviseBatch({
        kind: "residual",
        storyId: storyId ?? FEATURE_SCOPE,
        summary: storyId
          ? `${storyId} reached its fix-round cap with ${req.items.length} open item(s).`
          : `The branch review left ${req.items.length} open item(s) after its one fix pass.`,
        items,
        redGates: [...req.redGates],
      });
      if (result.kind !== "residual") return { rulings: [], diagnoses: {} };
      const rulings = result.items.flatMap((item, i) => {
        const finding = req.items[i];
        const ruling = finding && item.decision ? toWorkflowRuling(finding.id, item.decision, scope) : null;
        return ruling ? [ruling] : [];
      });
      for (const r of rulings.filter((x) => x.coercedFrom)) {
        getSafeLogger()?.warn("workflow", "Advisor deferred at branch scope; coerced to hold (no later review step)", {
          storyId: FEATURE_SCOPE,
          findingId: r.findingId,
          from: "defer",
          to: "hold",
        });
      }
      return { rulings, diagnoses: result.diagnoses as Partial<Record<GateName, string>> };
    },
  };
}
