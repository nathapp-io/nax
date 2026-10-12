/**
 * The recovery path and the fail-closed ledger at machine level (finish A section 6 / 5): which round a flow
 * stop names, where coverage comes from, and what a fix with no usable disposition leaves in the draft reason.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMachineHarness, restoreFinishMachineStubs, withTempDir, withWarnSpy } from "@test/helpers";
import { _finishGitDeps, type Finding, type FinishReviewOutput, runFinishMachine } from "@/finish";

afterEach(() => restoreFinishMachineStubs());

const q = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts" } satisfies Finding],
  covered: ["a.ts"],
});
const CLEAN: FinishReviewOutput = { findings: [], covered: ["a.ts"] };
const isChangedFilesCall = (args: string[]) =>
  args[0] === "diff" && args.includes("--name-only") && args.some((a) => a.includes("..."));

/** Wraps the harness git stub; `answer` returns the changed-files result for call n (1-based) or undefined for the stub. */
function stubChangedFiles(answer: (n: number) => { exitCode: number; stdout: string } | undefined): {
  calls: () => number;
} {
  const inner = _finishGitDeps.git;
  let n = 0;
  _finishGitDeps.git = async (args, cwd, ...rest) => {
    const a = args[0] === "--literal-pathspecs" ? args.slice(1) : args;
    if (isChangedFilesCall(a)) {
      n += 1;
      const out = answer(n);
      if (out) return { ...out, stderr: "" };
    }
    return inner(args, cwd, ...rest);
  };
  return { calls: () => n };
}

describe("flow stop round (the interrupted round, else the last completed one)", () => {
  test("a deadline during round 1's lenses reads 'review round 1'", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        ops: {
          reviewSpec: async () => {
            phase.abort();
            throw new Error("deadline");
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(h.state.stops.map((s) => [s.kind, s.step, s.round])).toEqual([["flow", "review", 1]]);
      expect(result.reason).toBe(
        "finish time limit (3 h) reached during review round 1; gates not run; spec review missing; quality review missing",
      );
    });
  });

  test("a deadline during round 2's lenses reads 'review round 2'", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      let specCalls = 0;
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A")] },
        ops: {
          reviewSpec: async () => {
            specCalls += 1;
            if (specCalls === 2) {
              phase.abort();
              throw new Error("deadline");
            }
            return CLEAN;
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(h.state.stops.map((s) => [s.kind, s.step, s.round])).toEqual([["flow", "review", 2]]);
      expect(result.reason?.startsWith("finish time limit (3 h) reached during review round 2;")).toBe(true);
    });
  });

  test("a flow stop inside a fix session carries the round it interrupted", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        runSignal: new AbortController().signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A")] },
        ops: {
          fix: async () => {
            phase.abort();
            throw new Error("deadline");
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(h.state.stops.map((s) => [s.kind, s.phase, s.round])).toEqual([["flow", "review", 1]]);
      expect(result.reason).toBe("finish time limit (3 h) reached during review round 1; 1 open; gates not run");
    });
  });

  test("a deadline after the review step starts but before round 1 begins reads 'during review', not round 0", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
      });
      // the review inputs load (changed files), then the deadline hits before the loop's first round
      stubChangedFiles(() => {
        phase.abort();
        return undefined;
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(h.state.stops.map((x) => [x.kind, x.step, x.round])).toEqual([["flow", "review", 0]]);
      expect(result.reason).toBe(
        "finish time limit (3 h) reached during review; gates not run; spec review missing; quality review missing",
      );
    });
  });
});

describe("coverage on the recovery path (#2461)", () => {
  test("a stop before the review inputs load reads the changed files itself: coverage 0, not null", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      phase.abort();
      const h = makeMachineHarness({ auditDir: dir, signal: phase.signal, flowMs: 10_800_000 });
      h.git.changedFiles = ["src/a.ts"];
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.facts?.coverage).toEqual({ spec: 0, quality: 0 });
    });
  });

  test("git failing on that path gives null coverage and a warn log", async () => {
    await withWarnSpy(async (warn) => {
      await withTempDir(async (dir) => {
        const phase = new AbortController();
        phase.abort();
        const h = makeMachineHarness({ auditDir: dir, signal: phase.signal, flowMs: 10_800_000 });
        stubChangedFiles(() => ({ exitCode: 128, stdout: "" }));
        const result = await runFinishMachine(h.state, h.deps);
        expect(result.facts?.coverage).toEqual({ spec: null, quality: null });
        const call = warn.mock.calls.find((c) => c[1] === "No changed files for coverage on the recovery path");
        expect(call?.[0]).toBe("finish");
        expect(call?.[2]).toEqual({ storyId: "_run" });
      });
    });
  });

  test("after the inputs loaded, their changed list is used, not a second git call", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [CLEAN], spec: [CLEAN] },
        qualityExit: () => {
          phase.abort();
          return 1;
        },
      });
      // the first call (loading the inputs) sees a.ts; any later call would see nothing
      const git = stubChangedFiles((n) => (n === 1 ? { exitCode: 0, stdout: "a.ts\n" } : { exitCode: 0, stdout: "" }));
      const result = await runFinishMachine(h.state, h.deps);
      expect(git.calls()).toBe(1);
      expect(result.facts?.coverage).toEqual({ spec: 1, quality: 1 });
    });
  });
});

describe("fail-closed ledger at machine level (current spec-mandated behaviour)", () => {
  test("a committed fix with no dispositions, then a clean full round, still ends as a draft with '1 open'", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
        ops: { fix: async () => ({}) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toBe("1 open");
    });
  });

  test("a finding the fixer rejected, not re-raised by the next clean full round, stays in the draft reason", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
        ops: { fix: async () => ({ dispositions: [{ index: 1, disposition: "rejected", evidence: "a.ts:1" }] }) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toBe("1 open");
    });
  });
});
