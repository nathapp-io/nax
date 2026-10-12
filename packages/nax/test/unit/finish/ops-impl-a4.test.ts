/**
 * A4 ops: the two review lenses, the review fix, and the two PR finalizers.
 * The LLM ops are stubbed through `_finishOpsDeps.callOp`; git and the forge
 * are stubbed to record the commands they were handed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeAdviceDecision, makeMockCallContext, withTempDir } from "@test/helpers";
import { appendDecision } from "@/advisor";
import type { Finding, FinishReviewOutput, ReviewInputs } from "@/finish";
import { _finishGitDeps, _finishOpsDeps, createFinishOps, createFinishState } from "@/finish";
import type { ForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";
import { finishBranchReviewOp, finishFixOp, finishSpecReviewOp } from "@/operations";

const originalOps = { ..._finishOpsDeps };
const originalGit = _finishGitDeps.git;
afterEach(() => {
  Object.assign(_finishOpsDeps, originalOps);
  _finishGitDeps.git = originalGit;
});

const CLEAN: FinishReviewOutput = { findings: [], covered: [] };

const inputs: ReviewInputs = {
  changed: ["src/a.ts"],
  stories: [{ id: "US-001", title: "First" }],
  hints: [],
  prdPath: ".nax/features/demo/prd.json",
};

function freshState() {
  return createFinishState({
    feature: "demo",
    workdir: "/repo",
    branch: "feat/demo",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

function baseDeps(forgeHandler?: (cmd: string[]) => { exitCode: number; stdout?: string }) {
  const gitCalls: string[][] = [];
  const forgeCalls: string[][] = [];
  _finishGitDeps.git = async (args: string[]) => {
    gitCalls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const forge: ForgeDeps = {
    run: async (cmd) => {
      forgeCalls.push(cmd);
      const r = forgeHandler?.(cmd) ?? { exitCode: 0, stdout: "https://x/1" };
      return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: "" };
    },
    readText: async () => null,
  };
  return {
    gitCalls,
    forgeCalls,
    deps: {
      callCtx: makeMockCallContext(),
      forge,
      forgeKind: "github" as const,
      audit: { auditDir: "/tmp/audit", runId: "run-1" },
    },
  };
}

interface Seen {
  role?: string;
  op?: unknown;
  input?: Record<string, unknown>;
}

function recordCallOp(out: FinishReviewOutput = CLEAN): Seen {
  const seen: Seen = {};
  _finishOpsDeps.callOp = (async (ctx: CallContext, op: unknown, input: Record<string, unknown>) => {
    seen.role = ctx.sessionOverride?.role;
    seen.op = op;
    seen.input = input;
    return out;
  }) as typeof _finishOpsDeps.callOp;
  return seen;
}

describe("reviewSpec / reviewBranch", () => {
  test("reviewSpec runs finishSpecReviewOp under finish-review-spec with the prd path and changed files", async () => {
    const seen = recordCallOp();
    await createFinishOps(baseDeps().deps).reviewSpec(freshState(), inputs);
    expect(seen.op).toBe(finishSpecReviewOp);
    expect(seen.role).toBe("finish-review-spec");
    expect(seen.input?.prdPath).toBe(".nax/features/demo/prd.json");
    expect(seen.input?.changedFiles).toEqual(["src/a.ts"]);
    expect(seen.input?.base).toBe("origin/main");
    expect(seen.input?.specPath).toBe(".nax/features/demo/spec.md");
    expect(seen.input && "decisions" in seen.input).toBe(true);
  });

  test("reviewBranch runs finishBranchReviewOp under finish-review-quality with hints and stories", async () => {
    const seen = recordCallOp();
    await createFinishOps(baseDeps().deps).reviewBranch(freshState(), inputs);
    expect(seen.op).toBe(finishBranchReviewOp);
    expect(seen.role).toBe("finish-review-quality");
    expect(seen.input?.hints).toEqual([]);
    expect(seen.input?.stories).toEqual([{ id: "US-001", title: "First" }]);
    expect(seen.input?.changedFiles).toEqual(["src/a.ts"]);
  });

  test("the two lenses start before either resolves", async () => {
    const started: (string | undefined)[] = [];
    const release: (() => void)[] = [];
    _finishOpsDeps.callOp = ((ctx: CallContext) => {
      started.push(ctx.sessionOverride?.role);
      return new Promise<FinishReviewOutput>((resolve) => release.push(() => resolve(CLEAN)));
    }) as typeof _finishOpsDeps.callOp;
    const ops = createFinishOps(baseDeps().deps);
    const s = freshState();
    const both = Promise.all([ops.reviewSpec(s, inputs), ops.reviewBranch(s, inputs)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...started].sort()).toEqual(["finish-review-quality", "finish-review-spec"]);
    for (const r of release) r();
    await both;
  });

  test("a throw from a lens propagates to the caller", async () => {
    _finishOpsDeps.callOp = (async () => {
      throw new Error("agent died");
    }) as typeof _finishOpsDeps.callOp;
    await expect(createFinishOps(baseDeps().deps).reviewSpec(freshState(), inputs)).rejects.toThrow("agent died");
  });
});

describe("fix review", () => {
  test("passes the findings through as a review-phase fix with no reviewer role", async () => {
    const seen: Seen = {};
    _finishOpsDeps.callOp = (async (ctx: CallContext, op: unknown, input: Record<string, unknown>) => {
      seen.role = ctx.sessionOverride?.role;
      seen.op = op;
      seen.input = input;
      return {};
    }) as typeof _finishOpsDeps.callOp;
    const findings: Finding[] = [{ severity: "HIGH", title: "T", problem: "p", fix: "f", source: "spec" }];
    await createFinishOps(baseDeps().deps).fix("review", { state: freshState(), findings });
    expect(seen.op).toBe(finishFixOp);
    expect(seen.role).toBeUndefined();
    expect(seen.input?.phase).toBe("review");
    expect(seen.input?.findings).toEqual(findings);
  });
});

describe("promotePr / finalizeDraftPr without a forge", () => {
  test("promotePr pushes and reports local-only", async () => {
    const { deps, gitCalls, forgeCalls } = baseDeps();
    const out = await createFinishOps({ ...deps, forgeKind: null }).promotePr(freshState());
    expect(out).toEqual({ status: "local-only" });
    expect(gitCalls.some((c) => c[0] === "push")).toBe(true);
    expect(forgeCalls).toEqual([]);
  });

  test("finalizeDraftPr pushes and reports local-only", async () => {
    const { deps, gitCalls, forgeCalls } = baseDeps();
    const out = await createFinishOps({ ...deps, forgeKind: null }).finalizeDraftPr(freshState());
    expect(out).toEqual({ status: "local-only" });
    expect(gitCalls.some((c) => c[0] === "push")).toBe(true);
    expect(forgeCalls).toEqual([]);
  });
});

describe("finalizeDraftPr keeps the PR draft", () => {
  test("an existing draft is updated, never marked ready", async () => {
    const { deps, forgeCalls } = baseDeps((cmd) =>
      cmd.includes("view")
        ? { exitCode: 0, stdout: '{"isDraft":true,"url":"https://x/pr/9"}' }
        : { exitCode: 0, stdout: "" },
    );
    const out = await createFinishOps(deps).finalizeDraftPr(freshState());
    expect(out).toEqual({ status: "draft", url: "https://x/pr/9" });
    expect(forgeCalls.some((c) => c.includes("ready"))).toBe(false);
    expect(forgeCalls.some((c) => c.includes("edit"))).toBe(true);
  });

  test("with no PR it creates one as a draft", async () => {
    const { deps, forgeCalls } = baseDeps((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/pr/10\n" },
    );
    const out = await createFinishOps(deps).finalizeDraftPr(freshState());
    expect(out.status).toBe("draft");
    expect(out.url).toBe("https://x/pr/10");
    const create = forgeCalls.find((c) => c.includes("create"));
    assertDefined(create);
    expect(create).toContain("--draft");
  });

  test("an already-ready PR is reported honestly, not demoted", async () => {
    const { deps, forgeCalls } = baseDeps((cmd) =>
      cmd.includes("view")
        ? { exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/pr/9"}' }
        : { exitCode: 0, stdout: "" },
    );
    const out = await createFinishOps(deps).finalizeDraftPr(freshState());
    expect(out.status).toBe("already-ready");
    expect(forgeCalls.some((c) => c.includes("ready"))).toBe(false);
  });
});

/** A git stub for a dirty tree: HEAD moves on commit, and a commit without --no-verify is rejected by a hook. */
function dirtyTreeGit(opts: { hookRejects: boolean }) {
  const calls: string[][] = [];
  let head = "head0";
  _finishGitDeps.git = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "status") return { exitCode: 0, stdout: " M src/a.ts\n", stderr: "" };
    if (args[0] === "diff" && args.includes("--cached")) return { exitCode: 1, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
    if (args[0] === "commit") {
      if (opts.hookRejects && !args.includes("--no-verify")) return { exitCode: 1, stdout: "", stderr: "hook failed" };
      head = "head1";
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return calls;
}

const draftFacts = {
  findingsOpen: [],
  acceptance: "green" as const,
  gates: [],
  reviewsMissing: [],
  unreviewedFixCommits: [],
  coverage: { spec: null, quality: null },
  fixRounds: 1,
  findings: [],
  stops: [],
};

describe("finalizeDraftPr recovery commit", () => {
  test("commits a dirty tree with hooks skipped and lists the commit as unreviewed", async () => {
    const { deps } = baseDeps((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/pr/10\n" },
    );
    const calls = dirtyTreeGit({ hookRejects: false });
    const state = freshState();
    state.resolution = { outcome: "draft", reason: "deadline", facts: draftFacts, acceptedResidue: [] };
    await createFinishOps(deps).finalizeDraftPr(state);
    const commit = calls.find((c) => c[0] === "commit");
    assertDefined(commit);
    expect(commit).toContain("--no-verify");
    expect(state.unreviewedFixCommits).toEqual(["head1"]);
    expect(state.resolution.facts.unreviewedFixCommits).toEqual(["head1"]);
  });

  test("a pre-commit hook cannot turn the deadline draft into a throw", async () => {
    const { deps } = baseDeps((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/pr/10\n" },
    );
    dirtyTreeGit({ hookRejects: true });
    const out = await createFinishOps(deps).finalizeDraftPr(freshState());
    expect(out.status).toBe("draft");
  });
});

describe("promotePr fallback content", () => {
  test("a render failure keeps the feat title and the draft reason in the body", async () => {
    const { deps, forgeCalls } = baseDeps((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/pr/11\n" },
    );
    const state = freshState();
    state.resolution = {
      outcome: "draft",
      reason: "1 open finding(s)",
      facts: { ...draftFacts, findingsOpen: [{ severity: "HIGH", title: "Missing guard", problem: "p", fix: "f" }] },
      acceptedResidue: [],
    };
    Object.defineProperty(state, "review", {
      get() {
        throw new Error("render boom");
      },
    });
    await createFinishOps(deps).promotePr(state);
    const create = forgeCalls.find((c) => c.includes("create"));
    assertDefined(create);
    expect(create[create.indexOf("--title") + 1]).toBe("feat: demo");
    const body = create[create.indexOf("--body") + 1] ?? "";
    expect(body).toContain("Reason: 1 open finding(s)");
    expect(body).toContain("Missing guard");
    expect(body).toContain("render boom");
  });
});

describe("review step limit (finish A)", () => {
  test("a lens cut off at reviewMs returns missing + stoppedAtLimit", async () => {
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      await new Promise<void>((r) => ctx.signal?.addEventListener("abort", () => r(), { once: true }));
      throw new Error("callOp[finish-spec-review]: aborted");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const out = await createFinishOps({ ...deps, timeouts: { reviewMs: 5, fixMs: 5 } }).reviewSpec(
      freshState(),
      inputs,
    );
    expect(out).toMatchObject({ missing: true, stoppedAtLimit: true });
  });

  test("a verdict returned after reviewMs fired is discarded as missing", async () => {
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      await new Promise<void>((r) => ctx.signal?.addEventListener("abort", () => r(), { once: true }));
      return { findings: [{ severity: "LOW", title: "late", problem: "p", fix: "f" }], covered: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const out = await createFinishOps({ ...deps, timeouts: { reviewMs: 5, fixMs: 5 } }).reviewBranch(
      freshState(),
      inputs,
    );
    expect(out).toMatchObject({ missing: true, stoppedAtLimit: true, findings: [] });
  });

  test("a phase stop is not a step limit: the error propagates", async () => {
    const phase = new AbortController();
    _finishOpsDeps.callOp = (async () => {
      phase.abort();
      throw new Error("callOp[finish-spec-review]: aborted");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const ops = createFinishOps({
      ...deps,
      callCtx: { ...deps.callCtx, signal: phase.signal },
      timeouts: { reviewMs: 60_000 },
    });
    await expect(ops.reviewSpec(freshState(), inputs)).rejects.toThrow("aborted");
  });

  test("the op's timeoutMs is reviewMs plus the margin, so the step limit fires first", async () => {
    let seen: Record<string, unknown> | undefined;
    _finishOpsDeps.callOp = (async (_ctx: CallContext, _op: unknown, input: Record<string, unknown>) => {
      seen = input;
      return { findings: [], covered: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await createFinishOps({ ...deps, timeouts: { reviewMs: 1_000 } }).reviewSpec(freshState(), inputs);
    expect(seen?.timeoutMs).toBe(61_000);
  });
});

describe("rulings reach the quality lens and the fixer (finish B 4)", () => {
  async function trustedWaive(repo: string, outputDir: string): Promise<void> {
    const d = await appendDecision(repo, "demo", (id) => ({
      ...makeAdviceDecision({ action: { type: "waive", reason: "outOfScope" }, findingSeverity: "LOW" }),
      dedupeKey: "quality|Seam|src/t.ts",
      auditRef: `advisor-audit/demo/${id}.json`,
    }));
    await Bun.write(join(outputDir, d.auditRef), JSON.stringify({ result: { decision: d } }));
  }

  test("fix gets rulings, ruling ids and acceptance paths; reviewBranch gets decisions", async () => {
    await withTempDir(async (repo) => {
      await withTempDir(async (outputDir) => {
        const { deps } = baseDeps();
        const callCtx = { ...deps.callCtx, runtime: { ...deps.callCtx.runtime, outputDir } };
        await trustedWaive(repo, outputDir);
        const state = { ...freshState(), workdir: repo };
        const ops = createFinishOps({ ...deps, callCtx });

        const fixSeen = recordCallOp();
        await ops.fix("review", { state, findings: [], acceptancePaths: ["t.ts"] });
        expect(fixSeen.op).toBe(finishFixOp);
        expect(String(fixSeen.input?.rulings)).toContain("D-1 waived: Seam (src/t.ts) \u2014 outOfScope");
        expect(fixSeen.input?.rulingIds).toEqual(["D-1"]);
        expect(fixSeen.input?.acceptancePaths).toEqual(["t.ts"]);

        const reviewSeen = recordCallOp();
        await ops.reviewBranch(state, inputs);
        expect(String(reviewSeen.input?.decisions)).toContain("D-1 waived");
      });
    });
  });

  test("no ledger: no rulings field on the fix input", async () => {
    await withTempDir(async (repo) => {
      const seen = recordCallOp();
      await createFinishOps(baseDeps().deps).fix("gate", { state: { ...freshState(), workdir: repo } });
      expect(seen.input && "rulings" in seen.input).toBe(false);
    });
  });
});
