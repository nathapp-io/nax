import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeAdviceDecision, makeFeatureContext, makeTempDir } from "@test/helpers";
import type { Advisor } from "@/advisor";
import type { OpenOrPromoteArgs } from "@/finish/pr/open";
import type { ForgeDeps } from "@/forge";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { isPublishableBranch, type PublishInput, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const originalFeature = { ..._featureDeps };
const originalWorkflow = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_featureDeps, originalFeature);
  Object.assign(_workflowDeps, originalWorkflow);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const done: StorySummary = { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 };
const greenRecord = {
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  reviewRan: true,
  finalGates: { ran: ["build", "test"], failing: [] },
};

function advisor(approve: boolean, asked: string[] = []): Advisor {
  return {
    advise: async (q) => {
      asked.push(q.kind);
      return {
        decision: makeAdviceDecision({
          action: approve ? { type: "approve" } : { type: "hold", reason: "r" },
          rationale: approve ? "clean" : "risky",
        }),
      };
    },
    recordReuse: async () => null,
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
  };
}

type PromoteKept = { status: "draft" | "already-ready"; url?: string };
type PromoteReady = { status: "opened" | "promoted" | "already-ready"; url?: string };

interface Call {
  name: string;
  arg?: unknown;
  keepDraft?: boolean;
  body?: string;
}

/** Wires every forge-side dep; returns the call log. */
function wire(
  opts: {
    ci?: "green" | "failed" | "pending";
    pushFails?: boolean;
    promoteThrows?: boolean;
    alreadyReady?: boolean;
    onCi?: () => void;
  } = {},
) {
  const calls: Call[] = [];
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitAndPush = async (repoRoot, branch) => {
    calls.push({ name: "push", arg: [repoRoot, branch] });
    if (opts.pushFails) throw new Error("rejected: non-fast-forward");
    return { committed: false, pushed: true };
  };
  _featureDeps.openDraftFinishPr = async (args) => {
    calls.push({ name: "draft", arg: args.body });
    return { url: "https://gh/pr/7" };
  };
  _featureDeps.waitForChecks = async () => {
    calls.push({ name: "ci" });
    opts.onCi?.();
    return { outcome: opts.ci ?? "pending", detail: "d" };
  };
  async function fakePromote(args: OpenOrPromoteArgs & { keepDraft: true }, deps: ForgeDeps): Promise<PromoteKept>;
  async function fakePromote(args: OpenOrPromoteArgs & { keepDraft?: false }, deps: ForgeDeps): Promise<PromoteReady>;
  async function fakePromote(args: OpenOrPromoteArgs, deps: ForgeDeps): Promise<PromoteKept | PromoteReady>;
  async function fakePromote(args: OpenOrPromoteArgs): Promise<PromoteKept | PromoteReady> {
    calls.push({ name: "promote", keepDraft: args.keepDraft, body: args.body });
    if (opts.promoteThrows) throw new Error("gh edit failed");
    if (opts.alreadyReady && args.keepDraft) return { status: "already-ready", url: "https://gh/pr/7" };
    return args.keepDraft
      ? { status: "draft", url: "https://gh/pr/7" }
      : { status: "promoted", url: "https://gh/pr/7" };
  }
  _featureDeps.openOrPromotePr = fakePromote;
  _workflowDeps.readTrustedDecisions = async () => [];
  return calls;
}

function input(over: Partial<PublishInput> = {}): PublishInput {
  return { record: greenRecord, stories: [done], flagged: 0, advisor: advisor(true), preflight: null, ...over };
}

describe("isPublishableBranch", () => {
  test.each([
    ["feat/x", true],
    ["main", false],
    ["master", false],
    ["", false],
  ])("%s -> %p", (branch, ok) => expect(isPublishableBranch(branch)).toBe(ok));
});

