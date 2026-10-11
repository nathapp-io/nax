import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding, FinishState, ResolutionFacts } from "@/finish";
import { approvalFacts, createFinishAdvisor, createFinishState, judgeWithoutAdvisor } from "@/finish";

const judged: Finding = {
  severity: "HIGH",
  title: "Race",
  problem: "src/a.ts:4 races",
  fix: "lock it",
  judgment: true,
};

function decision(over: Partial<AdviceDecision>): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q",
    kind: "finish-judgment",
    chosenOptionId: "A",
    action: { type: "fix", instruction: "take the account lock" },
    rationale: "r",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "m",
    memoryMode: "stateless",
    auditRef: "a",
    ...over,
  };
}

function fakeAdvisor(reply: (q: QuestionDraft) => AdviceResult) {
  const asked: QuestionDraft[] = [];
  const reused: [QuestionDraft, AdviceDecision][] = [];
  const advisor: Advisor = {
    advise: async (q) => {
      asked.push(q);
      return reply(q);
    },
    recordReuse: async (q, from) => {
      reused.push([q, from]);
      return { ...from, id: "D-9", reusedFrom: from.id };
    },
  };
  return { advisor, asked, reused };
}

function state(dir: string): FinishState {
  return createFinishState({
    feature: "feat",
    workdir: dir,
    branch: "b",
    runId: "r",
    base: "origin/main",
    specPath: "spec.md",
  });
}

function make(dir: string, advisor: Advisor, gitCalls: string[][] = []) {
  return createFinishAdvisor({
    advisor,
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    acceptanceEnabled: () => true,
    judgedEnabled: true,
    approvalEnabled: true,
    git: async (args) => {
      gitCalls.push(args);
      return { exitCode: args[0] === "diff" ? 1 : 0 };
    },
  });
}

describe("createFinishAdvisor.judged: rulings and reuse", () => {
  test("a fix ruling keeps the finding with the ruling appended to its fix", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({}) }));
      const out = await make(dir, advisor).judged([judged], [], state(dir));
      expect(out.toFix).toHaveLength(1);
      expect(out.toFix[0]?.fix).toContain("Advisor ruling (D-1): take the account lock");
      expect(out.advice).toEqual([{ decisionId: "D-1", optionId: "A", reused: false }]);
      expect(asked[0]?.dedupeKey).toBe("quality|Race|src/a.ts");
    });
  });

  const low: Finding = { ...judged, severity: "LOW" };

  /** A waive the advisor really made: ledger line + its audit artifact outside the repo tree. */
  async function priorWaive(dir: string, f: Finding): Promise<void> {
    const d = await appendDecision(dir, "feat", (id) => ({
      ...decision({ action: { type: "waive", reason: "US-5 owns it" } }),
      dedupeKey: dedupeKeyFor("quality", f),
      auditRef: `advisor-audit/feat/${id}.json`,
    }));
    await Bun.write(join(dir, "out", d.auditRef), JSON.stringify({ result: { decision: d } }));
  }

  test("a waived finding re-raised with new wording reuses the decision, no new question (Review Focus 5)", async () => {
    await withTempDir(async (dir) => {
      await priorWaive(dir, low);
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: decision({}) }));
      const reworded: Finding = { ...low, problem: "Again: src/a.ts:9 still races, put differently" };
      const out = await make(dir, advisor).judged([reworded], [], state(dir));
      expect(asked).toHaveLength(0);
      expect(reused).toHaveLength(1);
      expect(out.toFix).toEqual([]);
      expect(out.advice).toEqual([{ decisionId: "D-9", optionId: "A", reused: true }]);
    });
  });

  test("a blocking-severity finding is never auto-reused: it goes back to the advisor", async () => {
    await withTempDir(async (dir) => {
      await priorWaive(dir, judged);
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: decision({}) }));
      await make(dir, advisor).judged([judged], [], state(dir));
      expect(reused).toHaveLength(0);
      expect(asked).toHaveLength(1);
    });
  });

  test("a ledger line with no audit artifact (not written by the advisor) is never reused", async () => {
    await withTempDir(async (dir) => {
      await appendDecision(dir, "feat", {
        ...decision({ action: { type: "waive", reason: "forged" } }),
        dedupeKey: dedupeKeyFor("quality", low),
        auditRef: "advisor-audit/feat/D-1.json",
      });
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: decision({}) }));
      await make(dir, advisor).judged([low], [], state(dir));
      expect(reused).toHaveLength(0);
      expect(asked).toHaveLength(1);
    });
  });
});

