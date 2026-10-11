import { afterEach, describe, expect, test } from "bun:test";
import { type FinishGitModel, installFinishGit, makeFinishOps, makeFinishState, withTempDir } from "@test/helpers";
import type { Finding, FinishAdvisor, FinishOps, FinishReviewOutput, ReviewInputs } from "@/finish";
import { MAX_REVIEW_ROUNDS, readRounds, runReviewLoop } from "@/finish";

const inputs: ReviewInputs = { changed: ["a.ts"], hints: [], stories: [], prdPath: ".nax/features/feat/prd.json" };

const q = (title: string, extra: Partial<Finding> = {}): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts", ...extra }],
  covered: ["a.ts"],
});

const s = (title: string, extra: Partial<Finding> = {}): FinishReviewOutput => ({
  findings: [{ severity: "HIGH", title, problem: "p", fix: "f", source: "spec", file: "b.ts", ...extra }],
  covered: ["b.ts"],
});

let restoreGit: () => void = () => {};
afterEach(() => restoreGit());

function stubGit(model: FinishGitModel): void {
  restoreGit = installFinishGit(model);
}

function deps(ops: FinishOps, auditDir: string, advise?: FinishAdvisor) {
  return {
    ops,
    ...(advise ? { advise } : {}),
    inputs,
    audit: { auditDir, runId: "run-1" },
    now: () => "t",
    assertNotAborted: () => {},
  };
}

/** A fixer that edits the tree (so `commitFixes` commits) and records the findings it was handed. */
function editingFix(git: FinishGitModel, trail: string[], seen: Finding[][] = []): FinishOps["fix"] {
  return async (phase, req) => {
    trail.push(`fix:${phase}`);
    seen.push(req.findings ?? []);
    git.dirty = true;
    return {};
  };
}

describe("runReviewLoop", () => {
  test("clean first round: no fix, rounds 1, lastFindings empty", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const trail: string[] = [];
      const state = makeFinishState();
      await runReviewLoop(state, deps(makeFinishOps(trail), dir));
      expect(state.review.rounds).toBe(1);
      expect(state.review.lastFindings).toEqual([]);
      expect(state.review.missingLenses).toEqual([]);
      expect(trail).toEqual(["review:spec", "review:quality"]);
      const rounds = await readRounds({ auditDir: dir, runId: "run-1" });
      expect(rounds.map((r) => `${r.phase}:${r.outcome}`)).toEqual(["spec:passed", "quality:passed"]);
    });
  });

  test("findings: one fix with the spec finding first, then a clean second round", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const seen: Finding[][] = [];
      const ops = makeFinishOps(
        trail,
        { spec: [s("Spec gap")], quality: [q("Quality gap")] },
        { fix: editingFix(git, trail, seen) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.map((f) => f.title)).toEqual(["Spec gap", "Quality gap"]);
      expect(state.review.rounds).toBe(2);
      expect(state.review.lastFindings).toEqual([]);
      expect(state.review.committedFixes).toBe(true);
      expect(state.committedThisRun).toBe(true);
      expect(state.unreviewedFixCommits).toEqual([]);
      const fixed = (await readRounds({ auditDir: dir, runId: "run-1" })).filter((r) => r.outcome === "fixed");
      expect(fixed.map((r) => r.phase)).toEqual(["review"]);
      expect(fixed[0]?.sha).toBe("sha2");
    });
  });

  test("a spec-sourced finding returned by the advisor is still ordered before quality findings", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const seen: Finding[][] = [];
      const judgedSpec: Finding = {
        severity: "HIGH",
        title: "J",
        problem: "p",
        fix: "f",
        source: "spec",
        judgment: true,
      };
      const advise: FinishAdvisor = {
        judgedEnabled: true,
        approvalEnabled: false,
        judged: async (findings) => ({ toFix: findings, advice: [], unresolved: [] }),
        approval: async () => ({ action: "unavailable", rationale: "n/a" }),
        commitLedger: async () => {},
      };
      const ops = makeFinishOps(
        [],
        { spec: [{ findings: [judgedSpec], covered: [] }], quality: [q("Q")] },
        { fix: editingFix(git, [], seen) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir, advise));
      expect(seen[0]?.map((f) => f.title)).toEqual(["J", "Q"]);
      expect(state.phases.review.adviseRounds).toBe(1);
    });
  });

  test("clean is checked before the cap: a clean round 2 ends the loop", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A")] }, { fix: editingFix(git, trail) });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(trail.filter((t) => t === "review:quality")).toHaveLength(2);
    });
  });
});

