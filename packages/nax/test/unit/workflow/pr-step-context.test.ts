import { afterEach, describe, expect, mock, test } from "bun:test";
import { join, relative } from "node:path";
import type { CommandShadow } from "@nathapp/nax-agent";
import { cleanupTempDir, makeNaxConfig, makeScriptedCallOp, makeTempDir, makeTestRuntime } from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import { NaxError } from "@/errors";
import type { DispatchAskWiring } from "@/interaction/dispatch-ask";
import { workflowBranchReviewOp } from "@/operations";
import type { BranchStepContext, PrStepContext, PrStepContextInput, PrStepRef } from "@/workflow";
import { runBranchReview } from "@/workflow/branch-review";
import { workflowRunDir } from "@/workflow/paths";
import { _workflowDeps } from "@/workflow/step-context";

const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
const restores: (() => void)[] = [];
const workflowOriginal = { ..._workflowDeps };
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  Object.assign(_workflowDeps, workflowOriginal);
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

async function fixture(options: { dryRun?: boolean; realWiring?: boolean } = {}) {
  // Lazy imports let every AC report a red result before the provider exists.
  const { buildPrStepContext } = await import("@/workflow");
  const { _prStepContextDeps } = await import("@/workflow/pr-step-context");
  const original = { ..._prStepContextDeps };
  restores.push(() => Object.assign(_prStepContextDeps, original));
  const repoRoot = makeTempDir("pr-step-context-");
  dirs.push(repoRoot);
  const config = makeNaxConfig({ execution: { iterationDelayMs: 0 } });
  const runtime = makeTestRuntime({ config, workdir: repoRoot, dryRun: options.dryRun });
  runtimes.push(runtime);
  const dispose = mock(async () => {});
  const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => {} };
  const wiring: DispatchAskWiring = {
    askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }) },
    commandShadow: shadow,
    dispose,
  };
  const buildWiring = mock(async (_opts: Parameters<typeof original.buildRunDispatchAskWiring>[0]) => wiring);
  if (!options.realWiring) _prStepContextDeps.buildRunDispatchAskWiring = buildWiring;
  const pr: PrStepRef = { forge: "github", number: 42, base: "abc", head: "def" };
  const input: PrStepContextInput = { runtime, config, repoRoot, agentName: "native", pr };
  return { buildPrStepContext, input, wiring, buildWiring, dispose };
}

