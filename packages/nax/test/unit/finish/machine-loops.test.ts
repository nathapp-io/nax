/**
 * The fix-and-reverify loops of `runFinishMachine`: acceptance re-check after a review fix, the gate fix's
 * re-review, and what the facts say when a fix commit is never reviewed. They assert on the observable call
 * trail and the returned `FinishResult`, never on machine internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeMachineHarness, restoreFinishMachineStubs, withTempDir } from "@test/helpers";
import type { Finding, FinishReviewOutput } from "@/finish";
import { MAX_FIX_ATTEMPTS, runFinishMachine } from "@/finish";

afterEach(() => restoreFinishMachineStubs());

const q = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts" } satisfies Finding],
  covered: ["a.ts"],
});

const count = (trail: string[], entry: string): number => trail.filter((t) => t === entry).length;

describe("opening the draft PR", () => {
  test("opens the draft once, after acceptance and before either reviewer", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir });
      await runFinishMachine(state, deps);
      expect(count(trail, "openDraftPr")).toBe(1);
      expect(trail.indexOf("acceptance-run")).toBeLessThan(trail.indexOf("openDraftPr"));
      expect(trail.indexOf("openDraftPr")).toBeLessThan(trail.indexOf("review:spec"));
    });
  });

  test("a draft opened earlier (state.prUrl) is not opened again", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir });
      await runFinishMachine({ ...state, prUrl: "https://x/pr/9" }, deps);
      expect(trail).not.toContain("openDraftPr");
    });
  });
});

describe("review fixes", () => {
  test("a committed review fix re-checks acceptance once, after the last review and before the gates", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, script: { quality: [q("A")] } });
      const result = await runFinishMachine(state, deps);

      // initial, re-check, and gate zero
      expect(count(trail, "acceptance-run")).toBe(3);
      const lastReview = trail.lastIndexOf("review:quality");
      expect(trail.slice(lastReview + 1)).toEqual([
        "acceptance-run",
        "acceptance-run",
        "quality-run:test",
        "promotePr",
      ]);
      expect(result.outcome).toBe("ready");
    });
  });

  test("without a review fix acceptance is not re-checked between the reviews and the gates", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir });
      await runFinishMachine(state, deps);
      expect(count(trail, "acceptance-run")).toBe(2);
    });
  });

  test("a review fix that edits nothing does not trigger the acceptance re-check", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A")] },
        fixIsNoop: true,
      });
      await runFinishMachine(state, deps);
      expect(count(trail, "acceptance-run")).toBe(2);
      expect(state.review.committedFixes).toBe(false);
    });
  });

  test("an acceptance regression after a review fix is fixed within the remaining cap and left unreviewed", async () => {
    await withTempDir(async (dir) => {
      // runs: 1 initial ok, 2 re-check red, 3 re-check after the acceptance fix ok, 4 gate zero ok
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A")] },
        acceptanceExit: (call) => (call === 2 ? 1 : 0),
      });
      const result = await runFinishMachine(state, deps);
      expect(trail).toContain("fix:acceptance");
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("unreviewed fix commit(s)");
    });
  });
});

describe("gate fixes", () => {
  test("a gate fix that commits code, with review rounds left, buys exactly one more review round", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, qualityExit: (call) => (call === 1 ? 1 : 0) });
      const result = await runFinishMachine(state, deps);

      expect(count(trail, "review:spec")).toBe(2);
      expect(count(trail, "review:quality")).toBe(2);
      expect(trail.indexOf("fix:gate")).toBeLessThan(trail.lastIndexOf("review:spec"));
      expect(state.review.rounds).toBe(2);
      expect(result.outcome).toBe("ready");
      expect(result.facts?.unreviewedFixCommits).toEqual([]);
    });
  });

  test("a tests-only gate fix is reviewed like a code fix", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        gitFiles: "test/unit/a.test.ts",
        qualityExit: (call) => (call === 1 ? 1 : 0),
      });
      await runFinishMachine(state, deps);
      expect(count(trail, "review:quality")).toBe(2);
    });
  });

  test("a gate fix that commits nothing buys no review round", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        fixIsNoop: true,
        qualityExit: (call) => (call === 1 ? 1 : 0),
      });
      await runFinishMachine(state, deps);
      expect(count(trail, "fix:gate")).toBe(1);
      expect(count(trail, "review:quality")).toBe(1);
    });
  });

  test("a gate fix after the third review round is listed as an unreviewed commit and the PR is a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A"), q("B"), q("C")] },
        qualityExit: (call) => (call === 1 ? 1 : 0),
      });
      const result = await runFinishMachine(state, deps);

      expect(state.review.rounds).toBe(3);
      expect(count(trail, "review:quality")).toBe(3);
      expect(result.outcome).toBe("draft");
      // the round-3 review fix, the acceptance re-check does not commit, and the gate fix
      expect(result.facts?.unreviewedFixCommits).toHaveLength(2);
      expect(result.reason).toContain("2 unreviewed fix commit(s)");
      expect(trail).toContain("finalizeDraftPr");
      expect(trail).not.toContain("promotePr");
    });
  });

  test("gates that stay red after the fix cap stop the loop: three fixes, then a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, qualityExit: () => 1 });
      const result = await runFinishMachine(state, deps);
      expect(count(trail, "fix:gate")).toBe(3);
      expect(result.outcome).toBe("draft");
    });
  });

  test("gate zero is skipped when acceptance is already red, so a red contract burns no gate-fix attempts", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, acceptanceExit: () => 1 });
      const result = await runFinishMachine(state, deps);
      // 1 initial + 3 acceptance fix re-runs; none from the gates loop
      expect(count(trail, "acceptance-run")).toBe(4);
      expect(count(trail, "fix:gate")).toBe(0);
      expect(result.facts?.acceptance).toBe("red");
      expect(result.outcome).toBe("draft");
    });
  });
});

describe("acceptance facts", () => {
  test("acceptance unverified (nothing ran): never ready, and no fix is attempted", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, context: { groups: [] } });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("acceptance unverified");
      expect(trail).not.toContain("fix:acceptance");
      expect(trail).not.toContain("promotePr");
    });
  });

  test("disabled acceptance runs nothing, is not-configured, and the repo gates still run", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, context: { acceptanceStatus: "disabled" } });
      const result = await runFinishMachine(state, deps);
      expect(trail).not.toContain("acceptance-run");
      expect(trail).toContain("quality-run:test");
      expect(result.facts?.acceptance).toBe("not-configured");
      expect(result.outcome).toBe("ready");
    });
  });

  test("the gate names that ran are recorded on state.gatesRan", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir });
      await runFinishMachine(state, deps);
      expect(state.gatesRan).toEqual(["test"]);
    });
  });
});

describe("a fix session that throws counts as used and the loop continues", () => {
  test("acceptance fix throws: the attempt is spent, review and gates still run", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        acceptanceExit: (call) => (call === 1 ? 1 : 0),
        ops: {
          fix: async (phase) => {
            trail.push(`fix:${phase}`);
            throw new Error("session died");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(state.phases.acceptance.fixAttempts).toBe(1);
      expect(trail).toContain("review:spec");
      expect(trail).toContain("quality-run:test");
      expect(result.facts?.reviewsMissing).toEqual([]);
      expect(result.outcome).toBe("ready");
    });
  });

  test("gate fix throws: attempts are counted up to the cap, then a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        qualityExit: () => 1,
        ops: {
          fix: async (phase) => {
            trail.push(`fix:${phase}`);
            throw new Error("session died");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(count(trail, "fix:gate")).toBe(3);
      expect(state.phases.gate.fixAttempts).toBe(3);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("gates red: test");
    });
  });
});

describe("a fix session that hits fixMs (finish A)", () => {
  test("is set aside, never committed, and the loop reviews again", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("x")] },
        fixMs: 5,
        ops: {
          fix: async (_p, req) => {
            await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
            return { dispositions: [], interrupted: true };
          },
        },
      });
      await runFinishMachine(h.state, h.deps);
      expect(count(h.trail, "commit")).toBe(0);
      expect(h.trail).toContain("restore");
      expect(h.state.stops[0]).toMatchObject({ kind: "fix", phase: "review" });
      expect(count(h.trail, "review:quality")).toBeGreaterThan(1);
      expect(h.state.phases.review.fixAttempts).toBeGreaterThan(0);
    });
  });

  test("a stopped gate fix counts as an attempt, so the loop ends at the attempt cap", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        qualityExit: () => 1,
        fixMs: 5,
        ops: {
          fix: async (phase, req) => {
            h.trail.push(`fix:${phase}`);
            await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
            return { dispositions: [], interrupted: true };
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(count(h.trail, "fix:gate")).toBe(MAX_FIX_ATTEMPTS);
      expect(h.state.phases.gate.fixAttempts).toBe(MAX_FIX_ATTEMPTS);
      expect(count(h.trail, "commit")).toBe(0);
      expect(result.outcome).toBe("draft");
    });
  });

  test("a phase deadline alone (no run abort) during a fix is a flow stop, not fix or run", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("x")] },
        ops: {
          fix: async () => {
            phase.abort();
            throw new Error("deadline");
          },
        },
      });
      await runFinishMachine(h.state, h.deps);
      expect(h.state.stops[0]).toMatchObject({ kind: "flow", phase: "review", limitMs: 10_800_000 });
    });
  });
});
