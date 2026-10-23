import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { assertDefined, makeAdviceDecision, makeFeatureContext } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { getLogger } from "@/logger";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { feature: { ..._featureDeps }, workflow: { ..._workflowDeps } };
const warn = spyOn(getLogger(), "warn");
afterAll(() => warn.mockRestore());
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
  warn.mockClear();
});

function wire(action: "approve" | "hold", reloadFails = false) {
  const decision = makeAdviceDecision({
    id: "D-3",
    kind: "finish-approval",
    action: action === "approve" ? { type: "approve" } : { type: "hold", reason: "defect in a.ts" },
    rationale: action === "approve" ? "clean" : "defect in a.ts",
  });
  let approved = false;
  let reads = 0;
  const updated: OpenOrPromoteArgs[] = [];
  const drafts: string[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => false;
  _featureDeps.commitAndPush = async () => ({ committed: false, pushed: true });
  _featureDeps.openDraftFinishPr = async (args) => {
    drafts.push(args.body);
    return { url: "https://gh/pr/7" };
  };
  _featureDeps.waitForChecks = async () => ({ outcome: "green", detail: "all checks passed" });
  _workflowDeps.git = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
  _workflowDeps.readTrustedDecisions = async () => {
    reads++;
    if (!approved) return [];
    if (reloadFails) throw new Error("ledger unavailable");
    return [decision];
  };
  type Kept = { status: "draft"; url: string };
  type Ready = { status: "promoted"; url: string };
  async function promote(args: OpenOrPromoteArgs & { keepDraft: true }, deps: ForgeDeps): Promise<Kept>;
  async function promote(args: OpenOrPromoteArgs & { keepDraft?: false }, deps: ForgeDeps): Promise<Ready>;
  async function promote(args: OpenOrPromoteArgs, deps: ForgeDeps): Promise<Kept | Ready>;
  async function promote(args: OpenOrPromoteArgs): Promise<Kept | Ready> {
    updated.push(args);
    return args.keepDraft
      ? { status: "draft", url: "https://gh/pr/7" }
      : { status: "promoted", url: "https://gh/pr/7" };
  }
  _featureDeps.openOrPromotePr = promote;
  const advisor: Advisor = {
    advise: async () => {
      approved = true;
      return { decision };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  const input = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return { input, updated, drafts, reads: () => reads };
}

function decisionsSection(body: string): string {
  return body.split("## Advisor decisions\n\n")[1]?.split("\n\n## ")[0] ?? "MISSING";
}

describe("publish approval decisions in the final PR body", () => {
  test.each(["approve", "hold"] as const)("AC-8/9: reloads D-3 after %s", async (action) => {
    const h = wire(action);
    const result = await publish(makeFeatureContext(), h.input);
    expect(result.outcome).toBe(action === "approve" ? "ready" : "draft");
    expect(h.updated).toHaveLength(1);
    const final = h.updated[0];
    assertDefined(final);
    expect(final.keepDraft).toBe(action === "hold");
    expect(decisionsSection(final.body)).toContain("D-3");
    expect(decisionsSection(final.body)).toContain(action);
    expect(decisionsSection(h.drafts[0] ?? "")).toBe("None.");
    expect(h.reads()).toBe(2);
  });

  test("AC-10/11: a failed reload renders None and warns", async () => {
    const h = wire("approve", true);
    const result = await publish(makeFeatureContext(), h.input);
    expect(result.outcome).toBe("ready");
    expect(h.reads()).toBe(2);
    const final = h.updated[0];
    assertDefined(final);
    expect(decisionsSection(final.body)).toBe("None.");
    expect(warn).toHaveBeenCalledWith("workflow", "Advisor decisions unavailable for the PR body", {
      storyId: "_run",
      error: "ledger unavailable",
    });
  });
});