describe("runReviewLoop cap", () => {
  test("three rounds with findings: the round-3 fix SHA is unreviewed and its findings cleared", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(trail, { quality: [q("A"), q("B"), q("C")] }, { fix: editingFix(git, trail) });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.rounds).toBe(MAX_REVIEW_ROUNDS);
      expect(trail.filter((t) => t === "fix:review")).toHaveLength(3);
      expect(state.review.lastFindings).toEqual([]);
      expect(state.unreviewedFixCommits).toEqual(["sha4"]);
    });
  });

  test("a cap-round fix that commits nothing keeps the findings open", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const ops = makeFinishOps(
        [],
        { quality: [q("A"), q("B"), q("C")] },
        {
          fix: async () => {
            if (git.head < 3) git.dirty = true; // rounds 1-2 edit, round 3 rejects everything
            return {};
          },
        },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.lastFindings.map((f) => f.title)).toEqual(["C"]);
      expect(state.unreviewedFixCommits).toEqual([]);
    });
  });

  test("extraRounds runs exactly that many rounds beyond those already run", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const trail: string[] = [];
      const ops = makeFinishOps(
        trail,
        { quality: [q("A"), q("B"), q("C"), q("D"), q("E")] },
        { fix: editingFix(git, trail) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      await runReviewLoop(state, deps(ops, dir), 1);
      expect(state.review.rounds).toBe(MAX_REVIEW_ROUNDS + 1);
      expect(state.unreviewedFixCommits).toEqual(["sha5"]);
    });
  });
});

describe("runReviewLoop failures and advisor-off judgment", () => {
  test("a fix session that throws counts the round and leaves findings open", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const ops = makeFinishOps(
        [],
        { quality: [q("A"), q("A"), q("A")] },
        {
          fix: async () => {
            throw new Error("session died");
          },
        },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.rounds).toBe(3);
      expect(state.review.lastFindings.map((f) => f.title)).toEqual(["A"]);
      expect(state.review.committedFixes).toBe(false);
    });
  });

  test("an abort while a fix session was failing is not swallowed", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      let aborted = false;
      const ops = makeFinishOps(
        [],
        { quality: [q("A")] },
        {
          fix: async () => {
            aborted = true;
            throw new Error("deadline");
          },
        },
      );
      const d = {
        ...deps(ops, dir),
        assertNotAborted: () => {
          if (aborted) throw new Error("aborted");
        },
      };
      await expect(runReviewLoop(makeFinishState(), d)).rejects.toThrow("aborted");
    });
  });

  test("contradiction with the advisor off: spec finding fixed, quality finding unresolved", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const seen: Finding[][] = [];
      const spec = s("Must retry", { file: "a.ts", line: 9, fix: "add retry" });
      const ops = makeFinishOps(
        [],
        { spec: [spec], quality: [q("Retry is bad", { line: 9 })] },
        { fix: editingFix(git, [], seen) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(seen[0]?.map((f) => f.title)).toEqual(["Must retry"]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual(["Retry is bad"]);
    });
  });

  test("judged finding with advisor off: unresolved, not fixed", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const trail: string[] = [];
      const judged = q("Design call", { judgment: true });
      const state = makeFinishState();
      await runReviewLoop(state, deps(makeFinishOps(trail, { quality: [judged] }), dir));
      expect(trail).not.toContain("fix:review");
      expect(state.review.unresolved.map((f) => f.title)).toEqual(["Design call"]);
      expect(state.review.rounds).toBe(1);
    });
  });

  test("unresolved findings accumulate across rounds without duplicates", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const judged = q("Design call", { judgment: true }).findings;
      const plain = q("Plain");
      const ops = makeFinishOps(
        [],
        {
          quality: [
            { findings: [...judged, ...plain.findings], covered: [] },
            { findings: judged, covered: [] },
          ],
        },
        { fix: editingFix(git, []) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.unresolved.map((f) => f.title)).toEqual(["Design call"]);
    });
  });
});

