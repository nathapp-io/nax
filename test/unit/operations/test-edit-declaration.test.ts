import { describe, expect, test } from "bun:test";
import { parseTestEditDeclarations, validatePrdQuote } from "@/operations";
import { makeStory } from "@test/helpers";

describe("parseTestEditDeclarations", () => {
  test("parses a single prd_contract block", () => {
    const output = `Some preamble.

TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "getChangeImpact(repoId: string, sha: string): Promise<ImpactReport>"
FILE: apps/api/test/unit/code-intel/impact-analysis.service.spec.ts
TEST_BEFORE: service.getChangeImpact(repoId)
TEST_AFTER: service.getChangeImpact(repoId, sha)

Trailing prose.`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual({
      reason: "prd_contract",
      file: "apps/api/test/unit/code-intel/impact-analysis.service.spec.ts",
      prdQuote: 'getChangeImpact(repoId: string, sha: string): Promise<ImpactReport>',
      testBefore: "service.getChangeImpact(repoId)",
      testAfter: "service.getChangeImpact(repoId, sha)",
    });
  });

  test("parses a single lint_only block", () => {
    const output = `TEST_EDIT_REASON: lint_only
FILE: apps/api/test/unit/foo.spec.ts
FINDING: no-non-null-assertion
CHANGE: foo!.bar → foo?.bar`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual({
      reason: "lint_only",
      file: "apps/api/test/unit/foo.spec.ts",
      finding: "no-non-null-assertion",
    });
  });

  test("parses a single sibling_scope block", () => {
    const output = `TEST_EDIT_REASON: sibling_scope
SIBLING_FILE: apps/api/test/unit/other.spec.ts
FINDING: TS2304 cannot find name 'X'`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual({
      reason: "sibling_scope",
      file: "apps/api/test/unit/other.spec.ts",
      finding: "TS2304 cannot find name 'X'",
    });
  });

  test("parses two prd_contract blocks in one output", () => {
    const output = `TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "fnA(): void"
FILE: a.spec.ts
TEST_BEFORE: fnA(x)
TEST_AFTER: fnA()

middle text

TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "fnB(x: number): void"
FILE: b.spec.ts
TEST_BEFORE: fnB()
TEST_AFTER: fnB(1)`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(2);
    expect(declarations[0].file).toBe("a.spec.ts");
    expect(declarations[1].file).toBe("b.spec.ts");
  });

  test("returns empty array when no declarations are present", () => {
    expect(parseTestEditDeclarations("plain output, no escape valve invoked")).toEqual([]);
  });

  test("ignores malformed blocks missing FILE", () => {
    const output = `TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "fn(): void"
TEST_BEFORE: fn()
TEST_AFTER: fn()`;

    expect(parseTestEditDeclarations(output)).toEqual([]);
  });

  test("ignores blocks with unknown reason", () => {
    const output = `TEST_EDIT_REASON: gibberish
FILE: foo.ts`;

    expect(parseTestEditDeclarations(output)).toEqual([]);
  });

  test("parses a single mock_structure block", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: a.test.ts, b.test.ts
REASON: The old mock uses callService but the new code dispatches via eventBus.`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual({
      reason: "mock_structure",
      file: "a.test.ts",
      files: ["a.test.ts", "b.test.ts"],
      reasonDetail: "The old mock uses callService but the new code dispatches via eventBus.",
    });
  });

  test("sets file to first entry in FILES for mock_structure", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: first.test.ts, second.test.ts, third.test.ts
REASON: Structural rewrite required.`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations[0].file).toBe("first.test.ts");
    expect(declarations[0].files).toHaveLength(3);
  });

  test.each([
    ["empty FILES", "TEST_EDIT_REASON: mock_structure\nFILES:\nREASON: Some reason."],
    ["missing FILES field", "TEST_EDIT_REASON: mock_structure\nREASON: Some reason."],
    ["empty REASON", "TEST_EDIT_REASON: mock_structure\nFILES: a.test.ts\nREASON:"],
    ["missing REASON field", "TEST_EDIT_REASON: mock_structure\nFILES: a.test.ts"],
  ])("ignores mock_structure block with %s", (_label, output) => {
    expect(parseTestEditDeclarations(output)).toEqual([]);
  });

  test("trims whitespace around commas in FILES", () => {
    const output = `TEST_EDIT_REASON: mock_structure
FILES: a.test.ts , b.test.ts , c.test.ts
REASON: Some reason.`;

    const declarations = parseTestEditDeclarations(output);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].files).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });
});

describe("validatePrdQuote", () => {
  test.each<[string, ReturnType<typeof makeStory>, string]>([
    ["verbatim in description", makeStory({ description: "Implement getChangeImpact(repoId: string, sha: string): Promise<ImpactReport>" }), "getChangeImpact(repoId: string, sha: string): Promise<ImpactReport>"],
    ["in acceptance criterion", makeStory({ acceptanceCriteria: ["AC-1: API exposes `fnA(x: number): void`", "AC-2: returns void"] }), "fnA(x: number): void"],
  ])("returns true when quote appears %s", (_label, story, quote) => {
    expect(validatePrdQuote(quote, story)).toBe(true);
  });

  test("normalises whitespace before matching", () => {
    const story = makeStory({
      description: "fn(  a:   string ,  b:   number ): void",
    });
    expect(validatePrdQuote("fn(a: string, b: number): void", story)).toBe(true);
  });

  test.each<[string, ReturnType<typeof makeStory>, string]>([
    ["fabricated quote", makeStory({ description: "fnA(): void", acceptanceCriteria: ["AC-1: API does X"] }), "fnB(y: string): boolean"],
    ["empty quote", makeStory(), ""],
  ])("returns false when %s", (_label, story, quote) => {
    expect(validatePrdQuote(quote, story)).toBe(false);
  });
});
