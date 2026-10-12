/**
 * Finish A §4.4: where the checkpoint is written. Each test records the state at every
 * checkpoint write, so deleting a call site changes a count or a snapshot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  cleanupTempDir,
  installFinishGit,
  makeFinishOps,
  makeFinishState,
  makeMachineHarness,
  makeTempDir,
  restoreFinishMachineStubs,
  withTempDir,
} from "@test/helpers";
import type { FinishAdvisor, FinishOps, FinishReviewOutput, FinishState, ReviewInputs } from "@/finish";
import {
  _checkpointDeps,
  _finishGitDeps,
  deserializeFinishState,
  emptyJudged,
  runFinishMachine,
  runReviewLoop,
} from "@/finish";
import { runAcceptanceLoop } from "@/finish/acceptance-loop";
import { runFixStep } from "@/finish/fix-step";
import { runGatesLoop } from "@/finish/gates-loop";

const originalDeps = { ..._checkpointDeps };
const restores: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
  Object.assign(_checkpointDeps, originalDeps);
  for (const r of restores.splice(0).reverse()) r();
  for (const d of dirs.splice(0)) cleanupTempDir(d);
  restoreFinishMachineStubs();
});

/** Every checkpoint written from here on, parsed, in order. */
function recordCheckpoints(): FinishState[] {
  const written: FinishState[] = [];
  const realWrite = originalDeps.writeFile;
  _checkpointDeps.writeFile = async (path, text) => {
    written.push(deserializeFinishState(text));
    await realWrite(path, text);
  };
  return written;
}

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };

function fixDeps(ops: FinishOps, over: Partial<{ signal: AbortSignal; runSignal: AbortSignal; fixMs: number }> = {}) {
  const auditDir = makeTempDir("ckpt-fix-");
  dirs.push(auditDir);
  return { ops, audit: { auditDir, runId: "run-1" }, now: () => "2026-10-12T00:00:00.000Z", ...over };
}

function interrupted(model: { dirty: boolean }): FinishOps["fix"] {
  return async (_phase, req) => {
    model.dirty = true;
    await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
    return { dispositions: [], interrupted: true };
  };
}

describe("runFixStep writes a checkpoint at every return", () => {
  test("done", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const written = recordCheckpoints();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          model.dirty = true;
          return { dispositions: [] };
        },
      },
    );
    const out = await runFixStep(makeFinishState(), fixDeps(ops), "review", { findings: [finding] });
    expect(out.kind).toBe("done");
    expect(written).toHaveLength(1);
  });

  test("failed (the fixer crashed): the snapshot already holds the set-aside handoff", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const written = recordCheckpoints();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async () => {
          throw new Error("boom");
        },
      },
    );
    const out = await runFixStep(makeFinishState(), fixDeps(ops), "review", { findings: [finding] });
    expect(out.kind).toBe("failed");
    expect(written).toHaveLength(1);
    expect(written[0]?.handoffs).toHaveLength(1);
  });

  test("failed (the base cannot be read)", async () => {
    restores.push(installFinishGit({ dirty: false, head: 1 }));
    const inner = _finishGitDeps.git;
    _finishGitDeps.git = async (args, cwd, ms) =>
      args.includes("rev-parse") && !args.includes("--show-toplevel")
        ? { exitCode: 128, stdout: "", stderr: "x" }
        : inner(args, cwd, ms);
    restores.push(() => {
      _finishGitDeps.git = inner;
    });
    const written = recordCheckpoints();
    const out = await runFixStep(makeFinishState(), fixDeps(makeFinishOps([])), "gate", { failing: ["lint"] });
    expect(out.kind).toBe("failed");
    expect(written).toHaveLength(1);
  });

  test("stopped (fixMs): the snapshot holds the handoff and the stop", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const written = recordCheckpoints();
    const ops = makeFinishOps([], {}, { fix: interrupted(model) });
    const out = await runFixStep(makeFinishState(), fixDeps(ops, { fixMs: 5 }), "review", { findings: [finding] });
    expect(out.kind).toBe("stopped");
    expect(written).toHaveLength(1);
    expect(written[0]?.handoffs).toHaveLength(1);
    expect(written[0]?.stops).toHaveLength(1);
  });

  test("stopped (a fixer that throws after its limit fired)", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const written = recordCheckpoints();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (_phase, req) => {
          model.dirty = true;
          await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
          throw new Error("killed by the limit");
        },
      },
    );
    const out = await runFixStep(makeFinishState(), fixDeps(ops, { fixMs: 5 }), "review", { findings: [finding] });
    expect(out.kind).toBe("stopped");
    expect(written).toHaveLength(1);
    expect(written[0]?.handoffs).toHaveLength(1);
  });

  test("a flow stop checkpoints the set-aside, and a failing checkpoint write cannot mask FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const written = recordCheckpoints();
    _checkpointDeps.rename = async () => {
      throw new Error("rename denied");
    };
    const phase = new AbortController();
    const ops = makeFinishOps(
      [],
      {},
      {
        fix: async (p, req) => {
          queueMicrotask(() => phase.abort());
          return interrupted(model)(p, req);
        },
      },
    );
    const state = makeFinishState();
    await expect(
      runFixStep(state, fixDeps(ops, { signal: phase.signal, fixMs: 60_000 }), "gate", { failing: ["t"] }),
    ).rejects.toThrow("Finish aborted");
    expect(written).toHaveLength(1);
    expect(written[0]?.handoffs).toHaveLength(1);
    expect(state.handoffs).toHaveLength(1);
  });
});

