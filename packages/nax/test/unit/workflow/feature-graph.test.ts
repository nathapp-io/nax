import { describe, expect, mock, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { type StepKind, validateStepGraph } from "@/step-graph";
import { FEATURE_GRAPH } from "@/workflow/feature-graph";
import { runFeatureMachine } from "@/workflow/feature-machine";
import type { FeatureStep } from "@/workflow/types";

const NODE_IDS = [
  "repo-gates",
  "branch-review",
  "branch-fix",
  "branch-rereview",
  "adjudicate",
  "final-gates",
  "gate-repair",
  "ci-repair",
  "publish",
] as const;
type NodeId = (typeof NODE_IDS)[number];
function nodeFor(id: NodeId) {
  const node = FEATURE_GRAPH.nodes[id];
  if (!node) throw new Error(`Missing graph node: ${id}`);
  return node;
}

const expectedTransitions: Record<NodeId, { on?: string; to: FeatureStep }[]> = {
  "repo-gates": [{ to: "branch-review" }],
  "branch-review": [{ to: "branch-fix" }],
  "branch-fix": [
    { on: "nothing-to-fix", to: "branch-rereview" },
    { on: "capped", to: "adjudicate" },
    { on: "no-base", to: "adjudicate" },
    { on: "fixed", to: "branch-rereview" },
  ],
  "branch-rereview": [
    { on: "nothing-to-check", to: "adjudicate" },
    { on: "skipped", to: "adjudicate" },
    { on: "again", to: "branch-fix" },
    { on: "settled", to: "adjudicate" },
  ],
  adjudicate: [{ to: "final-gates" }],
  "final-gates": [
    { on: "reused", to: "publish" },
    { on: "green", to: "publish" },
    { on: "repair", to: "gate-repair" },
    { on: "red", to: "publish" },
  ],
  "gate-repair": [{ to: "final-gates" }],
  "ci-repair": [{ to: "final-gates" }],
  publish: [{ on: "ci-repair", to: "ci-repair" }, { to: "done" }],
};
const expectedExits: Partial<Record<NodeId, string[]>> = {
  "branch-fix": ["nothing-to-fix", "capped", "no-base", "fixed"],
  "branch-rereview": ["nothing-to-check", "skipped", "again", "settled"],
  "final-gates": ["reused", "green", "repair", "red"],
  publish: ["ci-repair"],
};
const expectedProduces: Record<NodeId, string[]> = {
  "repo-gates": ["repoGates", "gateFindings", "nextFindingId"],
  "branch-review": ["reviewRan", "cannotVerify", "reviewUnread", "reviewOpen", "nextFindingId", "minors", "newMinors"],
  "branch-fix": ["fixBase", "fixRan", "fixRounds"],
  "branch-rereview": ["reReviewSkipped", "reviewOpen", "nextFindingId", "minors", "newMinors", "fixTargets"],
  adjudicate: ["rulings"],
  "final-gates": ["finalGates", "finalGateFindings", "gateRepairFindings"],
  // US-004: the gate repair also records the evidence-only review of its committed diff.
  "gate-repair": ["gateRepairRounds", "repairReviews"],
  // US-005: `ci-repair` also records the concerns its replies raised, and the evidence-only review
  // of its committed diff (the same line `gate-repair` records).
  "ci-repair": ["ciRepairRounds", "ciRepairFindings", "ciRepairConcerns", "repairReviews"],
  publish: [
    "outcome",
    "ci",
    "reasons",
    "url",
    "approval",
    "ciDetail",
    "storyStates",
    "head",
    "passed",
    "pushFailed",
    "flaggedDecisions",
    "ciRepairFindings",
    // US-005: the checks the decided repair targets.
    "ciRepairTargets",
    // US-006: the checks still red once the repair allowance is spent.
    "ciRemaining",
    // US-003: the PR this publish left with no item index.
    "itemIndexMissing",
    "endedAt",
  ],
};

describe("FEATURE_GRAPH", () => {
  test("declares every node kind, output set, ordered transition, and exit", () => {
    expect(validateStepGraph(FEATURE_GRAPH)).toEqual({ errors: [] });
    expect(FEATURE_GRAPH.start).toBe("repo-gates");
    expect(FEATURE_GRAPH.end).toEqual(["done"]);
    const expectedKinds: Record<NodeId, StepKind> = {
      "repo-gates": "gate",
      "branch-review": "agent",
      "branch-fix": "agent",
      "branch-rereview": "agent",
      adjudicate: "agent",
      "final-gates": "gate",
      "gate-repair": "agent",
      "ci-repair": "agent",
      publish: "forge",
    };
    for (const id of NODE_IDS) {
      const node = nodeFor(id);
      expect(node.kind).toBe(expectedKinds[id]);
      expect([...node.produces].sort()).toEqual([...expectedProduces[id]].sort());
      expect(node.transitions.map(({ on, to }) => (on === undefined ? { to } : { on, to }))).toEqual(
        expectedTransitions[id],
      );
      if (expectedExits[id]) expect([...(node.exits ?? [])].sort()).toEqual([...(expectedExits[id] ?? [])].sort());
      else expect(node.exits).toBeUndefined();
    }
    expect(
      NODE_IDS.filter((id) => nodeFor(id).kind === "agent").toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["adjudicate", "branch-fix", "branch-rereview", "branch-review", "ci-repair", "gate-repair"]);
    expect(
      NODE_IDS.filter((id) => nodeFor(id).commits === true).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["branch-fix", "ci-repair", "gate-repair", "publish"]);
    expect(FEATURE_GRAPH.costStopProduces).toEqual(["costLimited"]);
  });

  // US-003: the publish node's patch carries whether the PR it published has an item index, so the
  // node has to declare it — the runner rejects a patch key the node does not produce.
  test("AC-5 the publish node accepts itemIndexMissing and the record keeps it", async () => {
    const { env } = makeFeatureMachineHarness({});
    const final = await runFeatureMachine({
      ...env,
      record: { ...env.record, step: "publish" },
      itemThreadsIdentity: { projectDir: "/repo", feature: "demo" },
      steps: {
        ...env.steps,
        head: async () => "a".repeat(40),
        changedFiles: async () => ["file.ts"],
        postItemThreads: async () => ({
          posted: 1,
          closed: 0,
          skipped: 0,
          failed: 0,
          indexWritten: false,
          indexMissing: true,
        }),
      },
    });
    expect(final.itemIndexMissing).toBe(true);
    expect(final.step).toBe("done");
  });

  test("cost stop returns its patch and exact ledger arguments only when there is work", async () => {
    const { env } = makeFeatureMachineHarness({});
    const record = {
      ...env.record,
      reviewOpen: [{ id: "B1", kind: "quality" as const, severity: "important" as const, issue: "issue" }],
    };
    const ledger = mock(async (_text: string, _options?: { mirror?: boolean }) => {});
    const stoppingEnv = { ...env, sink: { ...env.sink, ledger } };
    expect(await FEATURE_GRAPH.costStop?.("branch-fix", record, stoppingEnv)).toEqual({
      patch: { costLimited: true },
      to: "final-gates",
    });
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveBeenCalledWith("cost limit reached: branch-fix skipped", { mirror: false });
    ledger.mockClear();
    expect(await FEATURE_GRAPH.costStop?.("adjudicate", { ...record, reviewOpen: [] }, stoppingEnv)).toBeUndefined();
    expect(await FEATURE_GRAPH.costStop?.("branch-review", { ...record, seed: null }, stoppingEnv)).toBeUndefined();
    expect(ledger).not.toHaveBeenCalled();
  });
});