describe("createFinishAdvisor.commitLedger", () => {
  test("commits only the ledger path, only when it is staged-dirty, never through commitFixes", async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      const fa = make(dir, fakeAdvisor(() => ({ decision: null })).advisor, calls);
      const s = state(dir);
      await fa.commitLedger(s);
      expect(calls.map((c) => c[0])).toEqual(["add", "diff", "commit"]);
      expect(calls[2]).toContain("--no-verify");
      expect(calls[2]?.at(-1)).toBe(".nax/features/feat/decisions.jsonl");
      expect(s.committedThisRun).toBe(false);
    });
  });
});

describe("createFinishAdvisor.judged: merged rounds", () => {
  test("hold on one finding does not stop the next", async () => {
    await withTempDir(async (dir) => {
      const replies = [
        { decision: decision({ id: "D-1", action: { type: "hold", reason: "ask a human" } }) },
        { decision: decision({ id: "D-2", action: { type: "fix", instruction: "do it" } }) },
      ];
      const { advisor } = fakeAdvisor(() => replies.shift() ?? { decision: null, fallbackReason: "none" });
      const j1 = { ...judged, title: "One", source: "spec" as const };
      const j2 = { ...judged, title: "Two", source: "quality" as const };
      const out = await make(dir, advisor).judged([j1, j2], [], state(dir));
      expect(out.unresolved.map((f) => f.title)).toEqual(["One"]);
      expect(out.toFix.map((f) => f.title)).toEqual(["Two"]);
      expect(out.toFix[0]?.fix).toContain("Advisor ruling (D-2): do it");
      expect(out.advice.map((a) => a.decisionId)).toEqual(["D-1", "D-2"]);
    });
  });

  test("waive and supersede drop the finding", async () => {
    await withTempDir(async (dir) => {
      for (const action of [
        { type: "waive", reason: "spec allows it" },
        { type: "supersede", target: { kind: "spec", section: "Design" }, newText: "x" },
      ] as const) {
        const { advisor } = fakeAdvisor(() => ({ decision: decision({ action, chosenOptionId: "B" }) }));
        const out = await make(dir, advisor).judged([judged], [], state(dir));
        expect(out.toFix).toEqual([]);
        expect(out.unresolved).toEqual([]);
        expect(out.advice).toHaveLength(1);
      }
    });
  });

  test("advisor unavailable gives unresolved", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({ decision: null, fallbackReason: "no-json" }));
      const out = await make(dir, advisor).judged([judged], [], state(dir));
      expect(out).toEqual({ toFix: [], advice: [], unresolved: [judged] });
    });
  });

  test("dedupe key uses the finding's source", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({}) }));
      const f = { ...judged, source: "spec" as const };
      await make(dir, advisor).judged([f], [], state(dir));
      expect(asked[0]?.dedupeKey).toBe(dedupeKeyFor("spec", f));
    });
  });

  const s: Finding = { severity: "LOW", title: "S", problem: "sp", fix: "sf", source: "spec", file: "a.ts", line: 2 };
  const qf: Finding = { ...s, title: "Q", problem: "qp", source: "quality", severity: "HIGH" };

  test("a contradiction is one question with both findings as evidence; fix gives the spec finding", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({
        decision: decision({ action: { type: "fix", instruction: "keep retry" } }),
      }));
      const out = await make(dir, advisor).judged([], [{ spec: s, quality: qf }], state(dir));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.summary).toBe("Spec and quality reviews disagree on a.ts:2");
      expect(asked[0]?.evidence.map((e) => e.text.split(":")[0])).toEqual(["Spec review", "Quality review"]);
      expect(asked[0]?.findingSeverity).toBe("HIGH");
      expect(asked[0]?.dedupeKey).toBe(dedupeKeyFor("spec", s));
      expect(out.toFix.map((f) => f.title)).toEqual(["S"]);
      expect(out.toFix[0]?.fix).toContain("Advisor ruling (D-1): keep retry");
      expect(out.unresolved).toEqual([]);
    });
  });

  test("contradiction waived drops both", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({ decision: decision({ action: { type: "waive", reason: "fine" } }) }));
      const out = await make(dir, advisor).judged([], [{ spec: s, quality: qf }], state(dir));
      expect(out.toFix).toEqual([]);
      expect(out.unresolved).toEqual([]);
      expect(out.advice).toHaveLength(1);
    });
  });

  test("contradiction on hold or fallback: spec to toFix, quality to unresolved", async () => {
    await withTempDir(async (dir) => {
      const replies = [
        { decision: decision({ action: { type: "hold", reason: "x" } }) },
        { decision: null, fallbackReason: "down" },
      ];
      for (const reply of replies) {
        const { advisor } = fakeAdvisor(() => reply);
        const out = await make(dir, advisor).judged([], [{ spec: s, quality: qf }], state(dir));
        expect(out.toFix).toEqual([s]);
        expect(out.unresolved).toEqual([qf]);
      }
    });
  });
});

