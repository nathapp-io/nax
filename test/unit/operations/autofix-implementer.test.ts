import { describe, expect, test } from "bun:test";
import { implementerRectifyOp } from "../../../src/operations/autofix-implementer";
import { makeStory } from "../../helpers/mock-story";

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

describe("implementerRectifyOp.parse — mockStructureDeclaration", () => {
  const input = { failedChecks: [], story: makeStory() };
  // biome-ignore lint/suspicious/noExplicitAny: parse only reads .story.id from ctx
  const ctx = { story: makeStory() } as any;

  test("populates mockStructureDeclaration from a mock_structure block", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts, test/bar.test.ts
REASON: Mock dispatch shape mismatch: test expects async but impl returns sync`;

    const out = implementerRectifyOp.parse(output, input, ctx);
    expect(out.mockStructureDeclaration).toBeDefined();
    expect(out.mockStructureDeclaration?.files).toEqual(["test/foo.test.ts", "test/bar.test.ts"]);
    expect(out.mockStructureDeclaration?.reasonDetail).toBe(
      "Mock dispatch shape mismatch: test expects async but impl returns sync",
    );
  });

  test("mock_structure block does not appear in testEditDeclarations (bypasses that flow)", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: test/foo.test.ts
REASON: Dispatch shape changed`;

    const out = implementerRectifyOp.parse(output, input, ctx);
    expect(out.testEditDeclarations.every((d) => d.reason !== "mock_structure")).toBe(true);
  });

  test("mockStructureDeclaration is absent when no mock_structure block is present", () => {
    const output = `TEST_EDIT_REASON: lint_only
FILE: test/foo.spec.ts
FINDING: no-unused-vars
CHANGE: removed unused import`;

    const out = implementerRectifyOp.parse(output, input, ctx);
    expect(out.mockStructureDeclaration).toBeUndefined();
  });
});
