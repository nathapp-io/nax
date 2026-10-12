/**
 * The recovery path and the fail-closed ledger at machine level (finish A section 6 / 5): which round a flow
 * stop names, where coverage comes from, and what a fix with no usable disposition leaves in the draft reason.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMachineHarness, restoreFinishMachineStubs, withTempDir, withWarnSpy } from "@test/helpers";
import { _finishGitDeps, type Finding, type FinishReviewOutput, runFinishMachine } from "@/finish";
import { stopReason } from "@/finish/resolve";

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

describe("a run abort is recorded as a run stop, never a flow stop (spec 3.3)", () => {
  const abortedRun = () => {
    const run = new AbortController();
    return { run, base: { signal: run.signal, runSignal: run.signal } };
  };

  test("during a review lens: failed 'aborted', a run stop naming the step and round, in result.stops", async () => {
    await withTempDir(async (dir) => {
      const { run, base } = abortedRun();
      const h = makeMachineHarness({
        auditDir: dir,
        ...base,
        context: { acceptanceStatus: "disabled" },
        ops: {
          reviewSpec: async () => {
            run.abort();
            throw new Error("aborted");
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.status).toBe("failed");
      expect(result.reason).toBe("aborted");
      expect(result.stops).toEqual([{ kind: "run", step: "review", round: 1, at: expect.any(String), limitMs: 0 }]);
      expect(h.state.stops).toEqual(result.stops ?? []);
      expect(stopReason(result.stops ?? [])).toBe("run cancelled during review round 1");
    });
  });

  test("during a gate run: the step is 'gate'", async () => {
    await withTempDir(async (dir) => {
      const { run, base } = abortedRun();
      const h = makeMachineHarness({
        auditDir: dir,
        ...base,
        context: { acceptanceStatus: "disabled" },
        qualityExit: () => {
          run.abort();
          return 1;
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.status).toBe("failed");
      expect(result.stops?.map((x) => [x.kind, x.step])).toEqual([["run", "gate"]]);
      expect(stopReason(result.stops ?? [])).toMatch(/^run cancelled during gate/);
    });
  });

  test("during acceptance: the step is 'acceptance'", async () => {
    await withTempDir(async (dir) => {
      const { run, base } = abortedRun();
      const h = makeMachineHarness({
        auditDir: dir,
        ...base,
        acceptanceExit: () => {
          run.abort();
          return 1;
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.status).toBe("failed");
      expect(result.stops?.map((x) => [x.kind, x.step])).toEqual([["run", "acceptance"]]);
    });
  });

  test("a fix session aborted by the run already recorded its run stop: the recovery path adds no second one", async () => {
    await withTempDir(async (dir) => {
      const { run, base } = abortedRun();
      const h = makeMachineHarness({
        auditDir: dir,
        ...base,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A")] },
        ops: {
          fix: async () => {
            run.abort();
            throw new Error("aborted");
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.status).toBe("failed");
      expect(result.stops?.map((x) => [x.kind, x.phase])).toEqual([["run", "review"]]);
    });
  });

  test("a phase deadline alone records a flow stop and no run stop", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      phase.abort();
      const h = makeMachineHarness({ auditDir: dir, signal: phase.signal, runSignal: new AbortController().signal });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.stops).toBeUndefined();
      expect(h.state.stops.map((x) => x.kind)).toEqual(["flow"]);
    });
  });

  test("a failed result that stopped nothing has no stops field", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({ auditDir: dir, context: { route: "escalate", reason: "no spec" } });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.status).toBe("failed");
      expect(result.stops).toBeUndefined();
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

/** Makes the fix session's base unreadable (`git stash create` fails), so the step fails before the fixer runs. */
function breakBaseCapture(): void {
  const inner = _finishGitDeps.git;
  _finishGitDeps.git = async (args, cwd, ...rest) => {
    const a = args[0] === "--literal-pathspecs" ? args.slice(1) : args;
    if (a[0] === "stash") return { exitCode: 128, stdout: "", stderr: "fatal" };
    return inner(args, cwd, ...rest);
  };
}

describe("a later clean full round closes open and rejected findings (finish A, owner-approved)", () => {
  test("a committed fix with no dispositions leaves the finding open until the next clean full round clears it", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
        ops: { fix: async () => ({}) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("ready");
      expect(result.reason).toBeUndefined();
      expect(result.facts?.findingsOpen).toEqual([]);
      expect(h.state.review.ledger.map((e) => [e.state, e.ref])).toEqual([
        ["cleared", "not re-raised by full round 2"],
      ]);
    });
  });

  test("a fix that is never followed by a clean round keeps the finding open (Review Focus 5)", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: Array.from({ length: 10 }, () => q("A")) },
        ops: { fix: async () => ({}) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("1 open");
      expect(h.state.review.ledger.map((e) => e.state)).toEqual(["open"]);
    });
  });

  test("a finding the fixer rejected, not re-raised by the next clean full round, is cleared and the PR is ready", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
        ops: { fix: async () => ({ dispositions: [{ index: 1, disposition: "rejected", evidence: "a.ts:1" }] }) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("ready");
      expect(h.state.review.ledger.map((e) => e.state)).toEqual(["cleared"]);
    });
  });

  test("a rejected finding the next round raises again stays open and the PR is a draft", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: Array.from({ length: 10 }, () => q("A")) },
        ops: { fix: async () => ({ dispositions: [{ index: 1, disposition: "rejected", evidence: "a.ts:1" }] }) },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("1 open");
    });
  });

  test("a fix step that failed before running the fixer, then a clean full round, ends ready", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
      });
      breakBaseCapture();
      const result = await runFinishMachine(h.state, h.deps);
      expect(h.state.handoffs).toEqual([]);
      expect(result.outcome).toBe("ready");
    });
  });

  test("a stopped fix stays set aside: the clean round does not close it and the draft names the handoff", async () => {
    await withTempDir(async (dir) => {
      const h = makeMachineHarness({
        auditDir: dir,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A"), CLEAN] },
        fixMs: 5,
        ops: {
          fix: async (_p, req) => {
            await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
            return { dispositions: [], interrupted: true };
          },
        },
      });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("1 set aside (handoff-1)");
    });
  });
});
