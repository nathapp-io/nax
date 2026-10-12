/**
 * The advisor's two seats in `runFinishMachine` (A1 callers 1 + 4, as rebuilt by A4): ruling on judged findings
 * inside the review loop, and approving, re-reviewing or holding from the end-of-run facts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeMachineHarness, restoreFinishMachineStubs, withTempDir } from "@test/helpers";
import type { ApprovalAction, Finding, FinishAdvisor, FinishReviewOutput, ResolutionFacts } from "@/finish";
import { runFinishMachine } from "@/finish";

afterEach(() => restoreFinishMachineStubs());

const finding = (title: string, extra: Partial<Finding> = {}): Finding => ({
  severity: "MEDIUM",
  title,
  problem: "p",
  fix: "f",
  source: "quality",
  file: "a.ts",
  ...extra,
});
const q = (title: string, extra: Partial<Finding> = {}): FinishReviewOutput => ({
  findings: [finding(title, extra)],
  covered: ["a.ts"],
});

interface AdvisorLog {
  approvals: ResolutionFacts[];
  judgedCalls: Finding[][];
  ledgerCommits: number;
}

function makeAdvisor(
  actions: Array<{ action: ApprovalAction; rationale: string }>,
  overrides: Partial<FinishAdvisor> = {},
): { advisor: FinishAdvisor; log: AdvisorLog } {
  const log: AdvisorLog = { approvals: [], judgedCalls: [], ledgerCommits: 0 };
  const queue = [...actions];
  const advisor: FinishAdvisor = {
    judgedEnabled: false,
    approvalEnabled: true,
    judged: async (findings) => {
      log.judgedCalls.push(findings);
      return { toFix: [], advice: [], unresolved: findings, dropped: [], held: [] };
    },
    approval: async (facts) => {
      log.approvals.push(facts);
      return queue.shift() ?? { action: "unavailable", rationale: "script exhausted" };
    },
    commitLedger: async () => {
      log.ledgerCommits += 1;
    },
    ...overrides,
  };
  return { advisor, log };
}

/** Quality findings that survive every round because the fixer commits nothing. */
const STUCK = { quality: [q("A"), q("A"), q("A"), q("A")] };

describe("approval", () => {
  test("approve with open findings: promotePr, outcome ready, the findings recorded as accepted residue", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([{ action: "approve", rationale: "residue is cosmetic" }]);
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: STUCK,
        fixIsNoop: true,
        advise: advisor,
      });
      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("promoted");
      expect(result.outcome).toBe("ready");
      expect(result.acceptedResidue?.map((f) => f.title)).toEqual(["A"]);
      expect(result.findings).toBeUndefined();
      expect(trail).toContain("promotePr");
      expect(trail).not.toContain("finalizeDraftPr");
      expect(log.approvals).toHaveLength(1);
      expect(log.ledgerCommits).toBe(1);
      expect(state.resolution?.acceptedResidue).toHaveLength(1);
    });
  });

  test("re-review: exactly one extra round, then resolve again", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([
        { action: "re-review", rationale: "look again" },
        { action: "approve", rationale: "now fine" },
      ]);
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A"), q("A"), q("A"), { findings: [], covered: ["a.ts"] }] },
        fixIsNoop: true,
        advise: advisor,
      });
      const result = await runFinishMachine(state, deps);

      expect(trail.filter((t) => t === "review:quality")).toHaveLength(4);
      expect(state.review.rounds).toBe(4);
      expect(state.review.reReviewUsed).toBe(true);
      // the extra round came back clean, so the second resolve is clean and never reaches the advisor again
      expect(log.approvals).toHaveLength(1);
      expect(log.approvals[0]?.findingsOpen).toHaveLength(1);
      expect(result.outcome).toBe("ready");
      expect(result.acceptedResidue).toBeUndefined();
      expect(log.ledgerCommits).toBe(1);
    });
  });

  test("a second re-review request is a draft, not a loop", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([
        { action: "re-review", rationale: "again" },
        { action: "re-review", rationale: "and again" },
      ]);
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: STUCK,
        fixIsNoop: true,
        advise: advisor,
      });
      const result = await runFinishMachine(state, deps);
      expect(trail.filter((t) => t === "review:quality")).toHaveLength(4);
      expect(log.approvals).toHaveLength(2);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("advisor:");
    });
  });

  test("a re-review round that commits a fix re-checks acceptance and the gates", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = makeAdvisor([
        { action: "re-review", rationale: "look again" },
        { action: "approve", rationale: "fine" },
      ]);
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, script: STUCK, advise: advisor });
      // rounds 1-3 fix and commit; the advisor then asks for a fourth, which commits too
      const result = await runFinishMachine(state, deps);
      const lastReview = trail.lastIndexOf("review:quality");
      expect(trail.slice(lastReview + 1)).toEqual([
        "fix:review",
        "commit",
        "acceptance-run", // the re-check of the re-review's fix
        "acceptance-run", // gate zero
        "quality-run:test",
        "finalizeDraftPr", // the re-review's own fix is unreviewed, so an approve cannot make the PR ready
      ]);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("approve rejected (phases incomplete)");
    });
  });

  test("hold: draft with an 'advisor:' reason", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([{ action: "hold", rationale: "needs a human call" }]);
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: STUCK,
        fixIsNoop: true,
        advise: advisor,
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason?.startsWith("advisor: needs a human call")).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(trail).toContain("finalizeDraftPr");
      // the ledger the advisor wrote is committed even when it held
      expect(log.ledgerCommits).toBe(1);
    });
  });

  test("advisor unavailable: draft, never ready", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = makeAdvisor([{ action: "unavailable", rationale: "no-json" }]);
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: STUCK,
        fixIsNoop: true,
        advise: advisor,
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("advisor: no-json");
      expect(trail).not.toContain("promotePr");
    });
  });

  test("an advisor that throws is unavailable: draft with the error", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = makeAdvisor([], {
        approval: async () => {
          throw new Error("advisor session died");
        },
      });
      const { deps, state } = makeMachineHarness({ auditDir: dir, script: STUCK, fixIsNoop: true, advise: advisor });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("advisor error: Error: advisor session died");
    });
  });

  test("a clean run never calls the advisor's approval, and commits no ledger", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([{ action: "approve", rationale: "unused" }]);
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, advise: advisor });
      const result = await runFinishMachine(state, deps);
      expect(log.approvals).toHaveLength(0);
      expect(log.ledgerCommits).toBe(0);
      expect(result.outcome).toBe("ready");
      expect(trail).toContain("promotePr");
    });
  });

  test("approvalEnabled off: an approval-only advisor is not consulted and the draft stands", async () => {
    await withTempDir(async (dir) => {
      const { advisor, log } = makeAdvisor([{ action: "approve", rationale: "unused" }], { approvalEnabled: false });
      const { deps, state } = makeMachineHarness({ auditDir: dir, script: STUCK, fixIsNoop: true, advise: advisor });
      const result = await runFinishMachine(state, deps);
      expect(log.approvals).toHaveLength(0);
      expect(result.outcome).toBe("draft");
    });
  });
});

