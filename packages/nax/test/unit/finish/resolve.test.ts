import { describe, expect, test } from "bun:test";
import { createFinishState } from "@/finish";
import type { LedgerEntry } from "@/finish/ledger";
import { approvalFacts, computeFacts, draftReason, isClean, resolve, stopReason } from "@/finish/resolve";
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
    findings: [],
    stops: [],
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
      ledger: [],
      stops: [],
      changed: ["a.ts", "b.ts"],
    });
    expect(f.coverage).toEqual({ spec: 0.5, quality: 0 });
    expect(
      computeFacts({
        review: r,
        acceptance: "green",
        gates: [],
        unreviewedFixCommits: [],
        changed: [],
        ledger: [],
        stops: [],
      }).coverage,
    ).toEqual({
      spec: null,
      quality: null,
    });
  });

  test("open findings are the ledger's open states, including unresolved judged findings", () => {
    const ledger = [entry("a", "open"), entry("j", "unresolved"), entry("w", "waived")];
    expect(
      computeFacts({
        review: review(),
        acceptance: "green",
        gates: [],
        unreviewedFixCommits: [],
        changed: [],
        ledger,
        stops: [],
      }).findingsOpen,
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

function baseFacts(over: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return facts({ gates: [], ...over });
}
const entry = (title: string, state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
  id: title,
  finding: { severity: "LOW", title, problem: "p", fix: "f" },
  state,
  ...(ref ? { ref } : {}),
});

describe("facts and reasons (finish A section 6)", () => {
  test("counts findings by state and names the unreviewed commit", () => {
    const findings = [
      entry("A", "open"),
      ...Array.from({ length: 11 }, (_, i) => entry(`F${i}`, "fixed-unreviewed", "68e7c2189abc")),
    ];
    const first = findings[0];
    const reason = draftReason(baseFacts({ findings, findingsOpen: first ? [first.finding] : [] }));
    expect(reason).toContain("1 open; 11 fixed in unreviewed commit 68e7c21");
  });
  test("gates that never ran read 'gates not run' and still block ready", () => {
    const f = baseFacts({ gates: [{ name: "gates", status: "not-run" }] });
    expect(draftReason(f)).toBe("gates not run");
    expect(isClean(f)).toBe(false);
  });
  test("set-aside findings are counted separately", () => {
    const findings = [entry("A", "set-aside", "handoff-1")];
    const first = findings[0];
    expect(draftReason(baseFacts({ findings, findingsOpen: first ? [first.finding] : [] }))).toBe(
      "1 set aside (handoff-1)",
    );
  });
  test("computeFacts reads open findings and stops from the ledger", () => {
    const ledger = [entry("A", "open"), entry("B", "waived")];
    const f = computeFacts({
      review: review(),
      acceptance: "green",
      gates: [],
      unreviewedFixCommits: [],
      changed: [],
      ledger,
      stops: [],
    });
    expect(f.findingsOpen.map((x) => x.title)).toEqual(["A"]);
    expect(f.findings).toEqual(ledger);
  });
  test("stopReason: first stop plus a count", () => {
    expect(
      stopReason([
        { kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 13 },
        { kind: "flow", step: "gate", at: "t", limitMs: 10_800_000, handoff: 2 },
      ]),
    ).toBe("fix session stopped at the 20 min limit (13 findings, handoff-1); +1 more stop");
    expect(stopReason([{ kind: "review", lens: "quality", round: 2, at: "t", limitMs: 900_000 }])).toBe(
      "review (quality) stopped at the 15 min limit",
    );
    expect(stopReason([{ kind: "flow", step: "review", round: 2, at: "t", limitMs: 10_800_000 }])).toBe(
      "finish time limit (3 h) reached during review round 2",
    );
    expect(stopReason([{ kind: "run", step: "gate", at: "t", limitMs: 0 }])).toBe("run cancelled during gate");
    expect(stopReason([])).toBeUndefined();
  });
});
