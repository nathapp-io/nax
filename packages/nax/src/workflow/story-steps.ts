/**
 * The story loop's five steps and its working state (spec §6), moved out of `story-loop.ts`.
 *
 * A mechanical port: every helper keeps its body and its `LoopState` parameter, and each node
 * re-expresses the code between two of the loop's decision points. A node returns a patch of the
 * graph-state keys it changed and, where the loop chose a destination, an exit label. The story
 * record is still written by the nodes' own `sink.update` patches — the graph state is never
 * persisted, so `StoryLoopState` is in memory only.
 *
 * Spec: docs/specs/SPEC-step-graph-g3-story-port.md § State, § Node table, § Transitions.
 */
import type { StepResult } from "@/step-graph";
import { adjudicateResidual } from "./adjudicate";
import { isFlaggedRuling } from "./advisor";
import { deriveEndState } from "./close";
import { ledgerCannotVerify } from "./gate-timing";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { absorbInterrupt, type InterruptOrigin } from "./interrupt-continue";
import { type LedgerWriteOptions, ledgerText } from "./ledger";
import { runNoWorkLadder } from "./no-work";
import { absorbReReviewVerdict } from "./re-review-absorb";
import { runReportCheck } from "./report-check";
import { describeFindings, startStep } from "./run-log";
import type { StoryLoopEnv, StoryLoopOutcome, StoryLoopState } from "./story-loop";
import type { ReviewOutcome } from "./story-review";
import type {
  GateName,
  GateRunResult,
  ImplementerReply,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowEndState,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
} from "./types";

export const WARM_ROUND_CAP = 3;
export const MAX_IMPLEMENTER_QUESTIONS = 2;

/** The step line in the log already says it; ledger.md still records it. */
const NO_MIRROR: LedgerWriteOptions = { mirror: false };

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";

/**
 * The node-local mutable working copy of the graph state. The helpers write to it exactly as they
 * wrote to the loop's own state; the node that owns it reads every key it declares in `produces`
 * back off it as its patch. The engine's own keys stay on the graph state, and `open`, `rulings`,
 * `firstAfterResume` and `closeAs` are node locals rather than fields of this copy.
 */
class LoopState {
  round: number;
  reviewed: boolean;
  unreviewed: boolean;
  nextId: number;
  reviewOpen: WorkflowFinding[];
  pendingSession: WorkflowFinding[];
  concerns: string[];
  questions: number;
  deferredMinors: number;
  fixBase: string | undefined;
  gates: GateRunResult | undefined;
  suite: GateRunResult | undefined;
  suiteThisIteration: boolean;
  costStop: boolean;
  lastTurn: StoryLoopState["lastTurn"];
  reportTurnRan: boolean;

  constructor(state: StoryLoopState) {
    this.round = state.round;
    this.reviewed = state.reviewed;
    this.unreviewed = state.unreviewed;
    this.nextId = state.nextId;
    this.reviewOpen = [...state.reviewOpen];
    this.pendingSession = [...state.pendingSession];
    this.concerns = [...state.concerns];
    this.questions = state.questions;
    this.deferredMinors = state.deferredMinors;
    this.fixBase = state.fixBase;
    this.gates = state.gates;
    this.suite = state.suite;
    this.suiteThisIteration = state.suiteThisIteration;
    this.costStop = state.costLimited;
    this.lastTurn = state.lastTurn;
    this.reportTurnRan = state.reportTurnRan;
  }

  assign(drafts: readonly WorkflowFindingDraft[]): WorkflowFinding[] {
    return drafts.map((d) => ({ ...d, id: `F${this.nextId++}` }));
  }
}