describe("runReviewLoop lens bookkeeping", () => {
  test("one lens missing: the other lens is still fixed and missingLenses records it", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps(
        [],
        {
          spec: [
            { findings: [], covered: [], missing: true },
            { findings: [], covered: [], missing: true },
          ],
          quality: [q("Q")],
        },
        { fix: editingFix(git, [], seen) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(seen[0]?.map((f) => f.title)).toEqual(["Q"]);
      expect(state.review.missingLenses).toEqual(["spec"]);
      const outcomes = (await readRounds({ auditDir: dir, runId: "run-1" })).map((r) => `${r.phase}:${r.outcome}`);
      expect(outcomes).toContain("spec:missing");
    });
  });

  test("a missing lens round does not clear unreviewed fix commits", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 5 });
      const ops = makeFinishOps([], { spec: [{ findings: [], covered: [], missing: true }] });
      const state = makeFinishState({ unreviewedFixCommits: ["sha4"] });
      await runReviewLoop(state, deps(ops, dir), 1);
      expect(state.unreviewedFixCommits).toEqual(["sha4"]);
    });
  });

  test("a clean round after a gate-fix SHA clears unreviewedFixCommits", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 5 });
      const state = makeFinishState({ unreviewedFixCommits: ["sha4"] });
      await runReviewLoop(state, deps(makeFinishOps([]), dir), 1);
      expect(state.unreviewedFixCommits).toEqual([]);
    });
  });

  test("title and summary from the branch lens are kept from the latest round that gave them", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const first: FinishReviewOutput = { ...q("A"), title: "feat: first", summary: "first summary" };
      const second: FinishReviewOutput = { findings: [], covered: ["a.ts"] };
      const ops = makeFinishOps([], { quality: [first, second] }, { fix: editingFix(git, []) });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.title).toBe("feat: first");
      expect(state.review.summary).toBe("first summary");
    });
  });

  test("a later round's title replaces an earlier one", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const first: FinishReviewOutput = { ...q("A"), title: "feat: first", summary: "one" };
      const second: FinishReviewOutput = { findings: [], covered: [], title: "feat: second", summary: "two" };
      const ops = makeFinishOps([], { quality: [first, second] }, { fix: editingFix(git, []) });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.title).toBe("feat: second");
      expect(state.review.summary).toBe("two");
    });
  });

  test("covered paths are recorded per lens and a missing lens keeps its earlier coverage", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const ops = makeFinishOps(
        [],
        {
          spec: [s("S"), { findings: [], covered: [], missing: true }],
          quality: [q("Q"), { findings: [], covered: ["a.ts"] }],
        },
        { fix: editingFix(git, []) },
      );
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.covered.spec).toEqual(["b.ts"]);
      expect(state.review.covered.quality).toEqual(["a.ts"]);
    });
  });

  test("a missing verdict is never mutated: its shared arrays stay empty", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const missing: FinishReviewOutput = { findings: [], covered: [], missing: true };
      const ops = makeFinishOps([], { spec: [missing] });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      state.review.covered.spec.push("x.ts");
      expect(missing.covered).toEqual([]);
      expect(missing.findings).toEqual([]);
    });
  });
});
