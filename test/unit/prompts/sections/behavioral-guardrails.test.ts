import { describe, expect, test } from "bun:test";
import type { GuardrailLevel, GuardrailRole } from "@/prompts/sections/behavioral-guardrails";
import { buildBehavioralGuardrailsSection } from "@/prompts/sections/behavioral-guardrails";

// AC-11: exports exist (verified by the imports above compiling)

describe("buildBehavioralGuardrailsSection", () => {
  // AC-12: returns null when level === "off" regardless of role
  describe("level === off", () => {
    const roles: GuardrailRole[] = [
      "implementer",
      "test-writer",
      "single-session",
      "tdd-simple",
      "batch",
      "verifier",
      "no-test",
    ];
    test.each(roles)('returns null for role="%s" when level=off', (role) => {
      expect(buildBehavioralGuardrailsSection(role, "off")).toBeNull();
    });
  });

  // AC-13: returns null when role === "verifier" or role === "no-test"
  describe("null roles", () => {
    const nullRoles: GuardrailRole[] = ["verifier", "no-test"];
    const levels: GuardrailLevel[] = ["lite", "strict"];

    test.each(nullRoles.flatMap((role) => levels.map((level) => [role, level] as const)))(
      'returns null for role="%s" level="%s"',
      (role, level) => {
        expect(buildBehavioralGuardrailsSection(role, level)).toBeNull();
      },
    );
  });

  // AC-14: lite content for implementer roles — at most 8 lines including header
  describe("lite level for implementer roles", () => {
    const implRoles: GuardrailRole[] = ["implementer", "single-session", "tdd-simple", "batch"];

    test.each(implRoles)('role="%s" lite: returns string with header', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "lite");
      expect(result).not.toBeNull();
      expect(result).toContain("# Behavioral Guardrails");
    });

    test.each(implRoles)('role="%s" lite: ≤8 lines', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "lite") as string;
      const lines = result.split("\n");
      expect(lines.length).toBeLessThanOrEqual(8);
    });

    test.each(implRoles)('role="%s" lite: includes all 5 bullet rules', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "lite") as string;
      expect(result).toContain("Simplicity");
      expect(result).toContain("Surgical");
      expect(result).toContain("Anti-cheat");
      expect(result).toContain("Orphans");
      expect(result).toContain("Commit");
    });
  });

  // AC-15: strict content includes "## State Assumptions" subsection for implementer roles
  describe("strict level for implementer roles", () => {
    const implRoles: GuardrailRole[] = ["implementer", "single-session", "tdd-simple", "batch"];

    test.each(implRoles)('role="%s" strict: includes ## State Assumptions', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "strict");
      expect(result).not.toBeNull();
      expect(result).toContain("## State Assumptions");
    });

    test.each(implRoles)('role="%s" strict: includes all section headers', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "strict") as string;
      expect(result).toContain("## Simplicity");
      expect(result).toContain("## Surgical");
      expect(result).toContain("## Anti-cheat");
      expect(result).toContain("## Orphans");
      expect(result).toContain("## Commit");
      expect(result).toContain("## State Assumptions");
    });
  });

  // AC-16: test-writer role — both lite and strict
  describe("role === test-writer", () => {
    test("lite: does NOT include Anti-cheat rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).not.toContain("Anti-cheat");
    });

    test("lite: does NOT include Orphans rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).not.toContain("Orphans");
    });

    test("lite: does NOT include Commit rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).not.toContain("Commit");
    });

    test("lite: DOES include Simplicity (test scope)", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).toContain("Simplicity");
    });

    test("lite: DOES include Surgical (don't touch src)", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).toContain("Surgical");
    });

    test("strict: does NOT include Anti-cheat rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).not.toContain("Anti-cheat");
    });

    test("strict: does NOT include Orphans rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).not.toContain("Orphans");
    });

    test("strict: does NOT include Commit rule", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).not.toContain("Commit");
    });

    test("strict: DOES include Simplicity (test scope)", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).toContain("Simplicity");
    });

    test("strict: DOES include Surgical (don't touch src)", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).toContain("Surgical");
    });

    test("strict: adds State Assumptions bullet", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "strict") as string;
      expect(result).toContain("State Assumptions");
    });

    test("lite: does not include State Assumptions", () => {
      const result = buildBehavioralGuardrailsSection("test-writer", "lite") as string;
      expect(result).not.toContain("State Assumptions");
    });
  });

  // Combined roles (single-session, tdd-simple, batch) write both tests and source —
  // their guardrails must include both test-scope AND source-scope Simplicity rules.
  describe("combined roles include both test-scope and source-scope Simplicity", () => {
    const combinedRoles: GuardrailRole[] = ["single-session", "tdd-simple", "batch"];

    test.each(combinedRoles)('role="%s" lite: includes test-scope Simplicity', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "lite") as string;
      expect(result).toContain("Simplicity (tests)");
    });

    test.each(combinedRoles)('role="%s" lite: includes source-scope Simplicity', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "lite") as string;
      expect(result).toContain("Simplicity (source)");
    });

    test.each(combinedRoles)('role="%s" strict: includes test-scope Simplicity', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "strict") as string;
      expect(result).toContain("## Simplicity (Tests)");
    });

    test.each(combinedRoles)('role="%s" strict: includes source-scope Simplicity', (role) => {
      const result = buildBehavioralGuardrailsSection(role, "strict") as string;
      expect(result).toContain("## Simplicity (Source)");
    });

    test("pure implementer lite: does NOT include test-scope Simplicity", () => {
      const result = buildBehavioralGuardrailsSection("implementer", "lite") as string;
      expect(result).not.toContain("Simplicity (tests)");
      expect(result).not.toContain("Simplicity (source)");
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
