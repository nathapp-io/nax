import { describe, expect, test } from "bun:test";
import { parseTestEditDeclarations } from "../../../src/operations/test-edit-declaration";

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
});
