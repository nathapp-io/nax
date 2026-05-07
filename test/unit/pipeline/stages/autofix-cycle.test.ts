import { describe, expect, test } from "bun:test";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { TestEditDeclaration } from "../../../../src/operations";
import type { Finding } from "../../../../src/findings";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { runAgentRectificationV2, buildAutofixStrategies, applyTestEditDeclarations } from "../../../../src/pipeline/stages/autofix-cycle";

import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../../helpers";

function makeMinCtx(): PipelineContext {
  return {
    story: makeStory(),
    config: makeNaxConfig(),
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    agentManager: makeMockAgentManager(),
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

describe("applyTestEditDeclarations", () => {
  function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "uses unsafe cast",
      file: "src/foo.ts",
      fixTarget: "source",
      ...overrides,
    };
  }

  test("re-tags matching source findings to fixTarget=test on valid prd_contract", () => {
    const story = makeStory({
      description: "fnA(x: number): void must be exposed",
    });
    const findings: Finding[] = [
      makeFinding({ file: "test/foo.spec.ts", message: "test calls fnA() without arg" }),
      makeFinding({ file: "src/bar.ts", message: "unrelated" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fnA(x: number): void",
        testBefore: "fnA()",
        testAfter: "fnA(1)",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    expect(out).toHaveLength(2);
    expect(out[0].fixTarget).toBe("test");
    expect(out[0].file).toBe("test/foo.spec.ts");
    expect(out[1].fixTarget).toBe("source");
  });

  test("emits a prd_quote_mismatch finding when quote is not in story", () => {
    const story = makeStory({ description: "Real story text" });
    const findings: Finding[] = [
      makeFinding({ file: "test/foo.spec.ts" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fabricated(x): void",
        testBefore: "x",
        testAfter: "y",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    // Original finding is left source-tagged
    expect(out[0].fixTarget).toBe("source");
    // A new advisory finding is appended
    const mismatch = out.find((f) => f.category === "prd_quote_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.source).toBe("adversarial-review");
    expect(mismatch?.message).toContain("fabricated(x): void");
  });

  test("ignores lint_only and sibling_scope declarations (no re-tagging)", () => {
    const story = makeStory();
    const findings: Finding[] = [makeFinding({ file: "test/foo.spec.ts" })];
    const declarations: TestEditDeclaration[] = [
      { reason: "lint_only", file: "test/foo.spec.ts", finding: "no-x" },
      { reason: "sibling_scope", file: "test/foo.spec.ts", finding: "TS2304" },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    expect(out).toHaveLength(1);
    expect(out[0].fixTarget).toBe("source");
  });

  test("no-op on empty declarations", () => {
    const story = makeStory();
    const findings: Finding[] = [makeFinding()];
    expect(applyTestEditDeclarations(findings, [], story)).toEqual(findings);
  });

  test("drops a prd_contract declaration whose FILE matches no current finding", () => {
    const story = makeStory({ description: "fn(): void" });
    const findings: Finding[] = [makeFinding({ file: "test/other.spec.ts" })];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/missing.spec.ts",
        prdQuote: "fn(): void",
        testBefore: "x",
        testAfter: "y",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    // No re-tagging, no mismatch finding
    expect(out).toHaveLength(1);
    expect(out[0].fixTarget).toBe("source");
  });
});

describe("runAgentRectificationV2 — declaration consumption", () => {
  test("preserves testEditDeclarations when no findings present (validate never fires)", async () => {
    const ctx: PipelineContext = {
      ...makeMinCtx(),
      runtime: {
        packages: { repo: () => ({}) },
        outputDir: "/tmp/out",
        // biome-ignore lint/suspicious/noExplicitAny: minimal runtime stub
      } as any,
      prd: { feature: "f" } as any,
    };
    ctx.testEditDeclarations = [
      { reason: "prd_contract", file: "test/foo.spec.ts", prdQuote: "x", testBefore: "y", testAfter: "z" },
    ];
    // No findings → cycle exits immediately; validate() is never called, so
    // the side-channel is NOT cleared (consumed on next pipeline retry).
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    try {
      await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");
    } finally {
      Object.assign(_autofixDeps, saved);
    }

    expect(ctx.autofixPriorIterations).toBeDefined();
    // Side-channel still present — validate() never ran to consume it.
    expect(ctx.testEditDeclarations).toHaveLength(1);
  });
});