export const turnLabel = (turn: ImplementTurn): string => {
  if (turn.kind === "implement") return "implementer";
  if (turn.kind === "answer") return "implementer answer";
  // US-001: a restart is its own run-log step, so a no-work story's restarts read distinctly from the first turn.
  if (turn.kind === "restart") return turn.fresh ? "implementer restart (fresh)" : "implementer restart";
  // US-004: a continue or report turn is its own run-log step too, so a recovered interrupt reads distinctly.
  if (turn.kind === "continue") return "implementer continue";
  if (turn.kind === "report") return "implementer report";
  return `fix r${turn.round}`;
};

/**
 * The state the graph starts from, built by the rules `LoopState`'s constructor used: a resumed
 * story keeps the record's round, ids and open spec/quality findings, and starts at `evaluate`,
 * so it skips the first implement turn exactly as `openStory` did.
 */
export function initialStoryState(env: StoryLoopEnv): StoryLoopState {
  const resume = env.resume;
  return {
    step: resume === null ? "implement" : "evaluate",
    timings: {},
    round: resume?.round ?? 0,
    reviewed: resume?.reviewed ?? false,
    unreviewed: resume?.unreviewed ?? false,
    nextId: resume?.nextFindingId ?? 1,
    deferredMinors: resume?.deferredMinors ?? 0,
    fixBase: resume?.fixBase,
    reviewOpen: (resume?.openFindings ?? []).filter((f) => f.kind === "spec" || f.kind === "quality"),
    pendingSession: [],
    concerns: [],
    questions: 0,
    suiteThisIteration: false,
    costLimited: false,
    firstAfterResume: resume !== null,
    open: [],
    rulings: [],
    // US-008: no report turn has been spent yet, and a resumed story starts with no absorbed turn of
    // its own — so its first evaluate pass has no reply to repair a report for.
    reportTurnRan: false,
  };
}

/** One implementer call, labelled in the run log with its step and round (nax#2491 P2). */
async function implementTurn(env: StoryLoopEnv, turn: ImplementTurn): Promise<ImplementOutcome> {
  const step = startStep(env.storyId, turnLabel(turn), { model: env.steps.modelFor?.("implementer", turn) });
  const out = await env.steps.implement(turn);
  step.done(out.failure ? `failed (${out.failure})` : (out.reply?.status ?? "no reply"));
  return out;
}

/**
 * US-008: the reply the next evaluate pass reads to decide whether a report turn is owed. A failure
 * or a turn with no reply clears it, so a stale DONE from an earlier round cannot repair a report
 * after a later turn blew up.
 */
function recordLastTurn(s: LoopState, reply: ImplementerReply | undefined, fallback: boolean, stepUps: number): void {
  s.lastTurn = reply === undefined ? undefined : { status: reply.status, fallback, stepUps };
}

async function absorbTurn(
  env: StoryLoopEnv,
  s: LoopState,
  outcome: ImplementOutcome,
  origin: InterruptOrigin,
): Promise<void> {
  let current = outcome;
  // US-006: one allowance per absorbed turn — the first implement turn (with its no-work restarts
  // and answers) or one fix round — so every continue turn it spends counts against the same budget.
  let used = 0;
  // US-008: whether the turn that finally replied was the interrupt fallback; its report may be missing.
  let fallback = false;
  for (;;) {
    const absorbed = await absorbInterrupt(env, current, origin, used, (turn) => implementTurn(env, turn));
    current = absorbed.outcome;
    used = absorbed.used;
    fallback = absorbed.fallback;
    if (current.failure) {
      s.pendingSession = [
        ...s.pendingSession,
        ...s.assign([
          { kind: "session", severity: "important", issue: `implementer session failed: ${current.failure}` },
        ]),
      ];
      recordLastTurn(s, undefined, fallback, origin.stepUps);
      return;
    }
    if (current.autoCommitted)
      await env.sink.ledger(ledgerText.note("auto-committed the implementer's uncommitted edits"));
    const reply = current.reply;
    if (!reply) {
      recordLastTurn(s, undefined, fallback, origin.stepUps);
      return;
    }
    const needsAnswer = reply.status === "NEEDS_CONTEXT" || reply.status === "BLOCKED";
    if (needsAnswer && s.questions < MAX_IMPLEMENTER_QUESTIONS) {
      s.questions += 1;
      const answer = await env.advisor.answerQuestion({
        storyId: env.storyId,
        status: reply.status as "NEEDS_CONTEXT" | "BLOCKED",
        concerns: reply.concerns ?? "",
      });
      if (answer !== null) {
        await env.sink.ledger(ledgerText.note(`implementer ${reply.status}: answered by the advisor`));
        current = await implementTurn(env, {
          kind: "answer",
          text: answer,
          stepUps: origin.stepUps,
          limit: origin.limit,
        });
        continue;
      }
    }
    if (reply.status !== "DONE" || reply.interrupted) await recordConcern(env, s, reply);
    recordLastTurn(s, reply, fallback, origin.stepUps);
    return;
  }
}

