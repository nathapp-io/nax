import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { outputRunFooter } from "@/execution/lifecycle/headless-formatter";

const base = {
  finalCounts: { total: 2, passed: 2, failed: 0, skipped: 0 },
  durationMs: 9_448_000,
  totalCost: 3.09,
  startedAt: "t0",
  completedAt: "t1",
  formatterMode: "normal" as const,
};

describe("outputRunFooter", () => {
  afterEach(() => spyOn(console, "log").mockRestore());

  function footer(extra: Partial<Parameters<typeof outputRunFooter>[0]> = {}): string {
    const log = spyOn(console, "log").mockImplementation(() => {});
    outputRunFooter({ ...base, ...extra });
    return log.mock.calls.map((c) => String(c[0])).join("\n");
  }

  test("pipeline footer has no split and no workflow block", () => {
    const out = footer();
    expect(out).toContain("157m 28s");
    expect(out).not.toContain("feature workflow");
  });

  test("workflow footer shows the whole duration with its split, and the workflow block", () => {
    const out = footer({
      workflowTiming: { storiesDurationMs: 8_393_000, featureWorkflowDurationMs: 1_055_000 },
      workflowSummary: {
        storiesDurationMs: 8_393_000,
        featureWorkflowDurationMs: 1_055_000,
        roles: [],
        stories: [{ id: "US-001", rounds: 2, maxRounds: 5 }],
        publish: { outcome: "local-only", reasons: [] },
      },
    });
    const plain = Bun.stripANSI(out);
    expect(plain).toContain("157m 28s (stories 139m 53s + feature workflow 17m 35s)");
    expect(plain).toContain("US-001 2/5");
    expect(plain).toContain("local-only");
  });
});
