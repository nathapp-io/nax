import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeFinalizeAdvisor, wireFinalize } from "@test/helpers";
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
  const log = wireFinalize({ ci });
  const input: PublishInput = {
    record,
    stories: [story],
    flagged: 0,
    advisor: makeFinalizeAdvisor(approve),
    preflight: null,
  };
  return { calls: log, run: () => publish(makeFeatureContext(), input) };
}

describe("publish PR approval push", () => {
  test("approving advisor pushes exactly once before CI", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.filter((call) => call.name === "push")).toHaveLength(1);
    expect(calls.map((call) => call.name).indexOf("ledger")).toBeLessThan(
      calls.map((call) => call.name).indexOf("push"),
    );
    expect(calls.map((call) => call.name).indexOf("push")).toBeLessThan(calls.map((call) => call.name).indexOf("ci"));
  });
  test("approving advisor commits ledger once before push", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
    expect(calls.map((call) => call.name).indexOf("ledger")).toBeLessThan(
      calls.map((call) => call.name).indexOf("push"),
    );
  });
  test("ready retains CI observed on pushed head", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await expect(run()).resolves.toMatchObject({ outcome: "ready", ci: "green" });
    expect(calls.map((call) => call.name).indexOf("push")).toBeLessThan(calls.map((call) => call.name).indexOf("ci"));
    expect(calls.map((call) => call.name).indexOf("ci")).toBeLessThan(
      calls.map((call) => call.name).indexOf("promote"),
    );
  });
  test("held advisor leaves draft after single pre-CI push", async () => {
    const { calls, run } = setup({ ci: "green", approve: false });
    await expect(run()).resolves.toMatchObject({ outcome: "draft", ci: "green" });
    expect(calls.filter((call) => call.name === "push")).toHaveLength(1);
  });
  test("pending CI cannot promote even when advisor would approve", async () => {
    const { calls, run } = setup({ ci: "pending", approve: true });
    await expect(run()).resolves.toMatchObject({ outcome: "draft", ci: "pending" });
    expect(calls.filter((call) => call.name === "push")).toHaveLength(1);
    expect(calls).toContainEqual(expect.objectContaining({ name: "promote", keepDraft: true }));
    expect(calls).not.toContainEqual(expect.objectContaining({ name: "promote", keepDraft: undefined }));
  });
});
