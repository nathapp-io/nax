import { describe, expect, test } from "bun:test";
import { buildFixCommitMessage } from "@flows/nax-finish/commit-message";
import type { Finding, FindingDisposition } from "@flows/nax-finish/types";

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

  // Was "carries the gate output tail": the body now names the failing test
  // when the output identifies one, and falls back to the tail only when it
  // cannot (covered below). What matters here is unchanged — the gate body
  // reports runner evidence, never a reviewer finding list.
  test("the gate body carries runner evidence, not a finding list", () => {
    const msg = buildFixCommitMessage(
      "gate",
      "f",
      ctxOf({ quality_gates: { failing: ["test"], output: "FAIL src/a.test.ts\n1 failed" } }),
    );
    expect(msg).toContain("Failing: test");
    expect(msg).toContain("src/a.test.ts");
    expect(msg).not.toContain("[HIGH]");
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

// The gate body used to be the raw last-20-lines of runner stdout. On the run
// that motivated this (#1506) those 20 lines were three stack traces emitted as
// *warnings* by tests that passed, so the message named the wrong failure
// entirely — and pasted the author's absolute home path into shipped history.
describe("buildFixCommitMessage — gate body names the failure", () => {
  // Authentic shape: bun prints `(fail) <describe> > <test>` for real failures,
  // while passing tests can still write stack traces to stderr.
  const REAL_GATE_OUTPUT = [
    "Warning: [finish-pr] Failed to write PR title/body",
    "      at updatePrBody (/Users/someone/work/nax/flows/nax-finish/steps/pr.ts:111:19)",
    "      at async <anonymous> (/Users/someone/work/nax/test/unit/flows/nax-finish/steps/pr.test.ts:476:21)",
    "(fail) nax-finish post-run action > execute omits reviewer profile env vars [0.12ms]",
    " 12121 pass",
    " 1 fail",
  ].join("\n");

  const gateMsg = (output: string, workdir?: string) =>
    buildFixCommitMessage("gate", "f", ctxOf({ quality_gates: { failing: ["test"], output } }), { workdir });

  test("names the failing test rather than whichever lines happened to be last", () => {
    const msg = gateMsg(REAL_GATE_OUTPUT);
    expect(msg).toContain("execute omits reviewer profile env vars");
  });

  test("does not present a passing test's warning trace as the failure", () => {
    const msg = gateMsg(REAL_GATE_OUTPUT);
    expect(msg).not.toContain("Failed to write PR title/body");
  });

  test("strips absolute paths so shipped history carries no local filesystem layout", () => {
    const msg = gateMsg(REAL_GATE_OUTPUT);
    expect(msg).not.toContain("/Users/someone");
  });

  test("rewrites paths under the workdir to repo-relative", () => {
    const msg = gateMsg("      at foo (/Users/someone/work/nax/src/a.ts:1:2)", "/Users/someone/work/nax");
    expect(msg).toContain("src/a.ts:1:2");
    expect(msg).not.toContain("/Users/someone");
  });

  test("falls back to the output tail when no failing test can be identified", () => {
    const msg = gateMsg("something broke\nexit code 2");
    expect(msg).toContain("exit code 2");
  });

  test("still records which gate commands were red", () => {
    expect(gateMsg(REAL_GATE_OUTPUT)).toContain("Failing: test");
  });

  // A bare list of ten reads as "ten tests failed". A reader who acts on that
  // count is acting on a truncation, so the cut has to announce itself.
  test("says how many failing tests it left out rather than truncating silently", () => {
    const many = Array.from({ length: 14 }, (_, i) => `(fail) suite > case ${i}`).join("\n");
    const msg = gateMsg(many);
    expect(msg).toContain("case 0");
    expect(msg).toContain("...and 4 more failing test(s)");
    expect(msg).not.toContain("case 13");
  });
});

// #1614-followup: the fixer can now reject a finding on cited counter-evidence
// (`fix_<phase>`'s `## DISPOSITIONS`), but the shipped commit body kept reading
// `Fix: <the fix text>` for it regardless — disagreeing with the PR body, which
// rendered the same finding as rejected. Threading `dispositions` through fixes
// that.
describe("buildFixCommitMessage — dispositions", () => {
  const rejected = (over: Partial<FindingDisposition> = {}): FindingDisposition => ({
    index: 1,
    disposition: "rejected",
    evidence: "test/config/loader.test.ts:42",
    ...over,
  });

  test("a rejected finding renders as rejected with its evidence, not as a fix", () => {
    const msg = buildFixCommitMessage(
      "quality",
      "f",
      ctxOf({ review_quality: { findings: [finding({ fix: "pass 'resolved' into buildRequest." })] } }),
      { dispositions: [rejected()] },
    );
    expect(msg).toContain("rejected: `test/config/loader.test.ts:42`");
    expect(msg).not.toContain("Fix: pass 'resolved' into buildRequest.");
  });

  test("a rejection with no cited evidence says so", () => {
    const msg = buildFixCommitMessage("quality", "f", ctxOf({ review_quality: { findings: [finding()] } }), {
      dispositions: [rejected({ evidence: undefined })],
    });
    expect(msg).toContain("rejected: no evidence cited");
  });

  test("an evidence path that does not resolve on disk is flagged, not discarded", () => {
    const msg = buildFixCommitMessage("quality", "f", ctxOf({ review_quality: { findings: [finding()] } }), {
      dispositions: [rejected({ evidenceMissing: true })],
    });
    expect(msg).toContain("evidence path not found");
  });

  test("a mixed batch renders each finding by its own disposition", () => {
    const msg = buildFixCommitMessage(
      "quality",
      "f",
      ctxOf({
        review_quality: {
          findings: [finding({ title: "A", fix: "Fix A" }), finding({ title: "B", fix: "Fix B" })],
        },
      }),
      { dispositions: [{ index: 2, disposition: "rejected", evidence: "a.ts:1" }] },
    );
    expect(msg).toContain("- [HIGH] A");
    expect(msg).toContain("Fix: Fix A");
    expect(msg).toContain("- [HIGH] B — rejected: `a.ts:1`");
    expect(msg).not.toContain("Fix: Fix B");
  });

  test("callers with no dispositions render exactly as before (gate/acceptance never pass any)", () => {
    const msg = buildFixCommitMessage("quality", "f", ctxOf({ review_quality: { findings: [finding()] } }));
    expect(msg).toContain("Fix: Drop the extra guard.");
  });
});
