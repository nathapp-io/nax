/**
 * Invariants of `runFinishMachine` that hold whatever the stubs do: aborts and deadlines, a throw from any op
 * or runner, nothing-verified-is-not-a-pass, and the preconditions that stand the machine down.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFinishContext, makeMachineHarness, restoreFinishMachineStubs, withTempDir } from "@test/helpers";
import type { Finding, FinishReviewOutput } from "@/finish";
import { readLedger, runFinishMachine } from "@/finish";

afterEach(() => restoreFinishMachineStubs());

const q = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "MEDIUM", title, problem: "p", fix: "f", source: "quality", file: "a.ts" } satisfies Finding],
  covered: ["a.ts"],
});

describe("aborts and deadlines", () => {
  test("run abort mid-review: failed 'aborted', neither promotePr nor finalizeDraftPr is called", async () => {
    await withTempDir(async (dir) => {
      const run = new AbortController();
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        signal: run.signal,
        runSignal: run.signal,
        context: { acceptanceStatus: "disabled" },
        ops: {
          reviewSpec: async () => {
            run.abort();
            throw new Error("aborted");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("failed");
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("aborted");
      expect(trail).not.toContain("promotePr");
      expect(trail).not.toContain("finalizeDraftPr");
    });
  });

  test("flowMs deadline during a fix session: no further LLM calls, finalizeDraftPr with reason 'deadline'", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        runSignal: new AbortController().signal,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [q("A")] },
        ops: {
          fix: async () => {
            trail.push("fix:review");
            phase.abort();
            throw new Error("deadline");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason?.startsWith("deadline")).toBe(true);
      expect(trail.slice(trail.indexOf("fix:review") + 1)).toEqual(["finalizeDraftPr"]);
    });
  });

  test("a deadline that fires before any review leaves both lenses missing in the draft", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      phase.abort();
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        runSignal: new AbortController().signal,
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.facts?.reviewsMissing).toEqual(["spec", "quality"]);
      expect(trail).toEqual(["finalizeDraftPr"]);
    });
  });
});

describe("throws become a draft or a failure, never an escalation", () => {
  test("acceptance runner throws: acceptance red, the run continues to a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, acceptanceThrows: "spawn failed" });
      const result = await runFinishMachine(state, deps);
      expect(state.acceptanceFact).toBe("red");
      expect(trail).toContain("review:spec");
      expect(trail).not.toContain("fix:acceptance");
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("acceptance red");
    });
  });

  test("gate runner throws: a red gate carrying the error, then a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, qualityThrows: "runner exploded" });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.facts?.gates).toEqual([{ name: "gates", status: "red", excerpt: "runner exploded" }]);
      expect(trail).not.toContain("fix:gate");
    });
  });

  test("an op that throws outside a named recovery (openDraftPr) still ends in a draft with the error", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        ops: {
          openDraftPr: async () => {
            throw new Error("forge hiccup");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("finish error: forge hiccup");
    });
  });

  test("finalizeDraftPr throws: failed with that error", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A"), q("A"), q("A")] },
        fixIsNoop: true,
        ops: {
          finalizeDraftPr: async () => {
            throw new Error("gh: not authenticated");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("gh: not authenticated");
    });
  });

  test("promotePr create failure at finalize: failed with the CLI error as reason, ledger not written", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        ops: {
          promotePr: async () => {
            throw new Error('Failed to create PR/MR for "feat/x": gh: command not found');
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("failed");
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe('Failed to create PR/MR for "feat/x": gh: command not found');
      expect(trail).not.toContain("finalizeDraftPr");
      expect(await readLedger(deps.audit.auditDir)).toBeNull();
    });
  });
});

describe("a lost result file", () => {
  test("a writeResult failure after finalize does not finalize twice and keeps the finalized outcome", async () => {
    await withTempDir(async (dir) => {
      const blocker = join(dir, "blocker");
      await Bun.write(blocker, "not a directory");
      const { deps, trail, state } = makeMachineHarness({ auditDir: join(blocker, "audit") });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("promoted");
      expect(result.outcome).toBe("ready");
      expect(trail.filter((t) => t === "promotePr")).toHaveLength(1);
      expect(trail).not.toContain("finalizeDraftPr");
    });
  });
});

describe("nothing verified is not a pass", () => {
  test("empty acceptance groups: acceptance is unverified and the PR is a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir, context: { groups: [] } });
      const result = await runFinishMachine(state, deps);
      expect(state.acceptanceFact).toBe("unverified");
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("acceptance unverified");
    });
  });

  test("no gate commands anywhere: the quality.commands gate is red and the PR is a draft", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, qualityCommands: {} });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.facts?.gates).toEqual([
        { name: "quality.commands", status: "red", excerpt: "No quality.commands configured" },
      ]);
      expect(trail).not.toContain("fix:gate");
    });
  });
});

describe("every ops.fix is committed before the next review", () => {
  test("fix, then commit, then the next review round", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, script: { quality: [q("A")] } });
      await runFinishMachine(state, deps);
      const fix = trail.indexOf("fix:review");
      expect(fix).toBeGreaterThan(-1);
      expect(trail[fix + 1]).toBe("commit");
      expect(trail.slice(fix + 2, fix + 4)).toEqual(["review:spec", "review:quality"]);
    });
  });
});

describe("preconditions", () => {
  test("a context escalate route is failed with the reason, and no PR or forge call is made", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        context: { route: "escalate", reason: "the spec could not be resolved" },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("failed");
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("the spec could not be resolved");
      expect(trail).toEqual([]);
    });
  });

  test("nothing-to-finish: never calls a reviewer, never opens a PR", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir, context: { route: "nothing-to-finish" } });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("nothing-to-finish");
      expect(trail).toEqual([]);
    });
  });

  test("merged-PR route: nothing-to-finish carrying skipReason and the PR url", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        context: { route: "nothing-to-finish", skipReason: "pr-merged", prUrl: "https://x/pr/7" },
      });
      const result = await runFinishMachine(state, deps);
      expect(result).toMatchObject({ status: "nothing-to-finish", skipReason: "pr-merged", url: "https://x/pr/7" });
    });
  });

  test("already-finished: reports skipReason and never runs the machine", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        context: makeFinishContext({ route: "already-finished", prUrl: "https://x/pr/3" }),
      });
      const result = await runFinishMachine(state, deps);
      expect(result).toMatchObject({
        status: "nothing-to-finish",
        skipReason: "already-finished",
        url: "https://x/pr/3",
      });
      expect(trail).toEqual([]);
    });
  });
});
