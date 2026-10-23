import { type CostStop, defineStepGraph, type StepGraph } from "@/step-graph";
import type { FeatureEnv } from "./feature-machine";
import {
  adjudicateStep,
  branchFixStep,
  branchReReviewStep,
  branchReviewStep,
  ciRepairStep,
  featureStep,
  finalGatesStep,
  fixNowMinors,
  gateRepairStep,
  isFollowUpRound,
  NO_MIRROR,
  publishStep,
  repoGatesStep,
  roundTargets,
} from "./feature-steps";
import { ledgerText } from "./ledger";
import type { FeatureStep, WorkflowFeatureRecord } from "./types";

export const FEATURE_GRAPH: StepGraph<WorkflowFeatureRecord, FeatureEnv, FeatureStep> = defineStepGraph({
  start: "repo-gates",
  end: ["done"],
  costStopProduces: ["costLimited"],
  nodes: {
    "repo-gates": {
      kind: "gate",
      produces: ["repoGates", "gateFindings", "nextFindingId"],
      transitions: [{ to: "branch-review" }],
      run: repoGatesStep,
    },
    "branch-review": {
      kind: "agent",
      produces: ["reviewRan", "cannotVerify", "reviewUnread", "reviewOpen", "nextFindingId", "minors", "newMinors"],
      transitions: [{ to: "branch-fix" }],
      run: branchReviewStep,
    },
    "branch-fix": {
      kind: "agent",
      commits: true,
      produces: ["fixBase", "fixRan", "fixRounds"],
      exits: ["nothing-to-fix", "capped", "no-base", "fixed"],
      transitions: [
        { on: "nothing-to-fix", to: "branch-rereview" },
        { on: "capped", to: "adjudicate" },
        { on: "no-base", to: "adjudicate" },
        { on: "fixed", to: "branch-rereview" },
      ],
      run: branchFixStep,
    },
    "branch-rereview": {
      kind: "agent",
      produces: ["reReviewSkipped", "reviewOpen", "nextFindingId", "minors", "newMinors", "fixTargets"],
      exits: ["nothing-to-check", "skipped", "again", "settled"],
      transitions: [
        { on: "nothing-to-check", to: "adjudicate" },
        { on: "skipped", to: "adjudicate" },
        { on: "again", to: "branch-fix" },
        { on: "settled", to: "adjudicate" },
      ],
      run: branchReReviewStep,
    },
    adjudicate: { kind: "agent", produces: ["rulings"], transitions: [{ to: "final-gates" }], run: adjudicateStep },
    "final-gates": {
      kind: "gate",
      produces: ["finalGates", "finalGateFindings", "gateRepairFindings"],
      exits: ["reused", "green", "repair", "red"],
      transitions: [
        { on: "reused", to: "publish" },
        { on: "green", to: "publish" },
        { on: "repair", to: "gate-repair" },
        { on: "red", to: "publish" },
      ],
      run: finalGatesStep,
    },
    "gate-repair": {
      kind: "agent",
      commits: true,
      produces: ["gateRepairRounds"],
      transitions: [{ to: "final-gates" }],
      run: gateRepairStep,
    },
    // US-007: the CI repair of a draft PR whose CI failed. The repair is a committing agent node,
    // so the run reads the repo gates again before it publishes the repaired branch.
    "ci-repair": {
      kind: "agent",
      commits: true,
      // US-005: the reply's concerns join the round and the findings it already records.
      produces: ["ciRepairRounds", "ciRepairFindings", "ciRepairConcerns"],
      transitions: [{ to: "final-gates" }],
      run: ciRepairStep,
    },
    publish: {
      kind: "forge",
      commits: true,
      produces: [
        "outcome",
        "ci",
        "reasons",
        "url",
        "approval",
        "ciDetail",
        "storyStates",
        "head",
        "passed",
        "flaggedDecisions",
        "ciRepairFindings",
        // US-005: the checks a decided repair targets.
        "ciRepairTargets",
        "endedAt",
      ],
      exits: ["ci-repair"],
      transitions: [{ on: "ci-repair", to: "ci-repair" }, { to: "done" }],
      run: publishStep,
    },
  },
  costStop: async (node, rec, env): Promise<CostStop<WorkflowFeatureRecord, FeatureStep> | undefined> => {
    if (!hasAgentWork(node, rec)) return undefined;
    featureStep(node, false).done("skipped (cost limit reached)");
    await env.sink.ledger(ledgerText.note(`cost limit reached: ${node} skipped`), NO_MIRROR);
    return { patch: { costLimited: true }, to: "final-gates" };
  },
});

function hasAgentWork(step: FeatureStep, rec: WorkflowFeatureRecord): boolean {
  if (step === "branch-review") return rec.seed !== null && rec.seed !== "";
  if (step === "branch-fix")
    return (
      (isFollowUpRound(rec) ? roundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings])
        .length > 0
    );
  if (step === "branch-rereview")
    return (
      (isFollowUpRound(rec) ? roundTargets(rec) : [...rec.reviewOpen, ...fixNowMinors(rec)]).length > 0 &&
      Boolean(rec.fixBase)
    );
  if (step === "adjudicate") return rec.reviewOpen.length > 0;
  if (step === "ci-repair") return (rec.ciRepairFindings?.length ?? 0) > 0;
  return step === "gate-repair" && (rec.gateRepairFindings?.length ?? 0) > 0;
}
