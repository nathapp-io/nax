import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestContext, withWarnSpy } from "@test/helpers";
import { _routingDeps, routingStage } from "@/pipeline/stages/routing";
import type { StoryRouterOutcome } from "@/routing";

const originalDeps = { ..._routingDeps };
const warning = "Story router enabled but routing.agents is disabled or has no profiles";
const consult = mock<typeof _routingDeps.consultStoryRouter>(
  async (): Promise<StoryRouterOutcome> => ({ kind: "no-router" }),
);
const resolve = mock<typeof _routingDeps.resolveRouting>(async () => ({
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "test",
}));

function fixture(mode: "off" | "shadow" | "apply" = "shadow") {
  const config = makeNaxConfig({
    tdd: { greenfieldDetection: false },
    routing: {
      router: { mode, precedence: "router", timeoutMs: 5000 },
      agents: {
        enabled: true,
        strategy: "off",
        default: "native-deepseek",
        profiles: [
          { id: "native-deepseek", strengths: [], target: { agent: "native", model: "balanced" } },
          { id: "native-luna", strengths: [], target: { agent: "native", model: "fast" } },
          { id: "claude-haiku", strengths: [], target: { agent: "claude", model: "fast" } },
        ],
      },
    },
  });
  const story = makeStory({
    escalations: [],
    routing: {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "plan",
      agentProfileId: "native-deepseek",
    },
  });
  return makeTestContext({ config, story });
}

beforeEach(() => {
  consult.mockReset();
  consult.mockImplementation(async () => ({ kind: "no-router" }));
  resolve.mockClear();
  Object.assign(_routingDeps, { consultStoryRouter: consult, resolveRouting: resolve });
});
afterEach(() => Object.assign(_routingDeps, originalDeps));

describe("routing stage story-router guards", () => {
  test("AC-1 off does not consult", async () => {
    await routingStage.execute(fixture("off"));
    expect(consult).not.toHaveBeenCalled();
  });
  test("AC-2 absent router block continues without consultation", async () => {
    const ctx = fixture();
    delete ctx.config.routing.router;
    expect(await routingStage.execute(ctx)).toEqual({ action: "continue" });
    expect(consult).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-3", "shadow"],
    ["AC-4", "apply"],
  ] as const)("%s %s consults once with the stage context", async (_ac, mode) => {
    const ctx = fixture(mode);
    await routingStage.execute(ctx);
    expect(consult).toHaveBeenCalledTimes(1);
    expect(consult.mock.calls[0]).toEqual([ctx.story, ctx.config, ctx.plugins, ctx]);
    expect(consult.mock.invocationCallOrder[0]).toBeLessThan(resolve.mock.invocationCallOrder[0] ?? 0);
  });
  test("AC-5 error is consulted again on the same story", async () => {
    consult.mockResolvedValueOnce({ kind: "error", router: "test", message: "failed", latencyMs: 1 });
    const ctx = fixture();
    await routingStage.execute(ctx);
    expect(ctx.story.routing?.routerDecision).toBeUndefined();
    await routingStage.execute(ctx);
    expect(consult).toHaveBeenCalledTimes(2);
  });
  test.each([
    ["AC-6", "shadow"],
    ["AC-7", "apply"],
  ] as const)("%s %s skips escalated stories", async (_ac, mode) => {
    const ctx = fixture(mode);
    ctx.story.escalations = [
      { fromTier: "fast", toTier: "balanced", reason: "test", timestamp: new Date().toISOString() },
    ];
    await routingStage.execute(ctx);
    expect(consult).not.toHaveBeenCalled();
    expect(resolve.mock.calls[0]?.[4]).toEqual({ skipPluginRouters: true });
  });
  test.each(["empty", "disabled"] as const)("AC-8/AC-9 %s agent routing does not consult", async (condition) => {
    const ctx = fixture();
    if (condition === "empty")
      ctx.config.routing.agents = {
        ...ctx.config.routing.agents,
        enabled: true,
        strategy: "off",
        default: "",
        profiles: [],
      };
    else if (ctx.config.routing.agents) ctx.config.routing.agents.enabled = false;
    await routingStage.execute(ctx);
    expect(consult).not.toHaveBeenCalled();
    expect(resolve.mock.calls[0]?.[4]).toEqual({ skipPluginRouters: false });
  });
  test("AC-10 AC-11 AC-12 unusable router warns once per run with storyId first", async () => {
    const ctx = fixture();
    if (ctx.config.routing.agents) ctx.config.routing.agents.profiles = [];
    await withWarnSpy(async (warn) => {
      await routingStage.execute(ctx);
      const second = makeTestContext({ config: ctx.config, story: makeStory({ id: "US-OTHER" }) });
      await routingStage.execute(second);
      const warnings = warn.mock.calls.filter((call) => call[1] === warning);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[0]).toBe("routing");
      expect(warnings[0]?.[2]?.storyId).toBe(ctx.story.id);
      expect(Object.keys(warnings[0]?.[2] ?? {})[0]).toBe("storyId");
    });
  });
  test.each([
    ["AC-13", "shadow", true, true],
    ["AC-14", "off", true, false],
    ["AC-15", "shadow", false, false],
  ] as const)("%s passes skipPluginRouters as fifth argument", async (_ac, mode, enabled, expected) => {
    const ctx = fixture(mode);
    if (ctx.config.routing.agents) ctx.config.routing.agents.enabled = enabled;
    await routingStage.execute(ctx);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]).toEqual([ctx.story, ctx.config, ctx.plugins, ctx, { skipPluginRouters: expected }]);
  });
  test("persisted decision suppresses consultation without restoring legacy routers", async () => {
    const ctx = fixture();
    if (ctx.story.routing)
      ctx.story.routing.routerDecision = {
        mode: "shadow",
        router: "test",
        outcome: "declined",
        applied: false,
        decidedAt: new Date().toISOString(),
      };
    await routingStage.execute(ctx);
    expect(consult).not.toHaveBeenCalled();
    expect(resolve.mock.calls[0]?.[4]).toEqual({ skipPluginRouters: true });
  });
  test("absent agents block warns and retains legacy routers", async () => {
    const ctx = fixture();
    delete ctx.config.routing.agents;
    await withWarnSpy(async (warn) => {
      await routingStage.execute(ctx);
      expect(warn.mock.calls.some((call) => call[1] === warning)).toBe(true);
      expect(consult).not.toHaveBeenCalled();
      expect(resolve.mock.calls[0]?.[4]).toEqual({ skipPluginRouters: false });
    });
  });
});
