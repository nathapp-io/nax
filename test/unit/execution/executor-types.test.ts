/**
 * buildPreviewRouting — the tier/complexity a story is ANNOUNCED with before its
 * routing stage runs (story.start log, story:started event, status display, dry run).
 *
 * #1575 follow-up: the preview must predict what the routing stage will resolve.
 * It previously read only the persisted modelTier and, failing that, looked up the
 * hardcoded "medium" complexity — so a profile-assigned story was announced at the
 * stale/default tier and executed at the profile's tier.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { buildPreviewRouting } from "@/execution";
import type { UserStory } from "@/prd";

const config = makeNaxConfig({
  autoMode: {
    complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
  },
});

const CUSTOM_LADDER = [
  { tier: "cheap", attempts: 3, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "native" },
  { tier: "balanced", attempts: 2, agent: "claude" },
  { tier: "powerful", attempts: 1, agent: "claude" },
];

function storyWith(routing: Partial<UserStory["routing"]>, escalations: UserStory["escalations"] = []): UserStory {
  return makeStory({
    escalations,
    routing: { complexity: "medium", testStrategy: "test-after", reasoning: "", ...routing },
  });
}

describe("buildPreviewRouting: tier prediction", () => {
  test("announces the profile's tier, not a stale persisted tier (#1575)", () => {
    const story = storyWith({ complexity: "expert", modelTier: "fast", profileModelTier: "balanced" });

    expect(buildPreviewRouting(story, config).modelTier).toBe("balanced");
  });

  test("derives the tier from the story's own complexity when it has no profile", () => {
    const story = storyWith({ complexity: "expert" });

    // Previously "balanced" — the lookup was hardcoded to the "medium" band.
    expect(buildPreviewRouting(story, config).modelTier).toBe("powerful");
  });

  test("keeps an escalated tier so the preview does not walk the story back down", () => {
    const story = storyWith({ complexity: "simple", modelTier: "powerful", profileModelTier: "fast" }, [
      { fromTier: "fast", toTier: "powerful", reason: "budget", timestamp: new Date(0).toISOString() },
    ]);

    expect(buildPreviewRouting(story, config).modelTier).toBe("powerful");
  });

  test("falls back to the default band when the story carries no routing at all", () => {
    const story = makeStory({ routing: undefined });

    const preview = buildPreviewRouting(story, config);
    expect(preview.complexity).toBe("medium");
    expect(preview.modelTier).toBe("balanced");
  });

  test("#1575 parity: preview honours a custom-ladder escalation", () => {
    const ladderConfig = makeNaxConfig({
      autoMode: {
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { tierOrder: CUSTOM_LADDER },
      },
    });
    const story = storyWith(
      {
        complexity: "medium",
        modelTier: "balanced",
        agent: "claude",
        profileModelTier: "cheap",
        initialAgent: "native",
      },
      [{ fromTier: "cheap", toTier: "balanced", reason: "budget", timestamp: new Date(0).toISOString() }],
    );

    const preview = buildPreviewRouting(story, ladderConfig);
    // record wins; a name-ranked or TIER_RANK preview would discard it
    expect(preview.modelTier).toBe("balanced");
  });
});

describe("buildPreviewRouting: passthrough fields", () => {
  test("carries the story's cached complexity and test strategy", () => {
    const story = storyWith({ complexity: "complex", testStrategy: "tdd-simple" });

    const preview = buildPreviewRouting(story, config);
    expect(preview.complexity).toBe("complex");
    expect(preview.testStrategy).toBe("tdd-simple");
  });

  test("marks the reasoning as a preview when the story has never been routed", () => {
    const preview = buildPreviewRouting(makeStory({ routing: undefined }), config);

    expect(preview.reasoning).toContain("preview");
  });
});