const inputs: ReviewInputs = { changed: ["a.ts"], hints: [], stories: [], prdPath: ".nax/features/feat/prd.json" };
const q = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts" }],
  covered: ["a.ts"],
});

describe("loops write a checkpoint after each step", () => {
  test("review loop: one per round, taken after the round's ledger events are applied", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      restores.push(installFinishGit(git));
      const written = recordCheckpoints();
      const ops = makeFinishOps(
        [],
        { quality: [q("A")] },
        {
          fix: async () => {
            git.dirty = true;
            return { dispositions: [{ index: 1, disposition: "fixed" }] };
          },
        },
      );
      const audit = { auditDir: dir, runId: "run-1" };
      const rdeps = {
        ops,
        inputs,
        audit,
        now: () => "t",
        assertNotAborted: () => {},
        fix: { ops, audit, now: () => "t" },
      };
      await runReviewLoop(makeFinishState(), rdeps);
      // round 1, the fix inside runFixStep, round 2
      expect(written).toHaveLength(3);
      const first = assertDefinedValue(written[0]);
      expect(first.review.rounds).toBe(1);
      expect(first.review.pendingRound).toBe(0);
      expect(first.review.ledger.length).toBeGreaterThan(0);
      expect(assertDefinedValue(written[2]).review.rounds).toBe(2);
    });
  });

  test("acceptance loop: one after the gate run is recorded", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir });
      const written = recordCheckpoints();
      await runAcceptanceLoop(state, deps);
      expect(written).toHaveLength(1);
      expect(assertDefinedValue(written[0]).acceptanceFact).toBe("green");
    });
  });

  test("acceptance loop: a fix is checkpointed by its step, then the re-run is recorded", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir, acceptanceExit: (n) => (n === 1 ? 1 : 0) });
      const written = recordCheckpoints();
      await runAcceptanceLoop(state, deps);
      expect(written).toHaveLength(2);
      expect(assertDefinedValue(written[1]).acceptanceFact).toBe("green");
    });
  });

  test("acceptance loop: disabled acceptance runs nothing and writes nothing", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir, context: { acceptanceStatus: "disabled" } });
      const written = recordCheckpoints();
      await runAcceptanceLoop(state, deps);
      expect(written).toHaveLength(0);
    });
  });

  test("gates loop: one after the gate run is recorded, a crashed runner included", async () => {
    await withTempDir(async (dir) => {
      for (const qualityThrows of [undefined, "runner exploded"]) {
        const { deps, state } = makeMachineHarness({
          auditDir: dir,
          ...(qualityThrows ? { qualityThrows } : {}),
        });
        const written = recordCheckpoints();
        const rdeps = {
          ops: deps.ops,
          inputs,
          audit: deps.audit,
          now: deps.now,
          assertNotAborted: () => {},
          fix: { ops: deps.ops, audit: deps.audit, now: deps.now },
        };
        await runGatesLoop(state, deps, rdeps);
        expect(written).toHaveLength(1);
        expect(assertDefinedValue(written[0]).gateFacts).toBeDefined();
        restoreFinishMachineStubs();
      }
    });
  });
});

