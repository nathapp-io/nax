/**
 * Regression: single-frame redesign PR2, Task 14 — acceptance-setup's
 * main-checkout dispatch root survives Task 1's containment-root move.
 *
 * `acceptance-setup`'s local `callOp` closure (`src/pipeline/stages/acceptance-setup.ts:175`)
 * resolves the pre-run stage's `packageDir` through
 * `pipelineCtx.runtime.packages.resolve(packageDir)`, then hands that view to the
 * shared `_callOp` (`@/operations`) Task 1 modified. `packageDir` is ALWAYS a
 * main-checkout absolute path: the generation loop passes `group.packageDir`
 * (`groupStoriesByPackage` joins `ctx.workdir`, never a worktree) and the refine
 * loop passes `storyAbsWorkdir(ctx.workdir, story)` — both rooted at the run's
 * main checkout.
 *
 * Post-run acceptance-gen/refine sessions are NOT worktree-isolated (worktrees are
 * per-story and cleaned before the post-run acceptance phase), so for such a
 * `packageDir` `storyExecRoot(packageView)` must equal `packageView.repoRoot` —
 * Task 1's `codingToolRoot`/ACP-cwd move must not reach this file destructively.
 *
 * This goes through the REAL local closure and the REAL dispatch seam
 * (`runWithFallback`), asserting the dispatched `AgentRunOptions`, not a mock of
 * the derivation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockAgentManager,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { groupStoriesByPackage } from "@/acceptance";
import type { AgentRunOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import { _acceptanceSetupDeps } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { storyExecRoot } from "@/runtime/packages";

const testSel = pickSelector("acceptance-setup-dispatch-root-test", "routing");

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
    name: "acceptance-setup-root-probe",
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

function makeCtx(runtime: NaxRuntime, repoRoot: string, prd: PRD): PipelineContext {
  return {
    config: runtime.configLoader.current(),
    rootConfig: runtime.configLoader.current(),
    prd,
    story: prd.userStories[0],
    stories: prd.userStories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: repoRoot,
    projectDir: repoRoot,
    featureDir: path.join(repoRoot, ".nax", "features", "test-feature"),
    hooks: { hooks: {} },
    ...makeDispatchContext({ runtime }),
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) cleanupTempDir(dir);
  tempDirs.length = 0;
});

function trackedTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

describe("acceptance-setup: main-checkout dispatch root survives the containment-root move", () => {
  test("local callOp dispatches at the main-checkout repoRoot, not a worktree path", async () => {
    const repoRoot = trackedTempDir("nax-accept-root-");
    const absPackageDir = path.join(repoRoot, "packages", "core");

    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: successResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, workdir: repoRoot });
    const prd = makePRD({
      feature: "test-feature",
      userStories: [makeStory({ id: "US-001", workdir: "packages/core", acceptanceCriteria: ["AC-1: works"] })],
    });
    const ctx = makeCtx(runtime, repoRoot, prd);

    await _acceptanceSetupDeps.callOp(ctx, absPackageDir, makeRunOp(), { text: "hi" });

    const packageView = runtime.packages.resolve(absPackageDir);
    // The registry relativizes the absolute packageDir, so the view's own
    // packageDir is relative — exactly the shape `storyExecRoot` expects.
    expect(packageView.packageDir).toBe("packages/core");
    expect(packageView.repoRoot).toBe(repoRoot);
    expect(storyExecRoot(packageView)).toBe(repoRoot);

    expect(seen).toBeDefined();
    expect(seen?.codingToolRoot).toBe(repoRoot);
    expect(seen?.workdir).toBe(repoRoot);
    // Discriminating: the package workdir is a different, real directory, and
    // the dispatch root must not have been re-pointed at it or at a worktree.
    expect(seen?.codingToolRoot).not.toBe(absPackageDir);
    expect(seen?.codingToolRoot).not.toContain(".nax-wt");
    expect(seen?.workdir).not.toContain(".nax-wt");
  });

  test("the absolute targetTestFilePath is inside storyExecRoot(packageView)", async () => {
    const repoRoot = trackedTempDir("nax-accept-path-");
    const runtime = makeTestRuntime({ agentManager: makeMockAgentManager(), workdir: repoRoot });
    const prd = makePRD({
      feature: "test-feature",
      userStories: [makeStory({ id: "US-001", workdir: "packages/core", acceptanceCriteria: ["AC-1: works"] })],
    });

    // `targetTestFilePath` (acceptance-setup.ts:417) is `group.testPath`
    // verbatim, so this is the real construction, not a copy of it.
    const [group] = await groupStoriesByPackage(prd, repoRoot, "test-feature");
    expect(group).toBeDefined();
    const testPath = group?.testPath as string;
    const packageDir = group?.packageDir as string;

    expect(path.isAbsolute(packageDir)).toBe(true);
    expect(path.isAbsolute(testPath)).toBe(true);

    const packageView = runtime.packages.resolve(packageDir);
    const execRoot = storyExecRoot(packageView);
    expect(execRoot).toBe(repoRoot);

    const relativeToExecRoot = path.relative(execRoot, testPath);
    expect(path.isAbsolute(relativeToExecRoot)).toBe(false);
    expect(relativeToExecRoot.startsWith("..")).toBe(false);
    expect(testPath).not.toContain(".nax-wt");
    // Explicit reachability for a package acceptance session: the file lives
    // under the package, which lives under the main-checkout exec root.
    expect(relativeToExecRoot.startsWith(`packages/core${path.sep}`)).toBe(true);
  });
});
