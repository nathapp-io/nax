import { afterEach, describe, expect, test } from "bun:test";
import { makeAdviceDecision, makeFeatureContext } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const originalFeature = { ..._featureDeps };
const originalWorkflow = { ..._workflowDeps };
afterEach(() => {
  Object.assign(_featureDeps, originalFeature);
  Object.assign(_workflowDeps, originalWorkflow);
});

const story: StorySummary = { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 };
const record = {
  ...newFeatureRecord({ now: "t", seed: null, minors: [] }),
  reviewRan: true,
  finalGates: { ran: ["build", "test"], failing: [] },
};
type Options = { ci: "green" | "pending"; approve: boolean };
function setup({ ci, approve }: Options) {
  const calls: string[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => {
    calls.push("ledger");
    return true;
  };
  _featureDeps.commitAndPush = async () => {
    calls.push("push");
    return { committed: false, pushed: true };
  };
  _featureDeps.openDraftFinishPr = async () => {
    calls.push("draft");
    return { url: "https://gh/pr/7" };
  };
  _featureDeps.waitForChecks = async () => {
    calls.push("ci");
    return { outcome: ci, detail: "observed" };
  };
  async function openOrPromote(
    args: OpenOrPromoteArgs & { keepDraft: true },
    deps: ForgeDeps,
  ): Promise<{ status: "draft" | "already-ready"; url?: string }>;
  async function openOrPromote(
    args: OpenOrPromoteArgs & { keepDraft?: false },
    deps: ForgeDeps,
  ): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }>;
  async function openOrPromote(
    args: OpenOrPromoteArgs,
    deps: ForgeDeps,
  ): Promise<{ status: "draft" | "already-ready" | "opened" | "promoted"; url?: string }>;
  async function openOrPromote(
    args: OpenOrPromoteArgs,
    _deps?: ForgeDeps,
  ): Promise<{ status: "draft" | "already-ready" | "opened" | "promoted"; url?: string }> {
    calls.push(args.keepDraft ? "keep-draft" : "promote");
    return args.keepDraft
      ? { status: "draft", url: "https://gh/pr/7" }
      : { status: "promoted", url: "https://gh/pr/7" };
  }
  _featureDeps.openOrPromotePr = openOrPromote;
  _workflowDeps.readTrustedDecisions = async () => [];
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  const advisor: Advisor = {
    advise: async () => ({
      decision: makeAdviceDecision({
        action: approve ? { type: "approve" } : { type: "hold", reason: "r" },
        rationale: approve ? "clean" : "risky",
      }),
    }),
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  const input: PublishInput = { record, stories: [story], flagged: 0, advisor, preflight: null };
  return { calls, run: () => publish(makeFeatureContext(), input) };
}

describe("publish PR approval push", () => {
  test("approving advisor pushes exactly once before CI", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.filter((call) => call === "push")).toHaveLength(1);
    expect(calls.indexOf("ledger")).toBeLessThan(calls.indexOf("push"));
    expect(calls.indexOf("push")).toBeLessThan(calls.indexOf("ci"));
  });
  test("approving advisor commits ledger once before push", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.filter((call) => call === "ledger")).toHaveLength(1);
    expect(calls.indexOf("ledger")).toBeLessThan(calls.indexOf("push"));
  });
  test("ready retains CI observed on pushed head", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await expect(run()).resolves.toMatchObject({ outcome: "ready", ci: "green" });
    expect(calls.indexOf("push")).toBeLessThan(calls.indexOf("ci"));
    expect(calls.indexOf("ci")).toBeLessThan(calls.indexOf("promote"));
  });
  test("held advisor leaves draft after single pre-CI push", async () => {
    const { calls, run } = setup({ ci: "green", approve: false });
    await expect(run()).resolves.toMatchObject({ outcome: "draft", ci: "green" });
    expect(calls.filter((call) => call === "push")).toHaveLength(1);
  });
  test("pending CI cannot promote even when advisor would approve", async () => {
    const { calls, run } = setup({ ci: "pending", approve: true });
    await expect(run()).resolves.toMatchObject({ outcome: "draft", ci: "pending" });
    expect(calls.filter((call) => call === "push")).toHaveLength(1);
    expect(calls).toContain("keep-draft");
    expect(calls).not.toContain("promote");
  });
});
