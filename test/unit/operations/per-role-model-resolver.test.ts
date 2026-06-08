import { describe, expect, test } from "bun:test";
import { implementerOp } from "@/operations";
import type { UserStory } from "@/prd";

function storyWithTier(tier: string | undefined): UserStory {
  return {
    id: "US-001",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    dependencies: [],
    status: "pending",
    passes: false,
    attempts: 0,
    routing: tier ? { complexity: "medium", modelTier: tier, testStrategy: "tdd-simple", reasoning: "" } : undefined,
  } as unknown as UserStory;
}

const buildCtx = { config: {} as any, packageView: {} as any };

describe("implementerOp.model — routing-driven", () => {
  test("returns the story's initial modelTier", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier("fast") }, buildCtx)).toBe("fast");
  });

  test("follows the escalated tier (escalation mutates story.routing.modelTier)", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier("powerful") }, buildCtx)).toBe("powerful");
  });

  test("returns undefined when routing is absent (callOp then defaults)", () => {
    const resolver = implementerOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({ story: storyWithTier(undefined) }, buildCtx)).toBeUndefined();
  });
});
