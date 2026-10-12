import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CommandShadow } from "@nathapp/nax-agent";
import { makeContextBundle, makeNaxConfig, makeTestContext } from "@test/helpers";
import { InteractionChain } from "@/interaction/chain";
import type { InteractionPlugin } from "@/interaction/types";
import { buildWorkflowCallContext } from "@/workflow/call-context";
import { _workflowCallContextDeps } from "@/workflow/call-context-deps";

const original = { ..._workflowCallContextDeps };
afterEach(() => Object.assign(_workflowCallContextDeps, original));

function fakeShadow(drain: () => Promise<void>): CommandShadow {
  return { observe: () => {}, settle: () => {}, drain };
}

function wireDeps(shadow: CommandShadow | undefined): void {
  _workflowCallContextDeps.prepareApprovalsStore = async () => {};
  _workflowCallContextDeps.loadConfigForPackage = async () => makeNaxConfig();
  _workflowCallContextDeps.buildCommandShadow = () => shadow;
}

const plugin: InteractionPlugin = {
  name: "fake",
  send: async () => {},
  receive: async (requestId) => ({ requestId, action: "approve", respondedBy: "test", respondedAt: 0 }),
};

describe("buildWorkflowCallContext", () => {
  test("carries identity, config and package view", async () => {
    wireDeps(undefined);
    const ctx = makeTestContext({
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "", agent: "codex" },
    });
    const { callCtx, dispose } = await buildWorkflowCallContext(ctx);
    expect(callCtx.agentName).toBe("codex");
    expect(callCtx.storyId).toBe(ctx.story.id);
    expect(callCtx.featureName).toBe(ctx.prd.feature);
    expect(callCtx.story).toBe(ctx.story);
    expect(callCtx.config).toBe(ctx.config);
    expect(callCtx.packageView).toBe(ctx.runtime.packages.resolve(ctx.workdir));
    expect(callCtx.packageDir).toBe(ctx.workdir);
    expect(callCtx.commandShadow).toBeUndefined();
    expect(callCtx.interactionBridge).toBeUndefined();
    expect(callCtx.contextBundle).toBeUndefined();
    expect(callCtx.askResolver).toBeDefined();
    await dispose();
  });

  test("passes through contextBundle, interactionBridge and commandShadow when present", async () => {
    const drain = mock(async () => {});
    const shadow = fakeShadow(drain);
    wireDeps(shadow);
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    chain.register(plugin);
    const bundle = makeContextBundle();
    const ctx = makeTestContext({ interaction: chain, contextBundle: bundle, sessionScratchDir: "/tmp/scratch" });
    const { callCtx, dispose } = await buildWorkflowCallContext(ctx);
    expect(callCtx.contextBundle).toBe(bundle);
    expect(callCtx.interactionBridge).toBeDefined();
    expect(callCtx.commandShadow).toBe(shadow);
    expect(callCtx.storyScratchDirs).toEqual(["/tmp/scratch"]);
    await dispose();
  });

  test("dispose is the dispatch-ask dispose (drains the command shadow)", async () => {
    const drain = mock(async () => {});
    wireDeps(fakeShadow(drain));
    const { dispose } = await buildWorkflowCallContext(makeTestContext());
    expect(drain).not.toHaveBeenCalled();
    await dispose();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