describe("judged findings", () => {
  test("plain and judged together: the advisor's ruling is fixed in one round with the plain finding", async () => {
    await withTempDir(async (dir) => {
      const seen: Finding[][] = [];
      const { advisor, log } = makeAdvisor([], {
        judgedEnabled: true,
        judged: async (findings) => ({
          toFix: findings.map((f) => ({ ...f, fix: `${f.fix}\n\nAdvisor ruling (D-1): do it` })),
          advice: [{ decisionId: "D-1", optionId: "A", reused: false }],
          unresolved: [],
          dropped: [],
          held: [],
        }),
      });
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        advise: advisor,
        script: {
          quality: [{ findings: [finding("Plain"), finding("Judged", { judgment: true, file: "b.ts" })], covered: [] }],
        },
        ops: {
          fix: async (_phase, req) => {
            seen.push(req.findings ?? []);
            return {};
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.map((f) => f.title)).toEqual(["Plain", "Judged"]);
      expect(seen[0]?.[1]?.fix).toContain("Advisor ruling (D-1)");
      expect(log.approvals).toHaveLength(0);
      expect(state.phases.review.adviseRounds).toBe(1);
      expect(result.outcome).toBe("ready");
      // the advisor wrote decisions this finish, so its ledger is committed before the PR is finalized
      expect(log.ledgerCommits).toBe(1);
    });
  });

  test("a judged finding the advisor holds stays open and keeps the PR a draft", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = makeAdvisor([], {
        judgedEnabled: true,
        approvalEnabled: false,
        judged: async (findings) => ({ toFix: [], advice: [], unresolved: findings, dropped: [], held: [] }),
      });
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        advise: advisor,
        script: { quality: [q("Design call", { judgment: true })] },
      });
      const result = await runFinishMachine(state, deps);
      expect(trail).not.toContain("fix:review");
      expect(result.outcome).toBe("draft");
      expect(result.findings?.map((f) => f.title)).toEqual(["Design call"]);
    });
  });

  test("no advisor: a judged finding is unresolved, the trail has no advisor step", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("Design call", { judgment: true })] },
      });
      const result = await runFinishMachine(state, deps);
      expect(trail).not.toContain("fix:review");
      expect(result.outcome).toBe("draft");
    });
  });
});
