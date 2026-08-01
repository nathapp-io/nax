import { describe, expect, test } from "bun:test";
import { buildFixCommitMessage } from "@flows/nax-finish/commit-message";
import type { Finding } from "@flows/nax-finish/types";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "HIGH",
  title: "Market gate skip branch is unreachable",
  problem: "The `should_skip` branch is guarded by `row.gate is not None`, which is never set.",
  fix: "Drop the extra guard.",
  ...over,
});

const ctxOf = (outputs: Record<string, unknown>) => ({ outputs });

describe("buildFixCommitMessage — subject line", () => {
  test("a single review finding puts that finding's title in the subject", () => {
    const msg = buildFixCommitMessage(
      "spec",
      "pipeline-run-outcome",
      ctxOf({ review_spec: { findings: [finding()] } }),
    );
    const subject = msg.split("\n")[0];
    expect(subject).toBe("fix(pipeline-run-outcome): market gate skip branch is unreachable");
    // The generic phase label is what this replaces — it must not survive.
    expect(subject).not.toContain("nax-finish spec fixes");
  });

  test("multiple findings summarise by count and worst severity", () => {
    const msg = buildFixCommitMessage(
      "quality",
      "feat-x",
      ctxOf({
        review_quality: {
          findings: [finding({ severity: "LOW" }), finding({ severity: "CRITICAL" }), finding({ severity: "MEDIUM" })],
        },
      }),
    );
    expect(msg.split("\n")[0]).toBe("fix(feat-x): address 3 quality review findings (worst: CRITICAL)");
  });

  test("the gate phase names the failing commands, not a finding", () => {
    const msg = buildFixCommitMessage("gate", "feat-x", ctxOf({ quality_gates: { failing: ["lint", "test"] } }));
    expect(msg.split("\n")[0]).toBe("fix(feat-x): repair failing lint and test gates");
  });

  test("the acceptance phase names the contract it is repairing", () => {
    const msg = buildFixCommitMessage("acceptance", "feat-x", ctxOf({ acceptance: { output: "2 failed" } }));
    expect(msg.split("\n")[0]).toBe("fix(feat-x): repair failing acceptance tests");
  });

  test("a subject too long for a git summary line is truncated, not wrapped", () => {
    const long = "a".repeat(120);
    const msg = buildFixCommitMessage("spec", "f", ctxOf({ review_spec: { findings: [finding({ title: long })] } }));
    const subject = msg.split("\n")[0];
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("...")).toBe(true);
  });

  test("falls back to the phase label when the reviewer produced no usable detail", () => {
    expect(buildFixCommitMessage("spec", "f", ctxOf({})).split("\n")[0]).toBe("fix(f): apply spec review fixes");
    expect(buildFixCommitMessage("gate", "f", ctxOf({ quality_gates: { failing: [] } })).split("\n")[0]).toBe(
      "fix(f): repair failing quality gates",
    );
  });
});

describe("buildFixCommitMessage — body", () => {
  test("lists every finding with severity, title and prescribed fix", () => {
    const msg = buildFixCommitMessage(
      "spec",
      "f",
      ctxOf({
        review_spec: {
          findings: [finding({ severity: "HIGH", title: "A", problem: "P-A", fix: "F-A" }), finding({ title: "B" })],
        },
      }),
    );
    expect(msg).toContain("- [HIGH] A\n  P-A\n  Fix: F-A");
    expect(msg).toContain("- [HIGH] B");
  });

  test("attributes the commit to the flow phase so it is greppable in history", () => {
    const msg = buildFixCommitMessage("quality", "f", ctxOf({ review_quality: { findings: [finding()] } }));
    expect(msg).toContain("nax-finish: quality review fixes");
  });

  test("the gate body carries the gate output tail, not a finding list", () => {
    const msg = buildFixCommitMessage(
      "gate",
      "f",
      ctxOf({ quality_gates: { failing: ["test"], output: "FAIL src/a.test.ts\n1 failed" } }),
    );
    expect(msg).toContain("Failing: test");
    expect(msg).toContain("1 failed");
  });

  test("a subject-only message still ends with a single trailing newline-free line", () => {
    const msg = buildFixCommitMessage("spec", "f", ctxOf({}));
    expect(msg.endsWith("\n")).toBe(false);
  });

  test("body lines are separated from the subject by exactly one blank line", () => {
    const msg = buildFixCommitMessage("spec", "f", ctxOf({ review_spec: { findings: [finding()] } }));
    expect(msg.split("\n")[1]).toBe("");
    expect(msg.split("\n")[2]).not.toBe("");
  });
});