describe("publish (P4-R3, P4-R11)", () => {
  test("happy path: push, draft PR, CI pending, advisor approves -> promoted, ready", async () => {
    const calls = wire({ ci: "pending" });
    const asked: string[] = [];
    const out = await publish(makeFeatureContext(), input({ advisor: advisor(true, asked) }));
    expect(calls.map((c) => c.name)).toEqual(["push", "draft", "ci", "promote"]);
    expect(calls[0]?.arg).toEqual(["/repo", "feat/x"]);
    expect(asked).toEqual(["finish-approval"]);
    expect(calls[3]?.keepDraft).toBe(false);
    expect(calls[3]?.body).toContain("Outcome: **ready**");
    expect(out).toEqual({ outcome: "ready", ci: "pending", url: "https://gh/pr/7", reasons: [] });
  });

  test("a deterministic reason keeps the draft and never asks the advisor (P4-R10)", async () => {
    const calls = wire();
    const asked: string[] = [];
    const out = await publish(
      makeFeatureContext(),
      input({ stories: [{ ...done, state: "complete-gate-open" }], advisor: advisor(true, asked) }),
    );
    expect(asked).toEqual([]);
    expect(calls.at(-1)?.keepDraft).toBe(true);
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toEqual(["stories gate-open: US-001"]);
  });

  test("CI failed -> draft with the reason", async () => {
    wire({ ci: "failed" });
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "draft", ci: "failed", reasons: ["CI failed"] });
  });

  test("the advisor holds -> draft with its rationale", async () => {
    wire({ ci: "green" });
    const out = await publish(makeFeatureContext(), input({ advisor: advisor(false) }));
    expect(out).toMatchObject({ outcome: "draft", reasons: ["advisor held: risky"] });
  });

  test("main, an empty branch, a dry run, or no forge -> local-only, nothing pushed", async () => {
    const calls = wire();
    expect((await publish(makeFeatureContext({ branch: "main" }), input())).outcome).toBe("local-only");
    expect((await publish(makeFeatureContext({ dryRun: true }), input())).reasons).toContain("dry run");
    _featureDeps.detectForge = async () => null;
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "local-only", ci: "skipped" });
    expect(out.reasons.at(-1)).toContain("no forge detected");
    expect(calls).toEqual([]);
  });

  test("a push failure -> local-only with the reason, no PR calls", async () => {
    const calls = wire({ pushFails: true });
    const out = await publish(makeFeatureContext(), input());
    expect(out.outcome).toBe("local-only");
    expect(out.reasons.at(-1)).toBe("push failed: rejected: non-fast-forward");
    expect(calls.map((c) => c.name)).toEqual(["push"]);
  });

  test("a promote failure keeps the draft URL and adds the reason", async () => {
    wire({ ci: "green", promoteThrows: true });
    const out = await publish(makeFeatureContext(), input());
    expect(out).toMatchObject({ outcome: "draft", url: "https://gh/pr/7" });
    expect(out.reasons.at(-1)).toBe("PR update failed: gh edit failed");
  });

  test("the body carries each story's Decisions & assumptions from its report", async () => {
    const runDir = makeTempDir("wf-fin-");
    dirs.push(runDir);
    await Bun.write(join(runDir, "US-001", "report.md"), "## Decisions & assumptions\n- used the JWT tenant id\n");
    const calls = wire({ ci: "green" });
    await publish(makeFeatureContext(), input({ stories: [{ ...done, runDir }] }));
    expect(String(calls.find((c) => c.name === "draft")?.arg)).toContain("US-001: - used the JWT tenant id");
  });

  test("a held branch finding puts a Before marking ready section in the draft body (#2496)", async () => {
    const calls = wire({ ci: "green" });
    const record = {
      ...greenRecord,
      reviewOpen: [{ id: "B1", kind: "quality" as const, severity: "important" as const, issue: "needs a human" }],
      rulings: [
        {
          findingId: "B1",
          action: "hold" as const,
          text: "t",
          why: "risky",
          costIfWrong: "c",
          source: "advisor" as const,
        },
      ],
    };
    await publish(makeFeatureContext(), input({ record }));
    const body = String(calls.find((c) => c.name === "draft")?.arg);
    expect(body).toContain("## Before marking ready");
    expect(body).toContain("**B1**");
  });

  test("an abort during the CI wait rejects: no approval, no promotion (W-R3)", async () => {
    const ac = new AbortController();
    const calls = wire({ ci: "pending", onCi: () => ac.abort() });
    const asked: string[] = [];
    const fc = makeFeatureContext({ runSignal: ac.signal });
    const err = await publish(fc, input({ advisor: advisor(true, asked) })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "WORKFLOW_ABORTED" });
    expect(asked).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual(["push", "draft", "ci"]);
  });

  test("uncommitted changes after the branch fix keep the draft and never ask the advisor", async () => {
    const calls = wire({ ci: "green" });
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    const asked: string[] = [];
    const out = await publish(makeFeatureContext(), input({ advisor: advisor(true, asked) }));
    expect(asked).toEqual([]);
    expect(out).toMatchObject({ outcome: "draft", reasons: ["uncommitted changes after the branch fix"] });
    expect(calls.at(-1)?.keepDraft).toBe(true);
  });

  test("a dirty tree is also a reason on the local-only path", async () => {
    wire();
    _workflowDeps.git = async () => ({ stdout: "?? new.ts\n", exitCode: 0 });
    const out = await publish(makeFeatureContext({ dryRun: true }), input());
    expect(out.reasons).toEqual(["uncommitted changes after the branch fix", "dry run"]);
  });

  test("a PR a human already marked ready stays as is, with a reason", async () => {
    wire({ ci: "failed", alreadyReady: true });
    const out = await publish(makeFeatureContext(), input());
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toEqual(["CI failed", "a human already marked the PR ready; nax left it as is"]);
  });
});
