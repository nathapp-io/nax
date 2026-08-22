import { describe, expect, test } from "bun:test";
import { implementerRectifyOp } from "@/operations";
import { makeStory } from "@test/helpers";

describe("implementerRectifyOp.parse", () => {
  const input = { failedChecks: [], story: makeStory() };
  // biome-ignore lint/suspicious/noExplicitAny: parse only reads .story.id from ctx
  const ctx = { story: makeStory() } as any;

  test("returns applied=true with empty declarations on plain output", () => {
    const out = implementerRectifyOp.parse("ok, fixed", input, ctx);
    expect(out.applied).toBe(true);
    expect(out.testEditDeclarations).toEqual([]);
    expect(out.unresolvedReason).toBeUndefined();
  });

  test("populates testEditDeclarations from a prd_contract block", () => {
    const output = `TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "fn(x: number): void"
FILE: test/foo.spec.ts
TEST_BEFORE: fn()
TEST_AFTER: fn(1)`;

    const out = implementerRectifyOp.parse(output, input, ctx);
    expect(out.testEditDeclarations).toHaveLength(1);
    expect(out.testEditDeclarations?.[0].reason).toBe("prd_contract");
    expect(out.testEditDeclarations?.[0].file).toBe("test/foo.spec.ts");
  });

  test("preserves unresolvedReason alongside declarations", () => {
    const output = `Some text.

UNRESOLVED: contradictory findings A and B

TEST_EDIT_REASON: lint_only
FILE: test/foo.spec.ts
FINDING: no-non-null-assertion
CHANGE: a! → a?`;

    const out = implementerRectifyOp.parse(output, input, ctx);
    expect(out.unresolvedReason).toBe("contradictory findings A and B");
    expect(out.testEditDeclarations).toHaveLength(1);
  });
});
