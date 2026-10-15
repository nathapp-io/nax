import { afterEach, describe, expect, test } from "bun:test";
import { makeAdviceDecision, makeFeatureContext } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _ciWaitDeps, type CiWaitResult } from "@/workflow/ci-wait";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { feature: { ..._featureDeps }, workflow: { ..._workflowDeps }, ci: { ..._ciWaitDeps } };
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
  Object.assign(_ciWaitDeps, saved.ci);
});

function wire(ci: CiWaitResult) {
  const updated: OpenOrPromoteArgs[] = [];
  const asked: string[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => false;
  _featureDeps.commitAndPush = async () => ({ committed: false, pushed: true });
  _featureDeps.openDraftFinishPr = async () => ({ url: "https://gh/pr/7" });
  _featureDeps.waitForChecks = async () => ci;
  _featureDeps.forge = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null };
  _workflowDeps.git = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _workflowDeps.readTrustedDecisions = async () => [];
  _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
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
    advise: async (q) => {
      asked.push(q.kind);
      return { decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
  const input: PublishInput = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [{ id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 }],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return { input, asked, updated };
}

describe("publish CI draft gate (US-002)", () => {
  test("AC-21/22/23/24/25: conflict keeps draft, explains why, never asks the advisor", async () => {
    const { input, asked, updated } = wire({ outcome: "conflicting", detail: "PR has merge conflicts with main" });
    const result = await publish(makeFeatureContext(), input);
    expect(asked).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.keepDraft).toBe(true);
    expect(updated[0]?.body).toContain("PR has merge conflicts with main");
    expect(updated[0]?.body).toContain("CI: conflicting");
    expect(result).toEqual({
      outcome: "draft",
      ci: "conflicting",
      url: "https://gh/pr/7",
      reasons: ["PR has merge conflicts with main"],
    });
  });

  test("AC-26: push-only missing checks forwards the exact CI detail", async () => {
    const { input, asked, updated } = wire({ outcome: "no-checks", detail: "no CI check reported within 20m 0s" });
    const fc = makeFeatureContext();
    const result = await publish({ ...fc, workflow: { ...fc.workflow, publish: "push" } }, input);
    expect(result).toMatchObject({
      outcome: "pushed",
      ci: "no-checks",
      reasons: ["no CI check reported within 20m 0s"],
    });
    expect(asked).toEqual([]);
    expect(updated).toEqual([]);
  });

  test("missing checks also block PR approval", async () => {
    const { input, asked, updated } = wire({ outcome: "no-checks", detail: "no CI check reported within 20m 0s" });
    expect((await publish(makeFeatureContext(), input)).outcome).toBe("draft");
    expect(asked).toEqual([]);
    expect(updated[0]?.keepDraft).toBe(true);
  });
});
