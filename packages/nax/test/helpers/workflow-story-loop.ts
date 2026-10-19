/**
 * G0 (step-graph equivalence): a scripted `StoryLoopEnv` for `runStoryLoop` (US-003), in the style of
 * `makeFeatureMachineHarness`. Every seam the loop injects is queued from the script, so a scenario is
 * a few lines of data rather than a bespoke harness, and the same script drives the trace recorder.
 *
 * Queues are cloned per factory call, the record keeps a deterministic timestamp, and HEAD answers with
 * synthetic SHAs (`h1`, `h2`, ...), so two runs of one script are byte-identical.
 */
import { defaultWorkflowAdvisor, type WorkflowAdvisor } from "@/workflow/advisor";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import type { StoryLoopEnv, StoryLoopSteps } from "@/workflow/story-loop";
import type { ReviewOutcome } from "@/workflow/story-review";
import type {
  GateName,
  GateRunResult,
  GateState,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowStoryRecord,
} from "@/workflow/types";

const GREEN: GateRunResult = {
  red: false,
  states: { lint: "green", typecheck: "green", scoped: "green" },
  findings: [],
};
const SUITE_GREEN: GateRunResult = { red: false, states: { "full-suite": "green" }, findings: [] };
const RED_LINT: GateRunResult = {
  red: true,
  states: { lint: "red" },
  findings: [{ kind: "gate", gate: "lint", severity: "important", issue: "issue one" }],
};
const SUITE_RED: GateRunResult = {
  red: true,
  states: { "full-suite": "red" },
  findings: [{ kind: "gate", gate: "full-suite", severity: "important", issue: "issue one" }],
};
const PASS: StoryReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const OK: ImplementOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};

/** The scripted runs' fixtures: a green/red gate and suite, a passing review and a done reply. */
export const storyLoopFixtures = { GREEN, SUITE_GREEN, RED_LINT, SUITE_RED, PASS, OK };

/** The story id the harness records under; every golden uses a synthetic `US-00N`. */
const STORY_ID = "US-001";
/** The record's deterministic `startedAt`: G0 injects no clock, and the trace normalizes `endedAt`. */
const STARTED_AT = "t";

/** A review verdict failing on `count` important spec findings, all of them `issue one`-shaped. */
export function failingReview(count = 1): StoryReviewVerdict {
  return {
    ...PASS,
    spec: "fail",
    quality: "changes",
    findings: Array.from({ length: count }, () => ({
      kind: "spec" as const,
      severity: "important" as const,
      issue: "issue one",
    })),
  };
}

/**
 * A re-review verdict: every id listed is addressed, and the drafts are its new findings. The shape a
 * scenario needs when a plain addressed flag cannot say what the reviewer added.
 */
export function reReviewVerdict(
  addressedIds: readonly string[],
  newFindings: readonly WorkflowFindingDraft[] = [],
): ReReviewVerdict {
  return { verdicts: addressedIds.map((id) => ({ id, addressed: true, note: "" })), newFindings };
}

/** The deterministic advisor, with the answer or ruling a scenario needs laid over it. */
export function makeStoryLoopAdvisor(over: Partial<WorkflowAdvisor> = {}): WorkflowAdvisor {
  return { ...defaultWorkflowAdvisor, ...over };
}

export interface StoryLoopScript {
  /** Queued `gates()` results, in order; an exhausted queue is green. */
  readonly gates?: readonly GateRunResult[];
  /** Queued `fullSuite()` results, in order; an exhausted queue is green. */
  readonly suite?: readonly GateRunResult[];
  /** Queued story-review verdicts, in order; `null` is a review that did not run. An exhausted queue passes. */
  readonly review?: readonly (StoryReviewVerdict | null)[];
  /** Explicit re-review verdicts, in order, taken ahead of `reReviewAllAddressed`; `null` is a skipped one. */
  readonly reReviews?: readonly (ReReviewVerdict | null)[];
  /** The addressed flag of each `reReview` call, in order; an exhausted queue addresses everything. */
  readonly reReviewAllAddressed?: readonly boolean[];
  /** The implementer's answer for a turn; absent replies `DONE`. */
  readonly implement?: (turn: ImplementTurn) => ImplementOutcome | Promise<ImplementOutcome>;
}