describe("the machine writes a checkpoint at every boundary", () => {
  test("clean run: after each loop, and once the status is set", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir });
      const written = recordCheckpoints();
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("promoted");
      // acceptance (loop + machine), review (loop + machine), gates (loop + machine), finalize
      expect(written).toHaveLength(7);
      expect(written.map((w) => w.step)).toEqual([
        "acceptance",
        "acceptance",
        "review",
        "review",
        "gate",
        "gate",
        "resolve",
      ]);
      expect(assertDefinedValue(written[6]).status).toBe("promoted");
      expect(assertDefinedValue(written[5]).status).not.toBe("promoted");
    });
  });

  test("a committed review fix: the acceptance re-check is checkpointed by the loop and by the machine", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, script: { quality: [q("A")] } });
      const written = recordCheckpoints();
      await runFinishMachine(state, deps);
      expect(trail.filter((t) => t === "acceptance-run")).toHaveLength(3);
      // acceptance 2, review (round, fix, round) 3 + machine 1, re-check 2, gates 2, finalize 1
      expect(written).toHaveLength(11);
      expect(written.slice(6, 8).map((w) => w.step)).toEqual(["acceptance", "acceptance"]);
    });
  });

  test("a throw: the recovery path checkpoints before finalizing, and finalize checkpoints the new status", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        ops: {
          openDraftPr: async () => {
            throw new Error("forge down");
          },
        },
      });
      const written = recordCheckpoints();
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      // acceptance loop, machine after acceptance, recovery, finalize
      expect(written).toHaveLength(4);
      const recovery = assertDefinedValue(written[2]);
      expect(recovery.status).not.toBe("draft");
      expect(recovery.resolution).toBeUndefined();
      const final = assertDefinedValue(written[3]);
      expect(final.status).toBe("draft");
      expect(final.resolution?.outcome).toBe("draft");
    });
  });

  test("the advisor's re-review is checkpointed after its review, its acceptance re-check and its gates", async () => {
    await withTempDir(async (dir) => {
      const asks = [
        { action: "re-review" as const, rationale: "again" },
        { action: "approve" as const, rationale: "ok" },
      ];
      const advisor: FinishAdvisor = {
        rulingsInForce: async () => [],
        reconcile: async () => ({ result: emptyJudged(), asked: 0 }),
        judgedEnabled: false,
        approvalEnabled: true,
        judged: async (findings) => ({ toFix: [], advice: [], unresolved: findings, dropped: [], held: [] }),
        approval: async () => asks.shift() ?? { action: "unavailable", rationale: "exhausted" },
        commitLedger: async () => {},
      };
      const stuck = { quality: [q("A"), q("A"), q("A"), q("A")] };
      const { deps, state } = makeMachineHarness({ auditDir: dir, script: stuck, advise: advisor });
      const written = recordCheckpoints();
      await runFinishMachine(state, deps);
      // main flow 13 (3 rounds with their fixes, then acceptance, gates), then the re-review: its round and fix,
      // the machine's own after the review, acceptance (loop + machine), gates (loop + machine), finalize
      expect(written).toHaveLength(21);
      expect(written.slice(15, 20).map((w) => w.phases.review.fixAttempts)).toEqual([4, 4, 4, 4, 4]);
      expect(written.at(-1)?.status).toBe("draft");
    });
  });

  test("a checkpoint that cannot be written never changes the result", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir });
      _checkpointDeps.rename = async () => {
        throw new Error("rename denied");
      };
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("promoted");
    });
  });
});

function assertDefinedValue<T>(value: T | undefined): T {
  assertDefined(value, "recorded checkpoint");
  return value;
}
