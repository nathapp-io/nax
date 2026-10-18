import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeDispatchContext, makeFakeClock, makeStory, withTimerSpy } from "@test/helpers";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import { PluginRegistry } from "@/plugins/registry";
import type { RoutingDecision, RoutingStrategy } from "@/routing";
import type { DispatchContext } from "@/runtime";

// Dynamic import keeps every criterion independently observable in the initial RED run.
async function consult(
  story: ReturnType<typeof makeStory>,
  config: NaxConfig,
  plugins: PluginRegistry | undefined,
  context: DispatchContext,
) {
  return (await import("@/routing/story-router")).consultStoryRouter(story, config, plugins, context);
}
const decision: RoutingDecision = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "Profile fit",
  agentProfileId: "native-luna",
};
function setup(route: RoutingStrategy["route"] = () => decision) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.routing.agents = {
    enabled: true,
    strategy: "off",
    default: "native-luna",
    profiles: [{ id: "native-luna", strengths: [], target: { agent: "native", model: "balanced" } }],
  };
  config.routing.router = { mode: "apply", precedence: "router", timeoutMs: 50 };
  const plugins = new PluginRegistry([]);
  const router = { name: "first-router", route: mock(route) };
  spyOn(plugins, "getRouters").mockReturnValue([router]);
  const story = makeStory();
  const context = makeDispatchContext();
  return { config, plugins, router, story, context, run: () => consult(story, config, plugins, context) };
}
afterEach(() => mock.restore());

describe("consultStoryRouter", () => {
  test("AC-1 undefined plugins", async () => {
    expect(await consult(makeStory(), DEFAULT_CONFIG, undefined, makeDispatchContext())).toEqual({ kind: "no-router" });
  });
  test("AC-2 empty registry", async () => {
    expect(await consult(makeStory(), DEFAULT_CONFIG, new PluginRegistry([]), makeDispatchContext())).toEqual({
      kind: "no-router",
    });
  });
  test("AC-3 AC-4 picked profile, router name, reasoning and latency", async () => {
    const result = await setup().run();
    expect(result).toMatchObject({
      kind: "picked",
      profileId: "native-luna",
      router: "first-router",
      reasoning: "Profile fit",
    });
    expect("latencyMs" in result && result.latencyMs).toBeGreaterThanOrEqual(0);
  });
  test.each([0.82, 0, 1])("AC-5 copies valid confidence %s", async (confidence) => {
    expect(await setup(() => ({ ...decision, confidence })).run()).toMatchObject({ kind: "picked", confidence });
  });
  test.each([1.5, Number.NaN, -0.1, Infinity, -Infinity])(
    "AC-6 AC-7 omits invalid confidence %s",
    async (confidence) => {
      const result = await setup(() => ({ ...decision, confidence })).run();
      expect(result.kind).toBe("picked");
      expect(result).not.toHaveProperty("confidence");
    },
  );
  test("AC-8 null declines", async () => {
    expect(await setup(() => null).run()).toMatchObject({ kind: "declined" });
  });
  test.each([undefined, "", "   "])("AC-9 missing or empty profile declines %s", async (agentProfileId) => {
    expect(await setup(() => ({ ...decision, agentProfileId })).run()).toMatchObject({ kind: "declined" });
  });
  test("AC-10 unknown id never falls back to configured default", async () => {
    expect(await setup(() => ({ ...decision, agentProfileId: "no-such-profile" })).run()).toMatchObject({
      kind: "unknown-profile",
      profileId: "no-such-profile",
    });
  });
  test.each([false, true])("AC-11 captures sync throw or async rejection %s", async (asyncError) => {
    const result = await setup(() => {
      if (asyncError) return Promise.reject(new Error("router down"));
      throw new Error("router down");
    }).run();
    expect(result).toMatchObject({ kind: "error", message: "router down" });
  });
  test("AC-12 bounds a never-settling router by configured 50ms", async () => {
    const fixture = setup(() => new Promise<RoutingDecision>(() => {}));
    const { consultStoryRouter, _storyRouterDeps } = await import("@/routing/story-router");
    const clock = makeFakeClock();
    spyOn(_storyRouterDeps, "setTimer").mockImplementation(clock.setTimeout);
    spyOn(_storyRouterDeps, "clearTimer").mockImplementation((timer) =>
      clock.clearTimeout(timer === undefined ? undefined : Number(timer)),
    );
    spyOn(_storyRouterDeps, "now").mockImplementation(clock.now);
    const pending = consultStoryRouter(fixture.story, fixture.config, fixture.plugins, fixture.context);
    expect(clock.pending()).toBe(1);
    await clock.advance(49);
    expect(clock.pending()).toBe(1);
    await clock.advance(1);
    expect(await pending).toEqual({ kind: "timeout", router: "first-router", latencyMs: 50 });
    expect(clock.pending()).toBe(0);
  });
  test("AC-13 only first router consulted even on decline", async () => {
    const fixture = setup(() => null);
    const second = { name: "second", route: mock(() => decision) };
    spyOn(fixture.plugins, "getRouters").mockReturnValue([fixture.router, second]);
    expect(await fixture.run()).toMatchObject({ kind: "declined" });
    expect(fixture.router.route).toHaveBeenCalledTimes(1);
    expect(second.route).not.toHaveBeenCalled();
  });
  test("AC-14 forwards story and full context with supplied config", async () => {
    const fixture = setup();
    await fixture.run();
    expect(fixture.router.route).toHaveBeenCalledWith(fixture.story, { ...fixture.context, config: fixture.config });
  });
  test("AC-15 barrel exports promise-returning consultation", async () => {
    const routing = await import("@/routing");
    const result = routing.consultStoryRouter(makeStory(), DEFAULT_CONFIG, undefined, makeDispatchContext());
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ kind: "no-router" });
  });
  test.each(["picked", "error"])("clears deadline timer on early %s", async (kind) => {
    const fixture = setup(() => {
      if (kind === "error") throw new Error("down");
      return decision;
    });
    const observed = await withTimerSpy(fixture.run, { origin: "routing/story-router" });
    expect(observed.result.kind).toBe(kind);
    expect(observed.armed).toHaveLength(1);
    expect(observed.leaked).toEqual([]);
    expect(observed.cleared.has(observed.armed[0])).toBe(true);
  });
});
