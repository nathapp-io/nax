import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, withTempDir } from "@test/helpers";
import type { AdviceAuditRecord, AdviceDecision } from "@/advisor";
import { appendLabel, buildMenu, writeAdviceAudit } from "@/advisor";
import { type AdvisorReplayDeps, runAdvisorReplay } from "@/cli/advisor-replay";
import type { AdviseOpOutput } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

const options = buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }); // A fix, B waive, C hold

function rec(id: string, originalType: "fix" | "waive" | null, patch = ""): AdviceAuditRecord {
  const decision = originalType
    ? ({
        id,
        action: originalType === "fix" ? { type: "fix", instruction: "x" } : { type: "waive", reason: "y" },
      } as AdviceDecision)
    : null;
  return {
    schemaVersion: 1,
    naxVersion: "v",
    naxCommit: "c",
    runId: "r",
    question: {
      id: `Q-${id}`,
      kind: "finish-judgment",
      feature: "feat",
      askedAtSha: "sha",
      summary: "s",
      evidence: [],
      options,
    },
    context: { specPath: "spec.md", specSha256: null, prdSha256: null, priorDecisions: [] },
    worktree: { sha: "abc", patch, patchTruncated: false },
    memoryMode: "stateless",
    model: "m",
    prompt: "",
    rawReply: "",
    result: decision ? { decision } : { decision: null, fallbackReason: "imported" },
    costUsd: 0,
    headsUp: { sent: false },
  };
}

const replyFor = (optionId: string): AdviseOpOutput => ({
  ok: true,
  reply: {
    optionId,
    instruction: "i",
    reason: "r",
    rationale: "r",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
  },
});

function harness(outDir: string, replies: (AdviseOpOutput | Error)[]) {
  const git: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const order: string[] = [];
  const writes: [string, string][] = [];
  let i = 0;
  const deps: AdvisorReplayDeps = {
    resolveOutputDir: async () => outDir,
    buildCallContext: async () => {
      const ctx = makeMockCallContext();
      runtimes.push(ctx.runtime);
      return { ctx, close: async () => {} };
    },
    callOp: (async () => {
      order.push("callOp");
      const r = replies[i++];
      if (r instanceof Error) throw r;
      return r;
    }) as AdvisorReplayDeps["callOp"],
    git: async (args) => {
      git.push(args);
      order.push(`git:${args[0]}:${args[1] ?? ""}`);
      return { stdout: "", exitCode: 0 };
    },
    makeTempDir: async () => "/tmp/replay-x",
    removeDir: async () => {},
    readPrdText: async () => "{}",
    writeFile: async (path, text) => {
      writes.push([path, text]);
    },
    log: (t) => out.push(t),
    logErr: (t) => {
      err.push(t);
      order.push("notice");
    },
    now: () => "2026-10-10T00-00-00",
  };
  return { deps, git, out, err, order, writes };
}

describe("nax advisor replay", () => {
  test("prints the billing notice first, adds then removes the worktree, applies the patch", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix", "diff --git a/x b/x\n"));
      const h = harness(outDir, [replyFor("A")]);
      const code = await runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps);
      expect(code).toBe(0);
      expect(h.order[0]).toBe("notice");
      expect(h.git.map((a) => a.slice(0, 2).join(" "))).toEqual([
        "worktree add",
        "apply --whitespace=nowarn",
        "worktree remove",
      ]);
      expect(h.out.join("\n")).toContain("D-1  fix → fix  (same)");
      expect(h.writes[0]).toEqual(["/tmp/replay-x/.advisor-replay.patch", "diff --git a/x b/x\n"]);
      expect(h.writes[1]?.[0]).toBe(join(outDir, "advisor-audit", "feat", "D-1.replay-2026-10-10T00-00-00.json"));
    });
  });

  test("the worktree is removed even when the model call throws", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
      const h = harness(outDir, [new Error("boom")]);
      await runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps);
      expect(h.git.at(-1)?.slice(0, 2)).toEqual(["worktree", "remove"]);
    });
  });

  test("--eval scores agreement and exits 0 with no unsafe replay", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
      await writeAdviceAudit(outDir, "feat", rec("D-2", "waive"));
      await appendLabel(outDir, "feat", { id: "D-1", verdict: "agree", labelledAt: "t" });
      await appendLabel(outDir, "feat", {
        id: "D-2",
        verdict: "disagree",
        expected: "fix",
        unsafeTypes: ["waive"],
        labelledAt: "t",
      });
      const h = harness(outDir, [replyFor("A"), replyFor("A")]);
      const code = await runAdvisorReplay({ dir, feature: "feat", eval: true, json: false }, h.deps);
      expect(h.out.join("\n")).toContain("agreement: 2/2  unsafe: 0");
      expect(code).toBe(0);
    });
  });

  test("--eval exits 1 when a case replays to one of its unsafe types", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-2", "waive"));
      await appendLabel(outDir, "feat", {
        id: "D-2",
        verdict: "disagree",
        expected: "fix",
        unsafeTypes: ["waive"],
        labelledAt: "t",
      });
      const h = harness(outDir, [replyFor("B")]);
      const code = await runAdvisorReplay({ dir, feature: "feat", eval: true, json: false }, h.deps);
      expect(h.out.join("\n")).toContain("agreement: 0/1  unsafe: 1");
      expect(code).toBe(1);
    });
  });

  test("a fallback replay counts as disagreement, not unsafe", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
      await appendLabel(outDir, "feat", { id: "D-1", verdict: "agree", labelledAt: "t" });
      const h = harness(outDir, [{ ok: false, error: "no-json", preview: "" }]);
      const code = await runAdvisorReplay({ dir, feature: "feat", eval: true, json: false }, h.deps);
      expect(h.out.join("\n")).toContain("agreement: 0/1  unsafe: 0");
      expect(code).toBe(0);
    });
  });

  test("an imported question (no original decision) replays against its question id", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("X", null));
      await appendLabel(outDir, "feat", { id: "Q-X", verdict: "disagree", expected: "fix", labelledAt: "t" });
      const h = harness(outDir, [replyFor("A")]);
      await runAdvisorReplay({ dir, feature: "feat", eval: true, json: false }, h.deps);
      expect(h.out.join("\n")).toContain("Q-X  (none) → fix");
      expect(h.out.join("\n")).toContain("agreement: 1/1");
    });
  });
});

describe("nax advisor replay — argument validation", () => {
  test("an unknown memory mode or malformed id exits 2 before any replay", async () => {
    const { Command } = await import("commander");
    const { registerAdvisorCommand } = await import("@/cli/advisor");
    await withTempDir(async (dir) => {
      const codes: number[] = [];
      const cli = {
        resolveOutputDir: async () => dir,
        log: () => {},
        logErr: () => {},
        exit: (c: number) => codes.push(c),
        now: () => "t",
      };
      const h = harness(join(dir, "out"), []);
      for (const argv of [
        ["replay", "-f", "feat", "-d", dir, "--memory", "forever"],
        ["replay", "../x", "-f", "feat", "-d", dir],
      ]) {
        const program = new Command();
        registerAdvisorCommand(program, cli, h.deps);
        await program.parseAsync(["node", "nax", "advisor", ...argv]);
      }
      expect(codes).toEqual([2, 2]);
      expect(h.order).toEqual([]);
    });
  });
});
