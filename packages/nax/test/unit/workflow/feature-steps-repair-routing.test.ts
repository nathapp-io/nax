/**
 * US-002: which feature steps run their session as a repair.
 *
 * `FeatureSteps.branchFix` takes `opts.repair`; the gate repair and the CI repair pass it, and no
 * one else does. These tests pin the arguments each step forwards — the routing itself (opts.repair
 * -> `kind: "repair"` -> `workflow-repair`) is `buildFeatureEnv`'s, covered by `feature-env.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { newFeatureRecord } from "@/workflow/feature-record";
import * as featureSteps from "@/workflow/feature-steps";
import type { WorkflowFeatureRecord, WorkflowFindingDraft } from "@/workflow/types";

const PR_URL = "https://github.com/o/r/pull/7";

/** One failed check, as the publish step turns it into the CI repair's finding. */
const CI_CHECK: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom" };

/** One red gate, as the final gates turn it into the gate repair's finding. */
const GATE_CHECK: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "repo gate test failed: FAIL" };

const baseRecord = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
  ...over,
});

interface Harness {
  readonly env: ReturnType<typeof makeFeatureMachineHarness>["env"];
  /** Every `branchFix` call's arguments, in the order the steps made them. */
  readonly calls: unknown[][];
}

/** The shared harness with a `branchFix` step that records its arguments instead of running a session. */
function harness(record: Partial<WorkflowFeatureRecord> = {}): Harness {
  const base = makeFeatureMachineHarness({}, { record: baseRecord(record) });
  const calls: unknown[][] = [];
  const env = {
    ...base.env,
    steps: {
      ...base.env.steps,
      branchFix: async (...args: Parameters<typeof base.env.steps.branchFix>) => {
        calls.push(args);
        return { autoCommitted: false, dirty: false };
      },
    },
  };
  return { env, calls };
}

describe("the gate repair's session (US-002)", () => {
  test("AC-4: the final-gate repair asks for a repair session", async () => {
    const h = harness({ gateRepairFindings: [GATE_CHECK] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.calls).toEqual([[[{ ...GATE_CHECK, id: "G1" }], { repair: true }]]);
  });
});

describe("the CI repair's session (US-002)", () => {
  test("AC-5: a published PR URL is spread into the repair options", async () => {
    const h = harness({ ciRepairFindings: [CI_CHECK], url: PR_URL });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.[1]).toEqual({ repair: true, prUrl: PR_URL });
  });

  test("AC-6: no published URL still asks for a repair, and names no prUrl", async () => {
    const h = harness({ ciRepairFindings: [CI_CHECK] });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.[1]).toEqual({ repair: true });
    expect(h.calls[0]?.[1]).not.toHaveProperty("prUrl");
  });
});

describe("the branch fix's session (US-002)", () => {
  test("AC-7: an ordinary branch fix stays a branch fix, with one argument", async () => {
    const findings = [{ ...CI_CHECK, id: "B1" }];
    const h = harness({ reviewOpen: findings });
    await featureSteps.branchFixStep(h.env, h.env.record);
    expect(h.calls).toEqual([[findings]]);
  });
});
