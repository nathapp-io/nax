import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeFinalizeAdvisor, wireFinalize } from "@test/helpers";
import type { Advisor } from "@/advisor";
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
type Options = {
  ci: "green" | "pending";
  approve: boolean;
  advisor?: Advisor;
  stories?: readonly StorySummary[];
};
function setup({ ci, approve, advisor, stories }: Options) {
  const log = wireFinalize({ ci });
  const input: PublishInput = {
    record,
    stories: stories ?? [story],
    flagged: 0,
    advisor: advisor ?? makeFinalizeAdvisor(approve),
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
  // US-001 (nax#2666): the advisor rules before the single ledger commit, so the ruling is in the
  // pushed commit and there is no post-CI commit of its own.
  test("approving advisor's ruling rides the single ledger commit before the push", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.map((call) => call.name)).toEqual(["ledger", "push", "draft", "ci", "promote"]);
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

/**
 * US-001 (nax#2666): the ruling `askApproval` writes rides the ledger commit that precedes the push, so
 * a publish round commits the ledger once and never pushes twice.
 */
describe("publish commits the ruling in its one pre-push ledger commit", () => {
  test.each([true, false])("approve=%p: one push and one ledger commit", async (approve) => {
    const { calls, run } = setup({ ci: "green", approve });
    await run();
    expect(calls.filter((call) => call.name === "push")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
  });
  test("an advisor that decided nothing wrote no ruling, so nothing more is committed", async () => {
    const silent: Advisor = {
      ...makeFinalizeAdvisor(true),
      advise: async () => ({ decision: null, fallbackReason: "offline" }),
    };
    const { calls, run } = setup({ ci: "green", approve: true, advisor: silent });
    await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
  });
  test("a deterministic reason asks no advisor, so nothing more is committed", async () => {
    const asked: string[] = [];
    const { calls, run } = setup({
      ci: "green",
      approve: true,
      stories: [{ ...story, state: "complete-gate-open" }],
      advisor: makeFinalizeAdvisor(true, asked),
    });
    await run();
    expect(asked).toEqual([]);
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
  });
});
