import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FinishGitModel, installFinishGit, makeFinishOps, makeFinishState, withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding, FinishAdvisor, FinishOps, FinishReviewOutput, ReviewInputs } from "@/finish";
import { createFinishAdvisor, runReviewLoop } from "@/finish";

const inputs: ReviewInputs = { changed: ["a.ts"], hints: [], stories: [], prdPath: ".nax/features/feat/prd.json" };
let restoreGit: () => void = () => {};
afterEach(() => restoreGit());

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

function loopDeps(ops: FinishOps, auditDir: string, advise?: FinishAdvisor, acceptancePaths?: string[]) {
  return {
    ops,
    ...(advise ? { advise } : {}),
    ...(acceptancePaths ? { acceptancePaths } : {}),
    inputs,
    audit: { auditDir, runId: "run-1" },
    now: () => "t",
    assertNotAborted: () => {},
    fix: { ops, audit: { auditDir, runId: "run-1" }, now: () => "t" },
  };
}

function finishAdvisor(dir: string, advisor: Advisor, judgedEnabled = true): FinishAdvisor {
  return createFinishAdvisor({
    advisor,
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    acceptanceEnabled: () => true,
    judgedEnabled,
    approvalEnabled: !judgedEnabled,
    git: async () => ({ exitCode: 0 }),
  });
}

/** A fixer that records the findings it was handed; `edits` makes it dirty the tree so a commit happens. */
function recordingFix(seen: Finding[][], git?: FinishGitModel): FinishOps["fix"] {
  return async (_phase, req) => {
    seen.push(req.findings ?? []);
    if (git) git.dirty = true;
    return {};
  };
}

async function trustedWaive(dir: string, f: Finding): Promise<void> {
  const d = await appendDecision(dir, "feat", (id) => ({
    ...decision({ action: { type: "waive", reason: "outOfScope" }, findingSeverity: f.severity }),
    dedupeKey: dedupeKeyFor(f.source ?? "quality", f),
    anchorFile: f.file,
    rulingTitle: f.title,
    auditRef: `advisor-audit/feat/${id}.json`,
  }));
  await Bun.write(join(dir, "out", d.auditRef), JSON.stringify({ result: { decision: d } }));
}

const seam = "src/thread-job-run.ts";
const specJudged: Finding = {
  severity: "MEDIUM",
  title: "ThreadJobRun has two lifetimes",
  problem: "p",
  fix: "f",
  source: "spec",
  file: seam,
  judgment: true,
};
const qualityPlain: Finding = {
  severity: "MEDIUM",
  title: "Constructor carries a test-only legacy mode",
  problem: "p",
  fix: "remove the seam",
  source: "quality",
  file: seam,
};
const out = (findings: Finding[]): FinishReviewOutput => ({ findings, covered: [seam] });

describe("review round: rulings stick (finish B)", () => {
  test("koda case: the other lens's plain sibling of a same-round waive is asked, not fixed", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps(
        [],
        { spec: [out([specJudged])], quality: [out([qualityPlain])] },
        { fix: recordingFix(seen, git) },
      );
      const { advisor, asked } = fakeAdvisor((q) =>
        q.summary.startsWith("Possibly the same issue as D-2")
          ? { decision: decision({ id: "D-3", action: { type: "waive", reason: "D-2 keeps the seam" } }) }
          : {
              decision: decision({ id: "D-2", action: { type: "waive", reason: "acceptance drives runs through it" } }),
            },
      );
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen.flat().map((f) => f.title)).not.toContain(qualityPlain.title);
      expect(asked).toHaveLength(2);
      expect(asked[0]?.summary).toContain("ThreadJobRun has two lifetimes");
      expect(asked[1]?.summary.startsWith("Possibly the same issue as D-2.")).toBe(true);
      // the same-round ruling carries its reason into the near question's evidence (spec §3.5)
      expect(asked[1]?.evidence[0]?.text).toContain("acceptance drives runs through it");
      expect(state.review.ledger.find((e) => e.finding.title === qualityPlain.title)?.state).toBe("waived");
    });
  });

  test("koda case, advisor gives no decision on the sibling: unresolved, not fixed", async () => {
    await withTempDir(async (dir) => {
      restoreGit = installFinishGit({ dirty: false, head: 1 });
      const seen: Finding[][] = [];
      const ops = makeFinishOps(
        [],
        { spec: [out([specJudged])], quality: [out([qualityPlain])] },
        { fix: recordingFix(seen) },
      );
      const { advisor } = fakeAdvisor((q) =>
        q.summary.startsWith("Possibly")
          ? { decision: null, fallbackReason: "down" }
          : { decision: decision({ id: "D-2", action: { type: "waive", reason: "keep it" } }) },
      );
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen.flat()).toEqual([]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual([qualityPlain.title]);
    });
  });

  test("#2464 across rounds: a re-titled re-raise of a trusted waive never reaches the fixer", async () => {
    await withTempDir(async (dir) => {
      restoreGit = installFinishGit({ dirty: false, head: 1 });
      const ruled: Finding = {
        ...qualityPlain,
        severity: "LOW",
        title: "Exec argv loses its refusal",
        file: "src/pm.ts",
      };
      await trustedWaive(dir, ruled);
      const retitled: Finding = { ...ruled, title: "Opening configRefusal unscreens Exec argv" };
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([retitled])] }, { fix: recordingFix(seen) });
      const { advisor, asked } = fakeAdvisor(() => ({
        decision: decision({ id: "D-2", action: { type: "waive", reason: "D-1" } }),
      }));
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen).toEqual([]);
      expect(asked).toHaveLength(1);
      expect(state.review.ledger.find((e) => e.finding.title === retitled.title)?.state).toBe("waived");
    });
  });

  test("approval-only advisor: no judgment calls; near is unresolved, exact is reused", async () => {
    await withTempDir(async (dir) => {
      restoreGit = installFinishGit({ dirty: false, head: 1 });
      const ruled: Finding = { ...qualityPlain, severity: "LOW", title: "Ruled", file: "src/pm.ts" };
      await trustedWaive(dir, ruled);
      const near: Finding = { ...ruled, title: "Different wording" };
      const exact: Finding = { ...ruled, source: "spec" };
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { spec: [out([exact])], quality: [out([near])] }, { fix: recordingFix(seen) });
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: null }));
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor, false)));
      expect(asked).toHaveLength(0);
      expect(reused).toHaveLength(1);
      expect(seen).toEqual([]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual(["Different wording"]);
    });
  });

  test("reconcile that throws carries its findings unresolved (Review Focus 3)", async () => {
    await withTempDir(async (dir) => {
      restoreGit = installFinishGit({ dirty: false, head: 1 });
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([qualityPlain])] }, { fix: recordingFix(seen) });
      const base = finishAdvisor(dir, fakeAdvisor(() => ({ decision: null })).advisor);
      const advise: FinishAdvisor = {
        ...base,
        rulingsInForce: async () => [
          { id: "D-1", action: "waive", anchor: seam, title: "x", blocking: false, summary: "waive: x" },
        ],
        reconcile: async () => {
          throw new Error("boom");
        },
      };
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, advise));
      expect(seen).toEqual([]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual([qualityPlain.title]);
      expect(state.review.rounds).toBe(1);
    });
  });

  test("advisor off: findings flow exactly as before (no rulings consulted)", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([qualityPlain])] }, { fix: recordingFix(seen, git) });
      await runReviewLoop(makeFinishState({ workdir: dir }), loopDeps(ops, dir));
      expect(seen[0]?.map((f) => f.title)).toEqual([qualityPlain.title]);
    });
  });
});
