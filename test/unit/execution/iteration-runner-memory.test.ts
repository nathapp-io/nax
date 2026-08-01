import { describe, expect, test } from "bun:test";
import { releaseHeavyPipelineContext } from "@/execution";
import type { PipelineContext } from "@/pipeline/types";

describe("releaseHeavyPipelineContext", () => {
  test("drops per-story payloads without clearing durable execution state", () => {
    const largeText = "payload".repeat(1_000);
    const ctx = {
      prd: { feature: "memory-fix" },
      story: { id: "US-001" },
      agentResult: { output: largeText },
      prompt: largeText,
      contextMarkdown: largeText,
      featureContextMarkdown: largeText,
      builtContext: { markdown: largeText },
      contextBundle: { pushMarkdown: largeText },
      constitution: { content: largeText },
      acceptanceFailures: { failedACs: [], findings: [], testOutput: largeText },
      autofixPriorIterations: [{ feedback: largeText }],
      reviewFindings: [{ message: largeText }],
      selfVerification: { evidence: largeText },
      tddIsolations: { implementer: { output: largeText } },
    } as unknown as PipelineContext;
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
    expect(ctx.autofixPriorIterations).toBeUndefined();
    expect(ctx.reviewFindings).toBeUndefined();
    expect(ctx.selfVerification).toBeUndefined();
    expect(ctx.tddIsolations).toBeUndefined();
    expect(ctx.prd).toBe(prd);
    expect(ctx.story).toBe(story);
  });
});
