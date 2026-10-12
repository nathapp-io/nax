/**
 * The story state machine (spec §6). Pure orchestration over injected steps:
 * no I/O of its own, so every branch is unit-testable. W-R3: it always returns
 * an end state; it never fails or pauses a story.
 */
import { adjudicateResidual } from "./adjudicate";
import type { WorkflowAdvisor } from "./advisor";
import { deriveEndState } from "./close";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { ledgerText } from "./ledger";
import type { ReviewOutcome } from "./story-review";
import type {
  GateName,
  GateRunResult,
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
  storyReview(concerns: readonly string[]): Promise<ReviewOutcome<StoryReviewVerdict>>;
  reReview(
    round: number,
    findings: readonly WorkflowFinding[],
    fixBase: string,
  ): Promise<ReviewOutcome<ReReviewVerdict>>;
  head(): Promise<string>;
  uncommitted(): Promise<string[]>;
  costExceeded(): boolean;
}
export interface StoryLoopSink {
  update(patch: Partial<WorkflowStoryRecord>): Promise<void>;
  ledger(text: string): Promise<void>;
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
        current = await env.steps.implement({
          kind: "answer",
          text: answer,
          stepUps: origin.stepUps,
          limit: origin.limit,
        });
        continue;
      }
    }
    if (reply.status !== "DONE" || reply.interrupted) {
      s.concerns = [...s.concerns, `${reply.status}: ${reply.concerns ?? ""}`.trim()];
    }
    return;
  }
}

async function review(env: StoryLoopEnv, s: LoopState): Promise<void> {
  if (!s.reviewed) {
    const out: ReviewOutcome<StoryReviewVerdict> = await env.steps.storyReview(s.concerns);
    s.reviewed = true;
    if (!out.ran) {
      s.unreviewed = true;
      await env.sink.ledger(ledgerText.reviewSkipped(`story review: ${out.why}`));
      return;
    }
    for (const item of out.verdict.cannotVerify) await env.sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
    await deferMinors(env, s, out.verdict.findings);
    s.reviewOpen = s.assign(out.verdict.findings.filter(isBlocking));
    return;
  }
  if (s.reviewOpen.length === 0 || s.fixBase === undefined) return;
  const out: ReviewOutcome<ReReviewVerdict> = await env.steps.reReview(s.round, s.reviewOpen, s.fixBase);
  s.fixBase = undefined;
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`re-review round ${s.round}: ${out.why}`));
    return;
  }
  const stillOpen = new Set(out.verdict.verdicts.filter((v) => !v.addressed).map((v) => v.id));
  await deferMinors(env, s, out.verdict.newFindings);
  s.reviewOpen = [
    ...s.reviewOpen.filter((f) => stillOpen.has(f.id)),
    ...s.assign(out.verdict.newFindings.filter(isBlocking)),
  ];
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

  if (!resumed) {
    await env.sink.update({ phase: "implement" });
    await absorbTurn(env, s, await env.steps.implement({ kind: "implement" }), { stepUps: 0, limit: "implement" });
  }

  for (;;) {
    if (env.steps.costExceeded()) {
      s.costStop = true;
      break;
    }
    const open = [...(await evaluate(env, s)), ...s.pendingSession];
    s.pendingSession = [];
    await env.sink.update({
      openFindings: open,
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
    await env.sink.update({ phase: "fix", round: s.round });
    const turn: ImplementTurn = {
      kind: "fix",
      round: s.round,
      fresh,
      stepUps: Math.max(0, s.round - warm),
      findings: open,
      uncommitted: await env.steps.uncommitted(),
    };
    await absorbTurn(env, s, await env.steps.implement(turn), { stepUps: turn.stepUps, limit: "fix" });
  }

  const end = deriveEndState({ costStop: s.costStop, gates: s.gates, suite: s.suite, rulings: rulings.length });
  return closeLoop(env, s, end.state, end.reason, rulings);
}

async function closeLoop(
  env: StoryLoopEnv,
  s: LoopState,
  state: WorkflowEndState,
  reason: string,
  rulings: readonly WorkflowRuling[],
): Promise<StoryLoopOutcome> {
  await env.sink.update({ state, reason, phase: "closed", rulings: rulings.length, endedAt: new Date().toISOString() });
  await env.sink.ledger(ledgerText.end(state, `${s.round} round(s), ${reason}${s.unreviewed ? ", unreviewed" : ""}`));
  return { state, reason, rounds: s.round, rulings, unreviewed: s.unreviewed };
}
