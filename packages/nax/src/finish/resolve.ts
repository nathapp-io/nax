/**
 * A4 resolution (spec §6): the end-of-finish facts, computed in code, and the
 * ready/draft decision. Replaces every escalation exit — nothing here stops
 * the run. Pure apart from the injected advisor call.
 */

import { type LedgerEntry, openFindings } from "./ledger";
import type { ReviewLoopState } from "./state";
import type { AcceptanceFact, Finding, GateFact, ResolutionFacts, ReviewLens, Stop } from "./types";

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
  ledger: LedgerEntry[];
  stops: Stop[];
  restoreFailed?: number[];
}): ResolutionFacts {
  return {
    findingsOpen: openFindings(args.ledger),
    acceptance: args.acceptance,
    gates: args.gates,
    reviewsMissing: [...args.review.missingLenses],
    unreviewedFixCommits: [...args.unreviewedFixCommits],
    coverage: {
      spec: coverageOf(args.review.covered.spec, args.changed),
      quality: coverageOf(args.review.covered.quality, args.changed),
    },
    fixRounds: args.review.rounds,
    findings: [...args.ledger],
    stops: [...args.stops],
    restoreFailed: [...(args.restoreFailed ?? [])],
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
  return {
    allPhasesComplete: f.reviewsMissing.length === 0 && f.unreviewedFixCommits.length === 0,
    gatesGreen: gatesGreen(f),
    reReviewUsed,
  };
}

const SHORT_SHA = 7;

function duration(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`;
}

function where(s: Stop): string {
  const step = s.step ?? s.phase ?? "finish";
  return s.round !== undefined && s.round > 0 && step === "review" ? `${step} round ${s.round}` : step;
}

const hasLimit = (ms: number | undefined): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0;

function describeFix(s: Stop): string {
  const held = s.findings !== undefined ? `${s.findings} ${s.findings === 1 ? "finding" : "findings"}` : "";
  const handoff = s.handoff !== undefined ? `handoff-${s.handoff}` : "";
  const detail = [held, handoff].filter(Boolean).join(", ");
  const limit = hasLimit(s.limitMs) ? ` at the ${duration(s.limitMs)} limit` : "";
  return `fix session stopped${limit}${detail ? ` (${detail})` : ""}`;
}

function describeStop(s: Stop): string {
  const limit = hasLimit(s.limitMs) ? ` (${duration(s.limitMs)})` : "";
  switch (s.kind) {
    case "review":
      return `review (${s.lens ?? "?"}) stopped${hasLimit(s.limitMs) ? ` at the ${duration(s.limitMs)} limit` : ""}`;
    case "flow":
      return `finish time limit${limit} reached during ${where(s)}`;
    case "run":
      return `run cancelled during ${where(s)}`;
    case "fix":
      return describeFix(s);
    default:
      return `stopped during ${where(s)}`;
  }
}

export function stopReason(stops: Stop[]): string | undefined {
  const [first] = stops;
  if (!first) return undefined;
  const rest = stops.length - 1;
  return rest > 0 ? `${describeStop(first)}; +${rest} more stop${rest > 1 ? "s" : ""}` : describeStop(first);
}

function countBy(entries: LedgerEntry[], label: (ref: string, n: number) => string): string[] {
  const refs = [...new Set(entries.map((e) => e.ref ?? ""))];
  return refs.map((ref) => label(ref, entries.filter((e) => (e.ref ?? "") === ref).length));
}

function findingParts(findings: LedgerEntry[], openCount: number): string[] {
  if (findings.length === 0) return openCount > 0 ? [`${openCount} open finding(s)`] : [];
  const open = findings.filter((e) => e.state === "open" || e.state === "rejected" || e.state === "unresolved");
  return [
    ...(open.length > 0 ? [`${open.length} open`] : []),
    ...countBy(
      findings.filter((e) => e.state === "fixed-unreviewed"),
      (ref, n) => `${n} fixed in unreviewed commit ${ref.slice(0, SHORT_SHA)}`,
    ),
    ...countBy(
      findings.filter((e) => e.state === "set-aside"),
      (ref, n) => `${n} set aside (${ref})`,
    ),
  ];
}

export function draftReason(f: ResolutionFacts): string {
  const parts = [...findingParts(f.findings, f.findingsOpen.length)];
  if (f.restoreFailed && f.restoreFailed.length > 0) {
    parts.push(`worktree restore failed (${f.restoreFailed.map((n) => `handoff-${n}`).join(", ")})`);
  }
  if (!acceptanceOk(f.acceptance)) parts.push(`acceptance ${f.acceptance}`);
  if (f.gates.some((g) => g.status === "not-run")) parts.push("gates not run");
  const red = f.gates.filter((g) => g.status === "red").map((g) => g.name);
  if (red.length > 0) parts.push(`gates red: ${red.join(", ")}`);
  for (const lens of LENSES) if (f.reviewsMissing.includes(lens)) parts.push(`${lens} review missing`);
  if (f.unreviewedFixCommits.length > 0) parts.push(`${f.unreviewedFixCommits.length} unreviewed fix commit(s)`);
  return parts.join("; ");
}

/** Set-aside work (a set-aside finding, or a handoff whose restore failed) is never approvable as residue. */
const holdsSetAsideWork = (f: ResolutionFacts): boolean =>
  f.findings.some((e) => e.state === "set-aside") || (f.restoreFailed?.length ?? 0) > 0;

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
  if (isClean(facts)) {
    // Acceptance/gate fixes have no ledger entry: a half-edit left by a restore-failed session could make the
    // next run green. Never ready (and never promoted/committed) while that work may still be in the worktree.
    if ((facts.restoreFailed?.length ?? 0) > 0) return { outcome: "draft", reason: draftReason(facts) };
    return { outcome: "ready", acceptedResidue: [] };
  }
  if (!args.advise) return { outcome: "draft", reason: draftReason(facts) };
  let decision: { action: ApprovalAction; rationale: string };
  try {
    decision = await args.advise.approval(facts, approvalFacts(facts, args.reReviewUsed));
  } catch (err) {
    decision = { action: "unavailable", rationale: `advisor error: ${String(err)}` };
  }
  if (decision.action === "approve") {
    // The menu only offers approve when the facts allow it, but the decision is
    // re-checked here: a reply must never make a PR ready over unreviewed code.
    const approval = approvalFacts(facts, args.reReviewUsed);
    if (approval.allPhasesComplete && approval.gatesGreen) {
      if (holdsSetAsideWork(facts)) {
        return { outcome: "draft", reason: `advisor approval blocked: set-aside work exists; ${draftReason(facts)}` };
      }
      return { outcome: "ready", acceptedResidue: facts.findingsOpen };
    }
    const why = approval.gatesGreen ? "phases incomplete" : "gates not green";
    return { outcome: "draft", reason: `advisor: approve rejected (${why}); ${draftReason(facts)}` };
  }
  if (decision.action === "re-review" && !args.reReviewUsed) return { outcome: "re-review" };
  return { outcome: "draft", reason: `advisor: ${decision.rationale}; ${draftReason(facts)}` };
}
