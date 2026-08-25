import { describe, expect, test } from "bun:test";
import { releaseHeavyPipelineContext } from "@/execution";
import { makeAgentResult, makeContextBundle, makeFinding, makePRD, makeStory, makeTestContext } from "@test/helpers";

describe("releaseHeavyPipelineContext", () => {
  test("drops per-story payloads without clearing durable execution state", () => {
    const largeText = "payload".repeat(1_000);
    const initialStory = makeStory({ id: "US-001" });
    const ctx = makeTestContext({
      prd: makePRD({ feature: "memory-fix", userStories: [initialStory] }),
      story: initialStory,
      agentResult: makeAgentResult({ output: largeText }),
      prompt: largeText,
      contextMarkdown: largeText,
      featureContextMarkdown: largeText,
      builtContext: { elements: [], totalTokens: 0, truncated: false, summary: largeText },
      contextBundle: makeContextBundle({ pushMarkdown: largeText }),
      constitution: { content: largeText, tokens: 0, truncated: false },
      acceptanceFailures: { failedACs: [], findings: [], testOutput: largeText },
      reviewFindings: [makeFinding({ message: largeText })],
      selfVerification: { lint: "pass", typecheck: "pass", preExistingFailures: [], rawMarker: largeText },
      tddIsolations: { implementer: { passed: true, violations: [] } },
    });
    const prd = ctx.prd;
    const story = ctx.story;

    releaseHeavyPipelineContext(ctx);

    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.prompt).toBeUndefined();
    expect(ctx.contextMarkdown).toBeUndefined();
    expect(ctx.featureContextMarkdown).toBeUndefined();
    expect(ctx.builtContext).toBeUndefined();
    expect(ctx.contextBundle).toBeUndefined();
    expect(ctx.constitution).toBeUndefined();
    expect(ctx.acceptanceFailures).toBeUndefined();
    expect(ctx.reviewFindings).toBeUndefined();
    expect(ctx.selfVerification).toBeUndefined();
    expect(ctx.tddIsolations).toBeUndefined();
    expect(ctx.prd).toBe(prd);
    expect(ctx.story).toBe(story);
  });
});
