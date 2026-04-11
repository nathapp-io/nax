import { describe, expect, test } from "bun:test";
import { buildTddLanguageSection } from "../../../../src/prompts/sections/tdd-conventions";
import { PromptBuilder } from "../../../../src/prompts";
import type { NaxConfig } from "../../../../src/config/types";

describe("buildTddLanguageSection", () => {
  describe("go", () => {
    test("returns a non-empty string for 'go'", () => {
      const result = buildTddLanguageSection("go");
      expect(result).not.toBe("");
    });

    test("contains '<filename>_test.go' naming convention", () => {
      const result = buildTddLanguageSection("go");
      expect(result).toContain("_test.go");
    });

    test("mentions same package directory placement", () => {
      const result = buildTddLanguageSection("go");
      // Convention: placed in the same package directory as the source file
      expect(result.toLowerCase()).toMatch(/same.*directory|same.*package/);
    });
  });

  describe("rust", () => {
    test("returns a non-empty string for 'rust'", () => {
      const result = buildTddLanguageSection("rust");
      expect(result).not.toBe("");
    });

    test("contains '#[cfg(test)]' attribute", () => {
      const result = buildTddLanguageSection("rust");
      expect(result).toContain("#[cfg(test)]");
    });

    test("mentions inline module convention", () => {
      const result = buildTddLanguageSection("rust");
      // Convention: inline module at the bottom of the source file
      expect(result.toLowerCase()).toMatch(/inline|module/);
    });
  });

  describe("python", () => {
    test("returns a non-empty string for 'python'", () => {
      const result = buildTddLanguageSection("python");
      expect(result).not.toBe("");
    });

    test("contains 'test_<source_filename>.py' naming convention", () => {
      const result = buildTddLanguageSection("python");
      expect(result).toContain("test_");
      expect(result).toContain(".py");
    });

    test("mentions tests/ directory", () => {
      const result = buildTddLanguageSection("python");
      expect(result).toContain("tests/");
    });
  });

  describe("typescript", () => {
    test("returns empty string for 'typescript'", () => {
      const result = buildTddLanguageSection("typescript");
      expect(result).toBe("");
    });
  });

  describe("undefined", () => {
    test("returns empty string when language is undefined", () => {
      const result = buildTddLanguageSection(undefined);
      expect(result).toBe("");
    });
  });

  describe("unknown languages", () => {
    test("returns empty string for an unrecognised language", () => {
      const result = buildTddLanguageSection("ruby");
      expect(result).toBe("");
    });
  });
});

describe("PromptBuilder — language-aware TDD convention integration", () => {
  function makeConfig(language: string): NaxConfig {
    return {
      version: 1,
      project: { language: language as any },
    } as NaxConfig;
  }

  test("build() contains Go TDD convention when config.project.language is 'go'", async () => {
    const config = makeConfig("go");
    const prompt = await PromptBuilder.for("test-writer")
      .withLoader("/tmp/fake-workdir", config)
      .build();

    expect(prompt).toContain("_test.go");
  });

  test("build() contains no Go convention when language is 'typescript'", async () => {
    const config = makeConfig("typescript");
    const prompt = await PromptBuilder.for("test-writer")
      .withLoader("/tmp/fake-workdir", config)
      .build();

    // Should not inject Go conventions for TypeScript projects
    expect(prompt).not.toContain("_test.go");
  });

  test("build() contains no language convention when project is undefined", async () => {
    const config = { version: 1 } as NaxConfig;
    const prompt = await PromptBuilder.for("test-writer")
      .withLoader("/tmp/fake-workdir", config)
      .build();

    expect(prompt).not.toContain("_test.go");
    expect(prompt).not.toContain("#[cfg(test)]");
  });
});
