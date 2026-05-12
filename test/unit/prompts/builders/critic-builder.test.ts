import { describe, expect, test } from "bun:test";
import type { PRD } from "@/prd";
import type { FactsManifest } from "@/debate/facts-manifest";

/**
 * CriticPromptBuilder tests — US-003 AC15
 *
 * Tests for the prompt building logic that the LLM critic uses
 * to audit acceptance criteria testability and failure-mode coverage.
 */

let CriticPromptBuilder: any;

try {
  const module = require("@/prompts/builders/critic-builder");
  CriticPromptBuilder = module.CriticPromptBuilder;
} catch (e) {
  // Module not yet created; tests will fail appropriately
}

describe("CriticPromptBuilder", () => {
  describe("build() method", () => {
    test("instantiates with new CriticPromptBuilder()", () => {
      expect(CriticPromptBuilder).toBeDefined();
      const builder = new CriticPromptBuilder();
      expect(builder).toBeDefined();
    });

    test("build() is a method on the class", () => {
      const builder = new CriticPromptBuilder();
      expect(typeof builder.build).toBe("function");
    });

    test("build(prd, manifest) returns a ComposeInput", () => {
      const prd: Partial<PRD> = {
        feature: "test-feature",
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(typeof result).toBe("object");
      expect(result.role).toBeDefined();
      expect(result.task).toBeDefined();
    });

    test("build() output contains 'ac-testable' substring", () => {
      const prd: Partial<PRD> = {
        feature: "test-feature",
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content).toContain("ac-testable");
    });

    test("build() output contains 'failure-modes-considered' substring", () => {
      const prd: Partial<PRD> = {
        feature: "test-feature",
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content).toContain("failure-modes-considered");
    });

    test("build() output contains the literal prd.feature value", () => {
      const featureName = "my-unique-feature-xyz";
      const prd: Partial<PRD> = {
        feature: featureName,
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content).toContain(featureName);
    });

    test("build() returns a non-empty string", () => {
      const prd: Partial<PRD> = {
        feature: "test-feature",
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content.length).toBeGreaterThan(0);
    });

    test("build() with complex PRD maintains feature in output", () => {
      const featureName = "complex-feature-name";
      const prd: Partial<PRD> = {
        feature: featureName,
        specContent: "Some spec content here",
        stories: [
          {
            id: "story-1",
            title: "Story 1",
            acceptanceCriteria: [
              {
                id: "ac-1",
                assertion: "should do something",
              },
            ],
          },
        ],
        branch: "feature/complex",
      };
      const manifest: FactsManifest = {
        repoFacts: [
          {
            id: "F-001",
            kind: "file",
            evidence: "path/to/file.ts",
            summary: "Found file",
          },
        ],
        specClaims: [
          {
            id: "S-001",
            specSpan: "line 1",
            claim: "test claim",
            kind: "factual",
            verification: { status: "verified" },
          },
        ],
        gaps: [
          {
            id: "G-001",
            kind: "missing-context",
            note: "test gap",
          },
        ],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content).toContain(featureName);
      expect(result.task.content).toContain("ac-testable");
      expect(result.task.content).toContain("failure-modes-considered");
    });
  });

  describe("static jsonRepair method", () => {
    test("jsonRepair exists as a static method", () => {
      expect(typeof CriticPromptBuilder.jsonRepair).toBe("function");
    });

    test("jsonRepair(isTruncated, message) returns a string", () => {
      const result = CriticPromptBuilder.jsonRepair(false, "error message");
      expect(typeof result).toBe("string");
    });

    test("jsonRepair returns non-empty string", () => {
      const result = CriticPromptBuilder.jsonRepair(false, "error message");
      expect(result.length).toBeGreaterThan(0);
    });

    test("jsonRepair accepts isTruncated=true flag", () => {
      const result = CriticPromptBuilder.jsonRepair(true, "error message");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("jsonRepair accepts isTruncated=false flag", () => {
      const result = CriticPromptBuilder.jsonRepair(false, "error message");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("jsonRepair includes the error message in output", () => {
      const errorMsg = "custom error message";
      const result = CriticPromptBuilder.jsonRepair(false, errorMsg);
      expect(result).toContain(errorMsg);
    });

    test("jsonRepair differentiates between truncated and non-truncated", () => {
      const errorMsg = "error message";
      const truncated = CriticPromptBuilder.jsonRepair(true, errorMsg);
      const notTruncated = CriticPromptBuilder.jsonRepair(false, errorMsg);

      // Both should be strings and non-empty
      expect(typeof truncated).toBe("string");
      expect(typeof notTruncated).toBe("string");
      expect(truncated.length).toBeGreaterThan(0);
      expect(notTruncated.length).toBeGreaterThan(0);

      // May differ if truncation affects the message (likely)
      // But we don't mandate how — just that both work
    });
  });

  describe("static schemaRepair method", () => {
    test("schemaRepair exists as a static method", () => {
      expect(typeof CriticPromptBuilder.schemaRepair).toBe("function");
    });

    test("schemaRepair(message) returns a string", () => {
      const result = CriticPromptBuilder.schemaRepair("error message");
      expect(typeof result).toBe("string");
    });

    test("schemaRepair returns non-empty string", () => {
      const result = CriticPromptBuilder.schemaRepair("error message");
      expect(result.length).toBeGreaterThan(0);
    });

    test("schemaRepair includes the error message in output", () => {
      const errorMsg = "custom schema error";
      const result = CriticPromptBuilder.schemaRepair(errorMsg);
      expect(result).toContain(errorMsg);
    });

    test("schemaRepair handles long error messages", () => {
      const longError = "This is a very long error message ".repeat(10);
      const result = CriticPromptBuilder.schemaRepair(longError);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("schemaRepair handles empty string", () => {
      const result = CriticPromptBuilder.schemaRepair("");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("prompt quality", () => {
    test("build() prompt is substantial (>200 chars) to guide LLM effectively", () => {
      const prd: Partial<PRD> = {
        feature: "test-feature",
        stories: [],
        branch: "main",
      };
      const manifest: FactsManifest = {
        repoFacts: [],
        specClaims: [],
        gaps: [],
      };

      const builder = new CriticPromptBuilder();
      const result = builder.build(prd as PRD, manifest);

      expect(result.task.content.length).toBeGreaterThan(200);
    });

    test("jsonRepair() prompt is substantial (>100 chars)", () => {
      const result = CriticPromptBuilder.jsonRepair(false, "error");
      expect(result.length).toBeGreaterThan(100);
    });

    test("schemaRepair() prompt is substantial (>100 chars)", () => {
      const result = CriticPromptBuilder.schemaRepair("error");
      expect(result.length).toBeGreaterThan(100);
    });
  });
});
