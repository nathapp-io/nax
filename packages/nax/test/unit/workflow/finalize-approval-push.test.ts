import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeFinalizeAdvisor, wireFinalize } from "@test/helpers";
import type { Advisor } from "@/advisor";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const PUSHED = "c".repeat(40);

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
  ledgerThrowsAt?: number;
  ledger?: readonly boolean[];
  headUnreadable?: boolean;
  advisor?: Advisor;
};
function setup({ ci, approve, ledgerThrowsAt, ledger, headUnreadable, advisor }: Options) {
  const log = wireFinalize({ ci, ...(ledgerThrowsAt ? { ledgerThrowsAt } : {}), ...(ledger ? { ledger } : {}) });
  _workflowDeps.git = async (args) =>
    args[0] === "rev-parse"
      ? headUnreadable
        ? { stdout: "", stderr: "fatal: bad HEAD", exitCode: 128 }
        : { stdout: `${PUSHED}\n`, exitCode: 0 }
      : { stdout: "", exitCode: 0 };
  const input: PublishInput = {
    record,
    stories: [story],
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
  test("approving advisor commits ledger before push, then commits its ruling locally (nax#2646)", async () => {
    const { calls, run } = setup({ ci: "green", approve: true });
    await run();
    expect(calls.map((call) => call.name)).toEqual(["ledger", "push", "draft", "ci", "promote", "ledger"]);
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

/** nax#2646: the ruling `askApproval` appends is committed locally, never pushed (#2629: one CI run). */
describe("publish commits the approval ruling locally", () => {
  test.each([true, false])("approve=%p: one push, a post-approval ledger commit, the pushed head", async (approve) => {
    const { calls, run } = setup({ ci: "green", approve });
    const out = await run();
    expect(calls.filter((call) => call.name === "push")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(2);
    expect(calls.at(-1)?.name).toBe("ledger");
    expect(out.pushedHead).toBe(PUSHED);
  });
  test("an advisor that decided nothing wrote no ruling, so nothing more is committed", async () => {
    const silent: Advisor = {
      ...makeFinalizeAdvisor(true),
      advise: async () => ({ decision: null, fallbackReason: "offline" }),
    };
    const { calls, run } = setup({ ci: "green", approve: true, advisor: silent });
    const out = await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
    expect(out.pushedHead).toBeUndefined();
  });
  test("a deterministic reason asks no advisor, so nothing more is committed", async () => {
    const { calls, run } = setup({ ci: "pending", approve: true });
    const out = await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
    expect(out.pushedHead).toBeUndefined();
  });
  test("an unknown pushed head commits nothing, so threads never cite an unpushed sha", async () => {
    const { calls, run } = setup({ ci: "green", approve: true, headUnreadable: true });
    const out = await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(1);
    expect(out.pushedHead).toBeUndefined();
  });
  test("a ruling commit that made no commit reports no pushed head", async () => {
    const { calls, run } = setup({ ci: "green", approve: true, ledger: [true, false] });
    const out = await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(2);
    expect(out.pushedHead).toBeUndefined();
  });
  test("a failed post-approval commit is fail-open: the outcome stands", async () => {
    const { calls, run } = setup({ ci: "green", approve: true, ledgerThrowsAt: 2 });
    const out = await run();
    expect(calls.filter((call) => call.name === "ledger")).toHaveLength(2);
    expect(out).toMatchObject({ outcome: "ready", ci: "green" });
    expect(out.pushedHead).toBeUndefined();
  });
});