/** The story review is told; the ledger and run log keep it for whoever finishes the branch. */
async function recordConcern(env: StoryLoopEnv, s: LoopState, reply: ImplementerReply): Promise<void> {
  const concern = `${reply.status}: ${reply.concerns ?? ""}`.trim();
  s.concerns = [...s.concerns, concern];
  const marker = reply.interrupted ? " (interrupted)" : "";
  await env.sink.ledger(ledgerText.note(`implementer${marker} ${concern}`));
}

async function review(env: StoryLoopEnv, s: LoopState): Promise<void> {
  if (!s.reviewed) {
    const step = startStep(env.storyId, "story-review", { model: env.steps.modelFor?.("story-review") });
    const out: ReviewOutcome<StoryReviewVerdict> = await env.steps.storyReview(s.concerns, {
      ...s.gates?.states,
      ...s.suite?.states,
    });
    s.reviewed = true;
    if (!out.ran) {
      step.done(`skipped (${out.why})`);
      s.unreviewed = true;
      await env.sink.ledger(ledgerText.reviewSkipped(`story review: ${out.why}`), NO_MIRROR);
      return;
    }
    await ledgerCannotVerify(env.sink, out.verdict.cannotVerify);
    await deferMinors(env, s, out.verdict.findings);
    s.reviewOpen = s.assign(out.verdict.findings.filter(isBlocking));
    const minors = out.verdict.findings.filter((f) => !isBlocking(f));
    step.done(
      `spec ${out.verdict.spec}, quality ${out.verdict.quality} - ${describeFindings([...s.reviewOpen, ...minors])}`,
    );
    return;
  }
  if (s.reviewOpen.length === 0 || s.fixBase === undefined) return;
  const step = startStep(env.storyId, `re-review r${s.round}`, { model: env.steps.modelFor?.("re-review") });
  const out: ReviewOutcome<ReReviewVerdict> = await env.steps.reReview(s.round, s.reviewOpen, s.fixBase);
  s.fixBase = undefined;
  if (!out.ran) {
    step.done(`skipped (${out.why})`);
    await env.sink.ledger(ledgerText.reviewSkipped(`re-review round ${s.round}: ${out.why}`), NO_MIRROR);
    return;
  }
  const asked = s.reviewOpen;
  const absorbed = absorbReReviewVerdict(asked, out.verdict);
  await deferMinors(env, s, absorbed.newDrafts);
  const added = s.assign(absorbed.newDrafts.filter(isBlocking));
  s.reviewOpen = [...absorbed.open, ...added];
  step.done(reReviewSummary(asked, out.verdict, added));
}

/** US-004 (nax#2524): a PARTIAL verdict keeps its id open, so its line names the residual verdict. */
function reReviewStatus(v: ReReviewVerdict["verdicts"][number] | undefined): string {
  if (!v) return "no verdict";
  if (v.residual) return "PARTIAL";
  return v.addressed ? "addressed" : "NOT addressed";
}

