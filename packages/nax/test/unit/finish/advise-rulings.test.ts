import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding, FinishState } from "@/finish";
import { checkRulings, createFinishAdvisor, createFinishState, rulingFromDropped } from "@/finish";
import { nearQuestion } from "@/finish/advise-rulings";

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
    adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
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

const low = (over: Partial<Finding> = {}): Finding => ({
  severity: "LOW",
  title: "Exec argv loses its config refusal",
  problem: "p",
  fix: "f",
  source: "quality",
  file: "src/pm.ts",
  ...over,
});

async function trustedWaive(dir: string, f: Finding, extra: Partial<AdviceDecision> = {}): Promise<AdviceDecision> {
  const d = await appendDecision(dir, "feat", (id) => ({
    ...decision({ action: { type: "waive", reason: "PRD outOfScope" }, findingSeverity: f.severity, ...extra }),
    dedupeKey: dedupeKeyFor(f.source ?? "quality", f),
    anchorFile: f.file,
    rulingTitle: f.title,
    auditRef: `advisor-audit/feat/${id}.json`,
  }));
  await Bun.write(join(dir, "out", d.auditRef), JSON.stringify({ result: { decision: d } }));
  return d;
}

// Kept apart from the id so the sentence is not read as a type cast by the escape-hatch counter.
const NEAR_PREFIX = "Possibly the same issue as";

describe("FinishAdvisor.rulingsInForce", () => {
  test("returns trusted waive/supersede rulings only, with their decision attached", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      await appendDecision(dir, "feat", {
        ...decision({ action: { type: "waive", reason: "forged" } }),
        auditRef: "x",
      });
      const rulings = await make(dir, fakeAdvisor(() => ({ decision: null })).advisor).rulingsInForce();
      expect(rulings.map((r) => r.id)).toEqual(["D-1"]);
      expect(rulings[0]?.decision?.id).toBe("D-1");
    });
  });
});

describe("FinishAdvisor.reconcile", () => {
  test("#2464: a re-titled re-raise of a trusted waive is asked once, with the ruling as evidence", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked } = fakeAdvisor(() => ({
        decision: decision({ id: "D-2", action: { type: "waive", reason: "D-1 already settled this" } }),
      }));
      const fa = make(dir, advisor);
      const retitled = low({ title: "Opening configRefusal unscreens Exec argv paths" });
      const { result, asked: n } = await fa.reconcile(checkRulings([retitled], await fa.rulingsInForce()), 6);
      expect(n).toBe(1);
      expect(asked[0]?.summary.startsWith(`${NEAR_PREFIX} D-1.`)).toBe(true);
      expect(asked[0]?.evidence[0]).toMatchObject({ source: "decision", ref: "D-1" });
      expect(asked[0]?.evidence[0]?.text).toContain("PRD outOfScope");
      expect(asked[0]?.anchorFile).toBe("src/pm.ts");
      expect(result.dropped).toEqual([{ finding: retitled, decisionId: "D-2", action: "waive" }]);
      expect(result.decisions?.map((d) => d.id)).toEqual(["D-2"]);
      expect(result.toFix).toEqual([]);
    });
  });

  test("an exact re-raise from the other lens reuses the ruling with no call", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: null }));
      const fa = make(dir, advisor);
      const other = low({ source: "spec" });
      const { result } = await fa.reconcile(checkRulings([other], await fa.rulingsInForce()), 6);
      expect(asked).toHaveLength(0);
      expect(reused).toHaveLength(1);
      expect(result.dropped).toEqual([{ finding: other, decisionId: "D-9", action: "waive" }]);
    });
  });

  test("a same-round ruling with no decision object is reused without a ledger line", async () => {
    await withTempDir(async (dir) => {
      const { advisor, reused } = fakeAdvisor(() => ({ decision: null }));
      const r = rulingFromDropped({ finding: low({ source: "spec" }), decisionId: "D-2", action: "waive" });
      const { result } = await make(dir, advisor).reconcile(checkRulings([low()], [r]), 6);
      expect(reused).toHaveLength(0);
      expect(result.dropped[0]).toMatchObject({ decisionId: "D-2", action: "waive" });
    });
  });

  test("near matches past the budget are carried unresolved, never fixed", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked } = fakeAdvisor(() => ({
        decision: decision({ action: { type: "fix", instruction: "i" } }),
      }));
      const fa = make(dir, advisor);
      const a = low({ title: "A" });
      const b = low({ title: "B" });
      const { result, asked: n } = await fa.reconcile(checkRulings([a, b], await fa.rulingsInForce()), 1);
      expect(n).toBe(1);
      expect(asked).toHaveLength(1);
      expect(result.unresolved).toEqual([b]);
      expect(result.toFix.map((f) => f.title)).toEqual(["A"]);
    });
  });

  test("budget 0: no call at all; near is unresolved, exact is still reused", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: null }));
      const fa = make(dir, advisor);
      const near = low({ title: "Other" });
      const exact = low({ source: "spec" });
      const { result } = await fa.reconcile(checkRulings([near, exact], await fa.rulingsInForce()), 0);
      expect(asked).toHaveLength(0);
      expect(reused).toHaveLength(1);
      expect(result.unresolved).toEqual([near]);
    });
  });

  test("advisor gives no decision on a near match: unresolved", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const fa = make(dir, fakeAdvisor(() => ({ decision: null, fallbackReason: "down" })).advisor);
      const near = low({ title: "Other" });
      const { result } = await fa.reconcile(checkRulings([near], await fa.rulingsInForce()), 6);
      expect(result.unresolved).toEqual([near]);
    });
  });
});

