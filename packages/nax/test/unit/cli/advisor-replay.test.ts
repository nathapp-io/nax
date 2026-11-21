import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeAdviceDecision, makeCallOp, makeMockCallContext, makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdviceAuditRecord } from "@/advisor";
import { appendLabel, buildMenu, writeAdviceAudit } from "@/advisor";
import { type AdvisorReplayDeps, runAdvisorReplay } from "@/cli/advisor-replay";
import type { AdviseOpOutput } from "@/operations";
import { type NaxRuntime, storyExecRoot } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

const options = buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }); // A fix, B waive, C hold

function rec(id: string, originalType: "fix" | "waive" | null, patch = ""): AdviceAuditRecord {
  const decision = originalType
    ? makeAdviceDecision({
        id,
        action: originalType === "fix" ? { type: "fix", instruction: "x" } : { type: "waive", reason: "y" },
      })
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

function harness(
  outDir: string,
  replies: (AdviseOpOutput | Error)[],
  failGit?: string,
  config?: ReturnType<typeof makeNaxConfig>,
) {
  const git: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const order: string[] = [];
  const writes: [string, string][] = [];
  const contexts: [string, string][] = [];
  const dispatched: { featureName?: string; packageDir: string; viewPackageDir: string; execRoot: string }[] = [];
  const specPaths: unknown[] = [];
  const models: unknown[] = [];
  let closes = 0;
  let i = 0;
  let tmp = 0;
  const deps: AdvisorReplayDeps = {
    resolveOutputDir: async () => outDir,
    buildCallContext: async (d, feature) => {
      contexts.push([d, feature]);
      const ctx = makeMockCallContext(config ? { config } : {});
      runtimes.push(ctx.runtime);
      return {
        ctx,
        close: async () => {
          closes++;
        },
      };
    },
    callOp: makeCallOp({
      onDispatch: (_op, ctx, input) => {
        order.push("callOp");
        models.push(typeof input === "object" && input !== null && "model" in input ? input.model : undefined);
        specPaths.push(typeof input === "object" && input !== null && "specPath" in input ? input.specPath : null);
        dispatched.push({
          featureName: ctx.featureName,
          packageDir: ctx.packageDir,
          viewPackageDir: ctx.packageView.packageDir,
          execRoot: storyExecRoot(ctx.packageView),
        });
      },
      next: () => replies[i++],
    }),
    git: async (args) => {
      git.push(args);
      order.push(`git:${args[0]}:${args[1] ?? ""}`);
      return { stdout: "", exitCode: failGit && args.join(" ").startsWith(failGit) ? 1 : 0 };
    },
    makeTempDir: async () => (++tmp === 1 ? "/tmp/replay-x" : `/tmp/replay-patch-${tmp}`),
    trustGate: async (d) => {
      order.push(`trust:${d}`);
    },
    removeDir: async () => {},
    readPrdText: async () => "{}",
    resolveSpecPath: async (wt, feature) => `${wt}/.nax/features/${feature}/spec.md`,
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
  return {
    deps,
    git,
    out,
    err,
    order,
    writes,
    dispatched,
    contexts,
    specPaths,
    models,
    closes: () => closes,
  };
}

describe("nax advisor replay", () => {
  test("prints the billing notice first, adds then removes the worktree, applies the patch", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix", "diff --git a/x b/x\n"));
      const h = harness(outDir, [replyFor("A")]);
      const code = await runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps);
      expect(code).toBe(0);
      expect(h.order[0]).toBe(`trust:${dir}`);
      expect(h.order[1]).toBe("notice");
      expect(h.git.map((a) => a.slice(0, 2).join(" "))).toEqual([
        "worktree add",
        "apply --whitespace=nowarn",
        "worktree remove",
      ]);
      expect(h.out.join("\n")).toContain("D-1  fix → fix  (same)");
      // The patch never lands inside the worktree (a committed symlink there could redirect the write).
      expect(h.writes[0]).toEqual(["/tmp/replay-patch-2/advisor-replay.patch", "diff --git a/x b/x\n"]);
      expect(h.git[1]).toEqual(["apply", "--whitespace=nowarn", "/tmp/replay-patch-2/advisor-replay.patch"]);
      expect(h.writes[1]?.[0]).toBe(join(outDir, "advisor-audit", "feat", "D-1.replay-2026-10-10T00-00-00.json"));
    });
  });

  test("the advisor session runs in the replay worktree, with the feature for its transcript dir", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
      const h = harness(outDir, [replyFor("A")]);
      await runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps);
      // The view keeps its relative root-package key: an absolute one becomes the prompt's scope label.
      expect(h.dispatched).toEqual([
        { featureName: "feat", packageDir: "/tmp/replay-x", viewPackageDir: "", execRoot: "/tmp/replay-x" },
      ]);
      // The runtime is built for the feature too, so the replay's prompts are audited.
      expect(h.contexts).toEqual([[dir, "feat"]]);
      // The spec is the one at the escalation sha, resolved inside the worktree, never the recorded path.
      expect(h.specPaths).toEqual(["/tmp/replay-x/.nax/features/feat/spec.md"]);
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

