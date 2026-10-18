import { afterEach, describe, expect, test } from "bun:test";
import { makeAdviceDecision, makeFeatureContext } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { feature: { ..._featureDeps }, workflow: { ..._workflowDeps } };
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
});

function advisor(inspectedFiles: string[] | undefined): Advisor {
  return {
    advise: async () => ({
      decision: makeAdviceDecision({
        action: { type: "approve" },
        rationale: "clean",
        ...(inspectedFiles === undefined ? {} : { inspectedFiles }),
      }),
    }),
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
}

function wire(inspectedFiles: string[] | undefined) {
  const updated: OpenOrPromoteArgs[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => false;
  _featureDeps.commitAndPush = async () => ({ committed: false, pushed: true });
  _featureDeps.openDraftFinishPr = async () => ({ url: "https://gh/pr/7" });
  _featureDeps.waitForChecks = async () => ({ outcome: "green", detail: "all passed" });
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
  const input: PublishInput = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "abc123", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [{ id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 }],
    flagged: 0,
    advisor: advisor(inspectedFiles),
    preflight: null,
  };
  return { input, updated };
}

describe("publish advisor read disclosure", () => {
  test.each([
    ["AC-15", [], "The advisor approved from the evidence alone: it listed no files it opened."],
    ["AC-16", ["src/a.ts", "src/b.ts"], "The advisor opened 2 file(s) before approving."],
    ["AC-20", undefined, "The advisor approved from the evidence alone: it listed no files it opened."],
  ] as const)("%s", async (_ac, files, sentence) => {
    const { input, updated } = wire(files === undefined ? undefined : [...files]);
    const result = await publish(makeFeatureContext(), input);
    expect(result.outcome).toBe("ready");
    expect(updated.length).toBeGreaterThan(0);
    const last = updated.at(-1);
    expect(last?.keepDraft).toBe(false);
    expect(last?.body?.split("## Stories")[0]).toContain(sentence);
    if (files === undefined) expect(result.approval).not.toHaveProperty("inspectedFiles");
    else expect(result.approval?.inspectedFiles).toEqual([...files]);
  });
});