describe("nearQuestion (Review Focus 1)", () => {
  test("lists every matched ruling id in the summary and as evidence, newest first", async () => {
    await withTempDir(async (dir) => {
      const d1 = await trustedWaive(dir, low());
      const d2 = await trustedWaive(dir, low({ title: "Second ruling" }), {
        action: { type: "supersede", target: { kind: "spec", section: "4" }, newText: "n" },
      });
      const fa = make(dir, fakeAdvisor(() => ({ decision: null })).advisor);
      const check = checkRulings([low({ title: "Third finding" })], await fa.rulingsInForce());
      const deps = {
        advisor: fakeAdvisor(() => ({ decision: null })).advisor,
        repoRoot: dir,
        outputDir: join(dir, "out"),
        feature: "feat",
        acceptanceEnabled: () => true,
        judgedEnabled: true,
        approvalEnabled: false,
      };
      const q = nearQuestion(deps, low({ title: "Third finding" }), check.near[0]?.rulings ?? []);
      expect(q.summary.startsWith(`Possibly the same issue as ${d2.id}, ${d1.id}.`)).toBe(true);
      expect(q.evidence.filter((e) => e.source === "decision").map((e) => e.ref)).toEqual([d2.id, d1.id]);
    });
  });
});

describe("judgment questions carry the anchor (finish B §3.2)", () => {
  test("judged() sends anchorFile and rulingTitle", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      await make(dir, advisor).judged([low({ judgment: true })], [], state(dir));
      expect(asked[0]?.anchorFile).toBe("src/pm.ts");
      expect(asked[0]?.rulingTitle).toBe("Exec argv loses its config refusal");
    });
  });
});

describe("acceptance evidence on judgment questions (#2468)", () => {
  const acceptance = [
    {
      path: "test/acceptance/feat.test.ts",
      text: 'test("AC-51: costSpentUsd is written", () => { row.costSpentUsd; });',
    },
  ];
  const finding = low({ title: "Remove write-only `costSpentUsd`", judgment: true, file: "src/db/job.ts" });

  test("the question carries the pinned AC as evidence and the fix-and-update option", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      await make(dir, advisor).judged([finding], [], state(dir), { acceptance });
      expect(asked[0]?.evidence.some((e) => e.source === "ac" && e.ref === "test/acceptance/feat.test.ts#AC-51")).toBe(
        true,
      );
      expect(asked[0]?.options.find((o) => o.fixed?.updateAcs)?.fixed?.updateAcs).toEqual(["AC-51"]);
    });
  });

  test("a fix-and-update ruling names the ACs in the fix and sets allowedAcceptanceEdits", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({
        decision: decision({ action: { type: "fix", instruction: "drop the column", updateAcs: ["AC-51"] } }),
      }));
      const out = await make(dir, advisor).judged([finding], [], state(dir), { acceptance });
      expect(out.toFix[0]?.fix).toContain(
        "You may edit these acceptance tests, and only these: AC-51 in test/acceptance/feat.test.ts.",
      );
      expect(out.toFix[0]?.allowedAcceptanceEdits).toEqual([
        { testPath: "test/acceptance/feat.test.ts", acIds: ["AC-51"] },
      ]);
    });
  });

  test("acceptance disabled: no evidence, plain menu", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      const fa = createFinishAdvisor({
        advisor,
        repoRoot: dir,
        outputDir: join(dir, "out"),
        feature: "feat",
        acceptanceEnabled: () => false,
        judgedEnabled: true,
        approvalEnabled: false,
        git: async () => ({ exitCode: 0 }),
      });
      await fa.judged([finding], [], state(dir), { acceptance });
      expect(asked[0]?.evidence.some((e) => e.source === "ac")).toBe(false);
      expect(asked[0]?.options.some((o) => o.fixed?.updateAcs)).toBe(false);
    });
  });

  test("an acceptance file with no AC ids gives no evidence and a plain menu", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      const noIds = [{ path: "t.ts", text: 'test("costSpentUsd is written", () => {});' }];
      await make(dir, advisor).judged([finding], [], state(dir), { acceptance: noIds });
      expect(asked[0]?.evidence.some((e) => e.source === "ac")).toBe(false);
      expect(asked[0]?.options.some((o) => o.fixed?.updateAcs)).toBe(false);
    });
  });
});