describe("nax advisor replay — failure handling", () => {
  test("a failed worktree add or patch apply is a replay error, not a silent replay of the wrong tree", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix", "diff\n"));
      for (const fail of ["worktree add", "apply"]) {
        const h = harness(outDir, [replyFor("A")], fail);
        await runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps);
        expect(h.order).not.toContain("callOp");
        expect(h.out.join("\n")).toContain("fallback:");
      }
    });
  });

  test("the trust gate refusing stops before any model call", async () => {
    await withTempDir(async (dir) => {
      const outDir = join(dir, "out");
      await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
      const h = harness(outDir, [replyFor("A")]);
      h.deps.trustGate = async () => {
        throw new Error("untrusted");
      };
      await expect(runAdvisorReplay({ dir, feature: "feat", eval: false, json: false }, h.deps)).rejects.toThrow(
        "untrusted",
      );
      expect(h.order).not.toContain("callOp");
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

describe("nax advisor replay — model alias overrides", () => {
  const SOL = "openai-codex/gpt-6.1-sol";
  const aliasConfig = () => makeNaxConfig({ agent: { modelAliases: { sol: SOL } } });
  const run = async (model: string, dir: string, h: ReturnType<typeof harness>) =>
    runAdvisorReplay({ dir, feature: "feat", eval: false, json: false, model }, h.deps);
  const setup = async (dir: string, config?: ReturnType<typeof makeNaxConfig>) => {
    const outDir = join(dir, "out");
    await writeAdviceAudit(outDir, "feat", rec("D-1", "fix"));
    return harness(outDir, [replyFor("A")], undefined, config);
  };

  test("AC-9: agent:@name dispatches the expanded model", async () => {
    await withTempDir(async (dir) => {
      const h = await setup(dir, aliasConfig());
      await run("native:@sol", dir, h);
      expect(h.models).toEqual([{ agent: "native", model: SOL }]);
    });
  });

  test("AC-10/11/12/13: an unknown alias rejects before any dispatch or git call, closing once", async () => {
    await withTempDir(async (dir) => {
      const h = await setup(dir, aliasConfig());
      await expect(run("native:@nope", dir, h)).rejects.toMatchObject({ code: "MODEL_ALIAS_INVALID" });
      expect(h.models).toEqual([]);
      expect(h.git).toEqual([]);
      expect(h.closes()).toBe(1);
    });
  });

  test("AC-14/16: a bare @name rejects naming <agent>:@sol with MODEL_ALIAS_INVALID", async () => {
    await withTempDir(async (dir) => {
      const h = await setup(dir, aliasConfig());
      await expect(run("@sol", dir, h)).rejects.toMatchObject({
        code: "MODEL_ALIAS_INVALID",
        message: expect.stringContaining("<agent>:@sol"),
      });
      expect(h.closes()).toBe(1);
    });
  });

  test("AC-20: a literal agent:model override is dispatched unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = await setup(dir, aliasConfig());
      await run(`native:${SOL}`, dir, h);
      expect(h.models).toEqual([{ agent: "native", model: SOL }]);
    });
  });
});
