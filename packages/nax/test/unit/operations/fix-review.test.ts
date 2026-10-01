/**
 * US-003 — `fixReviewOp` (src/operations/fix-review.ts).
 *
 * The operation half of the scoped fix review: a verdict-only op whose session
 * is a fresh `reviewer-fix`, whose model is the fix review's own resolution
 * chain, and whose `parse` turns a response into a typed `FixReviewOpOutput`
 * (`parsed: false` + preview when there is no JSON object).
 *
 * Assertions are on the op's runtime behaviour — the context it is handed is a
 * real `BuildContext` projected through `opSelector`, so AC9 exercises the same
 * config slice `callOp` would hand the op.
 */
import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime, opSelector } from "@test/helpers";
import type { ConfiguredModel } from "@/config";
import { type FixReviewOpInput, fixReviewOp } from "@/operations";
import { resolveFixReviewModel } from "@/review/fix-review";

interface ModelOverrides {
  readonly fixReviewModel?: ConfiguredModel;
  readonly semanticModel?: ConfiguredModel;
}

/**
 * A real `BuildContext` for the op: the config slice comes from the runtime's
 * own selector projection, exactly as `callOp` builds it.
 */
function makeCtx(overrides: ModelOverrides = {}) {
  const config = makeNaxConfig({
    review: {
      fixReview: { model: overrides.fixReviewModel },
      semantic: { model: overrides.semanticModel ?? "fast" },
    },
  });
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(fixReviewOp.config)) };
}

const input: FixReviewOpInput = {
  story: makeStory({ id: "US-003", acceptanceCriteria: ["AC one"], description: "Design prose." }),
  diff: "diff --git a/src/a.ts b/src/a.ts\n+const guard = 1;\n",
  findings: [],
};

/** The op's model selector, narrowed from `ConfiguredModel | resolver`. */
function resolveModel(ctx: ReturnType<typeof makeCtx>): ConfiguredModel | undefined {
  return typeof fixReviewOp.model === "function" ? fixReviewOp.model(input, ctx) : fixReviewOp.model;
}

describe("fixReviewOp.parse (US-003 AC6)", () => {
  test("US-003 AC6: keeps the verdict's reason, acIndex and file", () => {
    const result = fixReviewOp.parse('{"passed":false,"reason":"r","acIndex":4,"file":"src/a.ts"}', input, makeCtx());

    expect(result).toEqual({ parsed: true, passed: false, reason: "r", acIndex: 4, file: "src/a.ts" });
  });

  test("US-003 AC6 boundary: a pass verdict carries no acIndex or file", () => {
    const result = fixReviewOp.parse('{"passed":true,"reason":"no contradiction"}', input, makeCtx());

    expect(result).toEqual({ parsed: true, passed: true, reason: "no contradiction" });
  });
});

describe("fixReviewOp.parse (US-003 AC7)", () => {
  test("US-003 AC7: a response with no JSON object is unparsed with a preview of the output", () => {
    const result = fixReviewOp.parse(
      "I read the diff and everything looks consistent with the story.",
      input,
      makeCtx(),
    );
    const preview = result.parsed ? null : result.unparsedPreview;

    expect(result.parsed).toBe(false);
    expect(preview).toBeTruthy();
  });

  test("US-003 AC7 boundary: a whitespace-only response is unparsed rather than passed", () => {
    const result = fixReviewOp.parse("  \n\t ", input, makeCtx());

    expect(result.parsed).toBe(false);
  });
});

describe("fixReviewOp.session (US-003 AC8)", () => {
  test("US-003 AC8: opens a fresh reviewer-fix session", () => {
    expect(fixReviewOp.session).toEqual({ role: "reviewer-fix", lifetime: "fresh" });
  });
});

describe("fixReviewOp.model (US-003 AC9)", () => {
  test("US-003 AC9: resolves through resolveFixReviewModel(ctx.config.review)", () => {
    const ctx = makeCtx({ fixReviewModel: "powerful", semanticModel: "fast" });

    expect(resolveModel(ctx)).toBe(resolveFixReviewModel(ctx.config.review));
    expect(resolveModel(ctx)).toBe("powerful");
  });

  test("US-003 AC9 boundary: an unset fixReview.model falls back to the semantic reviewer's model", () => {
    const ctx = makeCtx({ semanticModel: "powerful" });

    expect(resolveModel(ctx)).toBe(resolveFixReviewModel(ctx.config.review));
    expect(resolveModel(ctx)).toBe("powerful");
  });
});
