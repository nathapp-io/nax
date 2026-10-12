/**
 * A1 finish glue (spec §4.8 callers 1 + 4), as rebuilt by A4.
 *
 * - `judged`: the advisor rules on each judged finding and each spec-vs-quality
 *   contradiction of a merged review round (reusing an earlier waive/supersede
 *   for the same `dedupeKey` without a new call).
 * - `approval`: from the end-of-run facts, the advisor approves, asks for one
 *   re-review, or holds before the PR is finalized.
 * - `commitLedger`: a ledger-only commit -- never `commitFixes`, so it moves
 *   neither `committedThisRun` nor the review window.
 */
import { relative } from "node:path";
import { gitWithTimeout } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, HeadsUpChannel, QuestionDraft } from "@/advisor";
import { buildMenu, createAdvisor, findReusable, ledgerPath, readTrustedDecisions } from "@/advisor";
import type { NaxConfig } from "@/config";
import { isAdvisorCallerEnabled } from "@/config";
import type { CallContext } from "@/operations";
import {
  type AdviceRef,
  adviseOn,
  allowedEdits,
  collectJudgment,
  contradictionQuestion,
  dedupePinned,
  droppedBy,
  emptyJudged,
  type FinishAdvisorDeps,
  type JudgeContext,
  type JudgedResult,
  type JudgeOneResult,
  judgmentQuestion,
  pinnedFor,
  RANK,
  withFixRuling,
} from "./advise-core";
import { loadRulings, reconcileRulings } from "./advise-rulings";
import type { Contradiction } from "./merge-findings";
import { type ApprovalAction, type approvalFacts, draftReason } from "./resolve";
import type { Ruling, RulingCheck } from "./ruling-check";
import type { FinishState } from "./state";
import type { Finding, ResolutionFacts } from "./types";

export type { AdviceRef, FinishAdvisorDeps, JudgedResult } from "./advise-core";

const GIT_TIMEOUT_MS = 30_000;

export interface FinishAdvisor {
  judgedEnabled: boolean;
  approvalEnabled: boolean;
  /** Judge the merged round's judgment findings and contradictions. */
  judged(
    findings: Finding[],
    contradictions: Contradiction[],
    state: FinishState,
    jctx?: JudgeContext,
  ): Promise<JudgedResult>;
  /** Approve / re-review / hold from the resolution facts. */
  approval(
    facts: ResolutionFacts,
    approval: ReturnType<typeof approvalFacts>,
  ): Promise<{ action: ApprovalAction; rationale: string }>;
  commitLedger(state: FinishState): Promise<void>;
  /** Finish B §3.2: trusted waive / supersede rulings this feature already has. */
  rulingsInForce(): Promise<Ruling[]>;
  /** Finish B §3.4-3.6: reuse exact matches, ask about near ones (up to `budget`), carry the rest unresolved. */
  reconcile(check: RulingCheck, budget: number, jctx?: JudgeContext): Promise<{ result: JudgedResult; asked: number }>;
}

const BLOCKING = new Set(["HIGH", "CRITICAL"]);

/**
 * An earlier waive/supersede for the same finding, safe to reuse without a new call.
 * Never for a blocking finding (it goes back to the advisor, which still sees the
 * prior decision), and only when the decision's audit artifact exists outside the
 * repo tree — a ledger line the advisor did not write is never trusted.
 */
async function reusablePrior(deps: FinishAdvisorDeps, f: Finding, key: string): Promise<AdviceDecision | undefined> {
  if (BLOCKING.has(f.severity)) return undefined;
  return findReusable(await readTrustedDecisions(deps.repoRoot, deps.feature, deps.outputDir), key);
}

async function judgeOne(
  deps: FinishAdvisorDeps,
  phase: "spec" | "quality",
  f: Finding,
  jctx?: JudgeContext,
): Promise<JudgeOneResult> {
  const question = judgmentQuestion(deps, phase, f, jctx);
  const prior = await reusablePrior(deps, f, question.dedupeKey ?? "");
  if (prior) {
    const reused = await deps.advisor.recordReuse(question, prior);
    const ref = { decisionId: reused?.id ?? prior.id, optionId: prior.chosenOptionId, reused: true };
    const dropped = droppedBy(prior.action.type);
    // findReusable only reuses waive / supersede; anything else is carried unresolved, never silently dropped.
    return dropped ? { ref, dropped } : { ref, fallback: `unexpected reusable action: ${prior.action.type}` };
  }
  return adviseOn(deps, question, f, pinnedFor(deps, f, jctx));
}

