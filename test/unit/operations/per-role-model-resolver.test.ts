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

import { testWriterOp } from "@/operations";

function tddBuildCtx(sessionTiers?: Record<string, unknown>) {
  return { config: { tdd: { sessionTiers } }, packageView: {} as any };
}

describe("testWriterOp.model — tdd.sessionTiers.testWriter", () => {
  test("returns the configured testWriter tier", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: "fast" }))).toBe("fast");
  });

  test("passes a ConfiguredModel object through unchanged", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: { agent: "claude", model: "haiku" } }))).toEqual({
      agent: "claude",
      model: "haiku",
    });
  });

  test("returns undefined when sessionTiers is absent (callOp then defaults)", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});

import { verifierOp } from "@/operations";

describe("verifierOp.model — tdd.sessionTiers.verifier", () => {
  test("returns the configured verifier tier", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ verifier: "fast" }))).toBe("fast");
  });

  test("returns undefined when sessionTiers is absent", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});
