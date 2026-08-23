/**
 * AC4: IMPLEMENTER_SOURCES includes "tdd-verifier"
 *
 * Verifies that:
 * - appliesTo returns true for a tdd-verifier finding with fixTarget=source
 * - appliesTo returns false for a tdd-verifier finding with fixTarget=test
 * - The source file contains exactly the canonical IMPLEMENTER_SOURCES line
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

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
    const { makeAutofixImplementerStrategy, makeDeclarationSink } = await import("@/operations");
    const { makeNaxConfig } = await import("@test/helpers");

    const story = { id: "US-001" } as never;
    const strategy = makeAutofixImplementerStrategy(story, makeNaxConfig(), makeDeclarationSink());

    expect(strategy.appliesTo(makeTddVerifierFinding("source"))).toBe(true);
  });

  test("AC4: appliesTo returns false for tdd-verifier finding with fixTarget=test (not implementer territory)", async () => {
    const { makeAutofixImplementerStrategy, makeDeclarationSink } = await import("@/operations");
    const { makeNaxConfig } = await import("@test/helpers");

    const story = { id: "US-001" } as never;
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
