import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import {
  buildWorkflowPrBody,
  extractAssumptions,
  PR_BODY_MAX_CHARS,
  type WorkflowPrBodyInput,
} from "@/workflow/pr-body";
import type { OpenItem } from "@/workflow/types";

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
    storyIds: ["US-001", "US-002"],
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
  openItems: [],
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

  test("AC-7: closes renders a ## Closes section directly after Summary and before Stories (US-007)", () => {
    const withCloses = buildWorkflowPrBody({ ...input, closes: [2508, 2507] });
    const section = "## Closes\n\nCloses #2508\nCloses #2507";
    expect(withCloses).toContain(section);
    // The section sits between Summary and Stories, and nothing else does.
    expect(withCloses.slice(withCloses.indexOf("## Closes"), withCloses.indexOf("## Stories"))).toBe(`${section}\n\n`);
    expect(
      withCloses.slice(withCloses.indexOf("## Summary"), withCloses.indexOf("## Closes")).match(/^## .*/gm),
    ).toEqual(["## Summary"]);
  });

  test("AC-9: an empty closes list renders exactly the body of no closes at all (US-007)", () => {
    const none = buildWorkflowPrBody(input);
    expect(buildWorkflowPrBody({ ...input, closes: [] })).toBe(none);
    expect(none).not.toContain("## Closes");
    // Control: a non-empty list does change the body, so the equality above is not vacuous.
    expect(buildWorkflowPrBody({ ...input, closes: [1] })).not.toBe(none);
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

  test("a red final gate appends each excerpt in a fenced block under the gates line (nax#2484)", () => {
    const red = buildWorkflowPrBody({
      ...input,
      finalGateFindings: [
        { kind: "gate", severity: "important", issue: "repo gate test failed:\nFAIL src/adds.test.ts > adds 1 + 1" },
      ],
    });
    expect(red).toContain("- Gates: red: lint (ran build, lint)");
    expect(red).toContain("```\nrepo gate test failed:\nFAIL src/adds.test.ts > adds 1 + 1\n```");
  });

  test("a fence longer than any backtick run in the excerpt cannot be closed early", () => {
    const red = buildWorkflowPrBody({
      ...input,
      finalGateFindings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed:\n```ts\nx\n```" }],
    });
    expect(red).toContain("````\nrepo gate lint failed:\n```ts\nx\n```\n````");
  });

  test("a green final gate shows no excerpt block", () => {
    const green = buildWorkflowPrBody({ ...input, finalGates: { ran: ["build"], failing: [] } });
    expect(green).not.toContain("```");
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

  const held: OpenItem = {
    id: "B3",
    kind: "ruling",
    severity: "important",
    file: "src/p.ts",
    line: 9,
    issue: `published() returns void ${"y".repeat(400)} <script>`,
    suggestion: "return the `id`",
    ruling: { action: "hold", why: "needs a human" },
  };

  test("draft: Before marking ready lists each open item in full with a checklist (#2496)", () => {
    const withItem = buildWorkflowPrBody({ ...input, openItems: [held] });
    const section = withItem.slice(
      withItem.indexOf("## Before marking ready"),
      withItem.indexOf("## Pre-flight rulings"),
    );
    expect(section).toContain("- [ ] **B3** (important, ruling) `src/p.ts:9`");
    expect(section).toContain("y".repeat(400));
    expect(section).toContain("&lt;script&gt;");
    expect(section).toContain("Suggestion: return the 'id'");
    expect(section).toContain("Advisor: hold — needs a human");
    expect(section).toContain("Then: rerun the repo gates, push, and run `gh pr ready`.");
    expect(withItem.indexOf("## Before marking ready")).toBeGreaterThan(withItem.indexOf("## Stories"));
  });

  test("no section when nothing is open or the PR is ready", () => {
    expect(buildWorkflowPrBody(input)).not.toContain("## Before marking ready");
    expect(buildWorkflowPrBody({ ...input, outcome: "ready", openItems: [held] })).not.toContain(
      "## Before marking ready",
    );
  });

  // A ready PR has no "Before marking ready" section, which used to drop what nax could not verify.
  test("a ready PR still lists what nax could not verify", () => {
    const cv: OpenItem = { id: "_run:cv1", kind: "cannot-verify", issue: "live GitHub App mint was not attempted" };
    const body = buildWorkflowPrBody({ ...input, outcome: "ready", openItems: [held, cv] });
    expect(body).toContain("## Not verified by nax\n\n- live GitHub App mint was not attempted");
    expect(body).not.toContain(held.issue);
    expect(body.indexOf("## Not verified by nax")).toBeGreaterThan(body.indexOf("## Stories"));
  });

  test("the Not verified section is capped like the other lists", () => {
    const many: OpenItem[] = Array.from({ length: 52 }, (_, i) => ({
      id: `_run:cv${i + 1}`,
      kind: "cannot-verify",
      issue: `${"z".repeat(400)} ${i}`,
    }));
    const body = buildWorkflowPrBody({ ...input, outcome: "ready", openItems: many });
    expect(body).toContain("- …and 2 more");
    expect(body).not.toContain("z".repeat(400));
  });

  test("a draft keeps cannot-verify items in Before marking ready, not a second section", () => {
    const cv: OpenItem = { id: "_run:cv1", kind: "cannot-verify", issue: "live mint not attempted" };
    const body = buildWorkflowPrBody({ ...input, openItems: [cv] });
    expect(body).toContain("## Before marking ready");
    expect(body).not.toContain("## Not verified by nax");
  });

  test("more than 50 open items: cap with a pointer to result.json", () => {
    const many = Array.from({ length: 52 }, (_, i) => ({ ...held, id: `B${i}` }));
    expect(buildWorkflowPrBody({ ...input, openItems: many })).toContain(
      "…and 2 more, see result.json verdict.openItems",
    );
  });

  test("a gate open item is one line; the excerpt stays under Gates and CI", () => {
    const gate: OpenItem = { id: "lint", kind: "gate", issue: `lint output ${"z".repeat(3000)}` };
    const body = buildWorkflowPrBody({ ...input, openItems: [gate] });
    expect(body).toContain("- [ ] **lint** (gate) — final gate lint is red; see the excerpt under Gates and CI");
    expect(body).not.toContain("z".repeat(100));
  });

  test("a body over the limit is bounded and points at result.json", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...held, id: `B${i}`, issue: "q".repeat(3000) }));
    const body = buildWorkflowPrBody({ ...input, openItems: many });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX_CHARS);
    expect(body).toContain("Open items truncated to fit the PR body; full text in result.json verdict.openItems");
  });

  test("a body that is still over the limit after capping is truncated whole", () => {
    const body = buildWorkflowPrBody({
      ...input,
      minorsLeft: Array.from({ length: 50 }, () => "m".repeat(299)),
      rulings: Array.from({ length: 50 }, () => ({
        findingId: "B",
        action: "defer" as const,
        text: "t".repeat(299),
        why: "w".repeat(299),
        costIfWrong: "c",
        source: "advisor" as const,
      })),
      assumptions: Array.from({ length: 50 }, () => ({ storyId: "S", text: "a".repeat(699) })),
      openItems: [held],
    });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX_CHARS);
    expect(body).toContain("Open items truncated to fit the PR body");
  });

  test("AC-8: a body cut to PR_BODY_MAX_CHARS still carries Closes #7 (US-007)", () => {
    const body = buildWorkflowPrBody({
      ...input,
      closes: [7],
      minorsLeft: Array.from({ length: 50 }, () => "m".repeat(299)),
      rulings: Array.from({ length: 50 }, () => ({
        findingId: "B",
        action: "defer" as const,
        text: "t".repeat(299),
        why: "w".repeat(299),
        costIfWrong: "c",
        source: "advisor" as const,
      })),
      assumptions: Array.from({ length: 50 }, () => ({ storyId: "S", text: "a".repeat(699) })),
      openItems: [held],
    });
    // The hard cut, not just the capping pass: the body is exactly the limit and keeps its head.
    expect(body.length).toBe(PR_BODY_MAX_CHARS);
    expect(body).toContain("## Closes\n\nCloses #7");
  });

  test("a small body keeps open item text in full", () => {
    const body = buildWorkflowPrBody({ ...input, openItems: [held] });
    expect(body).toContain("y".repeat(400));
    expect(body).not.toContain("Open items truncated");
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

describe("buildWorkflowPrBody — agent-sourced text is redacted and neutralised (#2552)", () => {
  const SECRET = "sk-abcdefghijklmnopqrstuvwx";
  const ZWSP = "​";

  test("redacts a secret in a failing-gate excerpt", () => {
    const body = buildWorkflowPrBody({
      ...input,
      finalGateFindings: [{ kind: "gate", severity: "important", issue: `lint failed, key ${SECRET}` }],
    });
    expect(body).not.toContain(SECRET);
    expect(body).toContain("[REDACTED]");
  });

  test("redacts secrets in assumptions, rulings, reasons, minors, open items and advisor rationale", () => {
    const body = buildWorkflowPrBody({
      ...input,
      outcome: "draft",
      reasons: [`reason ${SECRET}`],
      assumptions: [{ storyId: "US-001", text: `assumed ${SECRET}` }],
      rulings: [
        {
          findingId: "B2",
          action: "defer",
          text: `t ${SECRET}`,
          why: `w ${SECRET}`,
          costIfWrong: "c",
          source: "advisor",
        },
      ],
      minorsLeft: [`minor ${SECRET}`],
      openItems: [{ kind: "finding", id: "F1", issue: `issue ${SECRET}`, suggestion: `fix ${SECRET}` }],
      decisions: [makeAdviceDecision({ id: "D-9", action: { type: "answer", text: `answer ${SECRET}` } })],
    });
    expect(body).not.toContain(SECRET);
  });

  test("redacts a secret in a story title", () => {
    const body = buildWorkflowPrBody({
      ...input,
      stories: [{ id: "US-1", title: `title ${SECRET}`, state: "complete", rounds: 1, unreviewed: false, flagged: 0 }],
    });
    expect(body).not.toContain(SECRET);
  });

  test("neutralises issue references and mentions in agent text outside ## Closes", () => {
    const body = buildWorkflowPrBody({
      ...input,
      assumptions: [{ storyId: "US-001", text: "Fixes #123 and org/repo#45, cc @octocat" }],
      minorsLeft: ["see https://github.com/o/r/issues/77"],
    });
    expect(body).not.toMatch(/#\d/);
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(body).not.toMatch(/issues\/\d/);
    expect(body).toContain(`#${ZWSP}123`);
    expect(body).toContain(`@${ZWSP}octocat`);
  });

  test("leaves file-path code spans and word@word alone; breaks team and user mentions", () => {
    const body = buildWorkflowPrBody({
      ...input,
      openItems: [
        { kind: "finding", id: "F1", file: "packages/@scope/x/a.ts", issue: "bump node@20, ask @org/team and x/@user" },
      ],
    });
    expect(body).toContain("`packages/@scope/x/a.ts`");
    expect(body).toContain("node@20");
    expect(body).toContain(`@${ZWSP}org/team`);
    expect(body).toContain(`x/@${ZWSP}user`);
  });

  test("leaves the ## Closes section built from the spec untouched", () => {
    const body = buildWorkflowPrBody({ ...input, closes: [2508, 2507] });
    expect(body).toContain("## Closes\n\nCloses #2508\nCloses #2507");
  });

  test("does not touch a failing-gate excerpt's fence content beyond redaction", () => {
    const body = buildWorkflowPrBody({
      ...input,
      finalGateFindings: [{ kind: "gate", severity: "important", issue: "error at line 5 in a.ts" }],
    });
    expect(body).toContain("```\nerror at line 5 in a.ts\n```");
  });
});