describe("buildPrStepContext", () => {
  test("AC-1–6 returns PR identity and checkout-rooted paths without a PRD", async () => {
    const { buildPrStepContext, input } = await fixture();
    const { ctx, dispose } = await buildPrStepContext(input);
    const publicContext: PrStepContext = ctx;
    const branchContext: BranchStepContext = publicContext;
    expect(branchContext.feature).toBe("bot-pr-42");
    expect(ctx.runDir).toBe(workflowRunDir(input.repoRoot, "bot-pr-42", input.runtime.runId));
    expect(ctx.reportPath).toBe(join(ctx.runDir, "feature-report.md"));
    expect(ctx.prdPath).toBeUndefined();
    expect(ctx).not.toHaveProperty("prdPath");
    expect(ctx.packageDirs).toEqual([]);
    expect(ctx.pr).toBe(input.pr);
    expect(ctx.projectDir).toBe(input.repoRoot);
    expect(ctx.config).toBe(input.config);
    expect(ctx.workflow).toEqual(resolveWorkflowConfig(input.config));
    expect(ctx.dryRun).toBe(false);
    expect(ctx).not.toHaveProperty("runSignal");
    expect(ctx.callCtx).not.toHaveProperty("signal");
    expect(ctx.callCtx).toMatchObject({
      runtime: input.runtime,
      packageDir: input.repoRoot,
      config: input.config,
      agentName: input.agentName,
      featureName: "bot-pr-42",
    });
    expect(ctx.callCtx.packageView).toBe(input.runtime.packages.resolve(input.repoRoot));
    await dispose();
  });

  test("AC-7–13 wires merge approvals and forwards resolver, shadow and disposal", async () => {
    const { buildPrStepContext, input, buildWiring, wiring, dispose: wiringDispose } = await fixture();
    const signal = new AbortController().signal;
    const { ctx, dispose } = await buildPrStepContext({ ...input, abortSignal: signal, interactionChain: null });
    expect(buildWiring).toHaveBeenCalledTimes(1);
    expect(buildWiring).toHaveBeenCalledWith({
      config: input.config,
      rootConfig: input.config,
      projectDir: input.repoRoot,
      repoRoot: input.repoRoot,
      packageDirs: [],
      interaction: null,
      outputDir: input.runtime.outputDir,
      runId: input.runtime.runId,
      featureName: "bot-pr-42",
      abortSignal: signal,
      stage: "merge",
    });
    expect(ctx.callCtx.askResolver).toBe(wiring.askResolver);
    expect(ctx.callCtx.commandShadow).toBe(wiring.commandShadow);
    await dispose();
    expect(wiringDispose).toHaveBeenCalledTimes(1);
  });

  test("AC-14–16 forwards cancellation and the runtime dry-run flag", async () => {
    const { buildPrStepContext, input } = await fixture({ dryRun: true });
    const abortSignal = new AbortController().signal;
    const { ctx, dispose } = await buildPrStepContext({ ...input, abortSignal });
    expect(ctx.runSignal).toBe(abortSignal);
    expect(ctx.callCtx.signal).toBe(abortSignal);
    expect(ctx.dryRun).toBe(true);
    await dispose();
  });

  test.each([
    ["AC-17/18 zero number", { number: 0 }],
    ["AC-19 fractional number", { number: 1.5 }],
    ["AC-20 blank head", { head: "  " }],
    ["AC-21 empty base", { base: "" }],
    ["negative number", { number: -1 }],
    ["nonfinite number", { number: Number.NaN }],
    ["blank base", { base: "  " }],
  ])("%s fails before ask wiring", async (_name, patch) => {
    const { buildPrStepContext, input, buildWiring } = await fixture();
    const failure = buildPrStepContext({ ...input, pr: { ...input.pr, ...patch } });
    await expect(failure).rejects.toBeInstanceOf(NaxError);
    await expect(failure).rejects.toMatchObject({ code: "PR_STEP_CONTEXT_INVALID", context: { stage: "workflow" } });
    expect(buildWiring).not.toHaveBeenCalled();
  });

  test("AC-22 propagates the original ask-wiring failure", async () => {
    const { buildPrStepContext, input, buildWiring } = await fixture();
    const error = new NaxError("[workflow] wiring failed", "TEST_WIRING_FAILED", { stage: "workflow" });
    buildWiring.mockImplementation(async () => {
      throw error;
    });
    await expect(buildPrStepContext(input)).rejects.toBe(error);
  });

  test("omits an absent command shadow and preserves nonblank refs verbatim", async () => {
    const { buildPrStepContext, input, wiring } = await fixture();
    Object.assign(wiring, { commandShadow: undefined });
    const pr = { ...input.pr, base: " abc ", head: " def " };
    const { ctx, dispose } = await buildPrStepContext({ ...input, pr });
    expect(ctx.callCtx).not.toHaveProperty("commandShadow");
    expect(ctx.pr).toBe(pr);
    await dispose();
  });

  test("AC-23 integration: real branch review writes the checkout's PR review package", async () => {
    const { buildPrStepContext, input } = await fixture({ realWiring: true });
    async function git(...args: string[]) {
      const proc = Bun.spawn(["git", ...args], { cwd: input.repoRoot, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      return stdout.trim();
    }
    await git("init");
    await Bun.write(join(input.repoRoot, "change.txt"), "before\n");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    await Bun.write(join(input.repoRoot, "change.txt"), "after\n");
    await git("add", "change.txt");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "head");
    const head = await git("rev-parse", "HEAD");
    const { ctx, dispose } = await buildPrStepContext({ ...input, pr: { ...input.pr, base, head } });
    const calls: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, opInput) => {
      calls.push(opInput);
      expect(op).toBe(workflowBranchReviewOp);
      expect(opInput).toMatchObject({ range: `${base}..HEAD`, repoRoot: input.repoRoot });
      return {
        spec: "pass",
        quality: "approved",
        findings: [],
        cannotVerify: [],
        inspectedFiles: ["change.txt"],
        minorTriage: [],
      };
    });
    try {
      const outcome = await runBranchReview(ctx, {
        seed: ctx.pr.base,
        facts: { stories: [], minors: [], parked: [], cannotVerify: [], gateFindings: [] },
      });
      expect(outcome.ran).toBe(true);
      expect(calls).toHaveLength(1);
      const packagePath = join(ctx.runDir, "package-branch.diff");
      expect(relative(input.repoRoot, packagePath)).toBe(
        join(".nax", "features", "bot-pr-42", "workflow", input.runtime.runId, "package-branch.diff"),
      );
      const text = await Bun.file(packagePath).text();
      expect(text).toContain("change.txt");
      expect(text).toContain("## Changed files (1)\n- M change.txt");
      expect(text).toContain(`git diff ${base}..HEAD -- <path>`);
    } finally {
      await dispose();
    }
  });
});
