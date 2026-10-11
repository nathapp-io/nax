/**
 * A4 resolution (spec §6): the end-of-finish facts, computed in code, and the
 * ready/draft decision. Replaces every escalation exit — nothing here stops
 * the run. Pure apart from the injected advisor call.
 */

import type { ReviewLoopState } from "./state";
import type { AcceptanceFact, Finding, GateFact, ResolutionFacts, ReviewLens } from "./types";

const LENSES: readonly ReviewLens[] = ["spec", "quality"];

function coverageOf(covered: string[], changed: string[]): number | null {
  if (changed.length === 0) return null;
  const read = new Set(covered);
  return changed.filter((f) => read.has(f)).length / changed.length;
}

export function computeFacts(args: {
  review: ReviewLoopState;
  acceptance: AcceptanceFact;
  gates: GateFact[];
  unreviewedFixCommits: string[];
  changed: string[];
}): ResolutionFacts {
  const findingsOpen = [...new Set([...args.review.lastFindings, ...args.review.unresolved])];
  return {
    findingsOpen,
    acceptance: args.acceptance,
    gates: args.gates,
    reviewsMissing: [...args.review.missingLenses],
    unreviewedFixCommits: [...args.unreviewedFixCommits],
    coverage: {
      spec: coverageOf(args.review.covered.spec, args.changed),
      quality: coverageOf(args.review.covered.quality, args.changed),
    },
    fixRounds: args.review.rounds,
  };
}

const acceptanceOk = (a: AcceptanceFact): boolean => a === "green" || a === "not-configured";
const gatesGreen = (f: ResolutionFacts): boolean =>
  acceptanceOk(f.acceptance) && f.gates.every((g) => g.status === "green");

export function isClean(f: ResolutionFacts): boolean {
  return (
    f.findingsOpen.length === 0 && gatesGreen(f) && f.reviewsMissing.length === 0 && f.unreviewedFixCommits.length === 0
  );
}

export function approvalFacts(f: ResolutionFacts, reReviewUsed: boolean) {
  return { allPhasesComplete: f.reviewsMissing.length === 0, gatesGreen: gatesGreen(f), reReviewUsed };
}

export function draftReason(f: ResolutionFacts): string {
  const parts: string[] = [];
  if (f.findingsOpen.length > 0) parts.push(`${f.findingsOpen.length} open finding(s)`);
  if (!acceptanceOk(f.acceptance)) parts.push(`acceptance ${f.acceptance}`);
  const red = f.gates.filter((g) => g.status === "red").map((g) => g.name);
  if (red.length > 0) parts.push(`gates red: ${red.join(", ")}`);
  for (const lens of LENSES) if (f.reviewsMissing.includes(lens)) parts.push(`${lens} review missing`);
  if (f.unreviewedFixCommits.length > 0) parts.push(`${f.unreviewedFixCommits.length} unreviewed fix commit(s)`);
  return parts.join("; ");
}

export type ApprovalAction = "approve" | "re-review" | "hold" | "unavailable";

export type Resolution =
  | { outcome: "ready"; acceptedResidue: Finding[] }
  | { outcome: "draft"; reason: string }
  | { outcome: "re-review" };

export async function resolve(args: {
  facts: ResolutionFacts;
  advise?: {
    approval: (
      facts: ResolutionFacts,
      approval: ReturnType<typeof approvalFacts>,
    ) => Promise<{ action: ApprovalAction; rationale: string }>;
  };
  reReviewUsed: boolean;
}): Promise<Resolution> {
  const { facts } = args;
  if (isClean(facts)) return { outcome: "ready", acceptedResidue: [] };
  if (!args.advise) return { outcome: "draft", reason: draftReason(facts) };
  let decision: { action: ApprovalAction; rationale: string };
  try {
    decision = await args.advise.approval(facts, approvalFacts(facts, args.reReviewUsed));
  } catch (err) {
    decision = { action: "unavailable", rationale: `advisor error: ${String(err)}` };
  }
  if (decision.action === "approve") return { outcome: "ready", acceptedResidue: facts.findingsOpen };
  if (decision.action === "re-review" && !args.reReviewUsed) return { outcome: "re-review" };
  return { outcome: "draft", reason: `advisor: ${decision.rationale}; ${draftReason(facts)}` };
}
