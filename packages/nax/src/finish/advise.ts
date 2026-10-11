/**
 * A1 finish glue (spec §4.8 callers 1 + 4).
 *
 * - `judged`: the advisor rules on each judged finding (reusing an earlier
 *   waive/supersede for the same `dedupeKey` without a new call).
 * - `approval`: the advisor approves, asks for one re-review, or holds before
 *   the PR is promoted.
 * - `commitLedger`: a ledger-only commit — never `commitFixes`, so it moves
 *   neither `committedThisRun` nor the review window.
 *
 * The machine-facing helpers (`applyJudgedAdvice`, `runApproval`) take the
 * machine's loops and `doEscalate` as callbacks, so `machine.ts` grows only by
 * the two call sites.
 */
import { relative } from "node:path";
import { gitWithTimeout } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, AdviceResult, Advisor, HeadsUpChannel, QuestionDraft } from "@/advisor";
import { buildMenu, createAdvisor, dedupeKeyFor, findReusable, ledgerPath, readTrustedDecisions } from "@/advisor";
import type { NaxConfig } from "@/config";
import { isAdvisorCallerEnabled } from "@/config";
import type { CallContext } from "@/operations";
import type { Contradiction } from "./merge-findings";
import { type ApprovalAction, type approvalFacts, draftReason } from "./resolve";
import type { RoutedReview } from "./route";
import type { FinishPhaseState, FinishState } from "./state";
import type { Finding, FinishResult, FinishRound, ResolutionFacts } from "./types";

const GIT_TIMEOUT_MS = 30_000;

export type AdviceRef = { decisionId: string; optionId: string; reused: boolean };

export interface JudgedOutcome {
  toFix: Finding[];
  advice: AdviceRef[];
  /** The advisor chose `hold`: escalate with this rationale. */
  hold?: string;
  /** The advisor was unavailable: escalate as today. */
  fallback?: string;
}

export interface ApprovalFacts {
  allPhasesComplete: boolean;
  gatesGreen: boolean;
  reReviewUsed: boolean;
}

/** A4 result of judging a merged review round (replaces `JudgedOutcome` at Task 13). */
export interface JudgedResult {
  toFix: Finding[];
  advice: AdviceRef[];
  /** Hold, advisor unavailable, or (advisor off) judged findings: carried to resolution unfixed. */
  unresolved: Finding[];
}

