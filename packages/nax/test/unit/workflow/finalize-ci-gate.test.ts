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

function wire(ci: CiWaitResult, opts: { hold?: { id: string; rationale: string } } = {}) {
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
      const { hold } = opts;
      return {
        decision: makeAdviceDecision(
          hold
            ? { id: hold.id, action: { type: "hold", reason: "not yet" }, rationale: hold.rationale }
            : { action: { type: "approve" }, rationale: "clean" },
        ),
      };
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
      ciDetail: "PR has merge conflicts with main",
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

  // nax#2550: CI that could not be read is a reason, not a quiet pending.
  test("CI unavailable keeps the draft with the wait's detail, never asks the advisor", async () => {
    const detail = "CI status unavailable: gh: auth required";
    const { input, asked, updated } = wire({ outcome: "unavailable", detail });
    const result = await publish(makeFeatureContext(), input);
    expect(asked).toEqual([]);
    expect(updated[0]?.keepDraft).toBe(true);
    expect(result).toMatchObject({ outcome: "draft", ci: "unavailable", reasons: [detail] });
  });

  test("slow CI (pending) still asks the advisor (W-R9)", async () => {
    const { input, asked } = wire({ outcome: "pending", detail: "no CI result within 1200000ms" });
    await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
  });

  // nax#2550: a feature workflow stopped at the cost limit never goes ready.
  test("a cost-limited record keeps the draft and never asks the advisor", async () => {
    const { input, asked, updated } = wire({ outcome: "green", detail: "all checks passed" });
    const result = await publish(makeFeatureContext(), { ...input, record: { ...input.record, costLimited: true } });
    expect(asked).toEqual([]);
    expect(updated[0]?.keepDraft).toBe(true);
    expect(result.reasons).toEqual([
      "cost limit reached: the feature workflow stopped before its review and fix steps finished",
    ]);
  });

  // nax#2550: a tree whose state could not be read is not a verified clean tree.
  test("a failing git status keeps the draft with a could-not-verify reason, never asks the advisor", async () => {
    const { input, asked, updated } = wire({ outcome: "green", detail: "all checks passed" });
    _workflowDeps.git = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: index file corrupt" });
    const result = await publish(makeFeatureContext(), input);
    expect(asked).toEqual([]);
    expect(updated[0]?.keepDraft).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toStartWith("could not verify a clean working tree: ");
    expect(result.reasons[0]).toContain("fatal: index file corrupt");
  });

  // nax#2550: fix commits no re-review looked at never go ready.
  test("a skipped branch re-review keeps the draft and never asks the advisor", async () => {
    const { input, asked, updated } = wire({ outcome: "green", detail: "all checks passed" });
    const result = await publish(makeFeatureContext(), {
      ...input,
      record: { ...input.record, reReviewSkipped: true },
    });
    expect(asked).toEqual([]);
    expect(updated[0]?.keepDraft).toBe(true);
    expect(result.reasons).toEqual(["branch re-review did not run: the fix commits are unreviewed"]);
  });
});

/** US-002: the body written at the end of `publish` lists what the verdict lists, under the same ids. */
describe("publish rebuilds the body's open items (US-002)", () => {
  /** The lines of the body's "Before marking ready" section, or none when the section is absent. */
  function readyLines(body: string): string[] {
    const [, section] = body.split("## Before marking ready");
    return section === undefined ? [] : section.split("\n");
  }

  function expectReadyLine(body: string, prefix: string): void {
    expect(readyLines(body).find((l) => l.startsWith(prefix))).toBeDefined();
  }

  test("AC-20: an advisor hold is an advisor line, cited by its decision id", async () => {
    const { input, updated } = wire({ outcome: "green", detail: "ok" }, { hold: { id: "D-1", rationale: "risky" } });
    await publish(makeFeatureContext(), input);
    expectReadyLine(String(updated[0]?.body), "- [ ] **D-1** (advisor) — advisor held:");
  });

  test("AC-21: a failed CI is a ci line", async () => {
    const { input, updated } = wire({ outcome: "failed", detail: "1 check failed" });
    await publish(makeFeatureContext(), input);
    expectReadyLine(String(updated[0]?.body), "- [ ] **_run:ci** (ci) — CI failed");
  });

  test("AC-22: a story that did not finish is a story line", async () => {
    const { input, updated } = wire({ outcome: "green", detail: "ok" });
    await publish(makeFeatureContext(), {
      ...input,
      stories: [{ id: "US-002", title: "B", state: "complete-gate-open", rounds: 1, unreviewed: false, flagged: 0 }],
    });
    expectReadyLine(String(updated[0]?.body), "- [ ] **US-002** (story)");
  });

  test("AC-23: a reason nothing else explains is a reason line, numbered by its position", async () => {
    const { input, updated } = wire({ outcome: "green", detail: "ok" });
    await publish(makeFeatureContext(), { ...input, record: { ...input.record, reviewRan: false } });
    expectReadyLine(String(updated[0]?.body), "- [ ] **_run:reason1** (reason) — branch review did not run");
  });
});

/** US-001: the publish result keeps the approval outcome and the CI wait's detail for the verdict. */
describe("publish keeps the approval and the CI detail (US-001)", () => {
  test("AC-10: an advisor that holds returns its outcome with the decision id", async () => {
    const { input, asked } = wire({ outcome: "green", detail: "ok" }, { hold: { id: "D-1", rationale: "risky" } });
    const result = await publish(makeFeatureContext(), input);
    expect(asked).toEqual(["finish-approval"]);
    expect(result.approval).toEqual({ approved: false, rationale: "advisor held: risky", decisionId: "D-1" });
    expect(result.outcome).toBe("draft");
  });

  test("AC-11: a failed CI never asks the advisor, so there is no approval key", async () => {
    const { input, asked } = wire({ outcome: "failed", detail: "1 check failed" });
    const result = await publish(makeFeatureContext(), input);
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("draft");
    expect("approval" in result).toBe(false);
  });

  test("AC-12: a conflicting CI records the wait's detail", async () => {
    const { input } = wire({ outcome: "conflicting", detail: "PR #9 has merge conflicts" });
    const result = await publish(makeFeatureContext(), input);
    expect(result.ciDetail).toBe("PR #9 has merge conflicts");
  });

  test("AC-13: a green CI records no detail", async () => {
    const { input } = wire({ outcome: "green", detail: "3 checks passed" });
    const result = await publish(makeFeatureContext(), input);
    expect(result.outcome).toBe("ready");
    expect("ciDetail" in result).toBe(false);
    expect("approval" in result).toBe(true);
  });
});
