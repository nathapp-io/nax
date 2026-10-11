import { describe, expect, test } from "bun:test";
import { createFinishState } from "@/finish";
import { approvalFacts, computeFacts, draftReason, isClean, resolve } from "@/finish/resolve";
import type { ResolutionFacts } from "@/finish/types";

const review = () =>
  createFinishState({ feature: "f", workdir: "/r", branch: "b", runId: "r", base: "m", specPath: "s" }).review;
const finding = { severity: "HIGH" as const, title: "t", problem: "p", fix: "f" };

function facts(over: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    findingsOpen: [],
    acceptance: "green",
    gates: [{ name: "lint", status: "green" }],
    reviewsMissing: [],
    unreviewedFixCommits: [],
    coverage: { spec: 1, quality: 1 },
    fixRounds: 1,
    ...over,
  };
}

describe("computeFacts", () => {
  test("coverage is covered∩changed over changed, null when nothing changed", () => {
    const r = { ...review(), covered: { spec: ["a.ts", "z.ts"], quality: [] } };
    const f = computeFacts({
      review: r,
      acceptance: "green",
      gates: [],
      unreviewedFixCommits: [],
      changed: ["a.ts", "b.ts"],
    });
    expect(f.coverage).toEqual({ spec: 0.5, quality: 0 });
    expect(
      computeFacts({ review: r, acceptance: "green", gates: [], unreviewedFixCommits: [], changed: [] }).coverage,
    ).toEqual({
      spec: null,
      quality: null,
    });
  });

  test("open findings include unresolved judged findings", () => {
    const r = { ...review(), lastFindings: [finding], unresolved: [{ ...finding, title: "j", judgment: true }] };
    expect(
      computeFacts({ review: r, acceptance: "green", gates: [], unreviewedFixCommits: [], changed: [] }).findingsOpen,
    ).toHaveLength(2);
  });
});

describe("isClean / approvalFacts / draftReason", () => {
  test.each([
    ["clean", facts(), true],
    ["open finding", facts({ findingsOpen: [finding] }), false],
    ["acceptance red", facts({ acceptance: "red" }), false],
    ["acceptance unverified", facts({ acceptance: "unverified" }), false],
    ["acceptance not configured", facts({ acceptance: "not-configured" }), true],
    ["gate red", facts({ gates: [{ name: "lint", status: "red" }] }), false],
    ["lens missing", facts({ reviewsMissing: ["spec"] }), false],
    ["unreviewed fix commit", facts({ unreviewedFixCommits: ["abc"] }), false],
  ])("%s", (_name, f, clean) => {
    expect(isClean(f)).toBe(clean);
  });

  test("approvalFacts treats unreviewed fix commits as an incomplete phase", () => {
    expect(approvalFacts(facts({ unreviewedFixCommits: ["abc"] }), false).allPhasesComplete).toBe(false);
  });

  test("approvalFacts maps missing lenses and gates", () => {
    expect(approvalFacts(facts({ reviewsMissing: ["quality"] }), false)).toEqual({
      allPhasesComplete: false,
      gatesGreen: true,
      reReviewUsed: false,
    });
    expect(approvalFacts(facts({ acceptance: "unverified" }), true).gatesGreen).toBe(false);
  });

  test("draftReason lists every unresolved item", () => {
    expect(
      draftReason(
        facts({
          findingsOpen: [finding, finding],
          acceptance: "red",
          gates: [{ name: "lint", status: "red" }],
          reviewsMissing: ["spec"],
          unreviewedFixCommits: ["abc"],
        }),
      ),
    ).toBe("2 open finding(s); acceptance red; gates red: lint; spec review missing; 1 unreviewed fix commit(s)");
  });
});

describe("resolve", () => {
  const approve = (action: "approve" | "re-review" | "hold" | "unavailable") => ({
    approval: async () => ({ action, rationale: "why" }),
  });

  test("clean is ready without asking the advisor", async () => {
    let asked = false;
    const out = await resolve({
      facts: facts(),
      advise: {
        approval: async () => {
          asked = true;
          return { action: "hold" as const, rationale: "" };
        },
      },
      reReviewUsed: false,
    });
    expect(out).toEqual({ outcome: "ready", acceptedResidue: [] });
    expect(asked).toBe(false);
  });

  test("not clean without an advisor is draft", async () => {
    expect(await resolve({ facts: facts({ acceptance: "red" }), reReviewUsed: false })).toEqual({
      outcome: "draft",
      reason: "acceptance red",
    });
  });

  test("approve with open findings is ready with residue", async () => {
    const out = await resolve({
      facts: facts({ findingsOpen: [finding] }),
      advise: approve("approve"),
      reReviewUsed: false,
    });
    expect(out).toEqual({ outcome: "ready", acceptedResidue: [finding] });
  });

  test("approve with unreviewed fix commits is downgraded to draft", async () => {
    const out = await resolve({
      facts: facts({ unreviewedFixCommits: ["abc"] }),
      advise: approve("approve"),
      reReviewUsed: false,
    });
    expect(out).toEqual({
      outcome: "draft",
      reason: "advisor: approve rejected (phases incomplete); 1 unreviewed fix commit(s)",
    });
  });

  test("approve with a red gate is downgraded to draft", async () => {
    const out = await resolve({
      facts: facts({ gates: [{ name: "lint", status: "red" }] }),
      advise: approve("approve"),
      reReviewUsed: false,
    });
    expect(out).toEqual({
      outcome: "draft",
      reason: "advisor: approve rejected (gates not green); gates red: lint",
    });
  });

  test("re-review once, then draft", async () => {
    const f = facts({ findingsOpen: [finding] });
    expect(await resolve({ facts: f, advise: approve("re-review"), reReviewUsed: false })).toEqual({
      outcome: "re-review",
    });
    expect((await resolve({ facts: f, advise: approve("re-review"), reReviewUsed: true })).outcome).toBe("draft");
  });

  test.each(["hold", "unavailable"] as const)("%s is draft with the advisor rationale", async (action) => {
    const out = await resolve({
      facts: facts({ findingsOpen: [finding] }),
      advise: approve(action),
      reReviewUsed: false,
    });
    expect(out).toEqual({ outcome: "draft", reason: "advisor: why; 1 open finding(s)" });
  });

  test("an advisor that throws is draft with the error as rationale", async () => {
    const out = await resolve({
      facts: facts({ findingsOpen: [finding] }),
      advise: {
        approval: async () => {
          throw new Error("boom");
        },
      },
      reReviewUsed: false,
    });
    expect(out).toEqual({ outcome: "draft", reason: "advisor: advisor error: Error: boom; 1 open finding(s)" });
  });
});
