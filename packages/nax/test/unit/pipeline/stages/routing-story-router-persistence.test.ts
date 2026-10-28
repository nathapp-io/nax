import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
import { getLogger } from "@/logger";
import { _routingDeps, routingStage } from "@/pipeline/stages/routing";
import type { StoryRouterOutcome } from "@/routing";

const originalDeps = { ..._routingDeps };
const pick = {
  kind: "picked",
  router: "test-router",
  profileId: "native-luna",
  reasoning: "router reason",
  latencyMs: 12,
} satisfies StoryRouterOutcome;
const consult = mock<typeof _routingDeps.consultStoryRouter>(async () => pick);
const save = mock<typeof _routingDeps.savePRD>(async () => {});
const classified = {
  complexity: "medium",
  modelTier: "balanced",
  testStrategy: "test-after",
  reasoning: "classification",
} as const;

function fixture(planned = true) {
  const config = makeNaxConfig({
    tdd: { greenfieldDetection: false },
    routing: {
      router: { mode: "shadow", precedence: "router", timeoutMs: 5000 },
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
  return makeTestContext({
    config,
    story: makeStory({
      escalations: [],
      routing: planned
        ? {
            complexity: "simple",
            testStrategy: "test-after",
            reasoning: "plan",
            agentProfileId: "native-deepseek",
          }
        : undefined,
    }),
  });
}

beforeEach(() => {
  consult.mockReset();
  consult.mockResolvedValue(pick);
  save.mockClear();
  Object.assign(_routingDeps, {
    consultStoryRouter: consult,
    resolveRouting: mock(async () => classified),
    savePRD: save,
  });
});
afterEach(() => {
  Object.assign(_routingDeps, originalDeps);
  mock.restore();
});

test("AC-1 shadow preserves the planned profile", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.agentProfileId).toBe("native-deepseek");
});
test.each([
  ["AC-2", "applied", false],
  ["AC-3", "mode", "shadow"],
  ["AC-4", "profileId", "native-luna"],
  ["AC-5", "plannedProfileId", "native-deepseek"],
  ["AC-6", "router", "test-router"],
] as const)("%s records %s", async (_ac, key, expected) => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision?.[key]).toBe(expected);
});
test("AC-7 records a valid timestamp", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(Number.isFinite(Date.parse(ctx.story.routing?.routerDecision?.decidedAt ?? ""))).toBe(true);
});
test("AC-8 records producer-filtered confidence", async () => {
  consult.mockResolvedValue({ ...pick, confidence: 0.7 });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision?.confidence).toBe(0.7);
});
test("AC-9 omits absent confidence", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision).toBeDefined();
  expect(ctx.story.routing?.routerDecision).not.toHaveProperty("confidence");
});
test("AC-10 declined has no pick or confidence", async () => {
  consult.mockResolvedValue({ kind: "declined", router: "test-router", latencyMs: 3 });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision).toMatchObject({ outcome: "declined", applied: false });
  expect(ctx.story.routing?.routerDecision).not.toHaveProperty("profileId");
  expect(ctx.story.routing?.routerDecision).not.toHaveProperty("confidence");
});
test("AC-11 AC-12 unknown profile is audited without changing the plan", async () => {
  consult.mockResolvedValue({
    kind: "unknown-profile",
    router: "test-router",
    profileId: "no-such-profile",
    latencyMs: 3,
  });
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision).toMatchObject({
    outcome: "unknown-profile",
    profileId: "no-such-profile",
    applied: false,
  });
  expect(ctx.story.routing?.routerDecision).not.toHaveProperty("confidence");
  expect(ctx.story.routing?.agentProfileId).toBe("native-deepseek");
});
test.each([
  ["AC-13", "error"],
  ["AC-14", "timeout"],
  ["AC-15", "no-router"],
] as const)("%s %s is not persisted and can retry", async (_ac, kind) => {
  consult.mockResolvedValue(
    kind === "no-router" ? { kind } : { kind, router: "test-router", message: "router down", latencyMs: 3 },
  );
  const ctx = fixture();
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision).toBeUndefined();
  await routingStage.execute(ctx);
  expect(consult).toHaveBeenCalledTimes(2);
});
test("AC-16 AC-17 logs the decision with storyId first", async () => {
  const info = spyOn(getLogger(), "info")
    .mockImplementation(() => {})
    .mockClear();
  const ctx = fixture();
  await routingStage.execute(ctx);
  const call = info.mock.calls.find((call) => call[1] === "routing.router.decision");
  expect(call?.[0]).toBe("routing");
  expect(call?.[2]).toEqual({
    storyId: ctx.story.id,
    mode: "shadow",
    router: "test-router",
    outcome: "picked",
    plannedProfileId: "native-deepseek",
    routerProfileId: "native-luna",
    confidence: undefined,
    applied: false,
    latencyMs: 12,
  });
  expect(Object.keys(call?.[2] ?? {})[0]).toBe("storyId");
});
test.each([
  ["AC-18", "error"],
  ["AC-19", "timeout"],
] as const)("%s logs %s at warn", async (_ac, kind) => {
  consult.mockResolvedValue({ kind, router: "test-router", message: "router down", latencyMs: 3 });
  // spyOn reuses an existing mock on the shared logger; restore does not clear its history.
  const warn = spyOn(getLogger(), "warn")
    .mockImplementation(() => {})
    .mockClear();
  await routingStage.execute(fixture());
  const call = warn.mock.calls.find((call) => call[1] === "routing.router.failed");
  expect(call?.[0]).toBe("routing");
  expect(call?.[2]).toMatchObject({ outcome: kind, router: "test-router", latencyMs: 3 });
  if (kind === "error") expect(call?.[2]?.message).toBe("router down");
});
test("AC-20 no-router emits neither decision nor failure", async () => {
  consult.mockResolvedValue({ kind: "no-router" });
  const info = spyOn(getLogger(), "info")
    .mockImplementation(() => {})
    .mockClear();
  const warn = spyOn(getLogger(), "warn")
    .mockImplementation(() => {})
    .mockClear();
  await routingStage.execute(fixture());
  expect(
    [...info.mock.calls, ...warn.mock.calls].filter((call) =>
      ["routing.router.decision", "routing.router.failed"].includes(call[1]),
    ),
  ).toHaveLength(0);
});
test("AC-21 saves the audit in the existing PRD write-back", async () => {
  const ctx = fixture();
  ctx.prdPath = "/tmp/router-prd.json";
  await routingStage.execute(ctx);
  expect(save).toHaveBeenCalledTimes(1);
  expect(
    save.mock.calls[0]?.[0].userStories.find((story) => story.id === ctx.story.id)?.routing?.routerDecision?.profileId,
  ).toBe("native-luna");
});
test("AC-22 persisted decision suppresses a second consult", async () => {
  const ctx = fixture();
  await routingStage.execute(ctx);
  await routingStage.execute(ctx);
  expect(consult).toHaveBeenCalledTimes(1);
});
test("AC-23 unplanned story receives classification before audit write-back", async () => {
  const ctx = fixture(false);
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.complexity).toBe(classified.complexity);
  expect(ctx.story.routing?.reasoning).toBe(classified.reasoning);
  expect(ctx.story.routing?.routerDecision).toMatchObject({ profileId: "native-luna" });
  expect(ctx.story.routing?.routerDecision).not.toHaveProperty("plannedProfileId");
});
test("skipPrdPersistence still attaches the audit without saving", async () => {
  const ctx = fixture();
  ctx.prdPath = "/tmp/router-prd.json";
  ctx.skipPrdPersistence = true;
  await routingStage.execute(ctx);
  expect(ctx.story.routing?.routerDecision?.profileId).toBe("native-luna");
  expect(save).not.toHaveBeenCalled();
});
