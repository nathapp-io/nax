/**
 * Behavioral Guardrails — only the implementer role renders a section.
 *
 * US-004 narrowed `GuardrailRole` to `"implementer"`: the test-writer, verifier,
 * no-test, tdd-simple and batch branches had no caller. The implementer's text
 * is unchanged, and the retired branches are pinned as gone.
 */
import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { GuardrailRole } from "@/prompts/sections/behavioral-guardrails";
import { buildBehavioralGuardrailsSection } from "@/prompts/sections/behavioral-guardrails";

/**
 * Compile-time pin (US-004): the retired roles are out of `GuardrailRole`.
 * While one of them is still in the union the assertion below does not
 * typecheck — `bun run typecheck` is the gate that enforces it. It is also
 * what keeps the retired branches unreachable: a branch for a role the union
 * no longer admits has no caller.
 */
type AssertTrue<T extends true> = T;
type AssertOnlyTheImplementerRoleRemains = AssertTrue<"test-writer" extends GuardrailRole ? false : true>;

const _onlyTheImplementerRoleRemains: AssertOnlyTheImplementerRoleRemains = true;

describe("buildBehavioralGuardrailsSection", () => {
  // AC-2
  test('level="off" returns null for the implementer role', () => {
    expect(buildBehavioralGuardrailsSection("implementer", "off")).toBeNull();
  });

  // AC-1
  test('level="lite" returns a string that starts with "# Behavioral Guardrails"', () => {
    const result = buildBehavioralGuardrailsSection("implementer", "lite");
    assertDefined(result, "guardrails");
    expect(result.startsWith("# Behavioral Guardrails")).toBe(true);
  });

  describe("implementer role", () => {
    test('level="lite": at most 8 lines including the header', () => {
      const result = buildBehavioralGuardrailsSection("implementer", "lite");
      assertDefined(result, "guardrails");
      expect(result.split("\n").length).toBeLessThanOrEqual(8);
    });

    test('level="lite": includes all 5 bullet rules', () => {
      const result = buildBehavioralGuardrailsSection("implementer", "lite");
      assertDefined(result, "guardrails");
      expect(result).toContain("Simplicity");
      expect(result).toContain("Surgical");
      expect(result).toContain("Anti-cheat");
      expect(result).toContain("Orphans");
      expect(result).toContain("Commit");
    });

    test('level="lite": contains none of the retired role rule sets', () => {
      const result = buildBehavioralGuardrailsSection("implementer", "lite");
      assertDefined(result, "guardrails");
      // The retired test-writer rule set.
      expect(result).not.toContain("No tests for behaviors the story does not require");
      // The retired combined (tdd-simple / batch) rule set.
      expect(result).not.toContain("Simplicity (tests)");
      expect(result).not.toContain("Simplicity (source)");
    });

    test('level="strict": includes the "## State Assumptions" subsection', () => {
      const result = buildBehavioralGuardrailsSection("implementer", "strict");
      assertDefined(result, "guardrails");
      expect(result).toContain("## State Assumptions");
    });

    test('level="strict": includes all section headers', () => {
      const result = buildBehavioralGuardrailsSection("implementer", "strict");
      assertDefined(result, "guardrails");
      expect(result).toContain("## Simplicity");
      expect(result).toContain("## Surgical");
      expect(result).toContain("## Anti-cheat");
      expect(result).toContain("## Orphans");
      expect(result).toContain("## Commit");
      expect(result).toContain("## State Assumptions");
    });
  });

  // Pure function: same inputs yield same output
  describe("purity", () => {
    test("returns same output for same inputs", () => {
      const a = buildBehavioralGuardrailsSection("implementer", "strict");
      const b = buildBehavioralGuardrailsSection("implementer", "strict");
      expect(a).toEqual(b);
    });
  });
});