/** The deterministic split for a contradiction nobody ruled on: spec is fixed, quality carried. */
function specFirst(c: Contradiction): { toFix: Finding[]; unresolved: Finding[] } {
  return { toFix: [c.spec], unresolved: [c.quality] };
}

type ContradictionJudgment = Pick<JudgedResult, "toFix" | "unresolved" | "dropped" | "held" | "decisions"> & {
  ref?: AdviceRef;
};

async function judgeContradiction(
  deps: FinishAdvisorDeps,
  c: Contradiction,
  jctx?: JudgeContext,
): Promise<ContradictionJudgment> {
  const pinned = dedupePinned([...pinnedFor(deps, c.spec, jctx), ...pinnedFor(deps, c.quality, jctx)]);
  const { decision } = await deps.advisor.advise(contradictionQuestion(deps, c, jctx), {
    findingSeverity: RANK[c.spec.severity] >= RANK[c.quality.severity] ? c.spec.severity : c.quality.severity,
  });
  if (!decision) return { ...specFirst(c), dropped: [], held: [] };
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "fix") {
    const allowed = allowedEdits(pinned, action.updateAcs ?? []);
    const toFix = [withFixRuling(c.spec, decision.id, action.instruction, allowed)];
    // The ruling picks the spec side; the quality side is superseded, as it was before the ledger existed.
    const dropped = [{ finding: c.quality, decisionId: decision.id, action: "supersede" as const }];
    return { ref, decisions: [decision], toFix, unresolved: [], dropped, held: [] };
  }
  if (action.type === "waive" || action.type === "supersede") {
    const dropped = [c.spec, c.quality].map((finding) => ({ finding, decisionId: decision.id, action: action.type }));
    return { ref, decisions: [decision], toFix: [], unresolved: [], dropped, held: [] };
  }
  if (action.type === "hold") {
    return {
      ref,
      decisions: [decision],
      ...specFirst(c),
      dropped: [],
      held: [{ finding: c.quality, decisionId: decision.id }],
    };
  }
  return { ref, decisions: [decision], ...specFirst(c), dropped: [], held: [] };
}

/** Advisor off or the judged caller disabled: the deterministic fallback (spec §5 step 4). */
export function judgeWithoutAdvisor(findings: Finding[], contradictions: Contradiction[]): JudgedResult {
  return {
    toFix: contradictions.map((c) => c.spec),
    advice: [],
    unresolved: [...findings, ...contradictions.map((c) => c.quality)],
    dropped: [],
    held: [],
  };
}

const EXCERPT_LINES = 20;

function gateLines(facts: ResolutionFacts): string {
  return facts.gates
    .map((g) => {
      const head = `${g.name}: ${g.status}`;
      if (g.status !== "red" || !g.excerpt) return head;
      return `${head}\n${g.excerpt.split("\n").slice(0, EXCERPT_LINES).join("\n")}`;
    })
    .join("\n");
}

function approvalEvidence(facts: ResolutionFacts): { source: "review-round"; text: string }[] {
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  const open = facts.findingsOpen.map(
    (f) => `[${f.severity}] (${f.source ?? "quality"}) ${f.title} — ${f.file ?? "?"}${f.line ? `:${f.line}` : ""}`,
  );
  const texts = [
    open.length > 0 ? open.join("\n") : "none",
    `Acceptance: ${facts.acceptance}`,
    gateLines(facts),
    `Missing reviews: ${facts.reviewsMissing.length > 0 ? facts.reviewsMissing.join(", ") : "none"}`,
    `Unreviewed fix commits: ${facts.unreviewedFixCommits.length > 0 ? facts.unreviewedFixCommits.join(", ") : "none"}`,
    `Coverage: spec ${pct(facts.coverage.spec)}, quality ${pct(facts.coverage.quality)}`,
  ];
  return texts.map((text) => ({ source: "review-round", text }));
}

