import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTempDir,
  installFinishGit,
  makeFinishOps,
  makeFinishState,
  makeHandoffRecord,
  makeTempDir,
} from "@test/helpers";
import type { FinishOps, FixRequest } from "@/finish";
import { _finishGitDeps } from "@/finish";
import { consumeIfCommitted, runFixStep } from "@/finish/fix-step";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

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
    expect(state.handoffs[0]?.hasNote).toBe(false);
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

const handoff = makeHandoffRecord;

describe("runFixStep continuation (finish A 4.3)", () => {
  test("re-applies the pending handoff of the same phase and passes a continuation", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          seen = req;
          return { dispositions: [] };
        },
      },
    );
    const d = deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    const out = await runFixStep(state, d, "review", { findings: [] });
    expect(trail).toContain("apply");
    expect(seen?.continuation).toEqual({ files: ["a.ts"] });
    expect(out.kind === "done" ? out.continued?.n : undefined).toBe(1);
    expect(state.pendingHandoff).toBeUndefined();
  });

  test("a patch that fails --check: fresh start, handoff kept, marked not re-applied", async () => {
    const trail: string[] = [];
    restores.push(installFinishGit({ dirty: false, head: 1, applyFails: true }, trail));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          seen = req;
          return {};
        },
      },
    );
    const d = deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    const warns: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => warns.push(entry));
    try {
      await runFixStep(state, d, "review", { findings: [] });
    } finally {
      resetLogger();
    }
    expect(seen?.continuation).toBeUndefined();
    expect(state.handoffs[0]?.reapplied).toBe(false);
    expect(state.pendingHandoff).toBeUndefined();
    expect(trail).toContain("apply-check");
    expect(trail).not.toContain("apply");
    expect(warns.some((w) => w.message.includes("starts from scratch"))).toBe(true);
  });

  test("a pending handoff of another phase is left alone", async () => {
    const trail: string[] = [];
    restores.push(installFinishGit({ dirty: false, head: 1 }, trail));
    const d = deps({ fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir, { phase: "gate" })];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    expect(trail).not.toContain("apply");
    expect(state.pendingHandoff).toBe(1);
  });

  test("consumeIfCommitted marks the handoff consumed only after a commit", async () => {
    const d = deps();
    const state = makeFinishState();
    const rec = handoff(d.audit.auditDir);
    state.handoffs = [rec];
    await consumeIfCommitted(state, rec, false);
    expect(state.handoffs[0]?.consumed).toBe(false);
    await consumeIfCommitted(state, rec, true);
    expect(state.handoffs[0]?.consumed).toBe(true);
  });

  test("the base is captured before the re-apply: a second stop sets the re-applied edits aside too", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const d = deps({ ops: makeFinishOps([], {}, { fix: interruptedFix(model) }), fixMs: 5 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    const out = await runFixStep(state, d, "review", { findings: [] });
    expect(out.kind).toBe("stopped");
    // A base taken after the re-apply would be the stash of the re-applied edits ("stashsha"), not HEAD.
    expect(state.lastFixBase?.baseSha).toBe("sha1");
    expect(state.handoffs[1]).toMatchObject({ n: 2, baseSha: "sha1" });
    expect(trail.indexOf("restore")).toBeGreaterThan(trail.indexOf("apply"));
    expect(model.dirty).toBe(false);
    expect(state.pendingHandoff).toBe(2);
  });

  test("a handoff is offered once: the next attempt neither re-applies nor continues", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const seen: (FixRequest["continuation"] | undefined)[] = [];
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          seen.push(req.continuation);
          return {};
        },
      },
    );
    const d = deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    await runFixStep(state, d, "review", { findings: [] });
    expect(trail.filter((t) => t === "apply")).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeUndefined();
  });

  test("a crashed attempt's handoff is never offered to the next attempt", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    let calls = 0;
    let second: FixRequest | undefined;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          calls += 1;
          if (calls === 1) {
            model.dirty = true;
            throw new Error("model exploded");
          }
          second = req;
          return {};
        },
      },
    );
    const d = deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    await runFixStep(state, d, "review", { findings: [] });
    expect(state.handoffs[0]?.limit).toBe("error");
    expect(state.pendingHandoff).toBeUndefined();
    await runFixStep(state, d, "review", { findings: [] });
    expect(second?.continuation).toBeUndefined();
    expect(trail).not.toContain("apply");
  });

  test("a re-apply that throws degrades to a fresh start instead of rejecting the step", async () => {
    restores.push(installFinishGit({ dirty: false, head: 1 }));
    const inner = _finishGitDeps.git;
    _finishGitDeps.git = async (args, cwd, ms) => {
      if (args.includes("apply")) throw new Error("git exploded");
      return inner(args, cwd, ms);
    };
    restores.push(() => {
      _finishGitDeps.git = inner;
    });
    let seen: FixRequest | undefined;
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_p, req) => {
          seen = req;
          return {};
        },
      },
    );
    const d = deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    expect((await runFixStep(state, d, "review", { findings: [] })).kind).toBe("done");
    expect(seen?.continuation).toBeUndefined();
    expect(state.handoffs[0]?.reapplied).toBe(false);
  });

  test("not re-applied is persisted to the handoff's meta.json", async () => {
    restores.push(installFinishGit({ dirty: false, head: 1, applyFails: true }));
    const d = deps({ fixMs: 60_000 });
    const rec = handoff(d.audit.auditDir);
    await mkdir(rec.dir, { recursive: true });
    const state = makeFinishState();
    state.handoffs = [rec];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    const meta = JSON.parse(await readFile(join(rec.dir, "meta.json"), "utf8"));
    expect(meta.reapplied).toBe(false);
  });
});
