/** What the feature workflow says in the run log (nax#2491 P3): one line per step. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { type FeatureEnv, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { PublishOutcome } from "@/workflow/finalize";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict, ReReviewVerdict, StorySummary } from "@/workflow/types";

const GREEN: RepoGateRun = { summary: { ran: ["build", "test"], failing: [] }, findings: [] };
const RED_LINT: RepoGateRun = {
  summary: { ran: ["lint"], failing: ["lint"] },
  findings: [{ kind: "gate", severity: "important", issue: "lint failed" }],
};
const draft = (severity: "important" | "minor", issue: string) => ({ kind: "quality" as const, severity, issue });
const REVIEW: BranchReviewVerdict = {
  spec: "fail",
  quality: "changes",
  findings: [draft("important", "one"), draft("important", "two"), draft("minor", "nit")],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const NO_FORGE: PublishOutcome = {
  outcome: "local-only",
  ci: "skipped",
  reasons: ["no forge (origin is not GitHub or GitLab)"],
};
const story: StorySummary = { id: "US-001", title: "t", state: "complete", rounds: 0, unreviewed: false, flagged: 0 };

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

function envWith(script: {
  gates?: RepoGateRun[];
  review?: BranchReviewVerdict;
  reReview?: ReReviewVerdict;
  fixFailure?: string;
}): FeatureEnv {
  const gates = [...(script.gates ?? [])];
  let clock = 0;
  const steps: FeatureSteps = {
    repoGates: async () => gates.shift() ?? GREEN,
    branchReview: async () => ({ ran: true, verdict: script.review ?? REVIEW }),
    branchFix: async () => ({
      autoCommitted: false,
      dirty: false,
      ...(script.fixFailure ? { failure: script.fixFailure } : {}),
    }),
    branchReReview: async (findings) => ({
      ran: true,
      verdict: script.reReview ?? {
        verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })),
        newFindings: [],
      },
    }),
    adjudicate: async () => [],
    publish: async () => NO_FORGE,
    head: async () => "h",
  };
  return {
    steps,
    sink: { update: async () => {}, ledger: async () => {}, artifact: async () => {}, step: () => {} },
    facts: { stories: [story], parked: [], cannotVerify: [] },
    record: newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    aborted: () => false,
    now: () => (clock += 1000),
  };
}

const lines = () =>
  logs.filter((e) => e.stage === "workflow" && !(e.data as { ledger?: boolean })?.ledger).map((e) => e.message);

describe("feature machine run log", () => {
  test("one line per step: gates, review counts, fix ids, re-review result, final gates, publish", async () => {
    await runFeatureMachine(
      envWith({
        reReview: {
          verdicts: [
            { id: "B1", addressed: true, note: "" },
            { id: "B2", addressed: false, note: "" },
          ],
          newFindings: [],
        },
      }),
    );
    const out = lines();
    expect(out.find((l) => l.startsWith("repo-gates "))).toMatch(/^repo-gates green {2}\S+$/);
    expect(out).toContain("branch-review start");
    expect(out.find((l) => l.startsWith("branch-review: "))).toMatch(
      /^branch-review: spec fail, quality changes - 2 important, 1 minor \(B1 one, B2 two, nit\) {2}/,
    );
    expect(out).toContain("branch-fix start");
    expect(out.find((l) => l.startsWith("branch-fix: "))).toMatch(/^branch-fix: B1 B2 {2}/);
    expect(out.find((l) => l.startsWith("branch-rereview: "))).toMatch(
      /^branch-rereview: B1 addressed, B2 NOT addressed; minors left: 1 {2}/,
    );
    expect(out.find((l) => l.startsWith("final-gates "))).toMatch(/^final-gates green {2}/);
    expect(out.find((l) => l.startsWith("publish "))).toMatch(
      /^publish local-only: no forge \(origin is not GitHub or GitLab\) {2}/,
    );
  });

  test("a red repo gate names the failing gates; a clean branch skips fix and re-review lines", async () => {
    await runFeatureMachine(
      envWith({ gates: [RED_LINT, GREEN], review: { ...REVIEW, spec: "pass", quality: "approved", findings: [] } }),
    );
    const out = lines();
    expect(out.find((l) => l.startsWith("repo-gates "))).toMatch(/^repo-gates red \(lint\) {2}/);
    expect(out.find((l) => l.startsWith("branch-review: "))).toMatch(/- no findings {2}/);
    expect(out.some((l) => l.startsWith("branch-rereview"))).toBe(false);
  });

  test("a failed fix session is stated on the branch-fix line", async () => {
    await runFeatureMachine(envWith({ fixFailure: "timeout" }));
    expect(lines().find((l) => l.startsWith("branch-fix: "))).toMatch(
      /^branch-fix: B1 B2 \(session failed: timeout\) {2}/,
    );
  });

  test("lines are tagged workflow with the run scope as storyId", async () => {
    await runFeatureMachine(envWith({}));
    const feature = logs.filter((e) => e.stage === "workflow" && !(e.data as { ledger?: boolean })?.ledger);
    expect(feature.length).toBeGreaterThan(0);
    for (const e of feature) expect(Object.entries(e.data ?? {})[0]).toEqual(["storyId", "_run"]);
  });

  describe("one line per fact (M4)", () => {
    test("ledger lines the step lines already cover are written with mirror: false", async () => {
      const env = envWith({ fixFailure: "timeout", gates: [RED_LINT, RED_LINT] });
      const calls: { text: string; mirror: boolean | undefined }[] = [];
      await runFeatureMachine({
        ...env,
        sink: { ...env.sink, ledger: async (text, options) => void calls.push({ text, mirror: options?.mirror }) },
      });
      for (const prefix of [
        "repo gates red",
        "branch fix:",
        "branch fix session failed",
        "final gates red",
        "feature local-only",
      ]) {
        const call = calls.find((c) => c.text.startsWith(prefix));
        expect(call, prefix).toBeDefined();
        expect(call?.mirror, prefix).toBe(false);
      }
    });
  });

  describe("branch review without a seed", () => {
    test("still leaves exactly one info line in the log", async () => {
      const env = envWith({});
      await runFeatureMachine({ ...env, record: { ...env.record, seed: null } });
      const skipped = lines().filter((l) => l.startsWith("branch-review"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatch(/^branch-review: skipped \(no seed\) {2}/);
    });
  });
});
