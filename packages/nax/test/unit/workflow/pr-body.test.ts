import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import { buildWorkflowPrBody, extractAssumptions, type WorkflowPrBodyInput } from "@/workflow/pr-body";

const input: WorkflowPrBodyInput = {
  feature: "refunds",
  outcome: "draft",
  ci: "pending",
  reasons: ["stories gate-open: US-002"],
  stories: [
    { id: "US-001", title: "Create | list", state: "complete", rounds: 1, unreviewed: false, flagged: 0 },
    {
      id: "US-002",
      title: "Approve",
      state: "complete-gate-open",
      reason: "red: lint",
      rounds: 5,
      unreviewed: true,
      flagged: 0,
    },
  ],
  preflight: {
    schemaVersion: 1,
    overlap: [],
    conflicts: [
      { questionId: "Q1", storyIds: ["US-002"], summary: "30d vs 14d", decisionId: "D-1", action: "supersede" },
    ],
  },
  decisions: [
    makeAdviceDecision({ id: "D-1", action: { type: "carry", instruction: "keep lock order", toStories: ["US-3"] } }),
  ],
  rulings: [
    { findingId: "B2", action: "defer", text: "split later", why: "low risk", costIfWrong: "c", source: "advisor" },
  ],
  minorsLeft: ["US-001: rename tmp"],
  finalGates: { ran: ["build", "lint"], failing: ["lint"] },
  assumptions: [{ storyId: "US-001", text: "used the JWT tenant id" }],
};

describe("buildWorkflowPrBody", () => {
  const body = buildWorkflowPrBody(input);

  test("every section in order", () => {
    const order = [
      "## Summary",
      "## Stories",
      "## Pre-flight rulings",
      "## Advisor decisions",
      "## Parked findings",
      "## Deferred minors (left)",
      "## Gates and CI",
      "## Decisions & assumptions",
    ].map((h) => body.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("outcome, reasons, story rows (escaped), unreviewed marker", () => {
    expect(body).toContain("Outcome: **draft**");
    expect(body).toContain("- stories gate-open: US-002");
    expect(body).toContain("| US-001 | Create \\| list | complete | 1 |");
    expect(body).toContain("| US-002 | Approve | complete-gate-open (unreviewed) | 5 |");
  });

  test("pre-flight, advisor decisions, parked findings, minors, gates, CI, assumptions", () => {
    expect(body).toContain("- D-1 (US-002): supersede — 30d vs 14d");
    expect(body).toContain("**D-1**");
    expect(body).toContain("- B2 defer: split later — low risk");
    expect(body).toContain("- US-001: rename tmp");
    expect(body).toContain("- Gates: red: lint (ran build, lint)");
    expect(body).toContain("- CI: pending");
    expect(body).toContain("- US-001: used the JWT tenant id");
    expect(body).toContain("nax never merges");
  });

  test("empty sections read None.", () => {
    const empty = buildWorkflowPrBody({
      ...input,
      reasons: [],
      outcome: "ready",
      preflight: null,
      decisions: [],
      rulings: [],
      minorsLeft: [],
      assumptions: [],
      finalGates: { ran: [], failing: [] },
    });
    expect(empty).not.toContain("Not ready because");
    expect(empty.match(/None\./g)?.length).toBe(5);
    expect(empty).toContain("- Gates: nothing configured (nothing was verified)");
  });

  test("lists are capped at 50 rows", () => {
    const many = buildWorkflowPrBody({ ...input, minorsLeft: Array.from({ length: 60 }, (_, i) => `m${i}`) });
    expect(many).toContain("- …and 10 more");
  });
});

describe("extractAssumptions", () => {
  test("a heading section, up to the next heading", () => {
    const report =
      "## What was built\nx\n\n## Decisions & assumptions\n- chose X because Y\n- assumed Z\n\n## Files changed\n- a.ts";
    expect(extractAssumptions(report)).toBe("- chose X because Y - assumed Z");
  });

  test("an inline bold bullet, up to the next bold bullet", () => {
    const report =
      "- **What was built**: a\n- **Decisions & assumptions**: used the tenant id from the JWT.\n- **Files changed**: a.ts";
    expect(extractAssumptions(report)).toBe("used the tenant id from the JWT.");
  });

  test("no section -> empty; a long section is capped", () => {
    expect(extractAssumptions("## Files changed\n- a.ts")).toBe("");
    const long = extractAssumptions(`## Decisions & assumptions\n${"x".repeat(1000)}`);
    expect(long.length).toBe(601);
    expect(long.endsWith("…")).toBe(true);
  });
});
