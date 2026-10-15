/**
 * Finish advisor glue shared by `advise.ts` and `advise-rulings.ts`. A leaf: imports neither.
 */
import type { AdviceDecision, Advisor, QuestionDraft } from "@/advisor";
import { buildMenu, dedupeKeyFor } from "@/advisor";
import { type AcceptanceFile, findPinnedAcs, type PinnedAc } from "./acceptance-evidence";
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
  git?: (args: string[], cwd: string) => Promise<{ exitCode: number; stderr?: string }>;
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

/** Finish B: what a judgment question may carry beyond the finding. */
export interface JudgeContext {
  acceptance: AcceptanceFile[];
}

export function pinnedFor(deps: FinishAdvisorDeps, f: Finding, jctx?: JudgeContext): PinnedAc[] {
  if (!jctx || !deps.acceptanceEnabled()) return [];
  return findPinnedAcs(jctx.acceptance, f);
}

function acEvidence(pinned: PinnedAc[]): { source: "ac"; ref: string; text: string }[] {
  return pinned.map((p) => ({ source: "ac" as const, ref: `${p.path}#${p.acId}`, text: p.excerpt }));
}

function pinnedAcIds(pinned: PinnedAc[]): { pinnedAcs: string[] } | Record<string, never> {
  return pinned.length > 0 ? { pinnedAcs: [...new Set(pinned.map((p) => p.acId))] } : {};
}

export function dedupePinned(pinned: PinnedAc[]): PinnedAc[] {
  const seen = new Set<string>();
  return pinned.filter((p) => {
    const k = `${p.path}#${p.acId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The test files and AC ids a fix-and-update ruling may change: the pinned blocks it named. */
export function allowedEdits(pinned: PinnedAc[], acIds: string[]): { testPath: string; acIds: string[] }[] {
  const byPath = new Map<string, string[]>();
  for (const p of pinned) {
    if (!acIds.includes(p.acId)) continue;
    byPath.set(p.path, [...new Set([...(byPath.get(p.path) ?? []), p.acId])]);
  }
  return [...byPath.entries()].map(([testPath, ids]) => ({ testPath, acIds: ids }));
}

/** The finding with the ruling appended to its fix, plus the acceptance edits a fix-and-update ruling allows. */
export function withFixRuling(
  f: Finding,
  decisionId: string,
  instruction: string,
  allowed: { testPath: string; acIds: string[] }[],
): Finding {
  const base = `${f.fix}\n\nAdvisor ruling (${decisionId}): ${instruction}`;
  if (allowed.length === 0) return { ...f, fix: base };
  const where = allowed.map((a) => `${a.acIds.join(", ")} in ${a.testPath}`).join("; ");
  return {
    ...f,
    fix: `${base}. You may edit these acceptance tests, and only these: ${where}.`,
    allowedAcceptanceEdits: allowed,
  };
}

export function judgmentQuestion(
  deps: FinishAdvisorDeps,
  phase: "spec" | "quality",
  f: Finding,
  jctx?: JudgeContext,
): QuestionDraft {
  const pinned = pinnedFor(deps, f, jctx);
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
      ...acEvidence(pinned),
    ],
    options: buildMenu({
      kind: "finish-judgment",
      acceptanceEnabledForStory: deps.acceptanceEnabled(),
      ...pinnedAcIds(pinned),
      ...(/\bspec\b/i.test(f.problem) ? { citesSpecSection: "spec" } : {}),
    }),
    findingSeverity: f.severity,
  };
}

export const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function contradictionQuestion(deps: FinishAdvisorDeps, c: Contradiction, jctx?: JudgeContext): QuestionDraft {
  const pinned = dedupePinned([...pinnedFor(deps, c.spec, jctx), ...pinnedFor(deps, c.quality, jctx)]);
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
      ...acEvidence(pinned),
    ],
    options: buildMenu({
      kind: "finish-judgment",
      acceptanceEnabledForStory: deps.acceptanceEnabled(),
      ...pinnedAcIds(pinned),
      citesSpecSection: "spec",
    }),
    findingSeverity: sev,
  };
}

/** Ask one question about `f` and turn the decision into a judge result (no reuse lookup). */
export async function adviseOn(
  deps: FinishAdvisorDeps,
  question: QuestionDraft,
  f: Finding,
  pinned: PinnedAc[] = [],
): Promise<JudgeOneResult> {
  const { decision, fallbackReason } = await deps.advisor.advise(question, { findingSeverity: f.severity });
  if (!decision) return { fallback: fallbackReason ?? "advisor unavailable" };
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "hold") return { ref, decision, hold: decision.rationale };
  if (action.type !== "fix") {
    const dropped = droppedBy(action.type);
    return dropped ? { ref, decision, dropped } : { ref, decision };
  }
  const allowed = allowedEdits(pinned, action.updateAcs ?? []);
  return { ref, decision, keep: withFixRuling(f, decision.id, action.instruction, allowed) };
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
