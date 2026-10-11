/**
 * A4 ops: the two review lenses, the review fix, and the two PR finalizers.
 * The LLM ops are stubbed through `_finishOpsDeps.callOp`; git and the forge
 * are stubbed to record the commands they were handed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockCallContext } from "@test/helpers";
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
