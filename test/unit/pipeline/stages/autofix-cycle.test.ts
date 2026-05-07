import { describe, expect, test } from "bun:test";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { TestEditDeclaration } from "../../../../src/operations";

// We test the strategy builder in isolation. Importing buildAutofixStrategies
// requires it to be exported — Task 6 makes that change.
import { buildAutofixStrategies } from "../../../../src/pipeline/stages/autofix-cycle";

import { makeStory } from "../../../helpers/mock-story";

function makeMinCtx(): PipelineContext {
  // Minimal context: only the fields strategy buildInput / extractApplied read.
  return {
    story: makeStory(),
    config: { quality: { autofix: {} }, review: {} },
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    // biome-ignore lint/suspicious/noExplicitAny: only fields read by buildAutofixStrategies are populated
  } as any;
}

describe("buildAutofixStrategies — implementer strategy", () => {
  test("extractApplied stashes declarations on ctx.testEditDeclarations", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);

    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fn(x: number): void",
        testBefore: "fn()",
        testAfter: "fn(1)",
      },
    ];

    implementer.extractApplied?.(
      { applied: true, testEditDeclarations: declarations },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );

    expect(ctx.testEditDeclarations).toEqual(declarations);
  });

  test("extractApplied appends to existing declarations rather than replacing", () => {
    const ctx = makeMinCtx();
    ctx.testEditDeclarations = [
      { reason: "prd_contract", file: "a.spec.ts", prdQuote: "x", testBefore: "x", testAfter: "x" },
    ];
    const [, implementer] = buildAutofixStrategies(ctx, 3);

    implementer.extractApplied?.(
      {
        applied: true,
        testEditDeclarations: [
          { reason: "prd_contract", file: "b.spec.ts", prdQuote: "y", testBefore: "y", testAfter: "y" },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );

    expect(ctx.testEditDeclarations).toHaveLength(2);
    expect(ctx.testEditDeclarations?.[0].file).toBe("a.spec.ts");
    expect(ctx.testEditDeclarations?.[1].file).toBe("b.spec.ts");
  });

  test("extractApplied is a no-op when output has no declarations", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);
    implementer.extractApplied?.(
      { applied: true, testEditDeclarations: [] },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );
    expect(ctx.testEditDeclarations).toBeUndefined();
  });
});

describe("buildAutofixStrategies — testWriter strategy", () => {
  test("testWriter has maxAttempts: 2 (allow exactly one re-fire)", () => {
    const ctx = makeMinCtx();
    const [testWriter] = buildAutofixStrategies(ctx, 3);
    expect(testWriter.name).toBe("autofix-test-writer");
    expect(testWriter.maxAttempts).toBe(2);
  });
});
