import { describe, expect, test } from "bun:test";
import type { FactsManifest } from "@/debate/facts-manifest";
import type { PRD } from "@/prd";

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
    test("instantiates, has build(), returns ComposeInput with role/task, ac-testable, failure-modes-considered, feature, non-empty", () => {
      expect(CriticPromptBuilder).toBeDefined();
      const builder = new CriticPromptBuilder();
      expect(builder).toBeDefined();
      expect(typeof builder.build).toBe("function");

      const featureName = "my-unique-feature-xyz";
      const prd: Partial<PRD> = { feature: featureName, stories: [], branch: "main" };
      const manifest: FactsManifest = { repoFacts: [], specClaims: [], gaps: [] };
      const result = builder.build(prd as PRD, manifest);

      expect(typeof result).toBe("object");
      expect(result.role).toBeDefined();
      expect(result.task).toBeDefined();
      expect(result.task.content).toContain("ac-testable");
      expect(result.task.content).toContain("failure-modes-considered");
      expect(result.task.content).toContain(featureName);
      expect(result.task.content.length).toBeGreaterThan(0);
    });

    test("build() with complex PRD maintains feature, ac-testable, and failure-modes-considered in output", () => {
      const featureName = "complex-feature-name";
      const prd: Partial<PRD> = {
        feature: featureName,
        specContent: "Some spec content here",
        stories: [
          {
            id: "story-1",
            title: "Story 1",
            acceptanceCriteria: [{ id: "ac-1", assertion: "should do something" }],
          },
        ],
        branch: "feature/complex",
      };
      const manifest: FactsManifest = {
        repoFacts: [{ id: "F-001", kind: "file", evidence: "path/to/file.ts", summary: "Found file" }],
        specClaims: [
          {
            id: "S-001",
            specSpan: "line 1",
            claim: "test claim",
            kind: "factual",
            verification: { status: "verified" },
          },
        ],
        gaps: [{ id: "G-001", kind: "missing-context", note: "test gap" }],
      };

      const result = new CriticPromptBuilder().build(prd as PRD, manifest);

      expect(result.task.content).toContain(featureName);
      expect(result.task.content).toContain("ac-testable");
      expect(result.task.content).toContain("failure-modes-considered");
    });
  });

  describe("static jsonRepair method", () => {
    test("exists as static method, returns non-empty string that includes the error message", () => {
      expect(typeof CriticPromptBuilder.jsonRepair).toBe("function");
      const errorMsg = "custom error message";
      const result = CriticPromptBuilder.jsonRepair(false, errorMsg);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain(errorMsg);
    });

    test.each([
      ["isTruncated=true", true],
      ["isTruncated=false", false],
    ] as const)("jsonRepair accepts %s and returns non-empty string", (_label, isTruncated) => {
      const result = CriticPromptBuilder.jsonRepair(isTruncated, "error message");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("static schemaRepair method", () => {
    test("exists as static method, returns non-empty string that includes the error message", () => {
      expect(typeof CriticPromptBuilder.schemaRepair).toBe("function");
      const errorMsg = "custom schema error";
      const result = CriticPromptBuilder.schemaRepair(errorMsg);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain(errorMsg);
    });

    test.each([
      ["long error message", "This is a very long error message ".repeat(10)],
      ["empty string", ""],
    ] as const)("schemaRepair handles %s", (_label, errorMsg) => {
      const result = CriticPromptBuilder.schemaRepair(errorMsg);
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
          { id: "US-001", title: "first story", description: "do thing", acceptanceCriteria: ["When X, then Y"] },
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

    test("build() includes failure-table-enumerated when specContent provided and omits it when empty", () => {
      const prd: any = {
        feature: "f",
        userStories: [{ id: "US-001", title: "t", description: "d", acceptanceCriteria: ["When X, then Y"] }],
        branchName: "main",
      };

      const withSpec = new CriticPromptBuilder().build(prd, baseManifest, "## Failure handling\n| row | behaviour |");
      expect(withSpec.task.content).toContain("failure-table-enumerated");
      expect(withSpec.task.content).toContain("walk it row by row");

      const withoutSpec = new CriticPromptBuilder().build(prd, baseManifest, "");
      expect(withoutSpec.task.content).not.toContain("#### failure-table-enumerated");
      expect(withoutSpec.task.content).not.toContain("walk it row by row");
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
      for (let i = 1; i <= 8; i++) {
        expect(result.task.content).toContain(`- S-${String(i).padStart(3, "0")}: claim ${i}`);
      }
    });
  });

  describe("prompt quality", () => {
    test("build(), jsonRepair(), and schemaRepair() all produce substantial prompts", () => {
      const prd: Partial<PRD> = { feature: "test-feature", stories: [], branch: "main" };
      const manifest: FactsManifest = { repoFacts: [], specClaims: [], gaps: [] };

      const buildResult = new CriticPromptBuilder().build(prd as PRD, manifest);
      expect(buildResult.task.content.length).toBeGreaterThan(200);

      expect(CriticPromptBuilder.jsonRepair(false, "error").length).toBeGreaterThan(100);
      expect(CriticPromptBuilder.schemaRepair("error").length).toBeGreaterThan(100);
    });
  });
});
