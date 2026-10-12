import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, installFinishGit, makeFinishOps, makeFinishState, makeTempDir } from "@test/helpers";
import type { FinishOps, FixRequest } from "@/finish";
import { _finishGitDeps } from "@/finish";
import { runFixStep } from "@/finish/fix-step";

const restores: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
  for (const d of dirs.splice(0)) cleanupTempDir(d);
});

function deps(
  over: Partial<{ ops: FinishOps; signal: AbortSignal; runSignal: AbortSignal; fixMs: number; flowMs: number }> = {},
) {
  const auditDir = makeTempDir("fixstep-");
  dirs.push(auditDir);
  return {
    ops: over.ops ?? makeFinishOps([]),
    audit: { auditDir, runId: "run-1" },
    now: () => "2026-10-12T00:00:00.000Z",
    ...over,
  };
}

/** A fixer that edits, waits for its interrupt, then returns the op's interrupted outcome (as finishFixOp does). */
function interruptedFix(model: { dirty: boolean }): FinishOps["fix"] {
  return async (_phase, req) => {
    model.dirty = true;
    await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
    return {
      dispositions: [],
      interrupted: true,
      handoffNote: { findings: [{ index: 1, status: "partial", files: ["a.ts"], remaining: "tests" }] },
    };
  };
}

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };

describe("runFixStep (finish A)", () => {
  test("a fix that finishes is done, sent with an interrupt", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          seen = req;
          model.dirty = true;
          return { dispositions: [] };
        },
      },
    );
    const state = makeFinishState();
    expect((await runFixStep(state, deps({ ops, fixMs: 60_000 }), "review", { findings: [finding] })).kind).toBe(
      "done",
    );
    expect(seen?.interrupt).toBeDefined();
    expect(state.stops).toEqual([]);
  });

  test("fixMs: interrupted, set aside with its note, a fix stop recorded, never committed", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const state = makeFinishState();
    const out = await runFixStep(
      state,
      deps({ ops: makeFinishOps([], {}, { fix: interruptedFix(model) }), fixMs: 5 }),
      "review",
      { findings: [finding] },
    );
    expect(out.kind).toBe("stopped");
    expect(trail).toContain("restore");
    expect(trail).not.toContain("commit");
    expect(model.dirty).toBe(false);
    expect(state.stops).toEqual([
      { kind: "fix", phase: "review", at: "2026-10-12T00:00:00.000Z", limitMs: 5, handoff: 1, findings: 1 },
    ]);
    expect(state.handoffs[0]).toMatchObject({ limit: "fix", hasNote: true });
    expect(state.pendingHandoff).toBe(1);
  });

  test("flow stop: interrupted, set aside, then FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const phase = new AbortController();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (p, req) => {
          queueMicrotask(() => phase.abort());
          return interruptedFix(model)(p, req);
        },
      },
    );
    const state = makeFinishState();
    await expect(
      runFixStep(state, deps({ ops, signal: phase.signal, fixMs: 60_000, flowMs: 10_800_000 }), "gate", {
        failing: ["test"],
      }),
    ).rejects.toThrow("Finish aborted");
    expect(state.stops[0]).toMatchObject({ kind: "flow", phase: "gate", limitMs: 10_800_000, handoff: 1 });
    expect(state.handoffs[0]?.limit).toBe("flow");
  });

  test("run cancel: set aside as 'run', recorded as a run stop, then FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const run = new AbortController();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          model.dirty = true;
          run.abort();
          throw new Error("callOp[finish-fix]: aborted");
        },
      },
    );
    const state = makeFinishState();
    await expect(
      runFixStep(state, deps({ ops, signal: run.signal, runSignal: run.signal }), "review", { findings: [] }),
    ).rejects.toThrow("Finish aborted");
    expect(state.stops[0]?.kind).toBe("run");
    expect(state.handoffs[0]?.limit).toBe("run");
    expect(model.dirty).toBe(false);
  });

  test("commit guard: a fix that returns normally after the limit is set aside", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          model.dirty = true;
          await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
          return { dispositions: [] };
        },
      },
    );
    const state = makeFinishState();
    expect((await runFixStep(state, deps({ ops, fixMs: 5 }), "acceptance", { acceptanceOutput: "x" })).kind).toBe(
      "stopped",
    );
    expect(model.dirty).toBe(false);
  });

  test("a crashing fixer is set aside as 'error', not offered to the next attempt, and reported failed", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          model.dirty = true;
          throw new Error("model exploded");
        },
      },
    );
    const state = makeFinishState();
    const out = await runFixStep(state, deps({ ops, fixMs: 60_000 }), "review", { findings: [] });
    expect(out.kind).toBe("failed");
    expect(model.dirty).toBe(false);
    expect(state.handoffs[0]?.limit).toBe("error");
    expect(state.pendingHandoff).toBeUndefined();
    expect(state.stops).toEqual([]);
  });

  test("an unreadable base fails the step without running the fixer", async () => {
    restores.push(installFinishGit({ dirty: false, head: 1 }));
    const inner = _finishGitDeps.git;
    _finishGitDeps.git = async (args, cwd, ms) =>
      args.includes("rev-parse") && !args.includes("--show-toplevel")
        ? { exitCode: 128, stdout: "", stderr: "x" }
        : inner(args, cwd, ms);
    restores.push(() => {
      _finishGitDeps.git = inner;
    });
    let ran = false;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          ran = true;
          return {};
        },
      },
    );
    expect((await runFixStep(makeFinishState(), deps({ ops }), "review", { findings: [] })).kind).toBe("failed");
    expect(ran).toBe(false);
  });

  test("a base capture that throws fails the step instead of crashing the phase", async () => {
    restores.push(installFinishGit({ dirty: false, head: 1 }));
    const inner = _finishGitDeps.git;
    _finishGitDeps.git = async (args, cwd, ms) => {
      if (args.includes("stash")) throw new Error("git exploded");
      return inner(args, cwd, ms);
    };
    restores.push(() => {
      _finishGitDeps.git = inner;
    });
    let ran = false;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          ran = true;
          return {};
        },
      },
    );
    expect((await runFixStep(makeFinishState(), deps({ ops }), "review", { findings: [] })).kind).toBe("failed");
    expect(ran).toBe(false);
  });
});
