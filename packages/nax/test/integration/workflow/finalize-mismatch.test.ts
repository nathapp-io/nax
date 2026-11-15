/**
 * US-010: the branch verdict mismatch US-009 persisted is readiness evidence, not a finding. A
 * production publish over green gates, green CI and an approving advisor still leaves the PR a draft,
 * never asks the advisor to overrule it, and keeps the sentence under the two publish modes that open
 * no PR — each read from `_approvalDeps.branchMismatchReasons`, the source the branch-review step
 * writes its ledger notes from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeFinalizeAdvisor, wireFinalize } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { WorkflowConfig } from "@/config";
import { _approvalDeps } from "@/workflow/approval";
import type { FeatureContext } from "@/workflow/feature-context";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, type PublishOutcome, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const savedFeature = { ..._featureDeps };
const savedWorkflow = { ..._workflowDeps };
const savedApproval = { ..._approvalDeps };
afterEach(() => {
  Object.assign(_featureDeps, savedFeature);
  Object.assign(_workflowDeps, savedWorkflow);
  Object.assign(_approvalDeps, savedApproval);
});

const DONE: StorySummary = {
  id: "US-001",
  title: "A",
  state: "complete",
  rounds: 1,
  unreviewed: false,
  flagged: 0,
};

/** The persisted mismatch US-009 records, both kinds, in the order the parser reports them. */
const PERSISTED = { kinds: ["spec", "quality"] as const };

/** `fc` with `workflow.publish` set to `mode`. */
function withMode(fc: FeatureContext, mode: WorkflowConfig["publish"]): FeatureContext {
  return { ...fc, workflow: { ...fc.workflow, publish: mode } };
}

/** A record whose only open fact is the persisted branch mismatch. */
function input(advisor: Advisor, over: Partial<PublishInput> = {}): PublishInput {
  return {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["build", "test"], failing: [] },
      reviewMismatch: { kinds: [...PERSISTED.kinds] },
    },
    stories: [DONE],
    flagged: 0,
    advisor,
    preflight: null,
    ...over,
  };
}

/** One publish round over the `wireFinalize` harness, with its call log and the questions asked. */
function harness() {
  const calls = wireFinalize({ ci: "green", spec: null });
  const asked: string[] = [];
  const names = (): string[] => calls.map((call) => call.name);
  return {
    asked,
    names,
    promote: () => calls.find((call) => call.name === "promote"),
    run: (fc: FeatureContext = makeFeatureContext()): Promise<PublishOutcome> =>
      publish(fc, input(makeFinalizeAdvisor(true, asked))),
  };
}

describe("publish keeps the PR a draft for a persisted branch mismatch (US-010)", () => {
  test("AC-5: green gates, green CI and an approving advisor still leave the PR a draft", async () => {
    const h = harness();
    const out = await h.run();
    expect(out.outcome).toBe("draft");
    expect(out.ci).toBe("green");
    expect(h.promote()?.keepDraft).toBe(true);
    expect(out.reasons).toHaveLength(2);
  });

  test("AC-6: the advisor is never asked to overrule the deterministic reason", async () => {
    const h = harness();
    const out = await h.run();
    expect(h.asked).toEqual([]);
    // A ruling that never happened contributes no approval to the outcome.
    expect(out).not.toHaveProperty("approval");
    expect(h.names()).not.toContain("advise");
  });

  test("AC-7: local-only keeps the mismatch reason and invents no PR operation", async () => {
    const h = harness();
    // The two production local-only arms: a dry run (nothing committed) and a non-feature branch
    // (the ledger lands, nothing is pushed). Neither opens or promotes a PR.
    const dry = await h.run(makeFeatureContext({ dryRun: true }));
    expect(dry).toMatchObject({ outcome: "local-only", ci: "skipped" });
    expect(dry.reasons).toEqual([
      "branch review verdict inconsistent: spec fail without a blocking spec finding",
      "branch review verdict inconsistent: quality changes without a blocking finding",
      "dry run",
    ]);
    const notAFeatureBranch = await h.run(makeFeatureContext({ branch: "main" }));
    expect(notAFeatureBranch).toMatchObject({ outcome: "local-only", ci: "skipped" });
    expect(notAFeatureBranch.reasons).toEqual([
      "branch review verdict inconsistent: spec fail without a blocking spec finding",
      "branch review verdict inconsistent: quality changes without a blocking finding",
      'branch "main" is not a feature branch',
    ]);
    expect(h.names()).toEqual(["ledger"]);
    expect(h.names()).not.toContain("draft");
    expect(h.names()).not.toContain("promote");
  });

  test("AC-8: push-only keeps the mismatch reason and opens no PR", async () => {
    const h = harness();
    const out = await h.run(withMode(makeFeatureContext(), "push"));
    expect(out.outcome).toBe("pushed");
    expect(out.reasons).toEqual([
      "branch review verdict inconsistent: spec fail without a blocking spec finding",
      "branch review verdict inconsistent: quality changes without a blocking finding",
    ]);
    expect(h.names()).not.toContain("draft");
    expect(h.names()).not.toContain("promote");
  });
});

describe("publish reads the mismatch text through the shared seam (US-010)", () => {
  /** The one sentence this publish should carry, distinctive on purpose: an inline copy cannot produce it. */
  const FROM_THE_SEAM = "branch review verdict inconsistent: the seam said so";

  test("AC-9: the persisted kinds reach _approvalDeps.branchMismatchReasons during the publish call", async () => {
    const seen: (readonly string[])[] = [];
    _approvalDeps.branchMismatchReasons = (kinds) => {
      seen.push([...kinds]);
      return [FROM_THE_SEAM];
    };
    const h = harness();
    await h.run();
    expect(seen.length).toBeGreaterThan(0);
    for (const kinds of seen) expect(kinds).toEqual(["spec", "quality"]);
  });

  test("AC-10: the sentence that seam returns is the reason the outcome carries", async () => {
    // The stub answers only for real kinds, so an empty list proves nothing reached the seam.
    _approvalDeps.branchMismatchReasons = (kinds) => (kinds.length > 0 ? [FROM_THE_SEAM] : []);
    const h = harness();
    const out = await h.run();
    expect(out.reasons).toEqual([FROM_THE_SEAM]);
    expect(out.outcome).toBe("draft");
  });
});