function reReviewSummary(
  asked: readonly WorkflowFinding[],
  verdict: ReReviewVerdict,
  added: readonly WorkflowFinding[],
) {
  const per = asked.map((f) => `${f.id} ${reReviewStatus(verdict.verdicts.find((x) => x.id === f.id))}`);
  return added.length > 0 ? `${per.join(", ")}; new: ${describeFindings(added)}` : per.join(", ");
}

async function deferMinors(env: StoryLoopEnv, s: LoopState, drafts: readonly WorkflowFindingDraft[]): Promise<void> {
  for (const minor of drafts.filter((f) => !isBlocking(f))) {
    s.deferredMinors += 1;
    await env.sink.ledger(ledgerText.deferredMinor(minor.issue));
  }
}

/** One pass: gates -> suite -> report check -> review. Red gates or suite return directly to routing. */
async function evaluate(env: StoryLoopEnv, s: LoopState): Promise<WorkflowFinding[]> {
  s.suiteThisIteration = false;
  await env.sink.update({ phase: "gates" });
  s.gates = await env.steps.gates();
  await env.sink.update({ gates: { ...s.gates.states } });
  if (s.gates.red) return [...s.assign(s.gates.findings), ...s.reviewOpen];
  await env.sink.update({ phase: "suite" });
  s.suite = await env.steps.fullSuite();
  s.suiteThisIteration = true;
  const suiteFindings = s.suite.red ? s.assign(s.suite.findings) : [];
  // Preserve the open review's fix base while suite failures bypass re-review, including at the cap.
  if (s.suite.red) return [...suiteFindings, ...s.reviewOpen];
  // One report turn after the suite is non-red, before the review spends itself on a missing report.
  s.reportTurnRan = await runReportCheck(env, s, (turn) => implementTurn(env, turn));
  await env.sink.update({ phase: s.reviewed ? "rereview" : "review" });
  await review(env, s);
  return [...suiteFindings, ...s.reviewOpen];
}

function redGateNames(s: LoopState): GateName[] {
  const states = { ...(s.gates?.states ?? {}), ...(s.suite?.states ?? {}) };
  return (Object.entries(states) as [GateName, string][]).filter(([, v]) => v === "red").map(([g]) => g);
}

async function closeLoop(
  env: StoryLoopEnv,
  s: LoopState,
  state: WorkflowEndState,
  reason: string,
  rulings: readonly WorkflowRuling[],
): Promise<StoryLoopOutcome> {
  await env.sink.update({
    state,
    reason,
    phase: "closed",
    rulings: rulings.length,
    flagged: rulings.filter(isFlaggedRuling).length,
    endedAt: new Date().toISOString(),
  });
  await env.sink.ledger(
    ledgerText.end(state, `${s.round} round(s), ${reason}${s.unreviewed ? ", unreviewed" : ""}`),
    NO_MIRROR, // the stage logs "Story closed" with the same state and reason
  );
  return { state, reason, rounds: s.round, rulings, unreviewed: s.unreviewed };
}

/**
 * The story's first implement turn and the no-work ladder it may open (US-002). When the ladder
 * closes the story, `closeAs` carries the end state `close` uses instead of `deriveEndState`.
 */
export async function implementStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>> {
  const s = new LoopState(state);
  let closeAs: StoryLoopState["closeAs"];
  await env.sink.update({ phase: "implement" });
  const first = await implementTurn(env, { kind: "implement" });
  const result = await runNoWorkLadder(env, first, (turn) => implementTurn(env, turn));
  await absorbTurn(env, s, result.outcome, { stepUps: result.stepUps, limit: "implement" });
  if (result.closed) closeAs = { state: "complete-gate-open", reason: "no work produced" };
  return {
    patch: {
      pendingSession: s.pendingSession,
      nextId: s.nextId,
      questions: s.questions,
      concerns: s.concerns,
      lastTurn: s.lastTurn,
      closeAs,
    },
    exit: result.closed ? "no-work" : "worked",
  };
}

