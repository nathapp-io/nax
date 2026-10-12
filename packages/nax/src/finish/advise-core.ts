/**
 * Finish advisor glue shared by `advise.ts` and `advise-rulings.ts`. A leaf: imports neither.
 */
import type { AdviceDecision, Advisor, QuestionDraft } from "@/advisor";
import { buildMenu, dedupeKeyFor } from "@/advisor";
import type { Contradiction } from "./merge-findings";
import type { Finding } from "./types";

export type AdviceRef = { decisionId: string; optionId: string; reused: boolean };

/** The result of judging a merged review round. */
export interface JudgedResult {
  toFix: Finding[];
  advice: AdviceRef[];
  /** Hold, advisor unavailable, or (advisor off) judged findings: carried to resolution unfixed. */
  unresolved: Finding[];
  /** Findings a waive / supersede ruling dropped, for the ledger. */
  dropped: { finding: Finding; decisionId: string; action: "waive" | "supersede" }[];
  /** Hold decisions per finding, for the ledger ref. */
  held: { finding: Finding; decisionId: string }[];
  /** Finish B: decisions the advisor made while producing this result (same-round rulings carry their reason). */
  decisions?: AdviceDecision[];
}

export interface FinishAdvisorDeps {
  advisor: Advisor;
  repoRoot: string;
  /** Where audit artifacts live (outside the repo tree); reuse requires the prior decision's artifact. */
  outputDir: string;
  feature: string;
  acceptanceEnabled: () => boolean;
  judgedEnabled: boolean;
  approvalEnabled: boolean;
  git?: (args: string[], cwd: string) => Promise<{ exitCode: number }>;
}

export type Dropped = "waive" | "supersede";
export const droppedBy = (type: string): Dropped | undefined =>
  type === "waive" || type === "supersede" ? type : undefined;

export type JudgeOneResult = {
  keep?: Finding;
  ref?: AdviceRef;
  hold?: string;
  fallback?: string;
  dropped?: Dropped;
  decision?: AdviceDecision;
};

export function judgmentQuestion(deps: FinishAdvisorDeps, phase: "spec" | "quality", f: Finding): QuestionDraft {
  return {
    kind: "finish-judgment",
    feature: deps.feature,
    dedupeKey: dedupeKeyFor(phase, f),
    ...(f.file ? { anchorFile: f.file } : {}),
    rulingTitle: f.title,
    summary: `${f.title}: ${f.problem}`,
    evidence: [
      { source: "finding", text: `${f.problem}\nSuggested fix: ${f.fix}` },
      ...(f.judgmentReason
        ? [{ source: "finding" as const, ref: "reviewer", text: `Why a human: ${f.judgmentReason}` }]
        : []),
    ],
    options: buildMenu({
      kind: "finish-judgment",
      acceptanceEnabledForStory: deps.acceptanceEnabled(),
      ...(/\bspec\b/i.test(f.problem) ? { citesSpecSection: "spec" } : {}),
    }),
    findingSeverity: f.severity,
  };
}

export const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function contradictionQuestion(deps: FinishAdvisorDeps, c: Contradiction): QuestionDraft {
  const where = `${c.spec.file}${c.spec.line ? `:${c.spec.line}` : ""}`;
  const line = (label: string, f: Finding) => `${label}: ${f.title} — ${f.problem}\nSuggested fix: ${f.fix}`;
  const sev = RANK[c.spec.severity] >= RANK[c.quality.severity] ? c.spec.severity : c.quality.severity;
  return {
    kind: "finish-judgment",
    feature: deps.feature,
    dedupeKey: dedupeKeyFor("spec", c.spec),
    ...(c.spec.file ? { anchorFile: c.spec.file } : {}),
    rulingTitle: c.spec.title,
    summary: `Spec and quality reviews disagree on ${where}`,
    evidence: [
      { source: "finding", text: line("Spec review", c.spec) },
      { source: "finding", text: line("Quality review", c.quality) },
    ],
    options: buildMenu({
      kind: "finish-judgment",
      acceptanceEnabledForStory: deps.acceptanceEnabled(),
      citesSpecSection: "spec",
    }),
    findingSeverity: sev,
  };
}

/** Ask one question about `f` and turn the decision into a judge result (no reuse lookup). */
export async function adviseOn(deps: FinishAdvisorDeps, question: QuestionDraft, f: Finding): Promise<JudgeOneResult> {
  const { decision, fallbackReason } = await deps.advisor.advise(question, { findingSeverity: f.severity });
  if (!decision) return { fallback: fallbackReason ?? "advisor unavailable" };
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "hold") return { ref, decision, hold: decision.rationale };
  if (action.type !== "fix") {
    const dropped = droppedBy(action.type);
    return dropped ? { ref, decision, dropped } : { ref, decision };
  }
  return { ref, decision, keep: { ...f, fix: `${f.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}` } };
}

export function collectJudgment(out: JudgedResult, f: Finding, r: JudgeOneResult): void {
  if (r.ref) out.advice.push(r.ref);
  if (r.keep) out.toFix.push(r.keep);
  else if (r.hold !== undefined || r.fallback !== undefined) out.unresolved.push(f);
  if (r.ref && r.dropped) out.dropped.push({ finding: f, decisionId: r.ref.decisionId, action: r.dropped });
  if (r.ref && r.hold !== undefined) out.held.push({ finding: f, decisionId: r.ref.decisionId });
  if (r.decision) out.decisions = [...(out.decisions ?? []), r.decision];
}

export function emptyJudged(): JudgedResult {
  return { toFix: [], advice: [], unresolved: [], dropped: [], held: [] };
}

export function concatJudged(...results: JudgedResult[]): JudgedResult {
  const decisions = results.flatMap((r) => r.decisions ?? []);
  return {
    toFix: results.flatMap((r) => r.toFix),
    advice: results.flatMap((r) => r.advice),
    unresolved: results.flatMap((r) => r.unresolved),
    dropped: results.flatMap((r) => r.dropped),
    held: results.flatMap((r) => r.held),
    ...(decisions.length > 0 ? { decisions } : {}),
  };
}
