/**
 * The story state machine (spec §6). Pure orchestration over injected steps:
 * no I/O of its own, so every branch is unit-testable. W-R3: it always returns
 * an end state; it never fails or pauses a story.
 */
import { adjudicateResidual } from "./adjudicate";
import { isFlaggedRuling, type WorkflowAdvisor } from "./advisor";
import { deriveEndState } from "./close";
import { ledgerCannotVerify } from "./gate-timing";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { type LedgerWriteOptions, ledgerText } from "./ledger";
import { runNoWorkLadder } from "./no-work";
import { absorbReReviewVerdict } from "./re-review-absorb";
import { describeFindings, type StepModel, startStep } from "./run-log";
import type { ReviewOutcome } from "./story-review";
import type {
  GateName,
  GateRunResult,
  GateState,
  ImplementerReply,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowEndState,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
  WorkflowStoryRecord,
} from "./types";

export const WARM_ROUND_CAP = 3;
export const MAX_IMPLEMENTER_QUESTIONS = 2;

export interface StoryLoopSteps {
  implement(turn: ImplementTurn): Promise<ImplementOutcome>;
  gates(): Promise<GateRunResult>;
  fullSuite(): Promise<GateRunResult>;
  /**
   * US-006 (nax#2527): `gates` is the states the loop already recorded, so the reviewer prompt
   * states what nax checked. Optional so a caller that never ran the gates still compiles.
   */
  storyReview(
    concerns: readonly string[],
    gates?: Readonly<Partial<Record<GateName, GateState>>>,
  ): Promise<ReviewOutcome<StoryReviewVerdict>>;
  reReview(
    round: number,
    findings: readonly WorkflowFinding[],
    fixBase: string,
  ): Promise<ReviewOutcome<ReReviewVerdict>>;
  head(): Promise<string>;
  uncommitted(): Promise<string[]>;
  costExceeded(): boolean;
  /**
   * US-002: did the story leave any work evidence behind? Absent means "work produced", so the
   * no-work guard never fires for a caller that has not wired it.
   */
  workProduced?(): Promise<boolean>;
  /** The model a step will run on, for its start line (nax#2491 P6). Optional: absent names none. */
  modelFor?(step: "implementer" | "story-review" | "re-review", turn?: ImplementTurn): StepModel | undefined;
}
export interface StoryLoopSink {
  update(patch: Partial<WorkflowStoryRecord>): Promise<void>;
  ledger(text: string, options?: LedgerWriteOptions): Promise<void>;
}
export interface StoryLoopEnv {
  readonly storyId: string;
  readonly maxFixRounds: number;
  readonly steps: StoryLoopSteps;
  readonly advisor: WorkflowAdvisor;
  readonly sink: StoryLoopSink;
  /** A prior run's unfinished record (spec §10 resume); null for a fresh story. */
  readonly resume: WorkflowStoryRecord | null;
}
export interface StoryLoopOutcome {
  readonly state: WorkflowEndState;
  readonly reason: string;
  readonly rounds: number;
  readonly rulings: readonly WorkflowRuling[];
  readonly unreviewed: boolean;
}

/** The step line in the log already says it; ledger.md still records it. */
const NO_MIRROR: LedgerWriteOptions = { mirror: false };

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";

class LoopState {
  round: number;
  reviewed: boolean;
  unreviewed: boolean;
  nextId: number;
  reviewOpen: WorkflowFinding[];
  pendingSession: WorkflowFinding[] = [];
  concerns: string[] = [];
  questions = 0;
  deferredMinors: number;
  fixBase: string | undefined;
  gates: GateRunResult | undefined;
  suite: GateRunResult | undefined;
  suiteThisIteration = false;
  costStop = false;

  constructor(resume: WorkflowStoryRecord | null) {
    this.fixBase = resume?.fixBase;
    this.round = resume?.round ?? 0;
    this.reviewed = resume?.reviewed ?? false;
    this.unreviewed = resume?.unreviewed ?? false;
    this.nextId = resume?.nextFindingId ?? 1;
    this.deferredMinors = resume?.deferredMinors ?? 0;
    this.reviewOpen = (resume?.openFindings ?? []).filter((f) => f.kind === "spec" || f.kind === "quality");
  }

  assign(drafts: readonly WorkflowFindingDraft[]): WorkflowFinding[] {
    return drafts.map((d) => ({ ...d, id: `F${this.nextId++}` }));
  }
}

interface TurnOrigin {
  readonly stepUps: number;
  readonly limit: "implement" | "fix";
}

export const turnLabel = (turn: ImplementTurn): string => {
  if (turn.kind === "implement") return "implementer";
  if (turn.kind === "answer") return "implementer answer";
  // US-001: a restart is its own run-log step, so a no-work story's restarts read distinctly from the first turn.
  if (turn.kind === "restart") return turn.fresh ? "implementer restart (fresh)" : "implementer restart";
  return `fix r${turn.round}`;
};

