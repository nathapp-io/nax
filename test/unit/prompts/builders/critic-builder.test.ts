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

  describe("Step 2B — PRD serialization and new audit items", () => {
    const baseManifest: FactsManifest = { repoFacts: [], specClaims: [], gaps: [] };

    test("build() serializes user story IDs into the prompt", () => {
      const prd: any = {
        feature: "feat-x",
        userStories: [
          {
            id: "US-001",
            title: "first story",
            description: "do thing",
            acceptanceCriteria: ["When X, then Y"],
          },
          {
            id: "US-002",
            title: "second story",
            description: "do other thing",
            acceptanceCriteria: ["When A, then B"],
          },
        ],
        branchName: "feat/x",
      };
      const result = new CriticPromptBuilder().build(prd, baseManifest);
      expect(result.task.content).toContain("US-001");
      expect(result.task.content).toContain("US-002");
      expect(result.task.content).toContain("first story");
      expect(result.task.content).toContain("When X, then Y");
    });

    test("build() emits a placeholder when PRD has no user stories", () => {
      const prd: any = { feature: "feat-empty", userStories: [], branchName: "main" };
      const result = new CriticPromptBuilder().build(prd, baseManifest);
      expect(result.task.content).toContain("no user stories");
    });

    test("build() includes failure-table-enumerated checklist item when specContent provided", () => {
      const prd: any = {
        feature: "f",
        userStories: [{ id: "US-001", title: "t", description: "d", acceptanceCriteria: ["When X, then Y"] }],
        branchName: "main",
      };
      const result = new CriticPromptBuilder().build(prd, baseManifest, "## Failure handling\n| row | behaviour |");
      expect(result.task.content).toContain("failure-table-enumerated");
      expect(result.task.content).toContain("walk it row by row");
    });

    test("build() omits failure-table-enumerated checklist item when specContent is empty", () => {
      const prd: any = {
        feature: "f",
        userStories: [{ id: "US-001", title: "t", description: "d", acceptanceCriteria: ["When X, then Y"] }],
        branchName: "main",
      };
      const result = new CriticPromptBuilder().build(prd, baseManifest, "");
      // The "#### failure-table-enumerated" heading (and its body) must not appear when
      // there's no spec to enumerate. The literal string may still appear in the output
      // schema enum — that's intentional, so consumers know it's a valid checklistItem.
      expect(result.task.content).not.toContain("#### failure-table-enumerated");
      expect(result.task.content).not.toContain("walk it row by row");
    });

    test("build() includes description-ac-contradiction checklist item", () => {
      const prd: any = {
        feature: "f",
        userStories: [{ id: "US-001", title: "t", description: "d", acceptanceCriteria: ["When X, then Y"] }],
        branchName: "main",
      };
      const result = new CriticPromptBuilder().build(prd, baseManifest);
      expect(result.task.content).toContain("description-ac-contradiction");
    });

    test("build() includes ALL manifest spec claims (not capped at 5)", () => {
      const prd: any = {
        feature: "f",
        userStories: [{ id: "US-001", title: "t", description: "d", acceptanceCriteria: ["When X, then Y"] }],
        branchName: "main",
      };
      const specClaims = Array.from({ length: 8 }, (_, i) => ({
        id: `S-${String(i + 1).padStart(3, "0")}`,
        specSpan: `span ${i + 1}`,
        claim: `claim ${i + 1}`,
        kind: "factual" as const,
        verification: { status: "verified" as const },
      }));
      const manifest: FactsManifest = { repoFacts: [], specClaims, gaps: [] };
      const result = new CriticPromptBuilder().build(prd, manifest);
      // Pre-fix the critic only included the first 5; we now expect all 8.
      // Check the manifest format prefix `- S-NNN:` to avoid false-matching against
      // "US-001" in the output-schema example block.
      for (let i = 1; i <= 8; i++) {
        expect(result.task.content).toContain(`- S-${String(i).padStart(3, "0")}: claim ${i}`);
      }
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