export interface FinishAdvisor {
  judgedEnabled: boolean;
  approvalEnabled: boolean;
  /** A4: judge the merged round's judgment findings and contradictions. */
  judgedMerged(findings: Finding[], contradictions: Contradiction[], state: FinishState): Promise<JudgedResult>;
  /** A4: approve / re-review / hold from the resolution facts. */
  approvalFromFacts(
    facts: ResolutionFacts,
    approval: ReturnType<typeof approvalFacts>,
  ): Promise<{ action: ApprovalAction; rationale: string }>;
  judged(phase: "spec" | "quality", judged: Finding[], state: FinishState): Promise<JudgedOutcome>;
  approval(state: FinishState, facts: ApprovalFacts): Promise<AdviceResult>;
  commitLedger(state: FinishState): Promise<void>;
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

function judgmentQuestion(deps: FinishAdvisorDeps, phase: "spec" | "quality", f: Finding): QuestionDraft {
  return {
    kind: "finish-judgment",
    feature: deps.feature,
    dedupeKey: dedupeKeyFor(phase, f),
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
): Promise<{ keep?: Finding; ref?: AdviceRef; hold?: string; fallback?: string }> {
  const question = judgmentQuestion(deps, phase, f);
  const prior = await reusablePrior(deps, f, question.dedupeKey ?? "");
  if (prior) {
    const reused = await deps.advisor.recordReuse(question, prior);
    return { ref: { decisionId: reused?.id ?? prior.id, optionId: prior.chosenOptionId, reused: true } };
  }
  const { decision, fallbackReason } = await deps.advisor.advise(question, { findingSeverity: f.severity });
  if (!decision) return { fallback: fallbackReason ?? "advisor unavailable" };
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "hold") return { ref, hold: decision.rationale };
  if (action.type !== "fix") return { ref };
  return { ref, keep: { ...f, fix: `${f.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}` } };
}

function approvalQuestion(deps: FinishAdvisorDeps, state: FinishState, facts: ApprovalFacts): QuestionDraft {
  const phases = (["spec", "quality"] as const).map(
    (p) => `${p}: last round ${state.phases[p].lastOutcome ?? "unknown"}`,
  );
  return {
    kind: "finish-approval",
    feature: deps.feature,
    summary: `Approve promoting the PR for ${deps.feature}? Repo gates are ${facts.gatesGreen ? "green" : "not green"}.`,
    evidence: [{ source: "review-round", text: phases.join("\n") }],
    options: buildMenu({ kind: "finish-approval", ...facts, reReviewPhase: "quality" }),
  };
}

const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

function contradictionQuestion(deps: FinishAdvisorDeps, c: Contradiction): QuestionDraft {
  const where = `${c.spec.file}${c.spec.line ? `:${c.spec.line}` : ""}`;
  const line = (label: string, f: Finding) => `${label}: ${f.title} — ${f.problem}\nSuggested fix: ${f.fix}`;
  const sev = RANK[c.spec.severity] >= RANK[c.quality.severity] ? c.spec.severity : c.quality.severity;
  return {
    kind: "finish-judgment",
    feature: deps.feature,
    dedupeKey: dedupeKeyFor("spec", c.spec),
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

/** The deterministic split for a contradiction nobody ruled on: spec is fixed, quality carried. */
function specFirst(c: Contradiction): { toFix: Finding[]; unresolved: Finding[] } {
  return { toFix: [c.spec], unresolved: [c.quality] };
}

async function judgeContradiction(
  deps: FinishAdvisorDeps,
  c: Contradiction,
): Promise<{ ref?: AdviceRef; toFix: Finding[]; unresolved: Finding[] }> {
  const { decision } = await deps.advisor.advise(contradictionQuestion(deps, c), {
    findingSeverity: RANK[c.spec.severity] >= RANK[c.quality.severity] ? c.spec.severity : c.quality.severity,
  });
  if (!decision) return specFirst(c);
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "fix") {
    const fix = `${c.spec.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}`;
    return { ref, toFix: [{ ...c.spec, fix }], unresolved: [] };
  }
  if (action.type === "waive" || action.type === "supersede") return { ref, toFix: [], unresolved: [] };
  return { ref, ...specFirst(c) };
}

/** Advisor off or the judged caller disabled: the deterministic fallback (spec §5 step 4). */
export function judgeWithoutAdvisor(findings: Finding[], contradictions: Contradiction[]): JudgedResult {
  return {
    toFix: contradictions.map((c) => c.spec),
    advice: [],
    unresolved: [...findings, ...contradictions.map((c) => c.quality)],
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
    async judgedMerged(findings, contradictions) {
      const out: JudgedResult = { toFix: [], advice: [], unresolved: [] };
      for (const f of findings) {
        const r = await judgeOne(deps, f.source ?? "quality", f);
        if (r.ref) out.advice.push(r.ref);
        if (r.keep) out.toFix.push(r.keep);
        else if (r.hold !== undefined || r.fallback !== undefined) out.unresolved.push(f);
      }
      for (const c of contradictions) {
        const r = await judgeContradiction(deps, c);
        if (r.ref) out.advice.push(r.ref);
        out.toFix.push(...r.toFix);
        out.unresolved.push(...r.unresolved);
      }
      return out;
    },
    async approvalFromFacts(facts, approval) {
      const { decision, fallbackReason } = await deps.advisor.advise(approvalQuestionFromFacts(deps, facts, approval));
      if (!decision) return { action: "unavailable", rationale: fallbackReason ?? "no decision" };
      const type = decision.action.type;
      const action = type === "approve" || type === "re-review" ? type : "hold";
      return { action, rationale: decision.rationale };
    },
    async judged(phase, judged) {
      const out: JudgedOutcome = { toFix: [], advice: [] };
      for (const f of judged) {
        const r = await judgeOne(deps, phase, f);
        if (r.ref) out.advice.push(r.ref);
        if (r.hold !== undefined) return { ...out, hold: r.hold };
        if (r.fallback !== undefined) return { ...out, fallback: r.fallback };
        if (r.keep) out.toFix.push(r.keep);
      }
      return out;
    },
    approval: (state, facts) => deps.advisor.advise(approvalQuestion(deps, state, facts)),
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

// ── Machine-facing helpers ───────────────────────────────────────────────────

export interface ApplyJudgedArgs {
  phase: "spec" | "quality";
  routed: RoutedReview;
  phaseState: FinishPhaseState;
  state: FinishState;
  fa: FinishAdvisor;
  recordAdvised: (round: Omit<FinishRound, "attempt">) => Promise<void>;
  escalate: (reason: string, findings: Finding[]) => Promise<FinishResult>;
  now: () => string;
}

/** Route `advise`: rule on the judged findings; `toFix` empty means the round was recorded `advised`. */
export async function applyJudgedAdvice(
  a: ApplyJudgedArgs,
): Promise<{ result?: FinishResult; toFix: Finding[]; advice: AdviceRef[] }> {
  a.phaseState.adviseRounds = (a.phaseState.adviseRounds ?? 0) + 1;
  const judged = a.routed.judged ?? [];
  const out = await a.fa.judged(a.phase, judged, a.state);
  if (out.hold !== undefined) {
    return { result: await a.escalate(`advisor hold: ${out.hold}`, a.routed.findings), toFix: [], advice: out.advice };
  }
  if (out.fallback !== undefined) {
    const first = judged[0];
    const reason = first?.judgmentReason ?? `Needs human judgment: ${first?.title ?? "unknown"}`;
    return {
      result: await a.escalate(`${reason} (advisor unavailable: ${out.fallback})`, a.routed.findings),
      toFix: [],
      advice: out.advice,
    };
  }
  const toFix = [...a.routed.findings.filter((f) => !f.judgment), ...out.toFix];
  if (toFix.length === 0) {
    await a.recordAdvised({
      ts: a.now(),
      phase: a.phase,
      committed: false,
      outcome: "advised",
      findings: a.routed.findings,
      advice: out.advice,
    });
  }
  return { toFix, advice: out.advice };
}

const COMPLETE_OUTCOMES = new Set(["passed", "advised"]);

export interface RunApprovalArgs {
  state: FinishState;
  fa: FinishAdvisor;
  reviewAgain: (phase: "spec" | "quality") => Promise<FinishResult | null>;
  gatesAgain: () => Promise<FinishResult | null>;
  escalate: (reason: string) => Promise<FinishResult>;
}

/** Caller 4: approve / one re-review / hold. Fails closed — any fallback escalates. */
export async function runApproval(a: RunApprovalArgs): Promise<FinishResult | null> {
  let reReviewUsed = false;
  for (;;) {
    const allPhasesComplete = (["spec", "quality"] as const).every((p) =>
      COMPLETE_OUTCOMES.has(a.state.phases[p].lastOutcome ?? ""),
    );
    const { decision, fallbackReason } = await a.fa.approval(a.state, {
      allPhasesComplete,
      gatesGreen: true,
      reReviewUsed,
    });
    if (!decision) return a.escalate(`advisor approval unavailable: ${fallbackReason ?? "no decision"}`);
    if (decision.action.type === "approve") {
      await a.fa.commitLedger(a.state);
      return null;
    }
    if (decision.action.type !== "re-review" || reReviewUsed) {
      await a.fa.commitLedger(a.state);
      return a.escalate(`advisor hold: ${decision.rationale}`);
    }
    reReviewUsed = true;
    const fixesBefore = a.state.phases[decision.action.phase].fixAttempts;
    const reviewed = await a.reviewAgain(decision.action.phase);
    if (reviewed) return reviewed;
    if (a.state.phases[decision.action.phase].fixAttempts > fixesBefore) {
      const gates = await a.gatesAgain();
      if (gates) return gates;
    }
  }
}
