import { describe, expect, test } from "bun:test";
import type { GuardrailRole } from "@/prompts/sections";
import { buildNaxArtifactsSection } from "@/prompts/sections";

// AC-1: buildNaxArtifactsSection for test-writer mentions .nax/ immutability
// AC-2: returns non-null for test-writer
// AC-3: returns non-null for implementer
// AC-4: returns non-null for verifier
// AC-5: a test under .nax/ is not a reason to skip writing source-tree tests
// AC-6: a source-tree test is not a reason to remove a test under .nax/

describe("buildNaxArtifactsSection", () => {
  describe("test-writer role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("test-writer");
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result!.length).toBeGreaterThan(0);
    });

    test("mentions .nax/ files must never be moved, renamed, or deleted", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // The exact phrasing per AC-1: "files under `.nax/` must never be moved, renamed, or deleted".
      expect(result).toContain(".nax/");
      expect(result.toLowerCase()).toContain("moved");
      expect(result.toLowerCase()).toContain("renamed");
      expect(result.toLowerCase()).toContain("deleted");
    });

    test("states that a .nax/ test is not a reason to skip source-tree tests", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // AC-5
      expect(result.toLowerCase()).toContain(".nax/");
      expect(result.toLowerCase()).toMatch(/not.+reason.+skip.+source/);
    });

    test("states that a source-tree test is not a reason to remove a .nax/ test", () => {
      const result = buildNaxArtifactsSection("test-writer") as string;
      // AC-6
      expect(result.toLowerCase()).toMatch(/source.+test.+not.+reason.+remove.+\.nax\//);
    });
  });

  describe("implementer role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("implementer");
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result!.length).toBeGreaterThan(0);
    });
  });

  describe("verifier role", () => {
    test("returns non-null string", () => {
      const result = buildNaxArtifactsSection("verifier");
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result!.length).toBeGreaterThan(0);
    });

    test("verifier also sees the immutability text (AC-4 / story deviation)", () => {
      const result = buildNaxArtifactsSection("verifier") as string;
      expect(result).toContain(".nax/");
      expect(result.toLowerCase()).toMatch(/never.+moved.+renamed.+deleted|moved.+renamed.+or.+deleted/);
    });
  });

  describe("shared content across all roles", () => {
    const roles: GuardrailRole[] = ["test-writer", "implementer", "verifier"];

    test.each(roles)('role="%s": states a .nax/ test is not a reason to skip source-tree tests', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      expect(result.toLowerCase()).toMatch(/not.+reason.+skip/);
    });

    test.each(roles)('role="%s": states a source-tree test is not a reason to remove a .nax/ test', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      expect(result.toLowerCase()).toMatch(/not.+reason.+remove/);
    });

    test.each(roles)('role="%s": mentions immutability of .nax/ artifacts', (role) => {
      const result = buildNaxArtifactsSection(role) as string;
      // Per AC-1: a sentence about files under .nax/ never being moved/renamed/deleted.
      const lower = result.toLowerCase();
      const hasMoved = lower.includes("moved");
      const hasRenamed = lower.includes("renamed");
      const hasDeleted = lower.includes("deleted");
      expect(hasMoved && hasRenamed && hasDeleted).toBe(true);
    });
  });

  describe("purity", () => {
    test("returns same output for same inputs (test-writer)", () => {
      const a = buildNaxArtifactsSection("test-writer");
      const b = buildNaxArtifactsSection("test-writer");
      expect(a).toEqual(b);
    });

    test("returns same output for same inputs (implementer)", () => {
      const a = buildNaxArtifactsSection("implementer");
      const b = buildNaxArtifactsSection("implementer");
      expect(a).toEqual(b);
    });

    test("returns same output for same inputs (verifier)", () => {
      const a = buildNaxArtifactsSection("verifier");
      const b = buildNaxArtifactsSection("verifier");
      expect(a).toEqual(b);
    });
  });
});
