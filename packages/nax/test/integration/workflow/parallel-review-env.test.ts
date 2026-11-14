import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeScriptedCallOp,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { workflowStoryReviewOp } from "@/operations";
import { buildStoryEnv } from "@/workflow/stage-env";
import { _workflowDeps } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";

const dirs: string[] = [];
const original = _workflowDeps.callOp;
afterEach(() => {
  _workflowDeps.callOp = original;
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

async function setup(review: "enabled" | "absent") {
  const dir = makeTempDir("parallel-review-");
  dirs.push(dir);
  const config = makeNaxConfig();
  assertDefined(config.workflow, "workflow defaults");
  const { review: _review, ...withoutReview } = config.workflow;
  config.workflow =
    review === "absent"
      ? withoutReview
      : { ...config.workflow, review: { coverageRetries: 3, parallelWithSuite: true } };
  const runtime = makeMockRuntime({ config, workdir: dir });
  const ctx = makeTestContext({
    config,
    rootConfig: config,
    runtime,
    projectDir: dir,
    workdir: dir,
    storyGitRef: "HEAD",
  });
  return buildStoryEnv(ctx, makeMockCallContext({ runtime }));
}

async function initGit(dir: string) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["commit", "--allow-empty", "-qm", "seed"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(err);
  }
}

describe("parallel review env", () => {
  test("AC-6: enables parallel review", async () => expect((await setup("enabled")).env.parallelReview).toBe(true));
  test("AC-7: defaults a sparse workflow to false", async () =>
    expect((await setup("absent")).env.parallelReview).toBe(false));
  test.each(["direct", "step"])("AC-11/12: %s dispatch carries running-suite prompt", async (entry) => {
    const { env, sc } = await setup("enabled");
    await initGit(sc.projectDir);
    const calls: { name: string; input: unknown }[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      calls.push({ name: op.name, input });
      return null;
    });
    const gates = { lint: "green", typecheck: "green", scoped: "green" } as const;
    if (entry === "direct") await runStoryReview(sc, [], gates, { suiteRunning: true });
    else await env.steps.storyReview([], gates, { suiteRunning: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: workflowStoryReviewOp.name,
      input: { prompt: expect.stringContaining("full suite still running") },
    });
  });
});