export interface StoryLoopHarnessOpts {
  readonly storyId?: string;
  readonly maxFixRounds?: number;
  /** The advisor seam, for implementer answers and residual rulings; absent is the deterministic default. */
  readonly advisor?: WorkflowAdvisor;
  /** A prior run's unfinished record (spec §10); absent starts a fresh story. */
  readonly resume?: WorkflowStoryRecord | null;
  /**
   * Extra step behaviour spread over the scripted steps — `costExceeded`, a `fullSuite` that stays red,
   * `workProduced`. An optional step left out here stays absent from the env, as the loop requires.
   */
  readonly steps?: Partial<StoryLoopSteps>;
}

/** One re-review as the loop asked for it, so a scenario can assert the round and findings it was handed. */
export interface ReReviewCall {
  readonly round: number;
  readonly findings: readonly WorkflowFinding[];
  readonly fixBase: string;
}

const reviewOutcome = (queued: StoryReviewVerdict | null): ReviewOutcome<StoryReviewVerdict> =>
  queued === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: queued };

/** An explicit verdict wins; otherwise the next addressed flag; otherwise everything was addressed. */
function reReviewOutcome(
  findings: readonly WorkflowFinding[],
  queued: ReReviewVerdict | null | undefined,
  addressed: boolean | undefined,
): ReviewOutcome<ReReviewVerdict> {
  if (queued === null) return { ran: false, why: "timeout" };
  if (queued !== undefined) return { ran: true, verdict: queued };
  const flag = addressed ?? true;
  return {
    ran: true,
    verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: flag, note: "" })), newFindings: [] },
  };
}

export interface StoryLoopHarness {
  readonly env: StoryLoopEnv;
  /** Every implement turn the loop asked for, in order. */
  readonly turns: ImplementTurn[];
  /** Every ledger line the loop wrote, in order. */
  readonly ledger: string[];
  /** Every `sink.update` patch, in order. */
  readonly updates: Partial<WorkflowStoryRecord>[];
  /** The gate states each story review was handed (US-006). */
  readonly reviewGates: (Readonly<Partial<Record<GateName, GateState>>> | undefined)[];
  /** Every re-review as the loop asked for it, in order. */
  readonly reReviews: ReReviewCall[];
  /** The record as the patches accumulated it. */
  record(): WorkflowStoryRecord;
}

export function makeStoryLoopHarness(script: StoryLoopScript = {}, over: StoryLoopHarnessOpts = {}): StoryLoopHarness {
  const storyId = over.storyId ?? STORY_ID;
  const maxFixRounds = over.maxFixRounds ?? 5;
  const turns: ImplementTurn[] = [];
  const ledger: string[] = [];
  const updates: Partial<WorkflowStoryRecord>[] = [];
  const reviewGates: (Readonly<Partial<Record<GateName, GateState>>> | undefined)[] = [];
  const reReviews: ReReviewCall[] = [];
  const gates = [...(script.gates ?? [])];
  const suites = [...(script.suite ?? [])];
  const reviews = [...(script.review ?? [])];
  const verdicts = [...(script.reReviews ?? [])];
  const addressedFlags = [...(script.reReviewAllAddressed ?? [])];
  let head = 0;
  let record: WorkflowStoryRecord = newStoryRecord(storyId, maxFixRounds, STARTED_AT);
  const steps: StoryLoopSteps = {
    implement: async (turn) => {
      turns.push(turn);
      return script.implement ? await script.implement(turn) : OK;
    },
    gates: async () => gates.shift() ?? GREEN,
    fullSuite: async () => suites.shift() ?? SUITE_GREEN,
    storyReview: async (_concerns, gateStates) => {
      reviewGates.push(gateStates);
      const queued = reviews.shift();
      return reviewOutcome(queued === undefined ? PASS : queued);
    },
    reReview: async (round, findings, fixBase) => {
      reReviews.push({ round, findings: [...findings], fixBase });
      return reReviewOutcome(findings, verdicts.shift(), addressedFlags.shift());
    },
    head: async () => `h${++head}`,
    uncommitted: async () => [],
    costExceeded: () => false,
    ...over.steps,
  };
  const env: StoryLoopEnv = {
    storyId,
    maxFixRounds,
    steps,
    advisor: over.advisor ?? defaultWorkflowAdvisor,
    sink: {
      update: async (patch) => {
        updates.push(patch);
        record = { ...record, ...patch };
      },
      ledger: async (text) => {
        ledger.push(text);
      },
    },
    resume: over.resume ?? null,
  };
  return { env, turns, ledger, updates, reviewGates, reReviews, record: () => record };
}
