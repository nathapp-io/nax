/**
 * Root collapse (single-frame redesign PR2, Task 1).
 *
 * PR1 decoupled a declared command's cwd (`RunCommandToolOptions.commandCwd`)
 * from the agent's containment root. This is the collapse itself: the native
 * `codingToolRoot` and the ACP spawn cwd (`workdir`) both move from the story's
 * PACKAGE dir to `storyExecRoot(ctx.packageView)`.
 *
 * For a non-worktree package those differ (`/repo` vs `/repo/packages/api`); for
 * a worktree-isolated story the exec root is the worktree root, so the agent is
 * contained inside the story's own tree and cannot escape to the main checkout
 * (nax#2093, spec Risk-table R2).
 *
 * Anchored on the dispatch seam (`runWithFallback`/`completeAs`), not on the
 * `buildRunDispatchOptions` literal alone, so a future divergence between the
 * builder and what callOp actually sends is caught.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import type { AgentRunOptions, CompleteOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { BuildHopCallbackContext, CompleteOperation, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { packageWorkdir, storyExecRoot } from "@/runtime/packages";

const testSel = pickSelector("call-root-collapse-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const successResult = {
  success: true,
  exitCode: 0,
  output: "ok",
  rateLimited: false,
  durationMs: 1,
  estimatedCostUsd: 0,
  agentFallbacks: [],
};

function makeRunOp(): RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "root-collapse-run",
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

function makeCompleteOp(): CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name: "root-collapse-complete",
    stage: "run",
    config: testSel,
    build: (input) => ({
      role: { id: "role", content: "You echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

describe("callOp root collapse — package story", () => {
  test("runOptions.codingToolRoot and workdir are storyExecRoot, not the package workdir", async () => {
    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: successResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");
    // Sanity: the two candidate roots genuinely differ for a package story.
    expect(storyExecRoot(packageView)).toBe("/repo");
    expect(packageWorkdir(packageView)).toBe("/repo/packages/api");

    await callOp(
      { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
      makeRunOp(),
      { text: "hi" },
    );

    expect(seen?.codingToolRoot).toBe(storyExecRoot(packageView));
    expect(seen?.codingToolRoot).toBe("/repo");
    expect(seen?.codingToolRoot).not.toBe(packageWorkdir(packageView));
    // ACP-arm cwd (workdir) collapses with it.
    expect(seen?.workdir).toBe(storyExecRoot(packageView));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });
});

describe("callOp root collapse — worktree-isolated story", () => {
  test("codingToolRoot and workdir are the worktree root, not the main checkout or package dir", async () => {
    const repoRoot = "/repo";
    const storyId = "US-007";
    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: successResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: repoRoot });
    createdRuntimes.push(runtime);

    // Resolve through the registry so packageDir carries the `.nax-wt/<storyId>`
    // prefix — the exact shape a worktree-isolated story produces.
    const packageView = runtime.packages.resolve(join(repoRoot, ".nax-wt", storyId, "packages", "api"));
    expect(packageView.repoRoot).toBe(repoRoot);
    expect(packageView.packageDir).toBe(".nax-wt/US-007/packages/api");
    const worktreeRoot = join(repoRoot, ".nax-wt", storyId);
    expect(storyExecRoot(packageView)).toBe(worktreeRoot);
    expect(packageWorkdir(packageView)).toBe(join(worktreeRoot, "packages", "api"));

    await callOp(
      { runtime, packageView, packageDir: packageView.packageDir, agentName: "claude", storyId },
      makeRunOp(),
      { text: "hi" },
    );

    expect(seen?.codingToolRoot).toBe(worktreeRoot);
    expect(seen?.codingToolRoot).not.toBe(repoRoot);
    expect(seen?.codingToolRoot).not.toBe(packageWorkdir(packageView));
    expect(seen?.workdir).toBe(worktreeRoot);
    expect(seen?.workdir).not.toBe(repoRoot);
  });
});

describe("callOp root collapse — complete-kind and hop context", () => {
  test("completeOptions.workdir is storyExecRoot, not ctx.packageDir", async () => {
    let seen: CompleteOptions | undefined;
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _prompt, opts) => {
        seen = opts;
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");

    await callOp(
      { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
      makeCompleteOp(),
      { text: "hi" },
    );

    expect(seen?.workdir).toBe(storyExecRoot(packageView));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });

  test("hop context workdir is storyExecRoot, not ctx.packageDir", async () => {
    const orig = _callOpDeps.buildHopCallback;
    let seen: BuildHopCallbackContext | undefined;
    _callOpDeps.buildHopCallback = (hopCtx: BuildHopCallbackContext) => {
      seen = hopCtx;
      return async () => ({ result: successResult, bundle: undefined });
    };
    const agentManager = makeMockAgentManager({});
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: "/repo" });
    try {
      const packageView = runtime.packages.resolve("packages/api");
      await callOp(
        { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
        makeRunOp(),
        { text: "hi" },
      ).catch(() => undefined);
    } finally {
      _callOpDeps.buildHopCallback = orig;
      await runtime.close();
    }

    expect(seen?.workdir).toBe(storyExecRoot({ repoRoot: "/repo", packageDir: "packages/api" }));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });
});