function approvalQuestionFromFacts(
  deps: FinishAdvisorDeps,
  facts: ResolutionFacts,
  approval: ReturnType<typeof approvalFacts>,
): QuestionDraft {
  return {
    kind: "finish-approval",
    feature: deps.feature,
    summary: `Approve the PR for ${deps.feature}? ${draftReason(facts)}`,
    evidence: approvalEvidence(facts),
    options: buildMenu({ kind: "finish-approval", ...approval, reReviewPhase: "quality" }),
  };
}

export function createFinishAdvisor(deps: FinishAdvisorDeps): FinishAdvisor {
  const git = deps.git ?? ((args, cwd) => gitWithTimeout(args, cwd, GIT_TIMEOUT_MS));
  return {
    judgedEnabled: deps.judgedEnabled,
    approvalEnabled: deps.approvalEnabled,
    async judged(findings, contradictions, _state, jctx) {
      const out = emptyJudged();
      for (const f of findings) collectJudgment(out, f, await judgeOne(deps, f.source ?? "quality", f, jctx));
      for (const c of contradictions) {
        const r = await judgeContradiction(deps, c, jctx);
        if (r.ref) out.advice.push(r.ref);
        out.toFix.push(...r.toFix);
        out.unresolved.push(...r.unresolved);
        out.dropped.push(...r.dropped);
        out.held.push(...r.held);
        if (r.decisions) out.decisions = [...(out.decisions ?? []), ...r.decisions];
      }
      return out;
    },
    rulingsInForce: () => loadRulings(deps),
    reconcile: (check, budget, jctx) => reconcileRulings(deps, check, budget, jctx),
    async approval(facts, approval) {
      const { decision, fallbackReason } = await deps.advisor.advise(approvalQuestionFromFacts(deps, facts, approval));
      if (!decision) return { action: "unavailable", rationale: fallbackReason ?? "no decision" };
      const type = decision.action.type;
      const action = type === "approve" || type === "re-review" ? type : "hold";
      return { action, rationale: decision.rationale };
    },
    async commitLedger(state) {
      const path = relative(state.workdir, ledgerPath(deps.repoRoot, deps.feature));
      await git(["add", "--", path], state.workdir);
      const staged = await git(["diff", "--cached", "--quiet", "--", path], state.workdir);
      if (staged.exitCode === 0) return;
      await git(
        ["commit", "--no-verify", "-m", `chore(${deps.feature}): advisor decisions`, "--", path],
        state.workdir,
      );
    },
  };
}

/** Phase wiring: an advisor only when a finish caller is enabled (spec §4.13); `undefined` keeps today's behaviour. */
export function buildFinishAdvisorForPhase(args: {
  runConfig: NaxConfig;
  callCtx: CallContext;
  repoRoot: string;
  outputDir: string;
  feature: string;
  runId: string;
  specPath: string;
  headsUp?: HeadsUpChannel;
}): FinishAdvisor | undefined {
  const judgedEnabled = isAdvisorCallerEnabled(args.runConfig, "finishJudgment");
  const approvalEnabled = isAdvisorCallerEnabled(args.runConfig, "finishApproval");
  if (!judgedEnabled && !approvalEnabled) return undefined;
  const advisor = createAdvisor({
    callCtx: args.callCtx,
    repoRoot: args.repoRoot,
    outputDir: args.outputDir,
    feature: args.feature,
    runId: args.runId,
    specPath: args.specPath,
    workdir: args.repoRoot,
    ...(args.headsUp ? { headsUp: args.headsUp } : {}),
  });
  return createFinishAdvisor({
    advisor,
    repoRoot: args.repoRoot,
    outputDir: args.outputDir,
    feature: args.feature,
    // Root config: the advisor is feature-level; enabled ⇒ no AC supersede on the menu (spec §12.7).
    acceptanceEnabled: () => args.runConfig.acceptance?.enabled !== false,
    judgedEnabled,
    approvalEnabled,
  });
}