/** The loop's two decisions after a pass, as the graph's three exits. */
function passExit(open: readonly WorkflowFinding[], round: number, maxFixRounds: number): string {
  if (open.length === 0) return "clean";
  return round >= maxFixRounds ? "capped" : "open";
}

/** One loop pass: gates -> suite -> report check -> review, then persist the pass's record patch. */
export async function evaluateStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>> {
  const s = new LoopState(state);
  const open = [...(await evaluate(env, s)), ...s.pendingSession];
  s.pendingSession = [];
  await env.sink.update({
    openFindings: open,
    // Retire the fix base with its re-reviewed findings, never leaving stale findings without their base.
    fixBase: s.fixBase,
    reviewed: s.reviewed,
    unreviewed: s.unreviewed,
    nextFindingId: s.nextId,
    deferredMinors: s.deferredMinors,
  });
  return {
    patch: {
      suiteThisIteration: s.suiteThisIteration,
      gates: s.gates,
      suite: s.suite,
      nextId: s.nextId,
      reviewed: s.reviewed,
      unreviewed: s.unreviewed,
      deferredMinors: s.deferredMinors,
      reviewOpen: s.reviewOpen,
      fixBase: s.fixBase,
      open,
      pendingSession: s.pendingSession,
      reportTurnRan: s.reportTurnRan,
    },
    exit: passExit(open, s.round, env.maxFixRounds),
  };
}

/** Past the cap: advisor rulings; only run the suite if green gates have not reached it this pass. */
export async function residualStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>> {
  const s = new LoopState(state);
  await env.sink.update({ phase: "residual" });
  if (!s.gates?.red && !s.suiteThisIteration) s.suite = await env.steps.fullSuite();
  const items = state.open.filter((f) => f.kind !== "gate");
  const rulings = await adjudicateResidual(
    env.advisor,
    { storyId: env.storyId, items, redGates: redGateNames(s) },
    env.sink.ledger,
  );
  return { patch: { suite: s.suite, rulings } };
}

/** One fix round: the round is spent, the turn runs warm or fresh, and its outcome is absorbed. */
export async function fixStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>> {
  const s = new LoopState(state);
  const warm = Math.min(WARM_ROUND_CAP, env.maxFixRounds);
  const open = state.open;
  s.round += 1;
  const fresh = s.round > warm || state.firstAfterResume;
  if (s.reviewOpen.length > 0 && s.fixBase === undefined) s.fixBase = await env.steps.head();
  await env.sink.ledger(
    ledgerText.fixRound(
      s.round,
      env.maxFixRounds,
      `${open.length} open: ${open.map((f) => f.id).join(", ")}${fresh ? ", fresh" : ""}`,
    ),
  );
  await env.sink.update({ phase: "fix", round: s.round, fixBase: s.fixBase });
  const turn: ImplementTurn = {
    kind: "fix",
    round: s.round,
    fresh,
    stepUps: Math.max(0, s.round - warm),
    findings: open,
    uncommitted: await env.steps.uncommitted(),
  };
  await absorbTurn(env, s, await implementTurn(env, turn), { stepUps: turn.stepUps, limit: "fix" });
  return {
    patch: {
      round: s.round,
      firstAfterResume: false,
      fixBase: s.fixBase,
      pendingSession: s.pendingSession,
      nextId: s.nextId,
      questions: s.questions,
      concerns: s.concerns,
      lastTurn: s.lastTurn,
    },
  };
}

/** The end state (or the one `implement` already chose) and the one close write the loop makes. */
export async function closeStep(env: StoryLoopEnv, state: StoryLoopState): Promise<StepResult<StoryLoopState>> {
  const s = new LoopState(state);
  const end =
    state.closeAs ??
    deriveEndState({ costStop: s.costStop, gates: s.gates, suite: s.suite, rulings: state.rulings.length });
  const outcome = await closeLoop(env, s, end.state, end.reason, state.rulings);
  return { patch: { outcome } };
}
