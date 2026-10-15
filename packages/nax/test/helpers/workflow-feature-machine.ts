/** A scripted `FeatureEnv` for `runFeatureMachine` tests: every step records its call and input. */
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import type { BranchReviewFacts } from "@/workflow/branch-review";
import type { FeatureEnv, FeatureLimits, FeatureSteps } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { PublishOutcome } from "@/workflow/finalize";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type {
  BranchReviewVerdict,
  FeatureStep,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
} from "@/workflow/types";

const GREEN: RepoGateRun = { summary: { ran: ["build", "test"], failing: [] }, findings: [] };
const PASS: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const FIXED: BranchFixOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
  dirty: false,
};
const PUBLISHED: PublishOutcome = { outcome: "ready", ci: "pending", url: "https://gh/pr/1", reasons: [] };

export const featureMachineFixtures = { GREEN, PASS, FIXED, PUBLISHED } as const;

export function makeDoneStory(id: string, over: Partial<StorySummary> = {}): StorySummary {
  return { id, title: id, state: "complete", rounds: 0, unreviewed: false, flagged: 0, ...over };
}

export interface FeatureMachineScript {
  gates?: RepoGateRun[];
  review?: BranchReviewVerdict | null;
  reReview?: ReReviewVerdict | null;
  reReviews?: (ReReviewVerdict | null)[];
  changed?: string[] | Error;
  fix?: BranchFixOutcome;
}

export interface FeatureMachineHarnessOpts {
  record?: WorkflowFeatureRecord;
  stories?: StorySummary[];
  aborted?: boolean;
  limits?: FeatureLimits;
  /** nax#2550: the run's cost check, read before each agent step; absent = never exceeded. */
  costExceeded?: (calls: readonly string[]) => boolean;
}

/** The re-review a script did not queue: every item addressed, nothing new. */
function allAddressed(findings: readonly WorkflowFinding[]): ReReviewVerdict {
  return { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] };
}

export function makeFeatureMachineHarness(script: FeatureMachineScript, over: FeatureMachineHarnessOpts = {}) {
  const calls: string[] = [];
  const ledger: string[] = [];
  const artifacts: Record<string, unknown> = {};
  const stepsSeen: FeatureStep[] = [];
  const updates: WorkflowFeatureRecord[] = [];
  const fixInputs: (readonly WorkflowFinding[])[] = [];
  const reviewFacts: BranchReviewFacts[] = [];
  const reReviewInputs: (readonly WorkflowFinding[])[] = [];
  const adjudicated: (readonly WorkflowFinding[])[] = [];
  const gates = [...(script.gates ?? [])];
  const reReviewQueue = [...(script.reReviews ?? [])];
  let clock = 0;
  const steps: FeatureSteps = {
    repoGates: async () => {
      calls.push("repoGates");
      return gates.shift() ?? GREEN;
    },
    branchReview: async (seed, facts) => {
      calls.push(`branchReview:${seed}`);
      reviewFacts.push(facts);
      const v = script.review === undefined ? PASS : script.review;
      return v === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: v };
    },
    branchFix: async (findings) => {
      calls.push("branchFix");
      fixInputs.push(findings);
      return script.fix ?? FIXED;
    },
    branchReReview: async (findings, fixBase) => {
      calls.push(`branchReReview:${fixBase}`);
      reReviewInputs.push(findings);
      const queued = reReviewQueue.length > 0 ? reReviewQueue.shift() : undefined;
      const v =
        queued !== undefined ? queued : script.reReview === undefined ? allAddressed(findings) : script.reReview;
      return v === null ? { ran: false, why: "timeout" } : { ran: true, verdict: v };
    },
    adjudicate: async (items) => {
      calls.push("adjudicate");
      adjudicated.push(items);
      return items.map((f) => ({
        findingId: f.id,
        action: "hold" as const,
        text: `hold ${f.id}`,
        why: "w",
        costIfWrong: "c",
        source: "default" as const,
      }));
    },
    publish: async () => {
      calls.push("publish");
      return PUBLISHED;
    },
    head: async () => `h${calls.length}`,
    changedFiles: async () => {
      calls.push("changedFiles");
      if (script.changed instanceof Error) throw script.changed;
      return script.changed ?? [];
    },
  };
  const env: FeatureEnv = {
    steps,
    sink: {
      update: async (r) => {
        updates.push(r);
      },
      ledger: async (t) => {
        ledger.push(t);
      },
      step: (s) => {
        stepsSeen.push(s);
      },
      artifact: async (name, value) => {
        artifacts[name] = value;
      },
    },
    facts: { stories: over.stories ?? [makeDoneStory("US-001")], parked: [], cannotVerify: [] },
    record: over.record ?? newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    aborted: () => over.aborted === true,
    now: () => (clock += 5),
    ...(over.limits ? { limits: over.limits } : {}),
    ...(over.costExceeded ? { costExceeded: () => over.costExceeded?.(calls) === true } : {}),
  };
  return { env, calls, ledger, artifacts, stepsSeen, updates, fixInputs, reviewFacts, reReviewInputs, adjudicated };
}