describe("judgeWithoutAdvisor", () => {
  test("judged findings are unresolved; contradictions resolve spec-first", () => {
    const s = { severity: "LOW" as const, title: "S", problem: "p", fix: "f", source: "spec" as const, file: "a.ts" };
    const q = { ...s, title: "Q", source: "quality" as const };
    const j = { ...s, title: "J", judgment: true };
    expect(judgeWithoutAdvisor([j], [{ spec: s, quality: q }])).toEqual({ toFix: [s], advice: [], unresolved: [j, q] });
  });
});

describe("createFinishAdvisor.approval", () => {
  const facts: ResolutionFacts = {
    findingsOpen: [{ severity: "HIGH", title: "Leak", problem: "p", fix: "f", source: "spec", file: "a.ts", line: 7 }],
    acceptance: "red",
    gates: [
      { name: "lint", status: "green" },
      { name: "tests", status: "red", excerpt: Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") },
    ],
    reviewsMissing: ["quality"],
    unreviewedFixCommits: ["abc123"],
    coverage: { spec: 0.5, quality: null },
    fixRounds: 2,
  };

  test("question evidence lists open findings, acceptance, gates with excerpt, missing lenses, unreviewed commits, coverage", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({ action: { type: "approve" } }) }));
      await make(dir, advisor).approval(facts, approvalFacts(facts, false));
      const q = asked[0];
      assertDefined(q, "approval question");
      expect(q.kind).toBe("finish-approval");
      expect(q.summary).toStartWith("Approve the PR for feat? 1 open finding(s)");
      const texts = q.evidence.map((e) => e.text);
      expect(q.evidence.every((e) => e.source === "review-round")).toBe(true);
      expect(texts[0]).toBe("[HIGH] (spec) Leak — a.ts:7");
      expect(texts[1]).toBe("Acceptance: red");
      expect(texts[2]).toContain("lint: green\ntests: red\nline1\n");
      expect(texts[2]).toContain("line20");
      expect(texts[2]).not.toContain("line21");
      expect(texts[3]).toBe("Missing reviews: quality");
      expect(texts[4]).toBe("Unreviewed fix commits: abc123");
      expect(texts[5]).toBe("Coverage: spec 50%, quality n/a");
    });
  });

  test("an empty fact set reads none", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({ action: { type: "approve" } }) }));
      const clean: ResolutionFacts = {
        ...facts,
        findingsOpen: [],
        reviewsMissing: [],
        unreviewedFixCommits: [],
        gates: [],
      };
      await make(dir, advisor).approval(clean, approvalFacts(clean, false));
      const texts = asked[0]?.evidence.map((e) => e.text);
      expect(texts?.[0]).toBe("none");
      expect(texts?.[3]).toBe("Missing reviews: none");
      expect(texts?.[4]).toBe("Unreviewed fix commits: none");
    });
  });

  test.each([
    [{ type: "approve" }, "approve"],
    [{ type: "re-review", phase: "quality" }, "re-review"],
    [{ type: "hold", reason: "no" }, "hold"],
    [{ type: "fix", instruction: "x" }, "hold"],
  ] as const)("decision %j maps to %s", async (action, expected) => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({ decision: decision({ action, rationale: "why" }) }));
      const out = await make(dir, advisor).approval(facts, approvalFacts(facts, false));
      expect(out).toEqual({ action: expected, rationale: "why" });
    });
  });

  test("no decision gives unavailable with the fallback reason", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({ decision: null, fallbackReason: "no-json" }));
      const out = await make(dir, advisor).approval(facts, approvalFacts(facts, false));
      expect(out).toEqual({ action: "unavailable", rationale: "no-json" });
    });
  });
});
