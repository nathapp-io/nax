import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceQuestion, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding, FinishState } from "@/finish";
import { createFinishAdvisor, createFinishState } from "@/finish";

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

describe("createFinishAdvisor.judged", () => {
  test("a fix ruling keeps the finding with the ruling appended to its fix", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({}) }));
      const out = await make(dir, advisor).judged("quality", [judged], state(dir));
      expect(out.toFix).toHaveLength(1);
      expect(out.toFix[0]?.fix).toContain("Advisor ruling (D-1): take the account lock");
      expect(out.advice).toEqual([{ decisionId: "D-1", optionId: "A", reused: false }]);
      expect((asked[0] as AdviceQuestion).dedupeKey).toBe("quality|Race|src/a.ts");
    });
  });

  test("waive and supersede drop the finding", async () => {
    await withTempDir(async (dir) => {
      for (const action of [
        { type: "waive", reason: "spec allows it" },
        { type: "supersede", target: { kind: "spec", section: "Design" }, newText: "x" },
      ] as const) {
        const { advisor } = fakeAdvisor(() => ({ decision: decision({ action, chosenOptionId: "B" }) }));
        const out = await make(dir, advisor).judged("quality", [judged], state(dir));
        expect(out.toFix).toEqual([]);
        expect(out.hold).toBeUndefined();
      }
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
      const out = await make(dir, advisor).judged("quality", [reworded], state(dir));
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
      await make(dir, advisor).judged("quality", [judged], state(dir));
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
      await make(dir, advisor).judged("quality", [low], state(dir));
      expect(reused).toHaveLength(0);
      expect(asked).toHaveLength(1);
    });
  });

  test("hold and fallback short-circuit", async () => {
    await withTempDir(async (dir) => {
      const hold = fakeAdvisor(() => ({
        decision: decision({ action: { type: "hold", reason: "product call" }, rationale: "needs a human" }),
      }));
      expect((await make(dir, hold.advisor).judged("spec", [judged], state(dir))).hold).toBe("needs a human");
      const none = fakeAdvisor(() => ({ decision: null, fallbackReason: "no-json" }));
      expect((await make(dir, none.advisor).judged("spec", [judged], state(dir))).fallback).toBe("no-json");
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
