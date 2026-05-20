import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "../../../src/config/schemas-review";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { assemblePlanInputsFromCtx } from "../../../src/execution/plan-inputs";
import type { NaxConfig } from "../../../src/config/schema";

const DEFAULT_ADVERSARIAL = AdversarialReviewConfigSchema.parse({});

function makeCtx(configOverride: Partial<NaxConfig> = {}) {
  const config: NaxConfig = {
    ...DEFAULT_CONFIG,
    ...configOverride,
    execution: {
      ...DEFAULT_CONFIG.execution,
      ...(configOverride.execution ?? {}),
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...(configOverride.review ?? {}),
    },
  } as NaxConfig;
  return {
    story: { id: "S1", title: "T", workdir: "" },
    config,
    workdir: "/tmp/repo",
    routing: { testStrategy: "three-session-tdd", agent: "claude" },
    prompt: "ctx",
    featureContextMarkdown: "feat",
    constitution: { content: "" },
    prd: { feature: "f" },
    projectDir: "/tmp/proj",
  } as any;
}

describe("assemblePlanInputsFromCtx — review + rectification wiring", () => {
  test("populates semanticReview when inlineReview && checks includes 'semantic'", async () => {
    const ctx = makeCtx({
      execution: { ...DEFAULT_CONFIG.execution, inlineReview: true },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.semanticReview).toBeDefined();
  });

  test("populates adversarialReview when inlineReview && checks includes 'adversarial'", async () => {
    const ctx = makeCtx({
      execution: { ...DEFAULT_CONFIG.execution, inlineReview: true },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["adversarial"],
        adversarial: DEFAULT_ADVERSARIAL,
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.adversarialReview).toBeDefined();
  });

  test("populates rectification when inlineReview && rectification.enabled", async () => {
    const ctx = makeCtx({
      execution: {
        ...DEFAULT_CONFIG.execution,
        inlineReview: true,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: true, maxRetries: 2 },
      },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.rectification).toBeDefined();
    expect(inputs.rectification!.maxAttempts).toBe(2);
  });

  test("leaves review/rectification undefined when inlineReview is false (default)", async () => {
    const ctx = makeCtx({
      execution: { ...DEFAULT_CONFIG.execution, inlineReview: false },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.semanticReview).toBeUndefined();
    expect(inputs.adversarialReview).toBeUndefined();
    expect(inputs.rectification).toBeUndefined();
  });
});
