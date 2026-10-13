/** The workflow-aware end-of-run summary and the Duration split (nax#2491 P5). */
import { describe, expect, test } from "bun:test";
import { formatRunSummary } from "@/log-format/summary";
import type { RunSummary, WorkflowSummaryView } from "@/log-format/types";
import { formatWorkflowSummary } from "@/log-format/workflow-summary";

const VIEW: WorkflowSummaryView = {
  storiesDurationMs: 8_393_000,
  featureWorkflowDurationMs: 1_055_000,
  roles: [
    { role: "implementer", inputTokens: 120_000, outputTokens: 18_000, costUsd: 2.5, calls: 9 },
    { role: "branch-review", inputTokens: 40_000, outputTokens: 3_000, costUsd: 0.59, calls: 1 },
  ],
  stories: [
    { id: "US-001", rounds: 0, maxRounds: 5, state: "complete" },
    { id: "US-002", rounds: 3, maxRounds: 5, state: "complete-with-rulings" },
  ],
  branch: { found: 4, fixed: 3, left: 1, minorsLeft: 2 },
  finalGates: "green",
  publish: { outcome: "local-only", reasons: ["no forge (origin is not GitHub or GitLab)"] },
};

const base = (over: Partial<RunSummary> = {}): RunSummary => ({
  total: 2,
  passed: 2,
  failed: 0,
  skipped: 0,
  durationMs: 9_448_000,
  totalCost: 3.09,
  startedAt: "t0",
  ...over,
});
const OPTS = { mode: "normal" as const, useColor: false };

describe("formatWorkflowSummary", () => {
  const text = formatWorkflowSummary(VIEW, { useColor: false });

  test("splits the duration into stories and feature workflow", () => {
    expect(text).toContain("stories 139m 53s + feature workflow 17m 35s");
  });

  test("tokens and cost by role", () => {
    expect(text).toMatch(/implementer\s+in 120,000\s+out 18,000\s+\$2\.5000\s+9 calls/);
    expect(text).toMatch(/branch-review\s+in 40,000\s+out 3,000\s+\$0\.5900\s+1 call\b/);
  });

  test("rounds per story", () => {
    expect(text).toContain("US-001 0/5");
    expect(text).toContain("US-002 3/5");
  });

  test("branch findings found / fixed / left and the publish outcome", () => {
    expect(text).toContain("4 found, 3 fixed, 1 left (minors left 2)");
    expect(text).toContain("Final gates: green");
    expect(text).toContain("Publish:  local-only - no forge (origin is not GitHub or GitLab)");
  });

  test("a view without a branch section or publish omits those lines", () => {
    const bare = formatWorkflowSummary(
      { ...VIEW, branch: undefined, publish: undefined, finalGates: undefined },
      { useColor: false },
    );
    expect(bare).not.toContain("Branch");
    expect(bare).not.toContain("Publish");
  });
});

describe("formatRunSummary with a workflow", () => {
  test("Duration shows the whole run with the split beside it, then the workflow block", () => {
    const out = formatRunSummary(
      base({ storiesDurationMs: 8_393_000, featureWorkflowDurationMs: 1_055_000, workflow: VIEW }),
      OPTS,
    );
    expect(out).toContain("Duration: 157m 28s (stories 139m 53s + feature workflow 17m 35s)");
    expect(out).toContain("WORKFLOW");
  });

  test("without a workflow, Duration is unchanged", () => {
    const out = formatRunSummary(base(), OPTS);
    expect(out).toContain("Duration: 157m 28s");
    expect(out).not.toContain("feature workflow");
    expect(out).not.toContain("WORKFLOW");
  });

  describe("branch review skipped (L3)", () => {
    test("prints that the branch review was skipped instead of finding counts", () => {
      const out = formatWorkflowSummary({ ...VIEW, branch: undefined, branchReviewSkipped: true }, { useColor: false });
      expect(out).toContain("Branch findings: branch review skipped");
    });
  });
});
