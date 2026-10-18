import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
import { getLogger } from "@/logger";
import { _routingDeps, routingStage } from "@/pipeline/stages/routing";
import type { StoryRouterOutcome } from "@/routing";

const originalDeps = { ..._routingDeps };
const pick = {
  kind: "picked",
  router: "test-router",
  profileId: "claude-haiku",
  reasoning: "router reason",
  latencyMs: 12,
} satisfies StoryRouterOutcome;
const consult = mock<typeof _routingDeps.consultStoryRouter>(async () => pick);
const classified = {
  complexity: "medium",
  modelTier: "balanced",
  testStrategy: "test-after",
  reasoning: "classification",
} as const;

function fixture(precedence: "router" | "plan" = "router", setup: "planned" | "unprofiled" | "unplanned" = "planned") {
  const ctx = makeTestContext({
    config: makeNaxConfig({
      tdd: { greenfieldDetection: false },
      autoMode: {
        escalation: {
          tierOrder: [
            { tier: "fast", agent: "native" },
            { tier: "fast", agent: "claude" },
            { tier: "balanced", agent: "native" },
            { tier: "powerful", agent: "native" },
            { tier: "balanced", agent: "claude" },
          ],
        },
      },
      routing: {
        router: { mode: "apply", precedence, timeoutMs: 5000 },
        agents: {
          enabled: true,
          strategy: "off",
          default: "native-luna",
          profiles: [
            { id: "native-deepseek", strengths: [], target: { agent: "native", model: "balanced" } },
            { id: "native-luna", strengths: [], target: { agent: "native", model: "fast" } },
            { id: "claude-haiku", strengths: [], target: { agent: "claude", model: "fast" } },
            { id: "literal-pin", strengths: [], target: { agent: "native", model: "vendor/literal-model" } },
          ],
        },
      },
    }),
    story: makeStory({
      escalations: [],
      routing: {
        ...classified,
        initialComplexity: "simple",
        agentProfileId: "native-deepseek",
        agent: "native",
        profileModelTier: "balanced",
        initialModelTier: "balanced",
        initialAgent: "native",
        initialProfileId: "native-deepseek",
      },
    }),
  });
  if (setup === "unprofiled") delete ctx.story.routing?.agentProfileId;
  if (setup === "unplanned") ctx.story.routing = undefined;
  return ctx;
}

beforeEach(() => {
  consult.mockReset();
  consult.mockResolvedValue(pick);
  Object.assign(_routingDeps, { consultStoryRouter: consult, resolveRouting: mock(async () => classified) });
});
afterEach(() => {
  Object.assign(_routingDeps, originalDeps);
  mock.restore();
});

test.each([
  ["AC-1", "agentProfileId", "claude-haiku"],
  ["AC-2", "agent", "claude"],
  ["AC-4", "profileModelTier", "fast"],
  ["AC-5", "initialProfileId", "claude-haiku"],
  ["AC-6", "initialAgent", "claude"],
  ["AC-7", "initialModelTier", "fast"],
] as const)("%s writes %s", async (_ac, key, expected) => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.[key]).toBe(expected);
});
test("AC-3 rebases persisted balanced to fast", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.routing?.modelTier).toBe("fast");
});
test.each([
  ["AC-8", "applied", true],
  ["AC-9", "plannedProfileId", "native-deepseek"],
] as const)("%s audits %s", async (_ac, key, expected) => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision?.[key]).toBe(expected);
});
test("AC-10 logs actual application at info", async () => {
  const info = spyOn(getLogger(), "info").mockImplementation(() => {});
  await routingStage.execute(fixture());
  expect(info.mock.calls.find((call) => call[1] === "routing.router.decision")?.[2]?.applied).toBe(true);
});
test.each([
  ["AC-11", "profileModelPin", "vendor/literal-model"],
  ["AC-12", "profileModelTier", undefined],
  ["AC-13", "initialModelPin", "vendor/literal-model"],
  ["pin origin has no tier", "initialModelTier", undefined],
] as const)("%s pin writes %s", async (_ac, key, expected) => {
  consult.mockResolvedValue({ ...pick, profileId: "literal-pin" });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.[key]).toBe(expected);
});
test("AC-14 tier pick removes both old pins", async () => {
  const ctx = fixture();
  if (!ctx.story.routing) throw new Error("Expected planned routing");
  delete ctx.story.routing.profileModelTier;
  ctx.story.routing.profileModelPin = "old-pin";
  ctx.story.routing.initialModelPin = "old-pin";
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.initialModelPin).toBeUndefined();
  expect(ctx.story.routing?.profileModelPin).toBeUndefined();
});
test.each([
  ["AC-15", "profile"],
  ["AC-16", "audit"],
] as const)("%s plan precedence preserves selection (%s)", async (_ac, field) => {
  const ctx = fixture("plan");
  await routingStage.execute(ctx);
  if (field === "profile") expect(ctx.story.routing?.agentProfileId).toBe("native-deepseek");
  else expect(ctx.story.routing?.routerDecision?.applied).toBe(false);
});
test.each([
  ["AC-17", "profile"],
  ["AC-18", "audit"],
] as const)("%s plan precedence applies without plan profile (%s)", async (_ac, field) => {
  const ctx = fixture("plan", "unprofiled");
  consult.mockResolvedValue({ ...pick, profileId: "native-luna" });
  await routingStage.execute(ctx);
  if (field === "profile") expect(ctx.story.routing?.agentProfileId).toBe("native-luna");
  else expect(ctx.story.routing?.routerDecision?.applied).toBe(true);
});
test("AC-19 same-id pick still applies", async () => {
  consult.mockResolvedValue({ ...pick, profileId: "native-deepseek" });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision?.applied).toBe(true);
});
test.each([
  ["AC-20", "declined"],
  ["AC-21", "unknown-profile"],
] as const)("%s %s cannot apply default", async (_ac, kind) => {
  consult.mockResolvedValue({ kind, router: "test-router", profileId: "missing", latencyMs: 1 });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.agentProfileId).toBe("native-deepseek");
  expect(ctx.story.routing?.routerDecision?.applied).toBe(false);
});
test.each([
  ["AC-22", "profile"],
  ["AC-23", "complexity"],
] as const)("%s unplanned story retains %s", async (_ac, field) => {
  const ctx = fixture("router", "unplanned");
  consult.mockResolvedValue({ ...pick, profileId: "native-luna" });
  await routingStage.execute(ctx);
  if (field === "profile") expect(ctx.story.routing?.agentProfileId).toBe("native-luna");
  else expect(ctx.story.routing?.complexity).toBe(classified.complexity);
  expect(ctx.story.routing?.testStrategy).toBe(classified.testStrategy);
  expect(ctx.story.routing?.reasoning).toBe(classified.reasoning);
});
test("application leaves classification and original complexity alone", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing).toMatchObject({ ...classified, modelTier: "fast", initialComplexity: "simple" });
});