/** One implementer call, labelled in the run log with its step and round (nax#2491 P2). */
async function implementTurn(env: StoryLoopEnv, turn: ImplementTurn): Promise<ImplementOutcome> {
  const step = startStep(env.storyId, turnLabel(turn), { model: env.steps.modelFor?.("implementer", turn) });
  const out = await env.steps.implement(turn);
  step.done(out.failure ? `failed (${out.failure})` : (out.reply?.status ?? "no reply"));
  return out;
}

async function absorbTurn(
  env: StoryLoopEnv,
  s: LoopState,
  outcome: ImplementOutcome,
  origin: TurnOrigin,
): Promise<void> {
  let current = outcome;
  for (;;) {
    if (current.failure) {
      s.pendingSession = [
        ...s.pendingSession,
        ...s.assign([
          { kind: "session", severity: "important", issue: `implementer session failed: ${current.failure}` },
        ]),
      ];
      return;
    }
    if (current.autoCommitted)
      await env.sink.ledger(ledgerText.note("auto-committed the implementer's uncommitted edits"));
    const reply = current.reply;
    if (!reply) return;
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
    const out: ReviewOutcome<StoryReviewVerdict> = await env.steps.storyReview(s.concerns, s.gates?.states);
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

/** One pass of gates -> review -> suite. Returns the open findings, or [] when the story is clean. */
async function evaluate(env: StoryLoopEnv, s: LoopState): Promise<WorkflowFinding[]> {
  s.suiteThisIteration = false;
  await env.sink.update({ phase: "gates" });
  s.gates = await env.steps.gates();
  await env.sink.update({ gates: { ...s.gates.states } });
  if (s.gates.red) return [...s.assign(s.gates.findings), ...s.reviewOpen];
  await env.sink.update({ phase: s.reviewed ? "rereview" : "review" });
  await review(env, s);
  if (s.reviewOpen.length > 0) return [...s.reviewOpen];
  await env.sink.update({ phase: "suite" });
  s.suite = await env.steps.fullSuite();
  s.suiteThisIteration = true;
  return s.suite.red ? s.assign(s.suite.findings) : [];
}

function redGateNames(s: LoopState): GateName[] {
  const states = { ...(s.gates?.states ?? {}), ...(s.suite?.states ?? {}) };
  return (Object.entries(states) as [GateName, string][]).filter(([, v]) => v === "red").map(([g]) => g);
}

export async function runStoryLoop(env: StoryLoopEnv): Promise<StoryLoopOutcome> {
  const s = new LoopState(env.resume);
  const warm = Math.min(WARM_ROUND_CAP, env.maxFixRounds);
  const resumed = env.resume !== null;
  let firstAfterResume = resumed;
  let rulings: readonly WorkflowRuling[] = [];

  const early = await openStory(env, s);
  if (early) return early;

  for (;;) {
    if (env.steps.costExceeded()) {
      s.costStop = true;
      break;
    }
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
    if (open.length === 0) break;
    if (s.round >= env.maxFixRounds) {
      await env.sink.update({ phase: "residual" });
      if (!s.gates?.red && !s.suiteThisIteration) s.suite = await env.steps.fullSuite();
      const items = open.filter((f) => f.kind !== "gate");
      rulings = await adjudicateResidual(
        env.advisor,
        { storyId: env.storyId, items, redGates: redGateNames(s) },
        env.sink.ledger,
      );
      break;
    }
    if (env.steps.costExceeded()) {
      s.costStop = true;
      break;
    }
    s.round += 1;
    const fresh = s.round > warm || firstAfterResume;
    firstAfterResume = false;
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
  }

  const end = deriveEndState({ costStop: s.costStop, gates: s.gates, suite: s.suite, rulings: rulings.length });
  return closeLoop(env, s, end.state, end.reason, rulings);
}

/**
 * The first implement turn of a fresh story, and the no-work ladder it may open (US-002).
 * Lifted out of `runStoryLoop` so the loop's own cognitive complexity does not grow.
 */
async function openStory(env: StoryLoopEnv, s: LoopState): Promise<StoryLoopOutcome | undefined> {
  if (env.resume !== null) return undefined;
  await env.sink.update({ phase: "implement" });
  const first = await implementTurn(env, { kind: "implement" });
  const result = await runNoWorkLadder(env, first, (turn) => implementTurn(env, turn));
  await absorbTurn(env, s, result.outcome, { stepUps: result.stepUps, limit: "implement" });
  if (!result.closed) return undefined;
  return closeLoop(env, s, "complete-gate-open", "no work produced", []);
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
