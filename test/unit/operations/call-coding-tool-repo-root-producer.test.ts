/**
 * The PRODUCER for `AgentRunOptions.codingToolRepoRoot`.
 *
 * Exec's `target: "repoRoot"` resolves its cwd from this field. `call.ts` must
 * supply `storyExecRoot(ctx.packageView)`, not `ctx.packageView.repoRoot`:
 * under story worktree isolation the latter is the MAIN CHECKOUT, so a
 * repo-scoped command wrote the user's real working tree (nax#2093). The helper
 * test (test/unit/runtime/story-exec-root.test.ts) pins the resolution logic and
 * the boundary test pins normalizeExec, but neither exercises the wiring — so
 * this asserts on what actually reaches `runWithFallback`, the seam through
 * which production dispatch carries the field.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { callOp, type RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("coding-tool-repo-root-producer-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

// The main checkout the runtime was created with. The story's worktree lives
// beneath it at `<mainCheckout>/.nax-wt/<storyId>/`.
const mainCheckout = "/tmp/nax-pr6-coding-tool-repo-root";
const storyId = "US-003";
const worktreePackageDir = join(mainCheckout, ".nax-wt", storyId, "packages", "api");

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeOp(): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "coding-tool-repo-root-producer",
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

describe("callOp produces AgentRunOptions.codingToolRepoRoot", () => {
  test("points Exec's repoRoot at the story worktree, not the main checkout", async () => {
    const seen: AgentRunOptions[] = [];
    const runtime = makeMockRuntime({
      workdir: mainCheckout,
      agentManager: makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          seen.push(req.runOptions);
          const { executeHop } = req;
          assertDefined(executeHop, "req.executeHop");
          const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async () => ({
          output: "done",
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }),
      }),
    });
    createdRuntimes.push(runtime);

    // Resolve through the runtime registry so the view's repoRoot is the real
    // main checkout and packageDir carries the `.nax-wt/<storyId>` prefix — the
    // exact shape a worktree-isolated story produces.
    const packageView = runtime.packages.resolve(worktreePackageDir);
    expect(packageView.repoRoot).toBe(mainCheckout);

    await callOp({ runtime, packageView, packageDir: worktreePackageDir, agentName: "claude" }, makeOp(), "input");

    expect(seen.length).toBe(1);
    // The field Exec reads for target:"repoRoot" must be the story's execution
    // root (the worktree root), NOT the main checkout the runtime was created in.
    expect(seen[0]?.codingToolRepoRoot).toBe(join(mainCheckout, ".nax-wt", storyId));
    expect(seen[0]?.codingToolRepoRoot).not.toBe(mainCheckout);
    // Root collapse (single-frame redesign PR2): the containment root moved from
    // the package dir to the story exec root, so it is now numerically identical
    // to codingToolRepoRoot. Pre-PR2 this was `worktreePackageDir`.
    expect(seen[0]?.codingToolRoot).toBe(join(mainCheckout, ".nax-wt", storyId));
  });
});
