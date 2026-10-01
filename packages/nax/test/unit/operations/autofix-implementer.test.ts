import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeNaxConfig, makeStory, makeTestRuntime, opModelResolver } from "@test/helpers";
import { autofixConfigSelector } from "@/config";
import type { AutofixConfig } from "@/config/selectors";
import { implementerRectifyOp, makeAutofixImplementerStrategy, makeDeclarationSink } from "@/operations";
import type { BuildContext } from "@/operations/types";

function makeBuildCtx(): BuildContext<AutofixConfig> {
  const view = makeTestRuntime().packages.repo();
  return { packageView: view, config: view.select(autofixConfigSelector) };
}

describe("implementerRectifyOp.parse", () => {
  const input = { failedChecks: [], story: makeStory() };
  const ctx = makeBuildCtx();

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

describe("implementerRectifyOp.model", () => {
  test("the rectifier runs at the story's escalated tier, not a hardcoded balanced", () => {
    const story = makeStory({
      routing: { complexity: "simple", modelTier: "powerful", testStrategy: "tdd-simple", reasoning: "" },
    });

    expect(opModelResolver(implementerRectifyOp)({ failedChecks: [], story }, makeBuildCtx())).toBe("powerful");
  });

  test("the rectifier honours a profile's literal pin", () => {
    const story = makeStory({
      routing: {
        complexity: "simple",
        agent: "native",
        profileModelPin: "openai-codex/gpt-5.6-terra",
        modelTier: "balanced",
        testStrategy: "tdd-simple",
        reasoning: "",
      },
    });

    expect(opModelResolver(implementerRectifyOp)({ failedChecks: [], story }, makeBuildCtx())).toEqual({
      agent: "native",
      model: "openai-codex/gpt-5.6-terra",
    });
  });
});

/**
 * AC4: IMPLEMENTER_SOURCES includes "tdd-verifier"
 *
 * Verifies that:
 * - appliesTo returns true for a tdd-verifier finding with fixTarget=source
 * - appliesTo returns false for a tdd-verifier finding with fixTarget=test
 * - The source file contains exactly the canonical IMPLEMENTER_SOURCES line
 */
const BASE = join(import.meta.dir, "../../../src/operations");

function makeTddVerifierFinding(fixTarget: "source" | "test") {
  return {
    source: "tdd-verifier" as const,
    severity: "error" as const,
    category: "tests-failed",
    message: "2 test(s) failed",
    fixTarget,
  };
}

describe("AC4: IMPLEMENTER_SOURCES includes tdd-verifier", () => {
  test("AC4: appliesTo returns true for tdd-verifier finding with fixTarget=source", async () => {
    const story = makeStory({ id: "US-001" });
    const strategy = makeAutofixImplementerStrategy(story, makeNaxConfig(), makeDeclarationSink());

    expect(strategy.appliesTo(makeTddVerifierFinding("source"))).toBe(true);
  });

  test("AC4: appliesTo returns false for tdd-verifier finding with fixTarget=test (not implementer territory)", async () => {
    const story = makeStory({ id: "US-001" });
    const strategy = makeAutofixImplementerStrategy(story, makeNaxConfig(), makeDeclarationSink());

    // fixTarget=test routes to autofix-test-writer, not implementer
    expect(strategy.appliesTo(makeTddVerifierFinding("test"))).toBe(false);
  });

  test("AC4: source file contains exactly one IMPLEMENTER_SOURCES line with tdd-verifier", async () => {
    const file = Bun.file(join(BASE, "autofix-implementer-strategy.ts"));
    const content = await file.text();
    const matches = content
      .split("\n")
      .filter((line) =>
        /^const IMPLEMENTER_SOURCES = new Set\(\["lint", "typecheck", "semantic-review", "tdd-verifier"\]\);$/.test(
          line,
        ),
      );
    expect(matches.length).toBe(1);
  });
});
